import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface CreateBulkSendInput {
  name: string;
  smscId: string;
  message: string;
  recipients: string[];
}

export interface GridPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// Hard upper bound on recipients per job (a single message body fanned out).
export const BULK_SEND_MAX_RECIPIENTS = 5000;
// Namespace for the per-job transaction-level advisory lock (arbitrary).
const BULK_SEND_LOCK_NAMESPACE = 0x2c3d;

const JOB_COLUMNS =
  'id,name,smsc_id,status,total,submitted,failed,detail,created_by,created_at,completed_at';
const RECIPIENT_COLUMNS = 'id,job_id,receiver,text,status,foreign_id,error,created_at';

/**
 * Bulk send / campaign jobs. A tenant queues one message body to many
 * recipients through one of its own SMSCs. Jobs are persisted tenant-scoped
 * (migration 023, RLS enforced) and drained by a background processor that
 * submits each recipient through {@link KamexSqlboxRepository.submit} and
 * records per-recipient outcome.
 *
 * The processor is advisory-locked per job (transaction-level) so overlapping
 * ticks or multiple replicas never double-submit. It is disabled under test
 * (NODE_ENV=test) and when BULK_SEND_RUNNER_ENABLED=false. Small batches are
 * additionally kicked immediately after creation for low latency.
 */
