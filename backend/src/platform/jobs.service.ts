import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { backoffMs, JobHandlerRegistry, JOB_TYPE_PATTERN } from './job-registry';
import { GridDefinition } from './list-query';
import { runGrid } from './grid-runner';

export interface JobActor {
  tenantId: string;
  userId: string;
}
export interface CreateJobInput {
  type: string;
  input?: unknown;
  idempotencyKey?: string;
}

/** A row of `api_jobs` as extended by migration 034. */
export interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  input: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
  requested_by: string;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  heartbeat_at: string | null;
  dead_lettered_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Grid whitelist for GET /jobs (shared cursor + ?fields= support). */
export const JOBS_GRID = {
  searchColumns: ['type', 'error', 'last_error', 'requested_by'],
  sortColumns: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    status: 'status',
    type: 'type',
    attempts: 'attempts',
    nextAttemptAt: 'next_attempt_at',
    completedAt: 'completed_at',
  },
  filterColumns: {
    status: 'status',
    type: 'type',
    requestedBy: 'requested_by',
  },
  defaultOrderBy: 'created_at DESC',
  maxLimit: 500,
  defaultLimit: 50,
} satisfies GridDefinition;

const JOB_COLUMNS =
  'id,type,status,progress,input,result,error,requested_by,idempotency_key,attempts,max_attempts,' +
  'next_attempt_at,last_error,claimed_at,claimed_by,heartbeat_at,dead_lettered_at,started_at,' +
  'completed_at,created_at,updated_at';

