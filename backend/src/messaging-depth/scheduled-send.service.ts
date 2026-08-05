import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { JobsService } from '../platform/jobs.service';
import { PermanentJobError } from '../platform/job-registry';
import { describeMsisdnProblem, normalizeMsisdn } from '../routing-depth/msisdn';
import {
  Actor,
  MessageSendService,
  SendChannel,
  SendRequest,
  SendResult,
} from './message-send.service';
import { BulkSendService, CreateBulkSendInput } from './bulk-send.service';
import {
  MessageSchedule,
  classifyMissedWindow,
  describeSchedule,
  parseMessageSchedule,
  requiresHold,
  scheduledSendMaxLatenessMs,
} from './message-scheduling';

/**
 * REAL "SEND LATER".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS NOT THE QUEUE ADR-0008 REJECTED
 * ---------------------------------------------------------------------------
 * ADR-0008 rejected a JKANNEL-owned OUTBOUND QUEUE: a table in front of every
 * message, releasing traffic only when a bind looked healthy, which would have
 * duplicated the engine's retry, throttling, windowing, store-and-forward and
 * SMPP flow control and put the control plane on the critical path of all
 * traffic. That decision stands.
 *
 * This is categorically different. It holds ONLY the messages an operator
 * explicitly deferred, BEFORE they ever enter the data plane, and releases them
 * into the existing send path so the engine's behaviour is completely
 * unchanged. "When should this be submitted?" is a control-plane question;
 * "how is it delivered once submitted?" is still the engine's, and nothing here
 * touches that. Immediate traffic — the overwhelming majority — never passes
 * through this file at all. See the amendment in ADR-0008.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM: A SCHEDULED SEND IS A JOB DUE AT THE SCHEDULED INSTANT
 * ---------------------------------------------------------------------------
 * No second scheduler is introduced. A held send is:
 *
 *   1. a `scheduled_messages` row (migration 042) carrying the request, and
 *   2. an `api_jobs` row of type `message.scheduled.release` whose
 *      `next_attempt_at` IS the scheduled instant,
 *
 * both written in ONE transaction, so there is never a hold with no releaser
 * (a message reported as scheduled that would never be sent) nor a releaser
 * with no hold. The Wave-F queue then supplies everything that is hard:
 *
 *   - `status='queued' AND next_attempt_at <= now() ... FOR UPDATE SKIP LOCKED`
 *     means the row becomes claimable exactly at the scheduled instant and
 *     exactly one worker gets it, however many replicas are running;
 *   - retry with exponential backoff, bounded `max_attempts`, dead-lettering;
 *   - heartbeat + stale-claim reaping when a worker dies.
 *
 * ---------------------------------------------------------------------------
 * ENTITLEMENTS ARE EVALUATED AT RELEASE, NEVER AT SCHEDULE TIME
 * ---------------------------------------------------------------------------
 * Nothing about a customer's standing is checked or reserved when a message is
 * scheduled. At the scheduled instant the payload is replayed verbatim through
 * {@link MessageSendService.send}, so per-customer rate limit, blocklist/DND,
 * route selection against live bind health, sender-ID approval, route bindings,
 * quota and credit are all evaluated then, against the state that exists then,
 * and a `message_route_decisions` row is written either way. Scheduling at
 * midnight and releasing at 09:00 consumes the 09:00 quota. A customer who runs
 * out of credit overnight has their 09:00 message REFUSED, with the reason
 * recorded, rather than delivered on yesterday's entitlement.
 *
 * The only checks performed at schedule time are the ones that are about the
 * request rather than the customer: the instant must be in the future and
 * within 365 days, and the destination must be a syntactically valid MSISDN.
 * Refusing "+44 not-a-number" tomorrow morning would be user-hostile.
 *
 * ---------------------------------------------------------------------------
 * CRASH SAFETY: WHY `releasing` PROVABLY MEANS "NOT SENT"
 * ---------------------------------------------------------------------------
 * The release is two committed steps:
 *
 *   A. `pending` -> `releasing` (its own transaction). Durable.
 *   B. the send — and the `releasing` -> `released` transition is written by
 *      {@link SendRequest.onSubmitted} INSIDE the send's own transaction, as
 *      the last statement before COMMIT.
 *
 * So if B does not commit, the row is still `releasing` AND no quota was
 * consumed, no debit posted, no decision recorded and no engine row inserted —
 * they all roll back together. `releasing` therefore means "provably not sent",
 * which is what makes retrying it safe rather than a coin flip. The claim in
 * step A accepts `releasing` as well as `pending` for exactly that reason.
 *
 * Conversely a hold can never be released twice. `release_attempts` doubles as
 * a FENCING TOKEN: the claim increments it and returns the new value, and every
 * subsequent write in that release is guarded on
 * `status='releasing' AND release_attempts = <that value>`. If a second worker
 * has claimed the hold in the meantime the counter has moved, the first
 * worker's guarded UPDATE matches nothing, and it throws — rolling ITS send
 * back. So even if the queue's own single-claim guarantee were somehow torn
 * (a reaped claim racing a resurrected worker), the outcome is one send, not
 * two. That is stricter than "check the status", which two concurrent
 * `releasing` workers would both pass.
 *
 * THE ONE RESIDUAL SEAM, stated rather than hidden: SQLBox is a separate
 * database. A failure in the window between a successful `send_sms` INSERT and
 * JKANNEL's COMMIT would leave a spooled message with the hold still
 * `releasing`, and a retry would then send it twice. That is the same
 * cross-database seam {@link MessageSendService} already documents for the
 * quota debit; it is not introduced here and cannot be closed without a
 * distributed transaction between the two databases.
 *
 * ---------------------------------------------------------------------------
 * MISSED WINDOWS
 * ---------------------------------------------------------------------------
 * If the platform is down across the scheduled instant, the job simply becomes
 * overdue and is claimed as soon as a worker returns. Whether it is then SENT
 * is a policy decision, made in {@link classifyMissedWindow}: released (and
 * flagged `released_late`) inside the staleness ceiling, `expired` beyond it.
 * Default ceiling 120 minutes, `SCHEDULED_SEND_MAX_LATENESS_MINUTES`.
 */