@Injectable()
export class BulkSendService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.BULK_SEND_RUNNER_ENABLED === 'false') return;
    const interval = Number(process.env.BULK_SEND_RUNNER_INTERVAL_MS ?? 30_000);
    this.timer = setInterval(() => void this.runPending(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runPending(), 15_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private tenantSmscScope(client: PoolClient): Promise<string[]> {
    return client
      .query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      .then((r) => r.rows.map((row) => row.engine_id));
  }

  /** Validates input, bounds the recipient list, and persists a queued job. */
  async createJob(actor: Actor, input: CreateBulkSendInput) {
    const recipients = input.recipients;
    if (!recipients.length) throw new BadRequestException('recipients must be a non-empty array');
    if (recipients.length > BULK_SEND_MAX_RECIPIENTS)
      throw new BadRequestException(
        `recipients exceeds the maximum of ${BULK_SEND_MAX_RECIPIENTS} per job`,
      );

    const job = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const allowed = await this.tenantSmscScope(client);
      if (!allowed.includes(input.smscId))
        throw new BadRequestException('smscId must reference one of your tenant’s SMSCs');
      const created = (
        await client.query(
          `INSERT INTO bulk_send_jobs(tenant_id,name,smsc_id,status,total,created_by)
           VALUES($1,$2,$3,'queued',$4,$5) RETURNING ${JOB_COLUMNS}`,
          [actor.tenantId, input.name, input.smscId, recipients.length, actor.userId],
        )
      ).rows[0];
      // Bulk insert recipients via UNNEST so one round-trip handles the batch.
      await client.query(
        `INSERT INTO bulk_send_recipients(tenant_id,job_id,receiver,text)
         SELECT $1,$2,r,$3 FROM unnest($4::text[]) AS r`,
        [actor.tenantId, created.id, input.message, recipients],
      );
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'bulk_send.created',
          'bulk_send_job',
          created.id,
          JSON.stringify({ name: input.name, smscId: input.smscId, total: recipients.length }),
        ],
      );
      return created;
    });

    // Low-latency kick for small batches outside of test/disabled runs.
    if (
      process.env.NODE_ENV !== 'test' &&
      process.env.BULK_SEND_RUNNER_ENABLED !== 'false' &&
      job.total <= Number(process.env.BULK_SEND_INLINE_MAX ?? 100)
    ) {
      setImmediate(() => void this.processJob(actor.tenantId, job.id).catch(() => undefined));
    }
    return job;
  }

  listJobs(actor: Actor, query: Record<string, unknown> = {}): Promise<GridPage<any>> {
    const { limit, offset } = pageArgs(query);
    const status = typeof query.status === 'string' ? query.status : undefined;
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${JOB_COLUMNS}, count(*) OVER() AS __total FROM bulk_send_jobs
          WHERE ($1::text IS NULL OR status=$1)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status ?? null, limit, offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row);
      return { items, total, limit, offset };
    });
  }

  async getJob(actor: Actor, id: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const job = (
        await client.query(`SELECT ${JOB_COLUMNS} FROM bulk_send_jobs WHERE id=$1`, [id])
      ).rows[0];
      if (!job) throw new NotFoundException('Bulk send job not found');
      const counts = (
        await client.query<{ status: string; count: string }>(
          'SELECT status, count(*)::text AS count FROM bulk_send_recipients WHERE job_id=$1 GROUP BY status',
          [id],
        )
      ).rows;
      const recipients = (
        await client.query(
          `SELECT ${RECIPIENT_COLUMNS} FROM bulk_send_recipients WHERE job_id=$1 ORDER BY created_at LIMIT 50`,
          [id],
        )
      ).rows;
      const byStatus = counts.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = Number(row.count);
        return acc;
      }, {});
      return { ...job, recipientCounts: byStatus, recipientsPreview: recipients };
    });
  }

  listRecipients(
    actor: Actor,
    jobId: string,
    query: Record<string, unknown> = {},
  ): Promise<GridPage<any>> {
    const { limit, offset } = pageArgs(query);
    const status = typeof query.status === 'string' ? query.status : undefined;
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const exists = (await client.query('SELECT 1 FROM bulk_send_jobs WHERE id=$1', [jobId]))
        .rows[0];
      if (!exists) throw new NotFoundException('Bulk send job not found');
      const result = await client.query(
        `SELECT ${RECIPIENT_COLUMNS}, count(*) OVER() AS __total FROM bulk_send_recipients
          WHERE job_id=$1 AND ($2::text IS NULL OR status=$2)
          ORDER BY created_at LIMIT $3 OFFSET $4`,
        [jobId, status ?? null, limit, offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row);
      return { items, total, limit, offset };
    });
  }

  /** Drains queued jobs across every enabled tenant. */
  async runPending(): Promise<Array<{ tenantId: string; jobId: string; submitted: number }>> {
    if (this.running) return [];
    this.running = true;
    try {
      const tenants = await this.database.query<{ id: string }>(
        'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
      );
      const results: Array<{ tenantId: string; jobId: string; submitted: number }> = [];
      for (const tenant of tenants.rows) {
        const jobs = await this.database
          .tenantTransaction(tenant.id, async (client) =>
            (
              await client.query<{ id: string }>(
                "SELECT id FROM bulk_send_jobs WHERE status='queued' ORDER BY created_at LIMIT 20",
              )
            ).rows.map((row) => row.id),
          )
          .catch(() => [] as string[]);
        for (const jobId of jobs) {
          const outcome = await this.processJob(tenant.id, jobId).catch((error) => {
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'bulk send job failed',
                tenantId: tenant.id,
                jobId,
                error: String((error as Error).message ?? error),
              }),
            );
            return { submitted: 0 };
          });
          results.push({ tenantId: tenant.id, jobId, submitted: outcome.submitted });
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /**
   * Processes a single queued job: claims it under an advisory lock, submits
   * every pending recipient through the engine, and finalises the job status.
   * If SQLBox is unavailable, the job is recorded as an honest failure with all
   * recipients marked failed.
   */
  async processJob(
    tenantId: string,
    jobId: string,
  ): Promise<{ submitted: number; failed: number; status: string }> {
    const claim = await this.database.tenantTransaction(tenantId, async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [BULK_SEND_LOCK_NAMESPACE, hashId(jobId)],
      );
      if (!lock.rows[0]?.locked) return null;
      const job = (
        await client.query<{ id: string; smsc_id: string }>(
          "UPDATE bulk_send_jobs SET status='running' WHERE id=$1 AND status='queued' RETURNING id,smsc_id",
          [jobId],
        )
      ).rows[0];
      if (!job) return null;
      const recipients = (
        await client.query<{ id: string; receiver: string; text: string }>(
          "SELECT id,receiver,text FROM bulk_send_recipients WHERE job_id=$1 AND status='pending' ORDER BY created_at",
          [jobId],
        )
      ).rows;
      return { smscId: job.smsc_id, recipients };
    });
    if (!claim) return { submitted: 0, failed: 0, status: 'skipped' };

    const probe = await this.sqlbox.probe();
    if (!probe.available) {
      return this.finalise(
        tenantId,
        jobId,
        claim.recipients.map((r) => ({
          id: r.id,
          ok: false,
          error: `SQLBox unavailable: ${probe.evidence}`,
        })),
      );
    }

    const outcomes: Array<{ id: string; ok: boolean; foreignId?: string; error?: string }> = [];
    for (const recipient of claim.recipients) {
      try {
        const queued = await this.sqlbox.submit({
          sender: '',
          receiver: recipient.receiver,
          text: recipient.text,
          smscId: claim.smscId,
        });
        outcomes.push({ id: recipient.id, ok: true, foreignId: queued.sqlId });
      } catch (error) {
        outcomes.push({ id: recipient.id, ok: false, error: String((error as Error).message) });
      }
    }
    return this.finalise(tenantId, jobId, outcomes);
  }

  /** Persists per-recipient outcomes and the final job status. */
  private async finalise(
    tenantId: string,
    jobId: string,
    outcomes: Array<{ id: string; ok: boolean; foreignId?: string; error?: string }>,
  ): Promise<{ submitted: number; failed: number; status: string }> {
    const submitted = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - submitted;
    const status = failed === 0 ? 'completed' : submitted === 0 ? 'failed' : 'partial';
    await this.database.tenantTransaction(tenantId, async (client) => {
      for (const outcome of outcomes) {
        await client.query(
          'UPDATE bulk_send_recipients SET status=$2, foreign_id=$3, error=$4 WHERE id=$1',
          [
            outcome.id,
            outcome.ok ? 'submitted' : 'failed',
            outcome.foreignId ?? null,
            outcome.error ?? null,
          ],
        );
      }
      await client.query(
        `UPDATE bulk_send_jobs
            SET status=$2,
                submitted=submitted+$3,
                failed=failed+$4,
                detail=$5,
                completed_at=now()
          WHERE id=$1`,
        [
          jobId,
          status,
          submitted,
          failed,
          failed ? `${failed} recipient(s) failed to submit` : null,
        ],
      );
    });
    return { submitted, failed, status };
  }
}

/** Bounds pagination arguments for the grid endpoints. */
function pageArgs(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

/** Stable non-negative 31-bit hash of a uuid for the advisory lock key. */
function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 2147483647;
  return hash;
}