/**
 * Durable job queue over `api_jobs`.
 *
 * Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED` inside the tenant
 * transaction, so N workers racing for the same queue each get a distinct row
 * and no row is ever executed twice concurrently. Failure moves a job back to
 * `queued` with an exponential `next_attempt_at`, until `max_attempts` is
 * reached, at which point it becomes terminal `dead_letter` — visible, never
 * silently retried forever, and never reported as success.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: JobHandlerRegistry,
  ) {}

  // ---- submission ---------------------------------------------------------
  async create(actor: JobActor, value: CreateJobInput) {
    if (typeof value?.type !== 'string' || !JOB_TYPE_PATTERN.test(value.type))
      throw new BadRequestException('type must be a lowercase job type identifier');
    if (
      value.idempotencyKey &&
      (value.idempotencyKey.length < 8 || value.idempotencyKey.length > 128)
    )
      throw new BadRequestException('Idempotency-Key must be between 8 and 128 characters');
    // Fail loudly and immediately for a type nothing can execute. Accepting it
    // would recreate the defect this queue exists to fix: a job that reports
    // `queued` forever because no worker knows what to do with it.
    const registration = this.registry.require(value.type);
    if (value.input !== undefined && value.input !== null && typeof value.input !== 'object')
      throw new BadRequestException('input must be an object');

    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      if (value.idempotencyKey) {
        const existing = (
          await client.query<JobRow>(
            `SELECT ${JOB_COLUMNS} FROM api_jobs WHERE type=$1 AND idempotency_key=$2`,
            [value.type, value.idempotencyKey],
          )
        ).rows[0];
        if (existing) return { ...existing, replayed: true };
      }
      return (
        await client.query<JobRow>(
          `INSERT INTO api_jobs(tenant_id,type,input,requested_by,idempotency_key,max_attempts,next_attempt_at)
           VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING ${JOB_COLUMNS}`,
          [
            actor.tenantId,
            value.type,
            JSON.stringify(value.input ?? {}),
            actor.userId,
            value.idempotencyKey ?? null,
            registration.maxAttempts,
          ],
        )
      ).rows[0];
    });
  }

  // ---- reads --------------------------------------------------------------
  /**
   * Grid read with the shared runner: offset pagination by default, opt-in
   * keyset pagination via ?cursor=/?paginate=cursor, and ?fields= projection.
   * The legacy positional (status, type) arguments are still honoured.
   */
  list(actor: JobActor, query: Record<string, unknown> = {}) {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<JobRow>(
        { select: `SELECT ${JOB_COLUMNS}`, from: 'FROM api_jobs' },
        JOBS_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'DESC' } },
      ),
    );
  }

  async get(actor: JobActor, id: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM api_jobs WHERE id=$1`, [id])
      ).rows[0];
      if (!row) throw new NotFoundException('Job not found');
      return row;
    });
  }

  /** Registered job types, so a caller can discover what POST /jobs accepts. */
  types() {
    return this.registry.describe();
  }

  async cancel(actor: JobActor, id: string, reason?: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<JobRow>(
          `UPDATE api_jobs SET status='cancelled',progress=100,error=$2,last_error=$2,
                  completed_at=now(),updated_at=now(),claimed_by=NULL,heartbeat_at=NULL
             WHERE id=$1 AND status IN ('queued','running') RETURNING ${JOB_COLUMNS}`,
          [id, reason ?? 'Cancelled by operator'],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Cancellable job not found');
      return row;
    });
  }

  // ---- worker-side queue operations ---------------------------------------
  /**
   * Atomically claims the oldest due job for one tenant. `FOR UPDATE SKIP
   * LOCKED` on the inner SELECT means concurrent workers never contend for the
   * same row: the loser skips it and takes the next one (or gets nothing).
   * Increments `attempts` as part of the claim, so a worker that dies mid-job
   * cannot replay the attempt for free.
   */
  claimNext(tenantId: string, workerId: string): Promise<JobRow | undefined> {
    return this.database.tenantTransaction(tenantId, async (client) =>
      this.claimOn(client, workerId),
    );
  }

  /** Claim body, exposed so a caller can reuse an open tenant transaction. */
  async claimOn(client: PoolClient, workerId: string): Promise<JobRow | undefined> {
    return (
      await client.query<JobRow>(
        `UPDATE api_jobs
            SET status='running',
                attempts=attempts+1,
                claimed_at=now(),
                claimed_by=$1,
                heartbeat_at=now(),
                started_at=COALESCE(started_at, now()),
                updated_at=now()
          WHERE id = (
            SELECT id FROM api_jobs
             WHERE status='queued' AND next_attempt_at <= now()
             ORDER BY next_attempt_at ASC, created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING ${JOB_COLUMNS}`,
        [workerId],
      )
    ).rows[0];
  }

  /** Records progress on a running job; never throws (best effort). */
  async reportProgress(tenantId: string, id: string, percent: number): Promise<void> {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    await this.database
      .tenantTransaction(tenantId, (client) =>
        client.query(
          "UPDATE api_jobs SET progress=$2,heartbeat_at=now(),updated_at=now() WHERE id=$1 AND status='running'",
          [id, bounded],
        ),
      )
      .catch(() => undefined);
  }

  /**
   * Marks a claimed job succeeded. Returns undefined when the row is no longer
   * `running` (for example the operator cancelled it mid-flight) — the caller
   * must not treat that as a completed job.
   */
  async completeJob(tenantId: string, id: string, result: unknown): Promise<JobRow | undefined> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      return (
        await client.query<JobRow>(
          `UPDATE api_jobs
              SET status='succeeded',progress=100,result=$2,error=NULL,
                  completed_at=now(),updated_at=now(),claimed_by=NULL,heartbeat_at=NULL
            WHERE id=$1 AND status='running' RETURNING ${JOB_COLUMNS}`,
          [id, JSON.stringify(result ?? {})],
        )
      ).rows[0];
    });
  }

  /**
   * Records a failed attempt. Requeues with exponential backoff while attempts
   * remain; otherwise moves the job to the terminal `dead_letter` state so the
   * failure is visible in the grid instead of being retried indefinitely.
   * `permanent` skips the remaining attempts (bad input can never succeed).
   */
  async failAttempt(
    tenantId: string,
    job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>,
    message: string,
    options: { permanent?: boolean } = {},
  ): Promise<{ outcome: 'retry' | 'dead_letter'; retryInMs: number; row?: JobRow }> {
    const text = message.slice(0, 4000);
    const exhausted = options.permanent === true || job.attempts >= job.max_attempts;
    if (exhausted) {
      const row = await this.database.tenantTransaction(
        tenantId,
        async (client) =>
          (
            await client.query<JobRow>(
              `UPDATE api_jobs
                SET status='dead_letter',error=$2,last_error=$2,dead_lettered_at=now(),
                    completed_at=now(),updated_at=now(),claimed_by=NULL,heartbeat_at=NULL
              WHERE id=$1 AND status='running' RETURNING ${JOB_COLUMNS}`,
              [job.id, text],
            )
          ).rows[0],
      );
      return { outcome: 'dead_letter', retryInMs: 0, row };
    }
    const retryInMs = backoffMs(job.attempts);
    const row = await this.database.tenantTransaction(
      tenantId,
      async (client) =>
        (
          await client.query<JobRow>(
            `UPDATE api_jobs
              SET status='queued',last_error=$2,
                  next_attempt_at=now() + make_interval(secs => $3::double precision),
                  claimed_at=NULL,claimed_by=NULL,heartbeat_at=NULL,updated_at=now()
            WHERE id=$1 AND status='running' RETURNING ${JOB_COLUMNS}`,
            [job.id, text, retryInMs / 1000],
          )
        ).rows[0],
    );
    return { outcome: 'retry', retryInMs, row };
  }

  /**
   * Recovers jobs whose worker died: a `running` row whose heartbeat is older
   * than `staleAfterMs` is requeued (or dead-lettered if it has no attempts
   * left). Without this a crash would pin a job in `running` forever, which is
   * the same silent stall in a different costume.
   */
  async reapStuck(
    tenantId: string,
    staleAfterMs: number,
  ): Promise<{ requeued: number; deadLettered: number }> {
    const seconds = Math.max(1, Math.round(staleAfterMs / 1000));
    return this.database.tenantTransaction(tenantId, async (client) => {
      const dead = await client.query(
        `UPDATE api_jobs
            SET status='dead_letter',
                error=COALESCE(last_error,'') || ' Worker claim expired with no attempts remaining.',
                last_error='Worker claim expired with no attempts remaining.',
                dead_lettered_at=now(),completed_at=now(),updated_at=now(),
                claimed_by=NULL,heartbeat_at=NULL
          WHERE status='running'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at < now() - make_interval(secs => $1::double precision)
            AND attempts >= max_attempts
          RETURNING id`,
        [seconds],
      );
      const requeued = await client.query(
        `UPDATE api_jobs
            SET status='queued',
                last_error='Worker claim expired; job requeued for another worker.',
                next_attempt_at=now(),claimed_at=NULL,claimed_by=NULL,heartbeat_at=NULL,
                updated_at=now()
          WHERE status='running'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at < now() - make_interval(secs => $1::double precision)
            AND attempts < max_attempts
          RETURNING id`,
        [seconds],
      );
      return { requeued: requeued.rows.length, deadLettered: dead.rows.length };
    });
  }
}
