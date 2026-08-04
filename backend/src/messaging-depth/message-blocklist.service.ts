import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { describeMsisdnProblem, normalizeMsisdn } from '../routing-depth/msisdn';

export type BlocklistType = 'blacklist' | 'whitelist' | 'dnd';

export interface BlocklistRow {
  id: string;
  customer_id: string | null;
  list_type: BlocklistType;
  msisdn: string;
  reason: string | null;
  source: string | null;
  enabled: boolean;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface AddBlocklistEntryInput {
  listType: BlocklistType;
  msisdn: string;
  customerId?: string | null;
  reason?: string;
  source?: string;
  expiresAt?: Date | null;
}

/** The verdict for one destination. */
export interface BlocklistVerdict {
  allowed: boolean;
  /** Which list produced a refusal, when refused. */
  listType: BlocklistType | null;
  reason: string | null;
}

const COLUMNS =
  'id,customer_id::text,list_type,msisdn,reason,source,enabled,expires_at,created_by,created_at,updated_at';

/**
 * Recipient blacklist / whitelist / DND (migration 032).
 *
 * `ROUTING_ENGINE_SPEC_04` step 4 requires the destination to be validated
 * against a blocklist BEFORE a route is chosen; nothing implemented it. This
 * service is that check, and it is evaluated first on every send path.
 *
 * Entries are stored against the canonical digits-only E.164 form produced by
 * the shared normaliser, so `+256700000000`, `00256700000000` and
 * `256 700 000000` are one entry rather than three.
 *
 * Scope: an entry with `customer_id = NULL` is tenant-wide; an entry with a
 * customer applies to that customer's traffic only. Precedence, evaluated in
 * order, is:
 *
 *   1. `dnd`       — refuse (a do-not-disturb registration by the subscriber)
 *   2. `blacklist` — refuse (an operator/customer block)
 *   3. `whitelist` — when any whitelist entry is in scope the list is CLOSED:
 *                    only whitelisted destinations may be sent to. With no
 *                    whitelist entries in scope the list is inert, so enabling
 *                    the feature is an explicit act.
 *
 * A refusal is a {@link ForbiddenException} — it is a policy decision, not a
 * malformed request and never a 500.
 */
@Injectable()
export class MessageBlocklistService {
  constructor(private readonly database: DatabaseService) {}

  /** Canonical digits for an address, or a BadRequest describing why not. */
  private canonical(msisdn: string): string {
    const normalized = normalizeMsisdn(msisdn);
    if (!normalized.digits) throw new BadRequestException(describeMsisdnProblem(normalized));
    return normalized.digits;
  }

  /**
   * Evaluates one destination inside an existing tenant transaction. Pure read;
   * safe to call before any mutation.
   */
  async evaluateInClient(
    client: PoolClient,
    destinationDigits: string,
    customerId?: string | null,
  ): Promise<BlocklistVerdict> {
    // One round trip: every in-scope, live entry for this destination plus a
    // marker for whether any whitelist exists in scope at all.
    const rows = (
      await client.query<{ list_type: BlocklistType; msisdn: string; reason: string | null }>(
        `SELECT list_type, msisdn, reason
           FROM messaging_blocklist
          WHERE enabled = true
            AND (expires_at IS NULL OR expires_at > now())
            AND (customer_id IS NULL OR customer_id = $2::uuid)
            AND (msisdn = $1 OR list_type = 'whitelist')`,
        [destinationDigits, customerId ?? null],
      )
    ).rows;

    const hit = (type: BlocklistType) =>
      rows.find((row) => row.list_type === type && row.msisdn === destinationDigits);

    const dnd = hit('dnd');
    if (dnd)
      return {
        allowed: false,
        listType: 'dnd',
        reason: dnd.reason ?? 'destination is registered do-not-disturb',
      };

    const blacklisted = hit('blacklist');
    if (blacklisted)
      return {
        allowed: false,
        listType: 'blacklist',
        reason: blacklisted.reason ?? 'destination is blacklisted',
      };

    const whitelistExists = rows.some((row) => row.list_type === 'whitelist');
    if (whitelistExists && !hit('whitelist'))
      return {
        allowed: false,
        listType: 'whitelist',
        reason: 'a whitelist is active and this destination is not on it',
      };

    return { allowed: true, listType: null, reason: null };
  }

