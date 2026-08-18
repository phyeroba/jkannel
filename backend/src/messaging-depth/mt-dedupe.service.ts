import { ConflictException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  DEFAULT_DEDUPE_WINDOW_SECONDS,
  dedupeKey,
  describeDuplicate,
  normalizeWindowSeconds,
  type DedupeSubject,
} from './mt-dedupe';

/**
 * Claims a dedupe key for one submission, or refuses it as a duplicate
 * (SMS Studio "duplication control"; migration 053).
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLAIM IS AN INSERT AND NOT A SELECT-THEN-INSERT
 * ---------------------------------------------------------------------------
 * Two concurrent retries of the same submission is EXACTLY the case this
 * exists for, and it is precisely the case a read-then-write loses: both read
 * "not present", both insert, both send. `INSERT ... ON CONFLICT DO NOTHING`
 * makes the claim atomic, so one wins and the other is told it lost — by the
 * database, not by a race.
 *
 * The expiry is enforced in the same statement rather than by a sweep, so a
 * lapsed key is re-claimable the instant it lapses even if no sweep has run.
 */
@Injectable()
export class MtDedupeService {
  /**
   * Claims the key, inside the caller's transaction.
   *
   * Throws {@link ConflictException} when the same message was submitted inside
   * the window. Returns silently — and cheaply, with no statement at all — when
   * the tenant has suppression disabled.
   */
  async claimInClient(
    client: PoolClient,
    subject: DedupeSubject,
    windowSeconds: number,
  ): Promise<void> {
    const window = normalizeWindowSeconds(windowSeconds);
    if (window === 0) return;

    const key = dedupeKey(subject);

    // Lapsed key cleared FIRST, as its own statement.
    //
    // This was originally a data-modifying CTE in the same statement as the
    // INSERT, which does not work and was caught only by running it against a
    // real PostgreSQL: every sub-statement of a CTE executes against the SAME
    // snapshot, so the INSERT's ON CONFLICT check still saw the row the DELETE
    // had just removed. The result was a key that stayed blocked forever once
    // claimed, and a legitimate repeat an hour later was refused as a
    // duplicate.
    //
    // Two statements in one transaction is still atomic, and the concurrency
    // property is unchanged: the DELETE is a no-op for a live key, and the
    // INSERT's ON CONFLICT is what serialises two simultaneous retries.
    await client.query(
      'DELETE FROM mt_dedupe_keys WHERE tenant_id = $1 AND dedupe_key = $2 AND expires_at <= now()',
      [subject.tenantId, key],
    );

    // `xmax = 0` now means exactly "this row was inserted, not updated" — no
    // timestamp comparison to get subtly wrong.
    const { rows } = await client.query<{ claimed: boolean; first_sql_id: string | null }>(
      `INSERT INTO mt_dedupe_keys(tenant_id, dedupe_key, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
         SET suppressed_count = mt_dedupe_keys.suppressed_count + 1
       RETURNING (xmax = 0) AS claimed, first_sql_id`,
      [subject.tenantId, key, String(window)],
    );

    const row = rows[0];
    if (row?.claimed) return;
    throw new ConflictException(
      describeDuplicate(subject, window, row?.first_sql_id ?? null).detail,
    );
  }

  /**
   * Stamps the winning submission's id onto its key.
   *
   * Best effort and never throws: this is the "the first one is message 4231"
   * half of a later refusal's explanation, and failing to record it must not
   * fail a send that has already happened.
   */
  async stampInClient(
    client: PoolClient,
    subject: DedupeSubject,
    windowSeconds: number,
    sqlId: string,
  ): Promise<void> {
    if (normalizeWindowSeconds(windowSeconds) === 0) return;
    try {
      await client.query(
        'UPDATE mt_dedupe_keys SET first_sql_id=$3 WHERE tenant_id=$1 AND dedupe_key=$2 AND first_sql_id IS NULL',
        [subject.tenantId, dedupeKey(subject), sqlId],
      );
    } catch {
      // Deliberately swallowed — see the doc comment.
    }
  }

  /**
   * Releases a key whose send then failed.
   *
   * Without this, a submission that claimed its key and was subsequently
   * refused (no route, no credit, blocked recipient) would leave the key held,
   * and the operator's corrected retry a few seconds later would be rejected as
   * a duplicate of a message that never went. Called on the rollback path.
   */
  async releaseInClient(
    client: PoolClient,
    subject: DedupeSubject,
    windowSeconds: number,
  ): Promise<void> {
    if (normalizeWindowSeconds(windowSeconds) === 0) return;
    try {
      await client.query(
        'DELETE FROM mt_dedupe_keys WHERE tenant_id=$1 AND dedupe_key=$2 AND first_sql_id IS NULL',
        [subject.tenantId, dedupeKey(subject)],
      );
    } catch {
      // Same reasoning as stampInClient: never turn a cleanup failure into a
      // second, different error for the caller.
    }
  }

  /** The tenant's configured window, defaulted when the column is absent. */
  async windowForInClient(client: PoolClient, tenantId: string): Promise<number> {
    try {
      const { rows } = await client.query<{ mt_dedupe_window_seconds: number }>(
        'SELECT mt_dedupe_window_seconds FROM tenants WHERE id=$1',
        [tenantId],
      );
      return normalizeWindowSeconds(
        rows[0]?.mt_dedupe_window_seconds ?? DEFAULT_DEDUPE_WINDOW_SECONDS,
      );
    } catch {
      // Migration 053 not yet applied. Suppression OFF is the behaviour that
      // predates this feature, and failing open is right for a control whose
      // failure mode is refusing legitimate traffic.
      return 0;
    }
  }

  /** Deletes lapsed keys. Safe to run at any cadence, or never. */
  async sweepInClient(client: PoolClient): Promise<number> {
    const { rowCount } = await client.query(
      'DELETE FROM mt_dedupe_keys WHERE expires_at <= now()',
    );
    return rowCount ?? 0;
  }
}
