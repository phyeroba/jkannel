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
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { MessageSendService } from './message-send.service';
import { MessageSchedule, describeSchedule } from './message-scheduling';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface CreateBulkSendInput {
  name: string;
  /**
   * Engine-level bind to pin the campaign to. OPTIONAL: omit it and the routing
   * engine chooses per recipient at dispatch time (so a campaign follows route
   * configuration and fails over instead of being nailed to one carrier).
   */
  smscId?: string | null;
  message: string;
  recipients: string[];
  /** Sender ID for every message; defaults to {@link defaultBulkSender}. */
  sender?: string | null;
  /** Customer the campaign is attributed to and entitlement-checked against. */
  customerId?: string | null;
  /**
   * Campaign-level deferred delivery + expiry, already validated by
   * {@link parseMessageSchedule}. EVERY recipient inherits it: the offset is
   * recomputed per recipient at the instant its `send_sms` row is inserted, so
   * a campaign that takes ten minutes to drain still targets the one instant
   * the operator picked rather than drifting with the dispatch.
   */
  schedule?: MessageSchedule | null;
}

/**
 * Campaign sender ID when the caller supplies none. Bulk send previously
 * hard-coded `sender: ''`, so every campaign message went out with an empty
 * sender ID; an alphanumeric default is at least deliverable and is overridable
 * per job and per deployment.
 */
export function defaultBulkSender(): string {
  const configured = (process.env.BULK_SEND_DEFAULT_SENDER ?? '').trim();
  return configured || 'JKANNEL';
}

/**
 * @deprecated Both grids now return {@link GridResult} from the shared grid
 * runner, which carries `nextCursor`/`pagination` as well. Kept because it is
 * an exported type other modules may still reference.
 */
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
  'id,name,smsc_id,sender,customer_id::text,status,total,submitted,failed,detail,scheduled_at,validity_minutes,created_by,created_at,completed_at';
const RECIPIENT_COLUMNS = 'id,job_id,receiver,text,status,foreign_id,error,created_at';

/**
 * Job statuses the runner will pick up. `scheduled` is a queued job whose
 * campaign carries a future `scheduled_at`; it dispatches on the SAME tick as a
 * plain queued job (the deferral lives on the engine row, not in a JKANNEL
 * timer) and exists so the grid can show and filter "this campaign was
 * submitted for later" rather than presenting it as an ordinary send.
 */
const DISPATCHABLE_STATUSES = ['queued', 'scheduled'];

/**
 * The jobs grid. Cursor pagination is opted into here specifically: a campaign
 * list is one of the two tables in this module that grows without bound, and a
 * deep `OFFSET` over it degrades into a scan-and-discard. Served by
 * `bulk_send_jobs (tenant_id, created_at DESC, id)` from migration 040.
 */
export const BULK_JOB_GRID: GridDefinition = {
  searchColumns: ['name', 'smsc_id', 'sender', 'detail'],
  sortColumns: {
    createdAt: 'created_at',
    created_at: 'created_at',
    completedAt: 'completed_at',
    scheduledAt: 'scheduled_at',
    name: 'name',
    status: 'status',
    total: 'total',
    submitted: 'submitted',
    failed: 'failed',
    smscId: 'smsc_id',
    sender: 'sender',
  },
  filterColumns: {
    status: 'status',
    smscId: 'smsc_id',
    smsc_id: 'smsc_id',
    sender: 'sender',
    customerId: 'customer_id',
    name: 'name',
  },
  defaultOrderBy: 'created_at DESC',
  defaultLimit: 50,
  maxLimit: 200,
};

/**
 * The recipients grid. Same reasoning as {@link BULK_JOB_GRID}, more acutely: a
 * single campaign holds up to {@link BULK_SEND_MAX_RECIPIENTS} rows and a
 * tenant accumulates them forever. Served by
 * `bulk_send_recipients (tenant_id, job_id, created_at, id)`.
 */
export const BULK_RECIPIENT_GRID: GridDefinition = {
  searchColumns: ['receiver', 'foreign_id', 'error'],
  sortColumns: {
    createdAt: 'created_at',
    created_at: 'created_at',
    receiver: 'receiver',
    status: 'status',
    foreignId: 'foreign_id',
  },
  filterColumns: {
    status: 'status',
    receiver: 'receiver',
    foreignId: 'foreign_id',
    foreign_id: 'foreign_id',
  },
  defaultOrderBy: 'created_at ASC, id ASC',
  defaultLimit: 50,
  maxLimit: 500,
};