/** Job type the release handler registers. */
export const SCHEDULED_RELEASE_JOB_TYPE = 'message.scheduled.release';

/** Attempts a release job gets before it dead-letters. */
export const SCHEDULED_RELEASE_MAX_ATTEMPTS = 4;

const SCHEDULED_COLUMNS =
  'id,kind,status,scheduled_at,validity_minutes,payload,bulk_job_id,job_id,release_attempts,' +
  'claimed_at,claimed_by,released_at,released_late,lateness_ms,message_ref,decision_id,' +
  'failure_reason,created_by,created_at,updated_at';

/** A `scheduled_messages` row. */
export interface ScheduledMessageRow {
  id: string;
  kind: 'message' | 'bulk';
  status: 'pending' | 'releasing' | 'released' | 'cancelled' | 'failed' | 'expired';
  scheduled_at: Date | string;
  validity_minutes: number | string | null;
  payload: Record<string, unknown> | null;
  bulk_job_id: string | null;
  job_id: string | null;
  release_attempts: number;
  claimed_at: Date | string | null;
  claimed_by: string | null;
  released_at: Date | string | null;
  released_late: boolean;
  lateness_ms: number | string | null;
  message_ref: string | null;
  decision_id: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * What `POST /messages` returns when the message was HELD rather than sent.
 *
 * `sqlId: null` is deliberate and load-bearing: there is no engine row yet, and
 * returning a fabricated or borrowed id would be exactly the "report a send as
 * sent when it was not" failure this work exists to remove.
 */
export interface ScheduledSendAck {
  scheduledMessageId: string;
  releaseJobId: string | null;
  status: 'scheduled';
  held: true;
  sqlId: null;
  scheduledAt: string;
  validityMinutes: number | null;
  destination: string;
  customerId: string | null;
  smscId: string | null;
  /** The staleness ceiling that will apply to this hold, in minutes. */
  maxLatenessMinutes: number;
  note: string;
}

/** Result of one release attempt, as stored in the job's `result` column. */
export type ReleaseOutcome =
  | {
      outcome: 'released';
      kind: 'message';
      scheduledMessageId: string;
      sqlId: string;
      late: boolean;
      latenessMs: number;
    }
  | {
      outcome: 'released';
      kind: 'bulk';
      scheduledMessageId: string;
      bulkJobId: string;
      submitted: number;
      failed: number;
      late: boolean;
      latenessMs: number;
    }
  | {
      outcome: 'expired';
      scheduledMessageId: string;
      latenessMs: number;
      ceilingMs: number;
      reason: string;
    }
  | { outcome: 'cancelled' | 'already_released' | 'already_failed'; scheduledMessageId: string };

/** Grid whitelist for GET /scheduled-messages. */
export const SCHEDULED_MESSAGE_GRID: GridDefinition = {
  searchColumns: ['message_ref', 'failure_reason', 'created_by', 'claimed_by'],
  sortColumns: {
    scheduledAt: 'scheduled_at',
    scheduled_at: 'scheduled_at',
    createdAt: 'created_at',
    created_at: 'created_at',
    updatedAt: 'updated_at',
    releasedAt: 'released_at',
    status: 'status',
    kind: 'kind',
  },
  filterColumns: {
    status: 'status',
    kind: 'kind',
    createdBy: 'created_by',
    bulkJobId: 'bulk_job_id',
  },
  // Soonest-first is what an operator wants from "what is still pending".
  defaultOrderBy: 'scheduled_at ASC, id ASC',
  defaultLimit: 50,
  maxLimit: 200,
};

const TERMINAL_EXPLANATION: Record<string, string> = {
  releasing: 'is being released right now and can no longer be changed',
  released: 'has already been released into the send path and is gone',
  cancelled: 'was already cancelled',
  failed: 'already failed at release',
  expired: 'already expired without being sent',
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is this refusal a DECISION rather than a blip?
 *
 * A 4xx from the send path means the platform evaluated the request and said
 * no: quota exhausted, no credit, sender ID unapproved, destination blocked, no
 * route deployed. Retrying it in five seconds cannot change the answer and only
 * delays the honest failure, so the hold fails and the job dead-letters where
 * an operator can see it. 429 is the exception — a per-customer rate limit is
 * explicitly transient — as is anything that is not an HTTP error at all
 * (a dropped connection, SQLBox being down), which retries with backoff.
 */
export function isPermanentReleaseRefusal(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status = error.getStatus();
  return status >= 400 && status < 500 && status !== 429 && status !== 408;
}

@Injectable()
export class ScheduledSendService {
  constructor(
    private readonly database: DatabaseService,
    private readonly jobs: JobsService,
    private readonly send: MessageSendService,
    private readonly bulk: BulkSendService,
  ) {}

  // =========================================================================
  // SCHEDULE TIME
  // =========================================================================

  /**
   * THE single-message entry point. Sends immediately when there is nothing to
   * wait for, holds otherwise. Callers (`POST /messages`, and any future submit
   * path that accepts `scheduledAt`) go through here instead of calling
   * {@link MessageSendService.send} directly, so "send later" cannot be
   * accidentally bypassed by adding a new controller.
   */
  async submitMessage(
    actor: Actor,
    request: SendRequest,
    now = Date.now(),
  ): Promise<SendResult | ScheduledSendAck> {
    if (!requiresHold(request.schedule, now)) return this.send.send(actor, request);

    // Syntax, not policy: refuse an unusable destination at the door rather
    // than at 09:00 tomorrow. Everything about the CUSTOMER is left to release.
    const normalized = normalizeMsisdn(request.receiver);
    if (!normalized.digits) throw new BadRequestException(describeMsisdnProblem(normalized));
    if (typeof request.text !== 'string' || request.text === '')
      throw new BadRequestException('text is required');

    const scheduledAtMs = request.schedule!.scheduledAtMs!;
    const validityMinutes = request.schedule!.validityMinutes ?? null;
    const payload = {
      sender: request.sender ?? '',
      receiver: request.receiver,
      text: request.text,
      smscId: request.smscId ?? null,
      dlrMask: request.dlrMask ?? null,
      dlrUrl: request.dlrUrl ?? null,
      foreignId: request.foreignId ?? null,
      customerId: request.customerId ?? null,
      channel: request.channel,
      operator: request.operator ?? null,
      cost: request.cost ?? null,
      priority: request.priority ?? null,
      rerouteIfUnavailable: request.rerouteIfUnavailable ?? false,
      reference: request.reference ?? null,
    };

    const { row, jobId } = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const created = (
        await client.query<ScheduledMessageRow>(
          `INSERT INTO scheduled_messages
             (tenant_id,kind,status,scheduled_at,validity_minutes,payload,created_by)
           VALUES ($1,'message','pending',$2,$3,$4,$5) RETURNING ${SCHEDULED_COLUMNS}`,
          [
            actor.tenantId,
            new Date(scheduledAtMs),
            validityMinutes,
            JSON.stringify(payload),
            actor.userId,
          ],
        )
      ).rows[0];
      const releaseJobId = await this.enqueueRelease(client, actor, created.id, scheduledAtMs);
      await this.audit(client, actor, 'message.scheduled', created.id, {
        kind: 'message',
        destination: normalized.digits,
        customerId: payload.customerId,
        smscId: payload.smscId,
        channel: payload.channel,
        schedule: describeSchedule({ scheduledAtMs, validityMinutes }) ?? null,
        releaseJobId,
      });
      return { row: created, jobId: releaseJobId };
    });

    return this.ack(row, jobId, normalized.digits, payload.customerId, payload.smscId);
  }

