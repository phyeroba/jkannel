import { Injectable, Optional } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Actor, audit } from './data-model.common';
import {
  RETENTION_POLICIES,
  RetentionPolicy,
  retentionCutoff,
  effectiveRetentionDays,
} from './retention.policy';

// Transaction-level advisory lock namespace for the retention job, so multiple
// replicas / overlapping ticks never double-run a tenant's cycle. Distinct from
// the report scheduler (0x1c2d) and backup scheduler (7_244_118) namespaces.
const RETENTION_LOCK_NAMESPACE = 0x1c2e;

function batchSize(): number {
  const raw = Number(process.env.DATA_MODEL_RETENTION_BATCH_SIZE);
  return Number.isInteger(raw) && raw > 0 ? raw : 5000;
}
function maxBatches(): number {
  const raw = Number(process.env.DATA_MODEL_RETENTION_MAX_BATCHES);
  return Number.isInteger(raw) && raw > 0 ? raw : 20;
}

export interface PolicyResult {
  sourceTable: string;
  retentionDays: number;
  archived: number;
  deleted: number;
}

export interface TenantRetentionResult {
  tenantId: string;
  locked: boolean;
  policies: PolicyResult[];
}

/**
 * Archives / prunes rows older than each policy's retention window from the
 * high-volume log tables into their cold-storage *_archive tables. Tenant-scoped
 * (runs inside a tenant transaction so row level security applies), guarded by a
 * per-tenant transaction advisory lock, batched to bound transaction size, and
 * audited. See {@link RETENTION_POLICIES} for the source→archive mapping and the
 * copy-only vs archive-then-prune semantics (audit_log is copy-only).
 */
