import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Actor } from './data-model.common';
import { DataModelRetentionService } from './retention.service';

/**
 * Interval scheduler that drives {@link DataModelRetentionService} across all
 * enabled tenants. Mirrors the backup / report schedulers:
 *
 *   - Disabled under NODE_ENV=test and when DATA_MODEL_JOBS_ENABLED=false.
 *   - Per-tenant transaction advisory lock (inside the service) so multiple
 *     replicas never double-run a cycle.
 *   - Interval configurable via DATA_MODEL_RETENTION_INTERVAL_MS (default 6h);
 *     a first cycle runs shortly after boot.
 *
 * Failures are isolated per tenant and logged; one tenant's error never aborts
 * the sweep.
 */
@Injectable()
export class DataModelRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly retention: DataModelRetentionService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DATA_MODEL_JOBS_ENABLED === 'false') return;
    const interval = Number(process.env.DATA_MODEL_RETENTION_INTERVAL_MS ?? 6 * 3_600_000);
    this.timer = setInterval(() => void this.runCycle(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runCycle(), 45_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one retention cycle across every enabled tenant. */
  async runCycle(
    now: Date = new Date(),
  ): Promise<{ tenants: number; archived: number; deleted: number }> {
    if (this.running) return { tenants: 0, archived: 0, deleted: 0 };
    this.running = true;
    let archived = 0;
    let deleted = 0;
    let tenants = 0;
    try {
      const tenantRows = await this.database.query<{ id: string }>(
        'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
      );
      tenants = tenantRows.rows.length;
      for (const tenant of tenantRows.rows) {
        const actor: Actor = { tenantId: tenant.id, userId: 'data-model-retention' };
        try {
          const result = await this.retention.runForTenant(actor, now);
          for (const policy of result.policies) {
            archived += policy.archived;
            deleted += policy.deleted;
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'retention cycle failed for tenant',
              tenantId: tenant.id,
              error: String((error as Error).message ?? error),
            }),
          );
        }
      }
      return { tenants, archived, deleted };
    } finally {
      this.running = false;
    }
  }
}