  /**
   * THE campaign entry point. A future `scheduledAt` holds the campaign; at the
   * instant it is released the existing bulk runner dispatches every recipient
   * through the same {@link MessageSendService} path an immediate campaign uses,
   * so per-recipient routing, blocklist and entitlements behave identically.
   */
  async submitBulk(actor: Actor, input: CreateBulkSendInput, now = Date.now()) {
    if (!requiresHold(input.schedule, now)) return this.bulk.createJob(actor, input);

    const scheduledAtMs = input.schedule!.scheduledAtMs!;
    let scheduledMessageId: string | null = null;
    let releaseJobId: string | null = null;

    // The hold is written inside createJob's OWN transaction. Creating the
    // campaign first and the hold second would leave a window in which a crash
    // strands a campaign in `scheduled` with nothing to ever release it.
    const job = await this.bulk.createJob(actor, {
      ...input,
      onCreated: async (client, created) => {
        const row = (
          await client.query<ScheduledMessageRow>(
            `INSERT INTO scheduled_messages
               (tenant_id,kind,status,scheduled_at,validity_minutes,payload,bulk_job_id,created_by)
             VALUES ($1,'bulk','pending',$2,$3,$4,$5,$6) RETURNING ${SCHEDULED_COLUMNS}`,
            [
              actor.tenantId,
              new Date(scheduledAtMs),
              input.schedule!.validityMinutes ?? null,
              JSON.stringify({ name: created.name, total: created.total }),
              created.id,
              actor.userId,
            ],
          )
        ).rows[0];
        scheduledMessageId = row.id;
        releaseJobId = await this.enqueueRelease(client, actor, row.id, scheduledAtMs);
        await this.audit(client, actor, 'message.scheduled', row.id, {
          kind: 'bulk',
          bulkJobId: created.id,
          total: created.total,
          schedule: describeSchedule(input.schedule!) ?? null,
          releaseJobId,
        });
      },
    });

    return {
      ...job,
      scheduledMessageId,
      releaseJobId,
      held: true,
      maxLatenessMinutes: Math.round(scheduledSendMaxLatenessMs() / 60_000),
      note:
        'Campaign held by JKANNEL until scheduledAt. Every recipient is dispatched through the ' +
        'normal send path at release, so routing, blocklist, quota and credit are evaluated then.',
    };
  }

