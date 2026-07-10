import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Actor, BackupDrRepository, BackupScheduleRow } from './backup-dr.repository';
import { BackupDrService } from './backup-dr.service';

// Arbitrary lock key unique to the backup scheduler; distinct from the
// migration-runner lock (7_244_101). Ensures only one replica runs a cycle.
const ADVISORY_LOCK_KEY = 7_244_118;

/** Next run time for a schedule, from `interval_minutes` or a daily fallback. */
export function computeNextRun(schedule: BackupScheduleRow, from: Date = new Date()): Date {
  if (schedule.interval_minutes && schedule.interval_minutes > 0)
    return new Date(from.getTime() + schedule.interval_minutes * 60_000);
  // Cron expressions are stored but not parsed here; fall back to daily so a
  // cron-only schedule still advances honestly rather than looping every cycle.
  return new Date(from.getTime() + 86_400_000);
}

/**
 * Interval scheduler for backups + retention. Guarded by a PostgreSQL
 * session-level advisory lock so multiple backend replicas never double-run a
 * cycle. Disabled under NODE_ENV=test and when BACKUP_SCHEDULER_ENABLED=false.
 */
@Injectable()
export class BackupDrScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: BackupDrRepository,
    private readonly service: BackupDrService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.BACKUP_SCHEDULER_ENABLED === 'false') return;
    const interval = Number(process.env.BACKUP_SCHEDULER_INTERVAL_MS ?? 3_600_000);
    this.timer = setInterval(() => void this.runCycle(), interval);
    this.timer.unref?.();
    // Run a first cycle shortly after boot rather than waiting a full interval.
    setTimeout(() => void this.runCycle(), 30_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Runs one scheduler cycle across all tenants: executes due schedules, then
   * applies retention. Skips entirely if another replica holds the lock.
   */
  async runCycle(now: Date = new Date()): Promise<{ ran: number; tenants: number } | null> {
    if (this.running) return null;
    this.running = true;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.running = false;
      return null;
    }
    const lock = new Client({ connectionString });
    let ran = 0;
    let tenants = 0;
    try {
      await lock.connect();
      const acquired = await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ADVISORY_LOCK_KEY],
      );
      if (!acquired.rows[0]?.locked) return null; // another replica owns this cycle
      try {
        const tenantRows = await this.database.query<{ id: string }>(
          'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
        );
        tenants = tenantRows.rows.length;
        for (const tenant of tenantRows.rows) {
          const actor: Actor = { tenantId: tenant.id, userId: 'backup-scheduler' };
          ran += await this.runTenant(actor, now).catch((error) => {
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'backup scheduler tenant cycle failed',
                tenantId: tenant.id,
                error: String((error as Error).message ?? error),
              }),
            );
            return 0;
          });
        }
      } finally {
        await lock
          .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
          .catch(() => undefined);
      }
      return { ran, tenants };
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'backup scheduler cycle failed',
          error: String((error as Error).message ?? error),
        }),
      );
      return null;
    } finally {
      await lock.end().catch(() => undefined);
      this.running = false;
    }
  }

  /** Runs due schedules for one tenant and applies retention. */
  async runTenant(actor: Actor, now: Date): Promise<number> {
    const due = await this.repository.dueSchedules(actor, now);
    let ran = 0;
    for (const schedule of due) {
      await this.service
        .createBackup(actor, {
          kind: schedule.kind,
          retentionClass: schedule.retention_class,
          label: `${schedule.name}-${now.toISOString().replace(/[:.]/g, '-')}`,
        })
        .then(() => (ran += 1))
        .catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'scheduled backup failed',
              scheduleId: schedule.id,
              error: String((error as Error).message ?? error),
            }),
          );
        });
      await this.repository.markScheduleRan(actor, schedule.id, now, computeNextRun(schedule, now));
    }
    await this.service.applyRetention(actor, now).catch(() => undefined);
    return ran;
  }
}