  /** Evaluates and throws a {@link ForbiddenException} when the send is refused. */
  async assertAllowedInClient(
    client: PoolClient,
    destinationDigits: string,
    customerId?: string | null,
  ): Promise<void> {
    const verdict = await this.evaluateInClient(client, destinationDigits, customerId);
    if (!verdict.allowed)
      throw new ForbiddenException(`Destination refused by ${verdict.listType}: ${verdict.reason}`);
  }

  /** Operator-facing check for a single address (own transaction). */
  async evaluate(
    actor: Actor,
    msisdn: string,
    customerId?: string | null,
  ): Promise<BlocklistVerdict & { msisdn: string }> {
    const digits = this.canonical(msisdn);
    return this.database.tenantTransaction(actor.tenantId, async (client) => ({
      msisdn: digits,
      ...(await this.evaluateInClient(client, digits, customerId ?? null)),
    }));
  }

  async list(
    actor: Actor,
    query: {
      listType?: BlocklistType;
      customerId?: string | null;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ items: BlocklistRow[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query<BlocklistRow & { __total: string }>(
        `SELECT ${COLUMNS}, count(*) OVER() AS __total
           FROM messaging_blocklist
          WHERE ($1::text IS NULL OR list_type = $1)
            AND ($2::uuid IS NULL OR customer_id = $2::uuid)
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [query.listType ?? null, query.customerId ?? null, limit, offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      return { items: result.rows.map(({ __total, ...row }) => row), total, limit, offset };
    });
  }

  /** Adds (or re-enables) an entry. The address is normalised before storage. */
  async add(actor: Actor, input: AddBlocklistEntryInput): Promise<BlocklistRow> {
    const digits = this.canonical(input.msisdn);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      if (input.customerId) {
        const found = (
          await client.query('SELECT 1 FROM customers WHERE id=$1', [input.customerId])
        ).rows[0];
        if (!found) throw new NotFoundException('Customer not found');
      }
      // Idempotent: the partial uniques from migration 032 make a repeat add an
      // update of reason/source/expiry rather than a duplicate or a 409.
      const conflictTarget = input.customerId
        ? '(tenant_id, customer_id, list_type, msisdn) WHERE customer_id IS NOT NULL'
        : '(tenant_id, list_type, msisdn) WHERE customer_id IS NULL';
      const row = (
        await client.query<BlocklistRow>(
          `INSERT INTO messaging_blocklist
             (tenant_id, customer_id, list_type, msisdn, reason, source, expires_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT ${conflictTarget} DO UPDATE SET
             reason = EXCLUDED.reason,
             source = EXCLUDED.source,
             expires_at = EXCLUDED.expires_at,
             enabled = true,
             updated_at = now()
           RETURNING ${COLUMNS}`,
          [
            actor.tenantId,
            input.customerId ?? null,
            input.listType,
            digits,
            input.reason ?? null,
            input.source ?? null,
            input.expiresAt ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          actor.tenantId,
          actor.userId,
          `messaging_blocklist.${input.listType}.added`,
          'messaging_blocklist',
          row.id,
          JSON.stringify({
            msisdn: digits,
            listType: input.listType,
            customerId: input.customerId ?? null,
          }),
          input.reason ?? null,
        ],
      );
      return row;
    });
  }

  /** Removes an entry by id. */
  async remove(actor: Actor, id: string): Promise<void> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const deleted = (
        await client.query<{ id: string; msisdn: string; list_type: string }>(
          'DELETE FROM messaging_blocklist WHERE id=$1 RETURNING id,msisdn,list_type',
          [id],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('Blocklist entry not found');
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          `messaging_blocklist.${deleted.list_type}.removed`,
          'messaging_blocklist',
          deleted.id,
          JSON.stringify({ msisdn: deleted.msisdn }),
        ],
      );
    });
  }
}