  /** Writes the release job whose `next_attempt_at` is the scheduled instant. */
  private async enqueueRelease(
    client: PoolClient,
    actor: Actor,
    scheduledMessageId: string,
    scheduledAtMs: number,
  ): Promise<string> {
    const job = await this.jobs.createOn(client, actor, {
      type: SCHEDULED_RELEASE_JOB_TYPE,
      input: { scheduledMessageId },
      // One release job per hold, enforced by the queue's own
      // UNIQUE (tenant_id, type, idempotency_key).
      idempotencyKey: `scheduled-message:${scheduledMessageId}`,
      runAt: new Date(scheduledAtMs),
    });
    await client.query('UPDATE scheduled_messages SET job_id=$2,updated_at=now() WHERE id=$1', [
      scheduledMessageId,
      job.id,
    ]);
    return job.id;
  }

  private ack(
    row: ScheduledMessageRow,
    releaseJobId: string | null,
    destination: string,
    customerId: string | null,
    smscId: string | null,
  ): ScheduledSendAck {
    return {
      scheduledMessageId: row.id,
      releaseJobId,
      status: 'scheduled',
      held: true,
      sqlId: null,
      scheduledAt: new Date(toMs(row.scheduled_at)!).toISOString(),
      validityMinutes: toNumber(row.validity_minutes),
      destination,
      customerId,
      smscId,
      maxLatenessMinutes: Math.round(scheduledSendMaxLatenessMs() / 60_000),
      note:
        'Held by JKANNEL until scheduledAt; nothing has been submitted to the engine yet. ' +
        'Blocklist, routing, sender-ID approval, quota and credit are evaluated AT RELEASE, so ' +
        'this send can still be refused then. Cancel or reschedule via /scheduled-messages.',
    };
  }

  // =========================================================================
  // OPERATOR API
  // =========================================================================