/** CSV column order for the jobs export. */
const JOB_EXPORT_COLUMNS = [
  'id',
  'name',
  'status',
  'smsc_id',
  'sender',
  'customer_id',
  'total',
  'submitted',
  'failed',
  'scheduled_at',
  'validity_minutes',
  'detail',
  'created_by',
  'created_at',
  'completed_at',
] as const;

/** CSV column order for the recipients export. */
const RECIPIENT_EXPORT_COLUMNS = [
  'id',
  'job_id',
  'receiver',
  'status',
  'foreign_id',
  'error',
  'created_at',
  'text',
] as const;

/**
 * A bare `?status=` is accepted as shorthand for `?filter.status=`, because
 * that is what both grids took before they adopted the shared mechanism and a
 * saved console link should not stop working.
 */
function withLegacyStatus(query: Record<string, unknown>): Record<string, unknown> {
  if (typeof query.status !== 'string' || !query.status.trim()) return query;
  if (query['filter.status'] !== undefined) return query;
  return { ...query, 'filter.status': query.status };
}

function csv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return '""';
    if (value instanceof Date) return `"${value.toISOString()}"`;
    return `"${String(value).replace(/"/g, '""')}"`;
  };
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\r\n');
}

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
    private readonly send: MessageSendService,
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

    const smscId = input.smscId?.trim() || null;
    const sender = input.sender?.trim() || defaultBulkSender();
    const schedule = input.schedule ?? null;
    const scheduledAt = schedule?.scheduledAtMs != null ? new Date(schedule.scheduledAtMs) : null;
    // 'scheduled' is descriptive, not a gate: the runner dispatches it on the
    // next tick exactly like 'queued', and the wait lives on each recipient's
    // engine row. Distinguishing it in the grid is the point.
    const status = scheduledAt && scheduledAt.getTime() > Date.now() ? 'scheduled' : 'queued';

    const job = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      // A pinned bind must belong to the tenant; an unpinned job is resolved by
      // the routing engine per recipient when the job runs.
      if (smscId) {
        const allowed = await this.tenantSmscScope(client);
        if (!allowed.includes(smscId))
          throw new BadRequestException('smscId must reference one of your tenant’s SMSCs');
      }
      if (input.customerId) {
        const found = (
          await client.query('SELECT 1 FROM customers WHERE id=$1', [input.customerId])
        ).rows[0];
        if (!found) throw new NotFoundException('Customer not found');
      }
      const created = (
        await client.query(
          `INSERT INTO bulk_send_jobs(tenant_id,name,smsc_id,sender,customer_id,status,total,created_by,scheduled_at,validity_minutes)
           VALUES($1,$2,$3,$4,$5,$8,$6,$7,$9,$10) RETURNING ${JOB_COLUMNS}`,
          [
            actor.tenantId,
            input.name,
            smscId,
            sender,
            input.customerId ?? null,
            recipients.length,
            actor.userId,
            status,
            scheduledAt,
            schedule?.validityMinutes ?? null,
          ],
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
          JSON.stringify({
            name: input.name,
            smscId,
            sender,
            customerId: input.customerId ?? null,
            total: recipients.length,
            status,
            schedule: schedule ? (describeSchedule(schedule) ?? null) : null,
          }),
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

  /**
   * Campaign grid: search, sort, `filter.<field>`, `?fields=` projection, and
   * BOTH pagination modes — offset by default for compatibility, keyset when
   * the caller passes `?cursor=` or `?paginate=cursor`.
   *
   * Tenant isolation is RLS, not a predicate: every statement runs inside
   * `tenantTransaction`, which sets `app.tenant_id`, and `bulk_send_jobs` has
   * FORCE ROW LEVEL SECURITY. That is also why the migration-040 indexes lead
   * with `tenant_id` — the RLS predicate is on every plan whether or not the
   * SQL here mentions it.
   */
  listJobs(actor: Actor, query: Record<string, unknown> = {}): Promise<GridResult<any>> {
    const raw = withLegacyStatus(query);
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<any>(
        { select: `SELECT ${JOB_COLUMNS}`, from: 'FROM bulk_send_jobs' },
        BULK_JOB_GRID,
        raw,
        (sql, params) => client.query(sql, params as any[]).then((r) => r.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'DESC' } },
      ),
    );
  }

  /** CSV of the campaigns the grid would show for the SAME query. */
  async exportJobsCsv(actor: Actor, query: Record<string, unknown> = {}) {
    const page = await this.listJobs(actor, {
      ...query,
      limit: query.limit ?? BULK_JOB_GRID.maxLimit,
      // A cursor page is a slice of a scroll, not an export; an export always
      // takes the top of the filtered set so the file is reproducible.
      cursor: undefined,
      paginate: undefined,
      fields: undefined,
    });
    return {
      filename: `jkannel-bulk-send-jobs-${new Date().toISOString().slice(0, 10)}.csv`,
      rowCount: page.items.length,
      content: csv(page.items as Array<Record<string, unknown>>, JOB_EXPORT_COLUMNS),
    };
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

  /** Recipient grid for one campaign. Same mechanism as {@link listJobs}. */
  listRecipients(
    actor: Actor,
    jobId: string,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<any>> {
    const raw = withLegacyStatus(query);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const exists = (await client.query('SELECT 1 FROM bulk_send_jobs WHERE id=$1', [jobId]))
        .rows[0];
      if (!exists) throw new NotFoundException('Bulk send job not found');
      return runGrid<any>(
        {
          select: `SELECT ${RECIPIENT_COLUMNS}`,
          from: 'FROM bulk_send_recipients',
          where: 'WHERE job_id=$1',
          params: [jobId],
        },
        BULK_RECIPIENT_GRID,
        raw,
        (sql, params) => client.query(sql, params as any[]).then((r) => r.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'ASC' } },
      );
    });
  }

  /** CSV of the recipients the grid would show for the SAME query. */
  async exportRecipientsCsv(actor: Actor, jobId: string, query: Record<string, unknown> = {}) {
    const page = await this.listRecipients(actor, jobId, {
      ...query,
      limit: query.limit ?? BULK_RECIPIENT_GRID.maxLimit,
      cursor: undefined,
      paginate: undefined,
      fields: undefined,
    });
    return {
      filename: `jkannel-bulk-send-${jobId}-recipients-${new Date().toISOString().slice(0, 10)}.csv`,
      rowCount: page.items.length,
      content: csv(page.items as Array<Record<string, unknown>>, RECIPIENT_EXPORT_COLUMNS),
    };
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
                'SELECT id FROM bulk_send_jobs WHERE status = ANY($1) ORDER BY created_at LIMIT 20',
                [DISPATCHABLE_STATUSES],
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
        await client.query<{
          id: string;
          smsc_id: string | null;
          sender: string | null;
          customer_id: string | null;
          created_by: string | null;
          scheduled_at: Date | string | null;
          validity_minutes: number | string | null;
        }>(
          "UPDATE bulk_send_jobs SET status='running' WHERE id=$1 AND status = ANY($2) RETURNING id,smsc_id,sender,customer_id::text,created_by,scheduled_at,validity_minutes",
          [jobId, DISPATCHABLE_STATUSES],
        )
      ).rows[0];
      if (!job) return null;
      const recipients = (
        await client.query<{ id: string; receiver: string; text: string }>(
          "SELECT id,receiver,text FROM bulk_send_recipients WHERE job_id=$1 AND status='pending' ORDER BY created_at",
          [jobId],
        )
      ).rows;
      const scheduledAtMs = job.scheduled_at ? new Date(job.scheduled_at).getTime() : null;
      const validityMinutes =
        job.validity_minutes === null || job.validity_minutes === undefined
          ? null
          : Number(job.validity_minutes);
      return {
        smscId: job.smsc_id,
        sender: job.sender ?? defaultBulkSender(),
        customerId: job.customer_id,
        createdBy: job.created_by ?? 'bulk-send',
        // Every recipient inherits the campaign's schedule. It travels as the
        // absolute instant, not as an offset, so the per-recipient deferral is
        // recomputed against that instant at each INSERT and a slow drain
        // cannot smear the campaign across the schedule.
        schedule:
          scheduledAtMs === null && validityMinutes === null
            ? null
            : { scheduledAtMs, validityMinutes },
        recipients,
      };
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
        // Every campaign message now goes through the one send path: blocklist,
        // route selection (when the job pinned no bind), the customer's quota,
        // credit, sender-ID approval and route bindings, and a recorded routing
        // decision. A refusal fails only that recipient, never the whole job.
        const queued = await this.send.send(
          { tenantId, userId: claim.createdBy },
          {
            sender: claim.sender,
            receiver: recipient.receiver,
            text: recipient.text,
            smscId: claim.smscId,
            customerId: claim.customerId,
            channel: 'bulk',
            reference: jobId,
            schedule: claim.schedule,
          },
        );
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

/** Stable non-negative 31-bit hash of a uuid for the advisory lock key. */
function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 2147483647;
  return hash;
}
