import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { PermanentJobError } from '../platform/job-registry';
import { JobsService } from '../platform/jobs.service';
import type { Actor } from './message-send.service';

/** One sweep of new DLR rows into forward attempts, then its own successor. */
export const DLR_FORWARD_POLL_JOB_TYPE = 'dlr.forward.poll';
export const DLR_FORWARD_POLL_MAX_ATTEMPTS = 3;
/** One HTTP call to one caller-supplied URL. */
export const DLR_FORWARD_JOB_TYPE = 'dlr.forward.dispatch';
/**
 * 12 attempts on the platform's exponential backoff spans a little over a
 * day, which is the 24 hours CPaaS asked us to keep trying for.
 */
export const DLR_FORWARD_MAX_ATTEMPTS = 12;

const POLL_INTERVAL_SECONDS = 30;
/** A receipt nobody collected within a week is not going to be collected. */
const SWEEP_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

export interface DlrForwardAttemptRow {
  id: string;
  engine_sql_id: string;
  dlr_mask: number | null;
  url_host: string | null;
  status: string;
  attempts: number;
}

/**
 * FORWARDS A DELIVERY RECEIPT TO THE URL THE CALLER SUBMITTED WITH THE MESSAGE.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * In a stock Kannel, `dlr-url` is fetched by **smsbox**, for messages smsbox
 * itself originated through its `sendsms` interface. JKANNEL does not submit
 * that way: it writes to `send_sms` and sqlbox injects into bearerbox. When
 * the receipt comes back it is routed to the box that originated the message —
 * sqlbox — which writes it to `sent_sms` and stops.
 *
 * So the URL was stored, perfectly intact, in a column no process ever read.
 * A caller watching for receipts saw nothing and had no way to tell that
 * from a carrier that never sent one. This is the missing fetcher.
 *
 * WHY THERE IS AN ALLOWLIST, AND WHY IT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * `dlr_url` is **attacker-controllable**. Anyone who can submit a message can
 * put any URL in it. A worker that loops over a database column and fetches
 * whatever it finds, from inside the private network, is a server-side
 * request forgery engine with a queue in front of it: `http://postgres:5432`,
 * a cloud metadata endpoint, another tenant's service.
 *
 * So a host that is not on the operator's list is never called. It is
 * recorded as `refused`, because a receipt silently dropped and a receipt
 * deliberately refused are different facts and the difference is what an
 * operator needs during an incident.
 */