  list(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<ScheduledMessageRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<ScheduledMessageRow>(
        { select: `SELECT ${SCHEDULED_COLUMNS}`, from: 'FROM scheduled_messages' },
        SCHEDULED_MESSAGE_GRID,
        query,
        (sql, params) => client.query(sql, params as any[]).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'scheduledAt', direction: 'ASC' } },
      ),
    );
  }

  async get(actor: Actor, id: string): Promise<ScheduledMessageRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<ScheduledMessageRow>(
          `SELECT ${SCHEDULED_COLUMNS} FROM scheduled_messages WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Scheduled message not found');
      return row;
    });
  }

  /**
   * Cancels a hold that has not been released.
   *
   * The row is locked FOR UPDATE first, so this and a worker's claim serialise:
   * whichever gets the lock first wins, and the loser sees the other's state.
   * A released message is gone and says so with a 409 — never a silent success
   * over a message that is already on its way to a handset.
   */
  async cancel(actor: Actor, id: string, reason?: string): Promise<ScheduledMessageRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const current = await this.lock(client, id);
      this.assertMutable(current, 'cancelled');
      const detail = reason?.trim() || 'Cancelled by operator before release';
      const row = (
        await client.query<ScheduledMessageRow>(
          `UPDATE scheduled_messages SET status='cancelled',failure_reason=$2,updated_at=now()
             WHERE id=$1 AND status='pending' RETURNING ${SCHEDULED_COLUMNS}`,
          [id, detail],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException(
          `Scheduled message ${id} left the pending state while it was being cancelled; it was not cancelled.`,
        );
      if (current.job_id)
        await this.jobs.cancelOn(client, current.job_id, `Scheduled message cancelled: ${detail}`);
      if (current.kind === 'bulk' && current.bulk_job_id)
        await client.query(
          `UPDATE bulk_send_jobs SET status='failed',detail=$2,completed_at=now()
             WHERE id=$1 AND status='scheduled'`,
          [current.bulk_job_id, detail],
        );
      await this.audit(client, actor, 'message.schedule.cancelled', id, {
        kind: current.kind,
        scheduledAt: new Date(toMs(current.scheduled_at)!).toISOString(),
        bulkJobId: current.bulk_job_id,
        reason: detail,
      });
      return row;
    });
  }

  /**
   * Moves a hold to a new instant. Both the hold and its release job move in
   * ONE transaction: if the job has already been claimed
   * ({@link JobsService.rescheduleOn} returns nothing because the row is no
   * longer `queued`), the whole reschedule is refused rather than leaving a row
   * whose `scheduled_at` says one thing and whose releaser says another.
   */
  async reschedule(actor: Actor, id: string, scheduledAt: unknown): Promise<ScheduledMessageRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const current = await this.lock(client, id);
      this.assertMutable(current, 'rescheduled');

      // Re-validated by the same parser the original request used, so the past
      // instant / 365-day ceiling / "validity expires before delivery" rules
      // hold identically on a reschedule.
      const schedule = parseMessageSchedule({
        scheduledAt,
        validityMinutes: toNumber(current.validity_minutes) ?? undefined,
      });
      if (!requiresHold(schedule))
        throw new BadRequestException(
          'scheduledAt must be a future instant to reschedule. To send this message now, cancel ' +
            'the schedule and submit it again.',
        );
      const when = new Date(schedule.scheduledAtMs!);

      if (current.job_id) {
        const moved = await this.jobs.rescheduleOn(client, current.job_id, when);
        if (!moved)
          throw new ConflictException(
            `Scheduled message ${id} has already been claimed for release and can no longer be rescheduled.`,
          );
      }
      const row = (
        await client.query<ScheduledMessageRow>(
          `UPDATE scheduled_messages SET scheduled_at=$2,updated_at=now()
             WHERE id=$1 AND status='pending' RETURNING ${SCHEDULED_COLUMNS}`,
          [id, when],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException(
          `Scheduled message ${id} left the pending state while it was being rescheduled.`,
        );
      if (current.kind === 'bulk' && current.bulk_job_id)
        await client.query(
          `UPDATE bulk_send_jobs SET scheduled_at=$2 WHERE id=$1 AND status='scheduled'`,
          [current.bulk_job_id, when],
        );
      await this.audit(client, actor, 'message.schedule.rescheduled', id, {
        kind: current.kind,
        from: new Date(toMs(current.scheduled_at)!).toISOString(),
        to: when.toISOString(),
        bulkJobId: current.bulk_job_id,
      });
      return row;
    });
  }

  private async lock(client: PoolClient, id: string): Promise<ScheduledMessageRow> {
    const row = (
      await client.query<ScheduledMessageRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM scheduled_messages WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Scheduled message not found');
    return row;
  }

  private assertMutable(row: ScheduledMessageRow, verb: string): void {
    if (row.status === 'pending') return;
    throw new ConflictException(
      `Scheduled message ${row.id} ${TERMINAL_EXPLANATION[row.status] ?? `is ${row.status}`} and cannot be ${verb}.`,
    );
  }

  // =========================================================================
  // RELEASE TIME
  // =========================================================================

  /**
   * Releases one hold. Called by the `message.scheduled.release` job handler,
   * never directly by an HTTP request.
   *
   * Every exit is an explicit, recorded state; there is no path on which a hold
   * is silently forgotten. Read the class comment for why `releasing` proves
   * "not sent" and therefore why a retry cannot duplicate.
   */
  async release(
    tenantId: string,
    scheduledMessageId: string,
    context: { workerId: string; attempt: number; maxAttempts: number },
    now = Date.now(),
  ): Promise<ReleaseOutcome> {
    // Cheap, tenant-scoped, and the only place a hold abandoned by a hard-killed
    // worker gets resolved. Best effort: it must never stop a real release.
    await this.sweepStalled(tenantId).catch(() => undefined);

    const claimed = await this.claim(tenantId, scheduledMessageId, context.workerId);
    if ('outcome' in claimed) return claimed;
    const row = claimed.row;
    // The fencing token for this attempt. Every write below is guarded on it.
    const fence = Number(row.release_attempts);
    const actor: Actor = { tenantId, userId: row.created_by };
    const scheduledAtMs = toMs(row.scheduled_at)!;
    const verdict = classifyMissedWindow(scheduledAtMs, now);

    if (verdict.action === 'expire') {
      const reason =
        `Scheduled for ${new Date(scheduledAtMs).toISOString()} but not released until ` +
        `${new Date(now).toISOString()} — ${Math.round(verdict.latenessMs / 60_000)} minutes late, ` +
        `beyond the ${Math.round(verdict.ceilingMs / 60_000)} minute staleness ceiling ` +
        '(SCHEDULED_SEND_MAX_LATENESS_MINUTES). The message was NOT sent.';
      await this.database.tenantTransaction(tenantId, async (client) => {
        await client.query(
          `UPDATE scheduled_messages
              SET status='expired',failure_reason=$2,lateness_ms=$3,released_late=true,updated_at=now()
            WHERE id=$1 AND status='releasing' AND release_attempts=$4`,
          [row.id, reason, verdict.latenessMs, fence],
        );
        await this.audit(client, actor, 'message.schedule.expired', row.id, {
          kind: row.kind,
          scheduledAt: new Date(scheduledAtMs).toISOString(),
          latenessMs: verdict.latenessMs,
          ceilingMs: verdict.ceilingMs,
        });
      });
      return {
        outcome: 'expired',
        scheduledMessageId: row.id,
        latenessMs: verdict.latenessMs,
        ceilingMs: verdict.ceilingMs,
        reason,
      };
    }

    try {
      return row.kind === 'bulk'
        ? await this.releaseBulk(actor, row, fence, verdict.late, verdict.latenessMs)
        : await this.releaseMessage(
            actor,
            row,
            fence,
            verdict.late,
            verdict.latenessMs,
            scheduledAtMs,
          );
    } catch (error) {
      await this.recordReleaseFailure(actor, row, fence, error, context);
      throw error instanceof PermanentJobError
        ? error
        : isPermanentReleaseRefusal(error)
          ? new PermanentJobError(String((error as Error).message ?? error))
          : error;
    }
  }

  /**
   * `pending`/`releasing` -> `releasing`, atomically. Returns the row, or a
   * terminal outcome when there is nothing to release — a cancelled hold, or
   * one another worker already finished, both of which are successes for the
   * job rather than errors.
   */
  private async claim(
    tenantId: string,
    id: string,
    workerId: string,
  ): Promise<{ row: ScheduledMessageRow } | ReleaseOutcome> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const row = (
        await client.query<ScheduledMessageRow>(
          `UPDATE scheduled_messages
              SET status='releasing',release_attempts=release_attempts+1,
                  claimed_at=now(),claimed_by=$2,updated_at=now()
            WHERE id=$1 AND status IN ('pending','releasing') RETURNING ${SCHEDULED_COLUMNS}`,
          [id, workerId],
        )
      ).rows[0];
      if (row) return { row };
      const existing = (
        await client.query<ScheduledMessageRow>(
          `SELECT ${SCHEDULED_COLUMNS} FROM scheduled_messages WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!existing)
        throw new PermanentJobError(
          `Scheduled message ${id} no longer exists, so there is nothing to release.`,
        );
      if (existing.status === 'cancelled') return { outcome: 'cancelled', scheduledMessageId: id };
      if (existing.status === 'released')
        return { outcome: 'already_released', scheduledMessageId: id };
      return { outcome: 'already_failed', scheduledMessageId: id };
    });
  }

  /**
   * The whole point: replay the held request through THE send path, unchanged.
   * Blocklist, routing, entitlements, decision record and engine submit all
   * happen here and now, on today's state.
   */
  private async releaseMessage(
    actor: Actor,
    row: ScheduledMessageRow,
    fence: number,
    late: boolean,
    latenessMs: number,
    scheduledAtMs: number,
  ): Promise<ReleaseOutcome> {
    const payload = (row.payload ?? {}) as Record<string, any>;
    const schedule: MessageSchedule = {
      // Now in the past, so engineScheduleColumns() resolves `deferred` to 0 —
      // "send now" — while `validity` still reaches the carrier.
      scheduledAtMs,
      validityMinutes: toNumber(row.validity_minutes),
    };
    const result = await this.send.send(actor, {
      sender: String(payload.sender ?? ''),
      receiver: String(payload.receiver ?? ''),
      text: String(payload.text ?? ''),
      smscId: payload.smscId ?? null,
      dlrMask: payload.dlrMask ?? undefined,
      dlrUrl: payload.dlrUrl ?? undefined,
      foreignId: payload.foreignId ?? undefined,
      customerId: payload.customerId ?? null,
      channel: (payload.channel ?? 'console') as SendChannel,
      operator: payload.operator ?? null,
      cost: payload.cost ?? null,
      // `?? null`, never `?? 0`: a hold created before priority existed has no
      // key here, and null is "no preference" — 0 would be the bulk level.
      priority: payload.priority ?? null,
      rerouteIfUnavailable: Boolean(payload.rerouteIfUnavailable),
      reference: payload.reference ?? row.id,
      schedule,
      onSubmitted: async (client, submitted) => {
        const updated = await client.query(
          `UPDATE scheduled_messages
              SET status='released',released_at=now(),released_late=$2,lateness_ms=$3,
                  message_ref=$4,decision_id=$5,failure_reason=NULL,updated_at=now()
            WHERE id=$1 AND status='releasing' AND release_attempts=$6`,
          [row.id, late, latenessMs, submitted.sqlId, submitted.decisionId, fence],
        );
        // Guard, not decoration. If the hold is no longer `releasing`, or its
        // fencing token has moved because another worker claimed it, then this
        // send would be a duplicate. Throwing rolls the ENTIRE send back —
        // nothing spooled, no quota consumed, no debit — which is correct.
        if (updated.rowCount !== 1)
          throw new Error(
            `Scheduled message ${row.id} was claimed by another release (or resolved) while this ` +
              'one was in flight; the send was rolled back rather than delivered twice.',
          );
      },
    });
    await this.database
      .tenantTransaction(actor.tenantId, (client) =>
        this.audit(client, actor, 'message.schedule.released', row.id, {
          kind: 'message',
          sqlId: result.sqlId,
          smscId: result.smscId,
          decisionId: result.decisionId,
          charged: result.charged,
          late,
          latenessMs,
        }),
      )
      .catch(() => undefined);
    return {
      outcome: 'released',
      kind: 'message',
      scheduledMessageId: row.id,
      sqlId: result.sqlId,
      late,
      latenessMs,
    };
  }

  /**
   * Releasing a campaign is one committed flip from `scheduled` to `queued`
   * plus the hold's own transition, after which the ORDINARY bulk runner owns
   * it. Dispatch is then kicked inline for latency, but a crash before that
   * loses nothing: the campaign is `queued`, so the next runner tick picks it
   * up, and per-recipient status guards mean no recipient is submitted twice.
   */
  private async releaseBulk(
    actor: Actor,
    row: ScheduledMessageRow,
    fence: number,
    late: boolean,
    latenessMs: number,
  ): Promise<ReleaseOutcome> {
    const bulkJobId = row.bulk_job_id!;
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        `UPDATE bulk_send_jobs SET status='queued' WHERE id=$1 AND status='scheduled'`,
        [bulkJobId],
      );
      const updated = await client.query(
        `UPDATE scheduled_messages
            SET status='released',released_at=now(),released_late=$2,lateness_ms=$3,
                failure_reason=NULL,updated_at=now()
          WHERE id=$1 AND status='releasing' AND release_attempts=$4`,
        [row.id, late, latenessMs, fence],
      );
      if (updated.rowCount !== 1)
        throw new Error(
          `Scheduled campaign ${row.id} was claimed by another release (or resolved) while this ` +
            'one was in flight; the campaign was not started.',
        );
      await this.audit(client, actor, 'message.schedule.released', row.id, {
        kind: 'bulk',
        bulkJobId,
        late,
        latenessMs,
      });
    });
    const summary = await this.bulk.processJob(actor.tenantId, bulkJobId);
    return {
      outcome: 'released',
      kind: 'bulk',
      scheduledMessageId: row.id,
      bulkJobId,
      submitted: summary.submitted,
      failed: summary.failed,
      late,
      latenessMs,
    };
  }

  /**
   * Records why a release did not happen.
   *
   * A permanent refusal (a 4xx decision from the send path — quota, credit,
   * sender ID, blocklist, routing) is terminal: the hold becomes `failed` with
   * the reason, and the job dead-letters so it is visible in the jobs grid. A
   * transient failure returns the hold to `pending` so the queue can retry it
   * with backoff — and so an operator can still cancel it in the meantime —
   * unless this was the last attempt, in which case it is recorded as failed
   * rather than left looking like it is still waiting.
   */
  private async recordReleaseFailure(
    actor: Actor,
    row: ScheduledMessageRow,
    fence: number,
    error: unknown,
    context: { attempt: number; maxAttempts: number },
  ): Promise<void> {
    const message = String((error as Error)?.message ?? error).slice(0, 2000);
    const permanent = isPermanentReleaseRefusal(error) || error instanceof PermanentJobError;
    const lastAttempt = context.attempt >= context.maxAttempts;
    const terminal = permanent || lastAttempt;
    const reason = permanent
      ? `Refused at release: ${message}`
      : lastAttempt
        ? `Release failed after ${context.attempt} attempt(s) and was not retried further: ${message}`
        : `Release attempt ${context.attempt} failed and will be retried: ${message}`;
    await this.database
      .tenantTransaction(actor.tenantId, async (client) => {
        // Fenced like every other write: a worker whose claim was superseded
        // must not stamp `failed` over an attempt that is still in flight.
        await client.query(
          `UPDATE scheduled_messages SET status=$2,failure_reason=$3,updated_at=now()
             WHERE id=$1 AND status='releasing' AND release_attempts=$4`,
          [row.id, terminal ? 'failed' : 'pending', reason, fence],
        );
        if (terminal)
          await this.audit(client, actor, 'message.schedule.failed', row.id, {
            kind: row.kind,
            permanent,
            attempt: context.attempt,
            reason,
          });
      })
      // Losing the forensic record must not change the error the queue sees.
      .catch(() => undefined);
  }

  /**
   * Resolves holds abandoned mid-release.
   *
   * A worker killed hard (SIGKILL, OOM, node failure) never runs
   * {@link recordReleaseFailure}, so its hold stays `releasing`. The job queue
   * reaps the claim and retries, which normally fixes it; the case this covers
   * is the hold whose job also exhausted its attempts. Such a row provably did
   * not send, and once it is past the staleness ceiling it must not be sent, so
   * it is recorded as failed rather than left indefinitely mid-flight.
   *
   * Deliberately NOT a new scheduler: it runs at the head of every release, and
   * a tenant with no further scheduled traffic keeps a visible `releasing` row
   * (honest and inspectable) rather than a silently wrong one.
   */
  async sweepStalled(tenantId: string): Promise<number> {
    const claimTimeoutSeconds = Math.max(
      60,
      Math.round(Number(process.env.JOB_CLAIM_TIMEOUT_MS ?? 600_000) / 1000),
    );
    const ceilingSeconds = Math.round(scheduledSendMaxLatenessMs() / 1000);
    const result = await this.database.tenantTransaction(tenantId, (client) =>
      client.query(
        `UPDATE scheduled_messages
            SET status='failed',
                failure_reason=COALESCE(failure_reason || ' | ', '')
                  || 'Release was interrupted by a worker failure and the staleness ceiling has '
                  || 'since elapsed; the message was not sent.',
                updated_at=now()
          WHERE status='releasing'
            AND claimed_at IS NOT NULL
            AND claimed_at < now() - make_interval(secs => $1::double precision)
            AND scheduled_at < now() - make_interval(secs => $2::double precision)`,
        [claimTimeoutSeconds, ceilingSeconds],
      ),
    );
    return result.rowCount ?? 0;
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    entityId: string,
    detail: Record<string, unknown>,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value)
       VALUES($1,$2,$3,'scheduled_message',$4,$5)`,
      [actor.tenantId, actor.userId, action, entityId, JSON.stringify(detail)],
    );
  }
}
