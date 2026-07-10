import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Actor, assertCustomerExists, audit } from './customer-accounts.common';

export type QuotaPeriod = 'daily' | 'monthly';

export interface QuotaRow {
  id: string;
  customer_id: string;
  period: QuotaPeriod;
  limit_count: string;
  used_count: string;
  window_start: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface QuotaUsage {
  period: QuotaPeriod;
  limit: number;
  used: number;
  remaining: number;
  windowStart: string;
}

export interface SetQuotaInput {
  period: QuotaPeriod;
  limit: number;
}

const QUOTA_COLUMNS =
  'id,customer_id,period,limit_count,used_count,window_start,created_by,created_at,updated_at';

/**
 * Per-customer message quotas. Each (customer, period) pair carries a cap
 * (limit_count) and a rolling counter (used_count) that resets when the period
 * window elapses. {@link consume} is the enforcement primitive the send path
 * calls before dispatching messages; it resets the window lazily, rejects when
 * the cap would be exceeded, and increments the counter atomically under a row
 * lock. All access is tenant-scoped by row level security (migration 026).
 */
@Injectable()
export class CustomerQuotaService {
  constructor(private readonly database: DatabaseService) {}

  /** Whether `windowStart` is stale for `period` relative to `now`. */
  private windowElapsed(period: QuotaPeriod, windowStart: Date, now: Date): boolean {
    if (period === 'daily') {
      return (
        windowStart.getUTCFullYear() !== now.getUTCFullYear() ||
        windowStart.getUTCMonth() !== now.getUTCMonth() ||
        windowStart.getUTCDate() !== now.getUTCDate()
      );
    }
    return (
      windowStart.getUTCFullYear() !== now.getUTCFullYear() ||
      windowStart.getUTCMonth() !== now.getUTCMonth()
    );
  }

  private toUsage(row: QuotaRow): QuotaUsage {
    const limit = Number(row.limit_count);
    const used = Number(row.used_count);
    return {
      period: row.period,
      limit,
      used,
      remaining: Math.max(limit - used, 0),
      windowStart: row.window_start,
    };
  }

  /** Lists the customer's quotas with current usage vs limit. */
  async list(actor: Actor, customerId: string): Promise<QuotaUsage[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const rows = (
        await client.query<QuotaRow>(
          `SELECT ${QUOTA_COLUMNS} FROM customer_quotas WHERE customer_id=$1 ORDER BY period`,
          [customerId],
        )
      ).rows;
      return rows.map((row) => this.toUsage(row));
    });
  }

  /** Creates or updates the cap for one period (upsert), preserving usage. */
  async setQuota(actor: Actor, customerId: string, input: SetQuotaInput): Promise<QuotaUsage> {
    if (!Number.isInteger(input.limit) || input.limit < 0)
      throw new BadRequestException('limit must be a non-negative integer');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const old = (
        await client.query<QuotaRow>(
          'SELECT ' + QUOTA_COLUMNS + ' FROM customer_quotas WHERE customer_id=$1 AND period=$2',
          [customerId, input.period],
        )
      ).rows[0];
      const row = (
        await client.query<QuotaRow>(
          `INSERT INTO customer_quotas(tenant_id,customer_id,period,limit_count,created_by)
             VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id,customer_id,period)
             DO UPDATE SET limit_count=EXCLUDED.limit_count, updated_at=now()
           RETURNING ${QUOTA_COLUMNS}`,
          [actor.tenantId, customerId, input.period, input.limit, actor.userId],
        )
      ).rows[0];
      await audit(
        client,
        actor,
        old ? 'customer_quota.updated' : 'customer_quota.created',
        'customer_quota',
        row.id,
        old ?? null,
        row,
      );
      return this.toUsage(row);
    });
  }

  /** Removes a period's quota (returns true when a row was deleted). */
  async removeQuota(actor: Actor, customerId: string, period: QuotaPeriod): Promise<boolean> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const deleted = (
        await client.query<{ id: string }>(
          'DELETE FROM customer_quotas WHERE customer_id=$1 AND period=$2 RETURNING id',
          [customerId, period],
        )
      ).rows[0];
      if (deleted)
        await audit(client, actor, 'customer_quota.deleted', 'customer_quota', deleted.id, null, {
          period,
        });
      return Boolean(deleted);
    });
  }

  /**
   * Enforcement primitive: attempts to consume `count` messages against every
   * configured quota period. Resets any elapsed window first, then rejects with
   * a {@link BadRequestException} if any period would exceed its cap; otherwise
   * increments the counters. A customer with no quotas configured is
   * unconstrained (returns an empty usage list).
   *
   * INTEGRATION POINT: the live message send / bulk-send path should call this
   * (tenant-scoped, with the number of messages about to be dispatched) before
   * submitting to the engine, and only proceed when it resolves. It is exposed
   * as a service method and via POST /customer-accounts/:id/quota/consume; it is
   * NOT yet wired into BulkSendService (owned by the messaging-depth module).
   */
  async consume(actor: Actor, customerId: string, count: number): Promise<QuotaUsage[]> {
    if (!Number.isInteger(count) || count <= 0)
      throw new BadRequestException('count must be a positive integer');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      return this.consumeInClient(client, actor, customerId, count);
    });
  }

  /**
   * The transactional core of {@link consume}, reusable by callers that already
   * hold a tenant transaction (e.g. a future send path that debits credit and
   * consumes quota atomically). Assumes the customer has been verified.
   */
  async consumeInClient(
    client: PoolClient,
    actor: Actor,
    customerId: string,
    count: number,
  ): Promise<QuotaUsage[]> {
    const now = new Date();
    // Lock the customer's quota rows so concurrent sends serialise on the cap.
    const rows = (
      await client.query<QuotaRow>(
        `SELECT ${QUOTA_COLUMNS} FROM customer_quotas WHERE customer_id=$1 ORDER BY period FOR UPDATE`,
        [customerId],
      )
    ).rows;
    if (!rows.length) return [];

    // Reset elapsed windows and compute the effective post-consume usage.
    const effective = rows.map((row) => {
      const elapsed = this.windowElapsed(row.period, new Date(row.window_start), now);
      const usedBase = elapsed ? 0 : Number(row.used_count);
      return { row, elapsed, used: usedBase + count, limit: Number(row.limit_count) };
    });
    const exceeded = effective.find((e) => e.used > e.limit);
    if (exceeded)
      throw new BadRequestException(
        `${exceeded.row.period} quota exceeded: ${exceeded.used} would exceed limit ${exceeded.limit}`,
      );

    const updated: QuotaUsage[] = [];
    for (const e of effective) {
      const row = (
        await client.query<QuotaRow>(
          `UPDATE customer_quotas
              SET used_count=$3,
                  window_start=CASE WHEN $4 THEN now() ELSE window_start END,
                  updated_at=now()
            WHERE id=$1 AND customer_id=$2
            RETURNING ${QUOTA_COLUMNS}`,
          [e.row.id, customerId, e.used, e.elapsed],
        )
      ).rows[0];
      updated.push(this.toUsage(row));
    }
    await audit(client, actor, 'customer_quota.consumed', 'customer', customerId, null, { count });
    return updated;
  }
}