@Injectable()
export class DlrForwardService {
  private readonly logger = new Logger(DlrForwardService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Hosts a receipt may be forwarded to, from `DLR_FORWARD_ALLOWED_HOSTS`.
   *
   * Read per call rather than cached at construction: an operator adding a
   * host should not have to restart the API, and this runs every thirty
   * seconds so the cost is irrelevant.
   *
   * EMPTY MEANS FORWARD NOTHING, never "forward anything". A misconfigured or
   * missing variable must fail closed — the failure mode of the other choice
   * is the SSRF this list exists to prevent.
   */
  allowedHosts(): string[] {
    return (process.env.DLR_FORWARD_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Is this URL one we will call?
   *
   * Exact host match, no suffix matching: `evil-app.speedamobile.com.attacker
   * .test` ends with nothing we listed, but a naive `endsWith` check on
   * `speedamobile.com` would accept it.
   *
   * https only. A receipt URL carries a per-message token, and sending it in
   * clear is handing it to anyone on the path.
   */
  isAllowed(rawUrl: string): { allowed: boolean; host: string | null; reason?: string } {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, host: null, reason: 'not a valid absolute URL' };
    }
    if (url.protocol !== 'https:')
      return { allowed: false, host: url.hostname, reason: `refusing ${url.protocol} — https only` };
    const host = url.hostname.toLowerCase();
    const allowed = this.allowedHosts();
    if (!allowed.length)
      return { allowed: false, host, reason: 'DLR_FORWARD_ALLOWED_HOSTS is empty' };
    if (!allowed.includes(host))
      return { allowed: false, host, reason: `host ${host} is not in DLR_FORWARD_ALLOWED_HOSTS` };
    return { allowed: true, host };
  }

  /**
   * The caller's URL with `%d` replaced by the receipt type, and nothing else
   * touched.
   *
   * Byte-for-byte on the rest is a requirement, not a nicety: the URL carries
   * a per-message HMAC token in `t=`, and re-encoding the query string would
   * change it and every forward would be rejected as unauthenticated.
   */
  substituteMask(rawUrl: string, dlrMask: number | null): string {
    return rawUrl.replace(/%d/g, String(dlrMask ?? 0));
  }

  /** Host only, for the ledger. The token never goes in the database. */
  private hostOf(rawUrl: string): string | null {
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /** `t=…` masked. This string reaches logs, and the token is a credential. */
  static redact(rawUrl: string): string {
    return rawUrl.replace(/([?&]t=)[^&]*/gi, '$1***');
  }

  /**
   * Claim the DLR rows that have a `dlr_url` and no attempt row yet.
   *
   * The INSERT is `ON CONFLICT DO NOTHING` against the unique index, so two
   * sweeps racing — or two replicas — produce one attempt row and one
   * forward. The sweep does not need a lock; the index is the lock.
   */
  async sweep(actor: Actor): Promise<{ claimed: string[]; scanned: number }> {
    const probe = await this.sqlbox.probe();
    if (!probe.available) return { claimed: [], scanned: 0 };

    const receipts = await this.sqlbox.list({
      direction: 'DLR',
      fromEpoch: Math.floor(Date.now() / 1000) - SWEEP_LOOKBACK_SECONDS,
      limit: 200,
    });
    const candidates = receipts.items
      .map((item) => ({
        sqlId: String((item.raw as Record<string, unknown>)?.sql_id ?? item.id ?? ''),
        dlrUrl: String((item.raw as Record<string, unknown>)?.dlr_url ?? ''),
        dlrMask: Number((item.raw as Record<string, unknown>)?.dlr_mask ?? 0),
      }))
      .filter((row) => row.sqlId && row.dlrUrl);

    if (!candidates.length) return { claimed: [], scanned: receipts.items.length };

    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const claimed: string[] = [];
      for (const row of candidates) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO dlr_forward_attempts
             (tenant_id, engine_sql_id, dlr_mask, url_host)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, engine_sql_id) DO NOTHING
           RETURNING id`,
          [actor.tenantId, row.sqlId, row.dlrMask, this.hostOf(row.dlrUrl)],
        );
        if (inserted.rows[0]) claimed.push(inserted.rows[0].id);
      }
      return { claimed, scanned: receipts.items.length };
    });
  }

  /**
   * Forward one receipt.
   *
   * Throws {@link PermanentJobError} for anything a retry cannot fix — a URL
   * that has gone, a host that is not allowlisted, a 4xx that is not 408 or
   * 429 — so the queue dead-letters it instead of spending a day of backoff
   * on a request that will be refused identically every time.
   */
  async dispatch(actor: Actor, attemptId: string, attempt: number): Promise<unknown> {
    const record = await this.database.tenantTransaction(actor.tenantId, async (client) =>
      (
        await client.query<DlrForwardAttemptRow>(
          'SELECT id, engine_sql_id, dlr_mask, url_host, status, attempts FROM dlr_forward_attempts WHERE id = $1',
          [attemptId],
        )
      ).rows[0],
    );
    if (!record) throw new PermanentJobError(`No DLR forward attempt ${attemptId}`);
    if (record.status === 'delivered') return { skipped: true, reason: 'already delivered' };

    const rawUrl = await this.urlFor(record.engine_sql_id);
    if (!rawUrl) {
      await this.complete(actor, attemptId, 'dead_letter', attempt, null, 'the engine row no longer carries a dlr_url');
      throw new PermanentJobError('The engine row no longer carries a dlr_url');
    }

    const verdict = this.isAllowed(rawUrl);
    if (!verdict.allowed) {
      await this.complete(actor, attemptId, 'refused', attempt, null, verdict.reason ?? 'refused');
      // Recorded, not retried: an allowlist decision will not change on its
      // own, and burning a day of backoff on it hides the real finding.
      this.logger.warn(
        `DLR forward refused for engine row ${record.engine_sql_id}: ${verdict.reason} ` +
          `(${DlrForwardService.redact(rawUrl)})`,
      );
      throw new PermanentJobError(`Refused: ${verdict.reason}`);
    }

    const target = this.substituteMask(rawUrl, record.dlr_mask);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(target, {
        method: 'GET',
        signal: controller.signal,
        // A receipt endpoint that redirects is a receipt endpoint that may
        // redirect somewhere the allowlist never approved.
        redirect: 'manual',
      });
      if (response.status >= 200 && response.status < 300) {
        await this.complete(actor, attemptId, 'delivered', attempt, response.status, null);
        return { forwarded: true, status: response.status, host: verdict.host };
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      await this.record(actor, attemptId, attempt, response.status, `HTTP ${response.status}`);
      if (!retryable)
        throw new PermanentJobError(
          `${DlrForwardService.redact(target)} answered HTTP ${response.status}`,
        );
      throw new Error(`HTTP ${response.status}`);
    } catch (reason) {
      if (reason instanceof PermanentJobError) throw reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      await this.record(actor, attemptId, attempt, null, message);
      throw reason instanceof Error ? reason : new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The URL as the engine stored it, read fresh rather than cached. */
  private async urlFor(engineSqlId: string): Promise<string | null> {
    const page = await this.sqlbox.list({ sqlIds: [engineSqlId], direction: 'DLR', limit: 1 });
    const raw = page.items[0]?.raw as Record<string, unknown> | undefined;
    const url = raw?.dlr_url;
    return typeof url === 'string' && url ? url : null;
  }

  private async record(
    actor: Actor,
    attemptId: string,
    attempt: number,
    statusCode: number | null,
    error: string | null,
  ) {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        `UPDATE dlr_forward_attempts
            SET attempts = $2, last_status_code = $3, last_error = $4, status = 'failed'
          WHERE id = $1`,
        [attemptId, attempt, statusCode, error?.slice(0, 500) ?? null],
      );
    });
  }

  private async complete(
    actor: Actor,
    attemptId: string,
    status: 'delivered' | 'refused' | 'dead_letter',
    attempt: number,
    statusCode: number | null,
    error: string | null,
  ) {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        `UPDATE dlr_forward_attempts
            SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
                completed_at = now()
          WHERE id = $1`,
        [attemptId, status, attempt, statusCode, error?.slice(0, 500) ?? null],
      );
    });
  }

  /** Seconds between sweeps. The job queue's `next_attempt_at` is the clock. */
  pollIntervalSeconds(): number {
    return POLL_INTERVAL_SECONDS;
  }

  /**
   * Enqueues the next sweep, unless one is already queued or running.
   *
   * The "unless" is the whole point: without it a retried job would leave two
   * self-perpetuating chains running forever, each spawning its own
   * successor.
   *
   * `excludeJobId` is what makes the chain survive its own first hop. The
   * worker sets `status='running'` BEFORE invoking the handler and clears it
   * only after the handler returns, so a sweep calling this from inside its
   * own handler sees itself as in-flight and schedules nothing — and the
   * chain stops dead after one sweep. MO learned this the hard way; this is
   * the same fix, not a rediscovery.
   */
  async ensurePollScheduled(
    client: PoolClient,
    actor: Actor,
    delaySeconds: number,
    excludeJobId: string | null = null,
  ): Promise<boolean> {
    const inFlight = (
      await client.query(
        "SELECT 1 FROM api_jobs WHERE type=$1 AND status IN ('queued','running') " +
          'AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1',
        [DLR_FORWARD_POLL_JOB_TYPE, excludeJobId],
      )
    ).rows[0];
    if (inFlight) return false;
    await this.jobs.createOn(client, actor, {
      type: DLR_FORWARD_POLL_JOB_TYPE,
      input: {},
      runAt: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : null,
    });
    return true;
  }

  /**
   * One sweep, then the next one scheduled.
   *
   * `currentJobId` MUST be the id of the job running this sweep, or the chain
   * stops after one hop. It is optional only so a manual sweep can call this.
   *
   * The chain does not run at all while the allowlist is empty: with nowhere
   * approved to forward to there is nothing for it to do, and a poll every
   * thirty seconds that can only ever refuse is noise in the job history.
   */
  async runScheduledSweep(actor: Actor, currentJobId: string | null = null) {
    if (!this.allowedHosts().length)
      return { skipped: true as const, reason: 'DLR_FORWARD_ALLOWED_HOSTS is empty' };
    const result = await this.sweep(actor);
    const scheduled = await this.database.tenantTransaction(actor.tenantId, (client) =>
      this.ensurePollScheduled(client, actor, POLL_INTERVAL_SECONDS, currentJobId),
    );
    return { ...result, nextSweepScheduled: scheduled };
  }
}
