import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Client } from 'pg';
import { DatabaseService } from '../database/database.service';
import { isPermanentJobError, JobContext, JobHandlerRegistry } from './job-registry';
import { JobRow, JobsService } from './jobs.service';

/**
 * Advisory lock key unique to the job worker. Distinct from the migration
 * runner (7_244_101) and the backup scheduler (7_244_118). A session-level
 * `pg_try_advisory_lock` means only one replica drains the queue per cycle,
 * matching backup-dr.scheduler.ts and report-schedule.service.ts.
 *
 * Note the belt-and-braces: even without this lock the claim itself is safe
 * (`FOR UPDATE SKIP LOCKED`); the lock only stops N replicas from all paying
 * for a full tenant sweep at the same instant.
 */
const ADVISORY_LOCK_KEY = 7_244_131;

export interface JobCycleSummary {
  tenants: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  requeued: number;
}

const EMPTY_SUMMARY: JobCycleSummary = {
  tenants: 0,
  claimed: 0,
  succeeded: 0,
  retried: 0,
  deadLettered: 0,
  requeued: 0,
};

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  extra: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, context: 'JobWorker', message, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * The executor that makes `POST /jobs` honest.
 *
 * Before this existed, `api_jobs` rows were written and consumed by nothing: a
 * submitted job reported `queued` forever. This worker:
 *
 *   1. claims queued, due jobs one at a time per tenant with
 *      `SELECT ... FOR UPDATE SKIP LOCKED` (see JobsService.claimOn), so two
 *      workers racing the same queue never execute the same row;
 *   2. resolves the job type in {@link JobHandlerRegistry} — an unregistered
 *      type is dead-lettered on sight with a clear error instead of sitting in
 *      the queue, because a silent queue is the defect being fixed;
 *   3. runs the handler, heart-beating so a crash can be detected;
 *   4. on failure requeues with exponential backoff until `max_attempts`, then
 *      moves the job to the terminal `dead_letter` state;
 *   5. reaps `running` rows whose worker died (stale heartbeat).
 *
 * Disabled under NODE_ENV=test and when JOB_WORKER_ENABLED=false, like every
 * other scheduler in this codebase.
 */