@Injectable()
export class DataModelRetentionService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly policies: RetentionPolicy[] = RETENTION_POLICIES,
  ) {}

  /** Runs every policy for one tenant. Returns per-policy archived/deleted counts. */
  async runForTenant(actor: Actor, now: Date = new Date()): Promise<TenantRetentionResult> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [RETENTION_LOCK_NAMESPACE, Number(actor.tenantId) % 2147483647],
      );
      if (!lock.rows[0]?.locked) return { tenantId: actor.tenantId, locked: false, policies: [] };

      const results: PolicyResult[] = [];
      for (const policy of this.policies) {
        const result = await this.applyPolicy(client, actor, policy, now);
        results.push(result);
      }
      return { tenantId: actor.tenantId, locked: true, policies: results };
    });
  }

  /** Applies one policy within an already-open tenant transaction. */
  async applyPolicy(
    client: PoolClient,
    actor: Actor,
    policy: RetentionPolicy,
    now: Date,
  ): Promise<PolicyResult> {
    const cutoff = retentionCutoff(policy, now);
    const result: PolicyResult = {
      sourceTable: policy.sourceTable,
      retentionDays: effectiveRetentionDays(policy),
      archived: 0,
      deleted: 0,
    };

    if (policy.deleteAfterArchive) {
      await this.archiveAndPrune(client, policy, cutoff, result);
    } else {
      await this.archiveCopyOnly(client, actor, policy, cutoff, result);
    }

    await this.recordState(client, actor, policy, cutoff, result);
    await audit(client, actor, 'data_model.retention.ran', policy.sourceTable, null, {
      retentionDays: result.retentionDays,
      cutoff: cutoff.toISOString(),
      archived: result.archived,
      deleted: result.deleted,
      mode: policy.deleteAfterArchive ? 'archive-then-prune' : 'copy-only',
    });
    return result;
  }

  /**
   * Ordinary mutable log: archive a batch (idempotent) then DELETE exactly those
   * rows, looping until drained or the batch cap is hit. One CTE statement keeps
   * archive + delete on a single snapshot so no row is deleted un-archived.
   */
  private async archiveAndPrune(
    client: PoolClient,
    policy: RetentionPolicy,
    cutoff: Date,
    result: PolicyResult,
  ): Promise<void> {
    const cols = policy.columns.join(', ');
    const limit = batchSize();
    const sql = `
      WITH batch AS (
        SELECT id FROM ${policy.sourceTable}
         WHERE ${policy.timestampColumn} < $1
         ORDER BY ${policy.timestampColumn} ASC
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ),
      archived AS (
        INSERT INTO ${policy.archiveTable} (${cols})
        SELECT ${cols} FROM ${policy.sourceTable}
         WHERE id IN (SELECT id FROM batch)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      )
      DELETE FROM ${policy.sourceTable}
       WHERE id IN (SELECT id FROM batch)
      RETURNING id`;
    for (let i = 0; i < maxBatches(); i++) {
      const deleted = await client.query(sql, [cutoff]);
      const n = deleted.rowCount ?? 0;
      result.archived += n;
      result.deleted += n;
      if (n < limit) break;
    }
  }

  /**
   * Append-only / partitioned source (audit_log): copy forward only. A watermark
   * (data_model_retention_state.watermark) stops re-scanning already-archived
   * rows; ON CONFLICT keeps re-runs idempotent. Source rows are never deleted —
   * space reclaim is by partition drop at the ops layer (see migration 027).
   */
  private async archiveCopyOnly(
    client: PoolClient,
    actor: Actor,
    policy: RetentionPolicy,
    cutoff: Date,
    result: PolicyResult,
  ): Promise<void> {
    const watermark = await this.watermark(client, actor, policy);
    const cols = policy.columns.join(', ');
    const conflictKey = policy.sourceTable === 'audit_log' ? 'uuid' : 'id';
    const limit = batchSize();
    const sql = `
      INSERT INTO ${policy.archiveTable} (${cols})
      SELECT ${cols} FROM ${policy.sourceTable}
       WHERE ${policy.timestampColumn} < $1
         AND ($2::timestamptz IS NULL OR ${policy.timestampColumn} >= $2)
       ORDER BY ${policy.timestampColumn} ASC
       LIMIT ${limit}
      ON CONFLICT (${conflictKey}) DO NOTHING
      RETURNING ${policy.timestampColumn} AS ts`;
    let newest: Date | null = watermark;
    for (let i = 0; i < maxBatches(); i++) {
      const inserted = await client.query<{ ts: string }>(sql, [cutoff, newest]);
      const n = inserted.rowCount ?? 0;
      result.archived += n;
      for (const row of inserted.rows) {
        const ts = new Date(row.ts);
        if (!newest || ts > newest) newest = ts;
      }
      if (n < limit) break;
    }
    if (newest && (!watermark || newest > watermark)) {
      await client.query(
        `UPDATE data_model_retention_state SET watermark = $3, updated_at = now()
          WHERE tenant_id = $1 AND source_table = $2`,
        [actor.tenantId, policy.sourceTable, newest.toISOString()],
      );
    }
  }

  /** Reads the current archive watermark for a copy-only policy (NULL first run). */
  private async watermark(
    client: PoolClient,
    actor: Actor,
    policy: RetentionPolicy,
  ): Promise<Date | null> {
    const row = (
      await client.query<{ watermark: string | null }>(
        'SELECT watermark FROM data_model_retention_state WHERE tenant_id = $1 AND source_table = $2',
        [actor.tenantId, policy.sourceTable],
      )
    ).rows[0];
    return row?.watermark ? new Date(row.watermark) : null;
  }

  /** Upserts per-tenant per-source retention bookkeeping. */
  private recordState(
    client: PoolClient,
    actor: Actor,
    policy: RetentionPolicy,
    _cutoff: Date,
    result: PolicyResult,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO data_model_retention_state
         (tenant_id, source_table, last_run_at, last_archived, last_deleted,
          total_archived, total_deleted)
       VALUES ($1, $2, now(), $3::int, $4::int, $3::bigint, $4::bigint)
       ON CONFLICT (tenant_id, source_table) DO UPDATE SET
         last_run_at = now(),
         last_archived = EXCLUDED.last_archived,
         last_deleted = EXCLUDED.last_deleted,
         total_archived = data_model_retention_state.total_archived + EXCLUDED.last_archived,
         total_deleted = data_model_retention_state.total_deleted + EXCLUDED.last_deleted,
         updated_at = now()`,
      [actor.tenantId, policy.sourceTable, result.archived, result.deleted],
    );
  }

  /** Lists the retention bookkeeping rows for the caller's tenant. */
  async status(actor: Actor): Promise<Array<Record<string, unknown>>> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rows = (
        await client.query(
          `SELECT source_table, watermark, last_run_at, last_archived, last_deleted,
                  total_archived, total_deleted, updated_at
             FROM data_model_retention_state
            ORDER BY source_table`,
        )
      ).rows;
      return rows as Array<Record<string, unknown>>;
    });
  }
}