@Injectable()
export class JobWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Identifies this worker in `api_jobs.claimed_by` for stuck-job forensics. */
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly database: DatabaseService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.JOB_WORKER_ENABLED === 'false') return;
    const interval = Number(process.env.JOB_WORKER_INTERVAL_MS ?? 5_000);
    this.timer = setInterval(() => void this.runCycle(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runCycle(), 10_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One drain cycle across every enabled tenant, guarded by the advisory lock.
   * Returns null when another replica owns the cycle or the database is not
   * configured — never a fabricated success.
   */
  async runCycle(): Promise<JobCycleSummary | null> {
    if (this.running) return null;
    this.running = true;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.running = false;
      return null;
    }
    const lock = new Client({ connectionString });
    try {
      await lock.connect();
      const acquired = await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ADVISORY_LOCK_KEY],
      );
      if (!acquired.rows[0]?.locked) return null;
      try {
        return await this.drainAllTenants();
      } finally {
        await lock
          .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
          .catch(() => undefined);
      }
    } catch (error) {
      log('error', 'job worker cycle failed', { error: String((error as Error).message ?? error) });
      return null;
    } finally {
      await lock.end().catch(() => undefined);
      this.running = false;
    }
  }

  /** Drains every enabled tenant; one tenant's failure never aborts the sweep. */
  async drainAllTenants(): Promise<JobCycleSummary> {
    const summary: JobCycleSummary = { ...EMPTY_SUMMARY };
    const tenantRows = await this.database.query<{ id: string }>(
      'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
    );
    summary.tenants = tenantRows.rows.length;
    for (const tenant of tenantRows.rows) {
      try {
        const tenantSummary = await this.drainTenant(tenant.id);
        summary.claimed += tenantSummary.claimed;
        summary.succeeded += tenantSummary.succeeded;
        summary.retried += tenantSummary.retried;
        summary.deadLettered += tenantSummary.deadLettered;
        summary.requeued += tenantSummary.requeued;
      } catch (error) {
        log('error', 'job drain failed for tenant', {
          tenantId: tenant.id,
          error: String((error as Error).message ?? error),
        });
      }
    }
    return summary;
  }

  /**
   * Claims and runs up to `JOB_WORKER_BATCH` jobs for one tenant, after reaping
   * any expired claims left by a crashed worker.
   */
  async drainTenant(tenantId: string): Promise<JobCycleSummary> {
    const summary: JobCycleSummary = { ...EMPTY_SUMMARY, tenants: 1 };
    const staleAfterMs = Number(process.env.JOB_CLAIM_TIMEOUT_MS ?? 600_000);
    const reaped = await this.jobs.reapStuck(tenantId, staleAfterMs).catch(() => null);
    if (reaped) {
      summary.requeued += reaped.requeued;
      summary.deadLettered += reaped.deadLettered;
    }

    const batch = Math.max(1, Number(process.env.JOB_WORKER_BATCH ?? 5));
    for (let index = 0; index < batch; index += 1) {
      const job = await this.jobs.claimNext(tenantId, this.workerId);
      if (!job) break;
      summary.claimed += 1;
      const outcome = await this.execute(tenantId, job);
      if (outcome === 'succeeded') summary.succeeded += 1;
      else if (outcome === 'retry') summary.retried += 1;
      else summary.deadLettered += 1;
    }
    return summary;
  }

  /**
   * Runs one claimed job to a terminal or retryable state. Never throws: every
   * path ends in an explicit database state, so a job can never be left
   * `running` because of an unhandled rejection here.
   */
  async execute(tenantId: string, job: JobRow): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    const registration = this.registry.get(job.type);
    if (!registration) {
      // Fail loudly and immediately. Retrying would not conjure a handler, so
      // this is permanent by construction.
      const message =
        `No executor is registered for job type "${job.type}", so this job can never run. ` +
        `Registered types: ${this.registry.types().join(', ') || '(none)'}.`;
      log('error', 'job has no registered handler', { jobId: job.id, type: job.type });
      await this.jobs.failAttempt(tenantId, job, message, { permanent: true });
      return 'dead_letter';
    }

    const heartbeat = setInterval(
      () => {
        void this.jobs.reportProgress(tenantId, job.id, job.progress ?? 0);
      },
      Number(process.env.JOB_HEARTBEAT_MS ?? 30_000),
    );
    heartbeat.unref?.();

    try {
      const context: JobContext = {
        jobId: job.id,
        type: job.type,
        actor: { tenantId, userId: job.requested_by },
        input: normaliseInput(job.input),
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        progress: (percent: number) => this.jobs.reportProgress(tenantId, job.id, percent),
      };
      const result = await registration.handler(context);
      const completed = await this.jobs.completeJob(tenantId, job.id, result);
      if (!completed) {
        // The row left `running` under us (cancelled). Report that honestly
        // rather than counting a success we did not record.
        log('warn', 'job finished but was no longer running (cancelled?)', { jobId: job.id });
        return 'retry';
      }
      return 'succeeded';
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const permanent = isPermanentJobError(error);
      const outcome = await this.jobs.failAttempt(tenantId, job, message, { permanent });
      log(outcome.outcome === 'retry' ? 'warn' : 'error', `job ${outcome.outcome}`, {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        retryInMs: outcome.retryInMs,
        error: message,
      });
      return outcome.outcome === 'retry' ? 'retry' : 'dead_letter';
    } finally {
      clearInterval(heartbeat);
    }
  }
}

/** `input` is jsonb; the driver may hand back an object, a string or null. */
function normaliseInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input))
    return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* fall through to {} */
    }
  }
  return {};
}
