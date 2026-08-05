import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  DLR_EVENT_DELIVERED,
  KamexSqlboxRepository,
  NegativeDeliveryReport,
} from '../engine/kamex-sqlbox.repository';
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { JobsService } from '../platform/jobs.service';
import { Actor, MessageSendService } from '../messaging-depth/message-send.service';
import { RouteResolutionService } from '../routing-depth/route-resolution.service';
import {
  BindSelection,
  DELIVERY_RETRY_DEFAULTS,
  DeliveryRetryPolicy,
  DeliveryRetryPolicyRow,
  PolicyInput,
  classifyReport,
  resolveRetryPolicy,
  scannableEvents,
  selectRetryBind,
} from './delivery-retry.policy';

/** Sweeps the engine's delivery reports; re-enqueues itself while enabled. */
export const DELIVERY_RETRY_SCAN_JOB_TYPE = 'delivery.retry.scan';
export const DELIVERY_RETRY_SCAN_MAX_ATTEMPTS = 3;
/** Performs ONE re-send of ONE message. */
export const DELIVERY_RETRY_DISPATCH_JOB_TYPE = 'delivery.retry.dispatch';
/**
 * Queue-level ceiling for a dispatch job. Higher than the default three because
 * the failures worth retrying at THIS level are infrastructural (SQLBox briefly
 * unreachable, a connection dropped mid-deploy) and clear with a couple of
 * backed-off attempts. It is NOT the retry budget: that is the chain's own
 * `max_attempts`, and the chain increments `attempts` before the send, so a
 * queue-level retry cannot smuggle an extra submission past it.
 */
export const DELIVERY_RETRY_DISPATCH_MAX_ATTEMPTS = 4;

/** Window the storm caps are measured over. */
const BREAKER_WINDOW_SECONDS = 60;

export type RetryChainStatus =
  'pending' | 'retrying' | 'resent' | 'delivered' | 'exhausted' | 'abandoned' | 'failed';

export interface RetryChainRow {
  id: string;
  origin_message_ref: string;
  origin_decision_id: string | null;
  customer_id: string | null;
  origin_channel: string | null;
  sender: string | null;
  destination: string;
  body: string;
  origin_smsc_id: string | null;
  tried_smsc_ids: string[];
  trigger_dlr_event: number;
  trigger_dlr_sql_id: string | null;
  trigger_dlr_at: string | Date | null;
  trigger_detail: string | null;
  status: RetryChainStatus;
  attempts: number;
  max_attempts: number;
  policy_id: string | null;
  job_id: string | null;
  last_error: string | null;
  terminal_reason: string | null;
  resolved_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface RetryAttemptRow {
  id: string;
  retry_id: string;
  attempt_no: number;
  smsc_id: string | null;
  excluded_smsc_ids: string[];
  selection: string | null;
  outcome: 'submitted' | 'refused' | 'no_bind' | 'skipped' | 'error';
  message_ref: string | null;
  decision_id: string | null;
  charged: string | number;
  dlr_event: number | null;
  dlr_at: string | Date | null;
  reason: string;
  created_at: string | Date;
}

const CHAIN_COLUMNS =
  'id::text,origin_message_ref,origin_decision_id::text,customer_id::text,origin_channel,sender,' +
  'destination,body,origin_smsc_id,tried_smsc_ids,trigger_dlr_event,trigger_dlr_sql_id::text,' +
  'trigger_dlr_at,trigger_detail,status,attempts,max_attempts,policy_id::text,job_id::text,' +
  'last_error,terminal_reason,resolved_at,created_at,updated_at';

const ATTEMPT_COLUMNS =
  'id::text,retry_id::text,attempt_no,smsc_id,excluded_smsc_ids,selection,outcome,message_ref,' +
  'decision_id::text,charged,dlr_event,dlr_at,reason,created_at';

const POLICY_COLUMNS =
  'id::text,scope,smsc_id,customer_id::text,enabled,max_attempts,retry_on_failed,' +
  'retry_on_rejected,min_delay_seconds,max_age_seconds,require_different_bind,' +
  'charge_credit_on_retry,max_retries_per_minute,bind_retries_per_minute,created_by,' +
  'created_at,updated_at';

const STATE_COLUMNS =
  'id::text,watermark_sql_id::text,poll_interval_seconds,last_scanned_at,last_error,' +
  'reports_seen::text,chains_opened::text,created_at,updated_at';

/** Grid whitelist for GET /delivery-retries. */
export const RETRY_CHAIN_GRID: GridDefinition = {
  searchColumns: ['destination', 'sender', 'origin_message_ref', 'terminal_reason', 'last_error'],
  sortColumns: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    status: 'status',
    attempts: 'attempts',
    destination: 'destination',
    resolvedAt: 'resolved_at',
  },
  filterColumns: {
    status: 'status',
    customerId: 'customer_id',
    originSmscId: 'origin_smsc_id',
    triggerDlrEvent: 'trigger_dlr_event',
    originChannel: 'origin_channel',
  },
  defaultOrderBy: 'created_at DESC, id DESC',
  defaultLimit: 50,
  maxLimit: 500,
};

/** Grid whitelist for GET /delivery-retries/attempts. */
export const RETRY_ATTEMPT_GRID: GridDefinition = {
  searchColumns: ['reason', 'smsc_id', 'message_ref'],
  sortColumns: {
    createdAt: 'created_at',
    attemptNo: 'attempt_no',
    outcome: 'outcome',
    smscId: 'smsc_id',
    charged: 'charged',
  },
  filterColumns: {
    outcome: 'outcome',
    smscId: 'smsc_id',
    retryId: 'retry_id',
    selection: 'selection',
  },
  defaultOrderBy: 'created_at DESC, id DESC',
  defaultLimit: 50,
  maxLimit: 500,
};

export interface ScanOutcome {
  available: boolean;
  /** False when the tenant has no enabled policy; nothing was read. */
  enabled: boolean;
  reportsScanned: number;
  chainsOpened: number;
  /** Reports whose chain already existed — the dedupe index doing its job. */
  duplicates: number;
  /** Reports that continued an EXISTING chain (a retry that itself failed). */
  continuations: number;
  skipped: number;
  /** Chains resolved by observing a later delivery report. */
  settled: number;
  watermark: string;
  /** Set when the scan stopped early; storm cap, or the engine being down. */
  evidence?: string;
}

export interface DispatchOutcome {
  retryId: string;
  outcome:
    'submitted' | 'refused' | 'no_bind' | 'skipped' | 'delivered' | 'exhausted' | 'abandoned';
  attemptNo: number | null;
  smscId: string | null;
  messageRef: string | null;
  charged: number;
  reason: string;
}

/**
 * RESEND ON DELIVERY FAILURE.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * A send failure was already handled: `RouteResolutionService` picks a fallback
 * bind when the primary is not healthy at submit time, and the decision records
 * `fallback_used`. That only covers a failure the platform can see BEFORE the
 * message leaves.
 *
 * A message the engine ACCEPTED and the carrier later rejected was never
 * retried on anything. The delivery report landed in the engine's `sent_sms`
 * table, the message grid showed `failed`, and that was the end of it — with a
 * healthy alternative bind sitting idle. This service is that missing path.
 *
 * ---------------------------------------------------------------------------
 * HOW A FAILURE IS FOUND: `foreign_id`, AND THE MASK TRAP
 * ---------------------------------------------------------------------------
 * sqlbox stamps the consumed `send_sms.sql_id` into `foreign_id`, so every DLR
 * the engine writes carries the sql_id of the message it reports on. VERIFIED
 * on the running stack: `sent_sms` MT rows there carry `foreign_id` 1, 3, 4,
 * 5, 6 — send_sms sql_ids, not the caller-supplied correlation ids. That is the
 * same value {@link MessageSendService} records as
 * `message_route_decisions.message_ref`, so the join is direct.
 *
 * `dlr_mask` means two different things depending on the row it is on. On a DLR
 * row it is the EVENT (1 delivered / 2 failed / 4 buffered / 8 accepted /
 * 16 rejected). On an MT row it is the mask the sender REQUESTED — on the
 * running stack every MT row carries 31, "report everything" — which is a
 * subscription and not a status. A scan that forgot `momt = 'DLR'` would treat
 * ordinary sent messages as failures and re-send the entire outbox. The
 * predicate lives on the receipt; the message is reached only through the
 * correlation. See {@link KamexSqlboxRepository.findNegativeDeliveryReports}.
 *
 * ---------------------------------------------------------------------------
 * NO NEW SCHEDULER
 * ---------------------------------------------------------------------------
 * Two job types on the existing queue, exactly as MO ingest and scheduled send
 * do it. `delivery.retry.scan` sweeps the engine and enqueues its own successor
 * while any policy is enabled, so the queue's `next_attempt_at` is the poll
 * timer. `delivery.retry.dispatch` performs ONE re-send and is stamped with
 * `runAt = now + minDelaySeconds`, which is also the window in which a late
 * positive report can still cancel it.
 *
 * ---------------------------------------------------------------------------
 * WHY A DUPLICATE RETRY IS STRUCTURALLY IMPOSSIBLE (and where it is not)
 * ---------------------------------------------------------------------------
 * Four independent constraints, none of them a SELECT-then-INSERT:
 *
 *   1. `UNIQUE (tenant_id, origin_message_ref)` on the chain. Opening one is
 *      `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; a second observer of
 *      the same failure gets no row back and stops. A watermark that goes
 *      backwards, a replayed scan job or two workers all converge on one chain.
 *   2. `UNIQUE (tenant_id, type, idempotency_key)` on `api_jobs`. The dispatch
 *      job's key is `delivery-retry:<chain>:<attempt>`, so an attempt can never
 *      have two dispatchers.
 *   3. The claim is `UPDATE ... SET attempts = attempts + 1 WHERE attempts <
 *      max_attempts`, COMMITTED BEFORE the send. A crash-loop therefore cannot
 *      exceed the budget, and the returned value is a fencing token every
 *      subsequent write in that dispatch is guarded on.
 *   4. `UNIQUE (tenant_id, retry_id, attempt_no)` turns that fence into a
 *      database constraint, so a torn claim records one attempt, not two.
 *
 * A LATE POSITIVE REPORT is handled by re-reading the engine immediately before
 * the send: if the newest event for the original message, or for any retry of
 * it, is `delivered`, the chain terminates as `delivered` and nothing is sent.
 * `minDelaySeconds` (default 60) exists to widen that window.
 *
 * THE RESIDUAL SEAM, stated rather than hidden: SQLBox is a separate database.
 * A failure between a successful `send_sms` INSERT and JKANNEL's COMMIT leaves a
 * spooled message whose attempt row rolled back, and the chain would then be
 * re-dispatched. That is the same cross-database seam
 * {@link MessageSendService} and ScheduledSendService already document; it is
 * not introduced here and cannot be closed without a distributed transaction
 * between the two databases. What bounds it is constraint 3: `attempts` was
 * already incremented and committed, so the exposure is one extra send at most,
 * never a loop.
 *
 * ---------------------------------------------------------------------------
 * STORMS
 * ---------------------------------------------------------------------------
 * A carrier outage fails everything at once. Two limits, both policy:
 *
 *   - `maxRetriesPerMinute` (tenant-wide, default 60) caps the retries a tenant
 *     may set in motion. Concretely: a scan opens at most
 *     `cap - (retry attempts already made in the last 60 seconds)` chains, so a
 *     backlog of failures and a burst of in-flight retries draw on one budget.
 *     When it is spent the scan stops WITHOUT advancing its watermark past the
 *     unprocessed reports, so they are read again next cycle rather than lost.
 *     Backpressure, not discard.
 *   - `bindRetriesPerMinute` (default 30) excludes a bind that has already
 *     absorbed that many retries from the candidate set. That is the circuit
 *     breaker, and it is per-target because the failure being prevented is the
 *     surviving bind being buried by everything that failed elsewhere.
 *
 * ---------------------------------------------------------------------------
 * BILLING
 * ---------------------------------------------------------------------------
 * A retry goes through {@link MessageSendService.send} like any other message,
 * so by default it consumes quota and debits credit again. That is deliberate: a
 * retry is a real second submission which the carrier really invoices, and a
 * free one would let a customer with a permanently failing destination consume
 * unlimited carrier capacity at zero cost while the credit ledger silently
 * diverged from the carrier's bill.
 *
 * `chargeCreditOnRetry = false` passes `cost: 0` into the send path, which
 * suppresses the CREDIT DEBIT ONLY. Quota is still consumed, because the shared
 * send path has no bypass for it and adding a second entitlement rule here would
 * put two divergent answers in the system. The column comment and the policy
 * endpoint say exactly this rather than implying a retry can be made free.
 */
@Injectable()
export class DeliveryRetryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly jobs: JobsService,
    private readonly send: MessageSendService,
    private readonly routing: RouteResolutionService,
  ) {}

  // =========================================================================
  // POLICY
  // =========================================================================

  private async policyRows(client: PoolClient): Promise<DeliveryRetryPolicyRow[]> {
    return (
      await client.query<DeliveryRetryPolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM delivery_retry_policies ORDER BY scope, created_at`,
      )
    ).rows;
  }

  listPolicies(
    actor: Actor,
  ): Promise<{ items: DeliveryRetryPolicyRow[]; defaults: DeliveryRetryPolicy }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => ({
      items: await this.policyRows(client),
      defaults: DELIVERY_RETRY_DEFAULTS,
    }));
  }

  /**
   * Creates or replaces the policy for one scope, and — when it turns retrying
   * ON — makes sure a scanner is running. Without that last step an operator
   * would enable the feature and observe nothing happening until some unrelated
   * event scheduled a scan.
   */
  async upsertPolicy(actor: Actor, input: PolicyInput): Promise<DeliveryRetryPolicyRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      // The three partial uniques cannot be named in one ON CONFLICT clause, so
      // the conflict target is spelled out per scope. Each is the index that
      // makes a second row for the same scope impossible.
      const conflict =
        input.scope === 'tenant'
          ? "(tenant_id) WHERE scope = 'tenant'"
          : input.scope === 'smsc'
            ? "(tenant_id, smsc_id) WHERE scope = 'smsc'"
            : "(tenant_id, customer_id) WHERE scope = 'customer'";
      const row = (
        await client.query<DeliveryRetryPolicyRow>(
          `INSERT INTO delivery_retry_policies
             (tenant_id,scope,smsc_id,customer_id,enabled,max_attempts,retry_on_failed,
              retry_on_rejected,min_delay_seconds,max_age_seconds,require_different_bind,
              charge_credit_on_retry,max_retries_per_minute,bind_retries_per_minute,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT ${conflict} DO UPDATE SET
             enabled=EXCLUDED.enabled,
             max_attempts=EXCLUDED.max_attempts,
             retry_on_failed=EXCLUDED.retry_on_failed,
             retry_on_rejected=EXCLUDED.retry_on_rejected,
             min_delay_seconds=EXCLUDED.min_delay_seconds,
             max_age_seconds=EXCLUDED.max_age_seconds,
             require_different_bind=EXCLUDED.require_different_bind,
             charge_credit_on_retry=EXCLUDED.charge_credit_on_retry,
             max_retries_per_minute=EXCLUDED.max_retries_per_minute,
             bind_retries_per_minute=EXCLUDED.bind_retries_per_minute,
             updated_at=now()
           RETURNING ${POLICY_COLUMNS}`,
          [
            actor.tenantId,
            input.scope,
            input.smscId,
            input.customerId,
            input.enabled,
            input.maxAttempts,
            input.retryOnFailed,
            input.retryOnRejected,
            input.minDelaySeconds,
            input.maxAgeSeconds,
            input.requireDifferentBind,
            input.chargeCreditOnRetry,
            input.maxRetriesPerMinute,
            input.bindRetriesPerMinute,
            actor.userId,
          ],
        )
      ).rows[0];

      if (input.enabled) await this.ensureScanScheduled(client, actor, 0);
      await this.audit(
        client,
        actor,
        'delivery_retry.policy.saved',
        'delivery_retry_policy',
        row.id,
        {
          scope: row.scope,
          smscId: row.smsc_id,
          customerId: row.customer_id,
          enabled: row.enabled,
          maxAttempts: row.max_attempts,
          retryOnRejected: row.retry_on_rejected,
          chargeCreditOnRetry: row.charge_credit_on_retry,
        },
      );
      return row;
    });
  }

  async removePolicy(actor: Actor, id: string): Promise<void> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<{ id: string; scope: string }>(
          'DELETE FROM delivery_retry_policies WHERE id=$1 RETURNING id::text, scope',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Delivery retry policy not found');
      await this.audit(
        client,
        actor,
        'delivery_retry.policy.removed',
        'delivery_retry_policy',
        id,
        { scope: row.scope },
      );
    });
  }

  /**
   * The policy that WOULD apply to a failure on this bind for this customer.
   * Exposed so a console can show the effective answer rather than making an
   * operator resolve three scopes in their head.
   */
  effectivePolicy(
    actor: Actor,
    context: { smscId?: string | null; customerId?: string | null },
  ): Promise<DeliveryRetryPolicy> {
    return this.database.tenantTransaction(actor.tenantId, async (client) =>
      resolveRetryPolicy(await this.policyRows(client), context),
    );
  }

  // =========================================================================
  // SCAN
  // =========================================================================

  /**
   * Reads the engine's negative delivery reports past the watermark and opens a
   * retry chain for each one the policy accepts.
   *
   * The watermark is an optimisation, never the correctness mechanism — that is
   * `message_delivery_retries_origin_uidx`. A watermark that goes backwards
   * (restored database, manual reset) re-reads reports and opens no chain twice.
   */
  async scan(actor: Actor, options: { limit?: number } = {}): Promise<ScanOutcome> {
    const limit = Math.min(Math.max(Number(options.limit ?? 200) || 200, 1), 1000);
    const empty: ScanOutcome = {
      available: true,
      enabled: true,
      reportsScanned: 0,
      chainsOpened: 0,
      duplicates: 0,
      continuations: 0,
      skipped: 0,
      settled: 0,
      watermark: '0',
    };

    const probe = await this.sqlbox.probe();
    if (!probe.available) {
      await this.recordScan(actor.tenantId, null, `engine unavailable: ${probe.evidence}`);
      return { ...empty, available: false, evidence: probe.evidence };
    }

    const prepared = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const policies = await this.policyRows(client);
      return {
        policies,
        allowedSmscIds: await this.tenantSmscScope(client),
        watermark: (await this.state(client, actor.tenantId)).watermark_sql_id ?? '0',
        recentTotal: await this.recentAttemptCount(client),
      };
    });

    const events = scannableEvents(prepared.policies);
    if (!events.length) {
      await this.recordScan(actor.tenantId, null, null);
      return { ...empty, enabled: false, watermark: prepared.watermark };
    }
    if (!prepared.allowedSmscIds.length) {
      await this.recordScan(actor.tenantId, null, 'tenant has no SMSC definitions');
      return { ...empty, watermark: prepared.watermark };
    }

    const reports = await this.sqlbox.findNegativeDeliveryReports({
      afterSqlId: prepared.watermark,
      events,
      allowedSmscIds: prepared.allowedSmscIds,
      limit,
    });

    // Storm cap. `maxRetriesPerMinute` is read from the tenant scope regardless
    // of which policy ends up applying to any individual message, because it is
    // a ceiling over the tenant's whole estate.
    const cap = resolveRetryPolicy(prepared.policies, {}).maxRetriesPerMinute;
    let budget = Math.max(0, cap - prepared.recentTotal);

    const outcome: ScanOutcome = { ...empty, watermark: prepared.watermark };
    let highest = prepared.watermark;

    for (const report of reports) {
      if (budget <= 0) {
        // Stop WITHOUT advancing past this report: it is read again next cycle.
        outcome.evidence = `storm cap reached (${cap}/min); ${reports.length - outcome.reportsScanned} report(s) deferred to the next scan`;
        break;
      }
      outcome.reportsScanned += 1;
      try {
        const handled = await this.database.tenantTransaction(actor.tenantId, (client) =>
          this.ingestReport(client, actor, report, prepared.policies),
        );
        if (handled === 'opened') {
          outcome.chainsOpened += 1;
          budget -= 1;
        } else if (handled === 'continued') {
          outcome.continuations += 1;
          budget -= 1;
        } else if (handled === 'duplicate') outcome.duplicates += 1;
        else outcome.skipped += 1;
        highest = report.dlrSqlId;
      } catch (error) {
        // One unusable report must not stall every one behind it forever, but
        // the watermark must not advance past it either — record and stop.
        await this.recordScan(
          actor.tenantId,
          highest,
          `report ${report.dlrSqlId}: ${String((error as Error).message ?? error)}`,
          outcome,
        );
        return {
          ...outcome,
          watermark: highest,
          evidence: `stopped at delivery report ${report.dlrSqlId}`,
        };
      }
    }

    outcome.settled = await this.settleResentChains(actor);
    outcome.watermark = highest;
    await this.recordScan(actor.tenantId, highest, null, outcome);
    return outcome;
  }

  /**
   * One delivery report. Returns what it did so the scan can count it.
   *
   * Order matters: a report for a message that is ITSELF a retry continues the
   * existing chain rather than opening a new one. Without that lookup a retry
   * that failed would look like a brand-new message, its own chain would be
   * opened with a fresh attempt budget, and the pair would ping-pong until every
   * bind was exhausted — the loop hazard, closed structurally.
   */
  private async ingestReport(
    client: PoolClient,
    actor: Actor,
    report: NegativeDeliveryReport,
    policies: DeliveryRetryPolicyRow[],
  ): Promise<'opened' | 'continued' | 'duplicate' | 'skipped'> {
    const attempt = (
      await client.query<{ id: string; retry_id: string }>(
        'SELECT id::text, retry_id::text FROM message_delivery_retry_attempts WHERE message_ref=$1',
        [report.foreignId],
      )
    ).rows[0];
    if (attempt) return this.continueChain(client, actor, attempt, report);

    // TENANT ISOLATION AND PROVENANCE IN ONE PREDICATE. The decision table is
    // RLS-scoped, so a message this tenant did not send has no decision row
    // visible here and is never retried — not by this tenant onto its own binds,
    // and not onto anyone else's. It also excludes traffic injected into the
    // engine outside JKANNEL, which the platform has no mandate to re-send.
    const decision = (
      await client.query<{
        id: string;
        customer_id: string | null;
        channel: string;
        sender: string | null;
        destination: string;
        smsc_id: string | null;
      }>(
        `SELECT id::text, customer_id::text, channel, sender, destination, smsc_id
           FROM message_route_decisions
          WHERE message_ref=$1
          ORDER BY created_at DESC LIMIT 1`,
        [report.foreignId],
      )
    ).rows[0];
    if (!decision) return 'skipped';

    const policy = resolveRetryPolicy(policies, {
      smscId: report.smscId,
      customerId: decision.customer_id,
    });
    const verdict = classifyReport(policy, report, Date.now());
    if (!verdict.retry && !verdict.recordable) return 'skipped';

    const opened = (
      await client.query<{ id: string }>(
        `INSERT INTO message_delivery_retries
           (tenant_id,origin_message_ref,origin_decision_id,customer_id,origin_channel,sender,
            destination,body,origin_smsc_id,tried_smsc_ids,trigger_dlr_event,trigger_dlr_sql_id,
            trigger_dlr_at,trigger_detail,status,max_attempts,policy_id,terminal_reason,resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY[$9]::text[],$10,$11::bigint,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (tenant_id, origin_message_ref) DO NOTHING
         RETURNING id::text`,
        [
          actor.tenantId,
          report.foreignId,
          decision.id,
          decision.customer_id,
          decision.channel,
          report.sender || decision.sender,
          decision.destination,
          report.text,
          report.smscId,
          report.dlrEvent,
          report.dlrSqlId,
          report.dlrAt,
          report.detail,
          verdict.retry ? 'pending' : 'abandoned',
          policy.maxAttempts,
          policy.policyId,
          verdict.retry ? null : verdict.reason,
          verdict.retry ? null : new Date(),
        ],
      )
    ).rows[0];
    // No row back means the chain already existed: the unique index refused a
    // second one. That is the duplicate-retry guard, not an error.
    if (!opened) return 'duplicate';

    if (!verdict.retry) return 'opened';

    await this.enqueueDispatch(client, actor, opened.id, 1, policy.minDelaySeconds);
    await this.audit(client, actor, 'delivery_retry.opened', 'delivery_retry', opened.id, {
      originMessageRef: report.foreignId,
      dlrEvent: report.dlrEvent,
      originSmscId: report.smscId,
      destination: decision.destination,
      customerId: decision.customer_id,
      maxAttempts: policy.maxAttempts,
      policyScope: policy.scope,
    });
    return 'opened';
  }

  /** A retry of ours failed in turn: record it against its own chain. */
  private async continueChain(
    client: PoolClient,
    actor: Actor,
    attempt: { id: string; retry_id: string },
    report: NegativeDeliveryReport,
  ): Promise<'continued' | 'skipped'> {
    await client.query(
      'UPDATE message_delivery_retry_attempts SET dlr_event=$2, dlr_at=$3 WHERE id=$1',
      [attempt.id, report.dlrEvent, report.dlrAt],
    );
    const chain = (
      await client.query<RetryChainRow>(
        `SELECT ${CHAIN_COLUMNS} FROM message_delivery_retries WHERE id=$1 FOR UPDATE`,
        [attempt.retry_id],
      )
    ).rows[0];
    if (!chain || chain.status !== 'resent') return 'skipped';

    if (chain.attempts >= chain.max_attempts) {
      await this.terminate(
        client,
        chain.id,
        'exhausted',
        `retry ${chain.attempts} of ${chain.max_attempts} also failed (DLR ${report.dlrEvent}); no attempts left`,
      );
      return 'continued';
    }

    await client.query(
      `UPDATE message_delivery_retries
          SET status='pending', last_error=$2, updated_at=now()
        WHERE id=$1`,
      [chain.id, `retry on ${report.smscId} reported DLR ${report.dlrEvent}`],
    );
    const policy = resolveRetryPolicy(await this.policyRows(client), {
      smscId: report.smscId,
      customerId: chain.customer_id,
    });
    await this.enqueueDispatch(client, actor, chain.id, chain.attempts + 1, policy.minDelaySeconds);
    return 'continued';
  }

  /**
   * Resolves chains sitting in `resent` by asking the engine what happened to
   * the last attempt. Batched into one engine query for the whole page, because
   * the alternative — one round trip per open chain — is the kind of per-row
   * query that only hurts once there is real traffic.
   *
   * A chain whose retry has no report yet is LEFT in `resent`. That status means
   * exactly "a retry was submitted and its outcome is not known yet"; pretending
   * otherwise would be the sort of claim the code cannot back.
   */
  private async settleResentChains(actor: Actor, limit = 200): Promise<number> {
    const open = await this.database.tenantTransaction(actor.tenantId, (client) =>
      client
        .query<{ id: string; message_ref: string; attempt_no: number; smsc_id: string | null }>(
          `SELECT c.id::text, a.message_ref, a.attempt_no, a.smsc_id
             FROM message_delivery_retries c
             JOIN message_delivery_retry_attempts a
               ON a.retry_id = c.id AND a.attempt_no = c.attempts
            WHERE c.status='resent' AND a.message_ref IS NOT NULL AND a.dlr_event IS NULL
            ORDER BY c.updated_at ASC
            LIMIT $1`,
          [limit],
        )
        .then((result) => result.rows),
    );
    if (!open.length) return 0;

    const events = await this.sqlbox.latestDeliveryEvents(open.map((row) => row.message_ref));
    let settled = 0;
    for (const row of open) {
      const event = events.get(row.message_ref);
      if (!event || event.event !== DLR_EVENT_DELIVERED) continue;
      await this.database.tenantTransaction(actor.tenantId, async (client) => {
        await client.query(
          'UPDATE message_delivery_retry_attempts SET dlr_event=$3, dlr_at=$4 WHERE retry_id=$1 AND attempt_no=$2',
          [row.id, row.attempt_no, event.event, event.at],
        );
        await this.terminate(
          client,
          row.id,
          'delivered',
          `retry ${row.attempt_no} on ${row.smsc_id ?? 'unknown bind'} was delivered`,
        );
      });
      settled += 1;
    }
    return settled;
  }

  // =========================================================================
  // DISPATCH — ONE RE-SEND
  // =========================================================================

  /**
   * Performs one retry. Every early exit terminates the chain with a reason
   * rather than leaving it open: an operator asking "why did this stop?" must
   * always get an answer out of the row.
   */
  async dispatch(actor: Actor, retryId: string): Promise<DispatchOutcome> {
    const loaded = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const chain = (
        await client.query<RetryChainRow>(
          `SELECT ${CHAIN_COLUMNS} FROM message_delivery_retries WHERE id=$1`,
          [retryId],
        )
      ).rows[0];
      if (!chain) throw new NotFoundException('Delivery retry not found');
      const policy = resolveRetryPolicy(await this.policyRows(client), {
        smscId: chain.origin_smsc_id,
        customerId: chain.customer_id,
      });
      const attemptRefs = (
        await client.query<{ message_ref: string }>(
          'SELECT message_ref FROM message_delivery_retry_attempts WHERE retry_id=$1 AND message_ref IS NOT NULL',
          [retryId],
        )
      ).rows.map((row) => row.message_ref);
      return { chain, policy, attemptRefs };
    });
    const { chain, policy } = loaded;

    if (chain.status !== 'pending' && chain.status !== 'retrying')
      return this.outcome(retryId, 'skipped', null, null, null, 0, `chain is ${chain.status}`);

    if (!policy.enabled)
      return this.finish(
        actor,
        retryId,
        'abandoned',
        'delivery retry was switched off before this attempt ran',
      );

    // LATE POSITIVE REPORT. The last read before anything is sent: if the
    // original message, or any retry of it, has since been reported delivered,
    // sending again would double-deliver and double-bill. This is why the
    // dispatch is delayed by `minDelaySeconds` in the first place.
    const correlations = [chain.origin_message_ref, ...loaded.attemptRefs];
    const events = await this.sqlbox.latestDeliveryEvents(correlations);
    const delivered = correlations.find((ref) => events.get(ref)?.event === DLR_EVENT_DELIVERED);
    if (delivered)
      return this.finish(
        actor,
        retryId,
        'delivered',
        `a delivered report arrived for ${delivered} after the failure; retry cancelled`,
      );

    // CLAIM. Committed before the send, with the budget in the predicate, so no
    // crash-loop or duplicate dispatcher can exceed max_attempts submissions.
    // The returned count is the fencing token for everything below.
    //
    // THE COST OF THAT ORDER, stated because it is a real trade and not a free
    // win: a crash between this commit and the send burns an attempt on a
    // message that was never re-sent. Incrementing afterwards instead would
    // remove that, at the price of letting a crash-loop send the same message
    // repeatedly. Under-sending is the safe direction here — the recipient gets
    // the message once or not at all, never twice, and the chain says why.
    const claimed = await this.database.tenantTransaction(actor.tenantId, (client) =>
      client
        .query<{ attempts: number }>(
          `UPDATE message_delivery_retries
              SET status='retrying', updated_at=now(), attempts = attempts + 1
            WHERE id=$1 AND status IN ('pending','retrying') AND attempts < max_attempts
            RETURNING attempts`,
          [retryId],
        )
        .then((result) => result.rows[0]),
    );
    if (!claimed)
      return this.finish(
        actor,
        retryId,
        'exhausted',
        `no attempts left (${chain.attempts} of ${chain.max_attempts} used)`,
      );
    const attemptNo = Number(claimed.attempts);

    const selection = await this.chooseBind(actor, chain, policy);
    if (!selection.smscId) {
      await this.recordAttempt(actor, chain, attemptNo, {
        outcome: 'no_bind',
        selection,
        messageRef: null,
        decisionId: null,
        charged: 0,
        reason: selection.reason,
      });
      return this.finish(actor, retryId, 'exhausted', selection.reason);
    }

    try {
      const result = await this.send.send(actor, {
        sender: chain.sender ?? '',
        receiver: chain.destination,
        text: chain.body,
        smscId: selection.smscId,
        customerId: chain.customer_id,
        // Not the original channel: this submission was decided by the platform,
        // not by whoever sent the message that failed, and the decision record
        // must not attribute it to them.
        channel: 'system',
        reference: `delivery-retry:${retryId}:${attemptNo}`,
        // 0 suppresses the credit debit only; quota is still consumed. See the
        // billing note on this class.
        cost: policy.chargeCreditOnRetry ? null : 0,
        onSubmitted: async (client, submitted) => {
          // Guarded on the fence AND protected by
          // UNIQUE (tenant_id, retry_id, attempt_no): if another dispatcher has
          // moved the counter, this matches nothing, the INSERT ... SELECT
          // returns no row, and throwing rolls the whole send back.
          const inserted = (
            await client.query<{ id: string }>(
              `INSERT INTO message_delivery_retry_attempts
                 (tenant_id,retry_id,attempt_no,smsc_id,excluded_smsc_ids,selection,outcome,
                  message_ref,decision_id,charged,reason)
               SELECT $1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10
                WHERE EXISTS (
                  SELECT 1 FROM message_delivery_retries
                   WHERE id=$2 AND status='retrying' AND attempts=$3
                )
               RETURNING id::text`,
              [
                actor.tenantId,
                retryId,
                attemptNo,
                selection.smscId,
                selection.excluded,
                selection.selection,
                submitted.sqlId,
                submitted.decisionId,
                0,
                selection.reason,
              ],
            )
          ).rows[0];
          if (!inserted)
            throw new Error(
              `delivery retry ${retryId} attempt ${attemptNo} was claimed by another worker; rolling this send back`,
            );
          await client.query(
            `UPDATE message_delivery_retries
                SET status='resent', tried_smsc_ids = tried_smsc_ids || $2::text,
                    job_id=NULL, updated_at=now()
              WHERE id=$1 AND attempts=$3`,
            [retryId, selection.smscId, attemptNo],
          );
        },
      });

      // Outside the send transaction: the charge is only known once send()
      // returns, and losing it must not roll a successful send back.
      await this.database.tenantTransaction(actor.tenantId, async (client) => {
        await client.query(
          'UPDATE message_delivery_retry_attempts SET charged=$3 WHERE retry_id=$1 AND attempt_no=$2',
          [retryId, attemptNo, result.charged ?? 0],
        );
        await this.audit(client, actor, 'delivery_retry.resent', 'delivery_retry', retryId, {
          attemptNo,
          smscId: result.smscId,
          originSmscId: chain.origin_smsc_id,
          messageRef: result.sqlId,
          destination: chain.destination,
          customerId: chain.customer_id,
          charged: result.charged,
          selection: selection.selection,
        });
      });

      return this.outcome(
        retryId,
        'submitted',
        attemptNo,
        result.smscId,
        result.sqlId,
        result.charged ?? 0,
        selection.reason,
      );
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      await this.recordAttempt(actor, chain, attemptNo, {
        outcome: 'refused',
        selection,
        messageRef: null,
        decisionId: null,
        charged: 0,
        reason: `refused: ${message}`,
      });
      // A refusal is a DECISION — blocklist, content filter, quota, credit,
      // sender-ID approval. Repeating it immediately could not change the
      // answer, so the chain ends here instead of burning its remaining budget
      // on the same refusal. MessageSendService has already written its own
      // `outcome='rejected'` decision row with the detail.
      await this.finish(actor, retryId, 'failed', `retry refused by the send path: ${message}`);
      return this.outcome(
        retryId,
        'refused',
        attemptNo,
        selection.smscId,
        null,
        0,
        `refused: ${message}`,
      );
    }
  }

  /**
   * The candidate set for one retry: healthy, tenant-owned, customer-entitled,
   * untried, inside the per-bind breaker budget. The routing engine is asked
   * first so route configuration still governs where traffic goes.
   */
  private chooseBind(
    actor: Actor,
    chain: RetryChainRow,
    policy: DeliveryRetryPolicy,
  ): Promise<BindSelection> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      // RLS scopes smsc_definitions, so `available` can only ever contain binds
      // this tenant owns. That is what stops a retry crossing tenants.
      const { available } = await this.routing.availability(client);

      let entitled: string[] | null = null;
      if (chain.customer_id) {
        const bindings = (
          await client.query<{ engine_id: string | null; route_target: string | null }>(
            `SELECT d.engine_id,
                    (SELECT e.engine_id FROM smsc_definitions e
                      WHERE e.id = r.target_smsc_id) AS route_target
               FROM customer_routes cr
               LEFT JOIN smsc_definitions d ON d.id = cr.smsc_id
               LEFT JOIN routing_rules r ON r.id = cr.route_id
              WHERE cr.customer_id=$1 AND cr.enabled=true`,
            [chain.customer_id],
          )
        ).rows;
        // No bindings at all means unconstrained, exactly as the send path's
        // own entitlement check reads it. Constraining here instead would make
        // a retry stricter than the original send.
        if (bindings.length)
          entitled = [
            ...new Set(
              bindings
                .flatMap((row) => [row.engine_id, row.route_target])
                .filter((value): value is string => Boolean(value)),
            ),
          ];
      }

      const recentByBind = await this.recentAttemptsByBind(client);

      let routed: string | null = null;
      try {
        const decision = await this.routing.resolveInClient(client, {
          msisdn: chain.destination,
          sender: chain.sender,
          customerId: chain.customer_id,
        });
        routed = decision.smscId;
      } catch {
        // An unroutable destination is not an error here: the fallback below
        // picks a healthy bind directly, and the original message provably went
        // out once, so a route having been withdrawn since must not strand it.
        routed = null;
      }

      return selectRetryBind({
        available,
        tried: chain.tried_smsc_ids ?? [],
        entitled,
        recentByBind,
        bindRetriesPerMinute: policy.bindRetriesPerMinute,
        routed,
        requireDifferentBind: policy.requireDifferentBind,
      });
    });
  }

  // =========================================================================
  // OPERATOR READS
  // =========================================================================

  listChains(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<RetryChainRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<RetryChainRow>(
        { select: `SELECT ${CHAIN_COLUMNS}`, from: 'FROM message_delivery_retries' },
        RETRY_CHAIN_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'DESC' } },
      ),
    );
  }

  listAttempts(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<RetryAttemptRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<RetryAttemptRow>(
        { select: `SELECT ${ATTEMPT_COLUMNS}`, from: 'FROM message_delivery_retry_attempts' },
        RETRY_ATTEMPT_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'DESC' } },
      ),
    );
  }

  /** The whole chain: the original message, and every carrier it was tried on. */
  async getChain(
    actor: Actor,
    id: string,
  ): Promise<RetryChainRow & { attempts_log: RetryAttemptRow[] }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const chain = (
        await client.query<RetryChainRow>(
          `SELECT ${CHAIN_COLUMNS} FROM message_delivery_retries WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!chain) throw new NotFoundException('Delivery retry not found');
      const attempts = (
        await client.query<RetryAttemptRow>(
          `SELECT ${ATTEMPT_COLUMNS} FROM message_delivery_retry_attempts
            WHERE retry_id=$1 ORDER BY attempt_no ASC`,
          [id],
        )
      ).rows;
      return { ...chain, attempts_log: attempts };
    });
  }

  status(actor: Actor): Promise<DeliveryRetryStateRow> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      this.state(client, actor.tenantId),
    );
  }

  /**
   * Runs one scan and, while any policy is enabled, schedules the next.
   *
   * `currentJobId` is not optional decoration. The job running this handler is
   * itself `status='running'` in `api_jobs` for the whole of the handler's life,
   * so an "is one already in flight?" check that did not exclude it would always
   * see itself, never enqueue a successor, and the poll chain would stop dead
   * after exactly one run.
   */
  async runScheduledScan(actor: Actor, options: { currentJobId?: string | null } = {}) {
    const result = await this.scan(actor);
    if (!result.enabled) return { ...result, nextScanScheduled: false };
    const scheduled = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      if (!scannableEvents(await this.policyRows(client)).length) return false;
      const state = await this.state(client, actor.tenantId);
      return this.ensureScanScheduled(
        client,
        actor,
        Number(state.poll_interval_seconds) || 60,
        options.currentJobId ?? null,
      );
    });
    return { ...result, nextScanScheduled: scheduled };
  }

  async setPollInterval(actor: Actor, seconds: number): Promise<DeliveryRetryStateRow> {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)
      throw new BadRequestException('pollIntervalSeconds must be an integer between 5 and 3600');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<DeliveryRetryStateRow>(
          `INSERT INTO delivery_retry_state (tenant_id, poll_interval_seconds) VALUES ($1,$2)
           ON CONFLICT (tenant_id) DO UPDATE SET poll_interval_seconds=$2, updated_at=now()
           RETURNING ${STATE_COLUMNS}`,
          [actor.tenantId, seconds],
        )
      ).rows[0];
      return row;
    });
  }

  // =========================================================================
  // INTERNALS
  // =========================================================================

  /** Engine-level SMSC ids the tenant owns (RLS-scoped smsc_definitions). */
  private async tenantSmscScope(client: PoolClient): Promise<string[]> {
    return (
      await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
    ).rows.map((row) => row.engine_id);
  }

  private async recentAttemptCount(client: PoolClient): Promise<number> {
    const row = (
      await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM message_delivery_retry_attempts
          WHERE created_at > now() - make_interval(secs => $1)`,
        [BREAKER_WINDOW_SECONDS],
      )
    ).rows[0];
    return Number(row?.count ?? 0);
  }

  private async recentAttemptsByBind(client: PoolClient): Promise<Record<string, number>> {
    const rows = (
      await client.query<{ smsc_id: string; count: string }>(
        `SELECT smsc_id, count(*)::text count FROM message_delivery_retry_attempts
          WHERE smsc_id IS NOT NULL AND created_at > now() - make_interval(secs => $1)
          GROUP BY smsc_id`,
        [BREAKER_WINDOW_SECONDS],
      )
    ).rows;
    return Object.fromEntries(rows.map((row) => [row.smsc_id, Number(row.count)]));
  }

  /** Reads (creating on first use) this tenant's scanner state row. */
  private async state(client: PoolClient, tenantId: string): Promise<DeliveryRetryStateRow> {
    const existing = (
      await client.query<DeliveryRetryStateRow>(
        `SELECT ${STATE_COLUMNS} FROM delivery_retry_state LIMIT 1`,
      )
    ).rows[0];
    if (existing) return existing;
    return (
      await client.query<DeliveryRetryStateRow>(
        `INSERT INTO delivery_retry_state (tenant_id) VALUES ($1)
         ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
         RETURNING ${STATE_COLUMNS}`,
        [tenantId],
      )
    ).rows[0];
  }

  private async recordScan(
    tenantId: string,
    watermark: string | null,
    error: string | null,
    counters?: { reportsScanned: number; chainsOpened: number },
  ): Promise<void> {
    await this.database
      .tenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO delivery_retry_state
             (tenant_id, watermark_sql_id, last_scanned_at, last_error, reports_seen, chains_opened)
           VALUES ($1, COALESCE($2::bigint, 0), now(), $3, $4, $5)
           ON CONFLICT (tenant_id) DO UPDATE SET
             watermark_sql_id = GREATEST(delivery_retry_state.watermark_sql_id, COALESCE($2::bigint, 0)),
             last_scanned_at = now(),
             last_error = $3,
             reports_seen = delivery_retry_state.reports_seen + $4,
             chains_opened = delivery_retry_state.chains_opened + $5,
             updated_at = now()`,
          [tenantId, watermark, error, counters?.reportsScanned ?? 0, counters?.chainsOpened ?? 0],
        );
      })
      .catch(() => undefined);
  }

  /**
   * Enqueues the next scan unless one is already queued or running. Without the
   * "unless", enabling a policy while a scan chain is already self-perpetuating
   * would leave two chains running forever, each spawning its own successor.
   *
   * `excludeJobId` is what keeps the chain alive. The scan job that calls this
   * from its own handler is `status='running'` for the whole call, so without
   * excluding itself it would always find an in-flight scan — itself — and the
   * chain would stop after one run. Callers that are NOT a scan job (an operator
   * enabling a policy) pass null and correctly defer to a scan already in
   * flight.
   */
  private async ensureScanScheduled(
    client: PoolClient,
    actor: Actor,
    delaySeconds: number,
    excludeJobId: string | null = null,
  ): Promise<boolean> {
    const inFlight = (
      await client.query(
        `SELECT 1 FROM api_jobs
          WHERE type=$1 AND status IN ('queued','running')
            AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
        [DELIVERY_RETRY_SCAN_JOB_TYPE, excludeJobId],
      )
    ).rows[0];
    if (inFlight) return false;
    await this.jobs.createOn(client, actor, {
      type: DELIVERY_RETRY_SCAN_JOB_TYPE,
      input: {},
      runAt: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : null,
    });
    return true;
  }

  /**
   * One dispatch job per (chain, attempt). The idempotency key is what makes
   * that structural: `api_jobs` carries UNIQUE (tenant_id, type,
   * idempotency_key), so a re-enqueue returns the existing job instead of
   * creating a second dispatcher for the same attempt.
   */
  private async enqueueDispatch(
    client: PoolClient,
    actor: Actor,
    retryId: string,
    attemptNo: number,
    delaySeconds: number,
  ): Promise<string> {
    const job = await this.jobs.createOn(client, actor, {
      type: DELIVERY_RETRY_DISPATCH_JOB_TYPE,
      input: { retryId },
      idempotencyKey: `delivery-retry:${retryId}:${attemptNo}`,
      runAt: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : null,
    });
    await client.query(
      'UPDATE message_delivery_retries SET job_id=$2, updated_at=now() WHERE id=$1',
      [retryId, job.id],
    );
    return job.id;
  }

  private terminate(
    client: PoolClient,
    retryId: string,
    status: RetryChainStatus,
    reason: string,
  ): Promise<unknown> {
    return client.query(
      `UPDATE message_delivery_retries
          SET status=$2, terminal_reason=$3, resolved_at=now(), job_id=NULL, updated_at=now()
        WHERE id=$1`,
      [retryId, status, reason],
    );
  }

  private async finish(
    actor: Actor,
    retryId: string,
    status: RetryChainStatus,
    reason: string,
  ): Promise<DispatchOutcome> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await this.terminate(client, retryId, status, reason);
      await this.audit(client, actor, `delivery_retry.${status}`, 'delivery_retry', retryId, {
        reason,
      });
    });
    return this.outcome(
      retryId,
      status === 'failed' ? 'refused' : (status as DispatchOutcome['outcome']),
      null,
      null,
      null,
      0,
      reason,
    );
  }

  private async recordAttempt(
    actor: Actor,
    chain: RetryChainRow,
    attemptNo: number,
    value: {
      outcome: RetryAttemptRow['outcome'];
      selection: BindSelection;
      messageRef: string | null;
      decisionId: string | null;
      charged: number;
      reason: string;
    },
  ): Promise<void> {
    await this.database
      .tenantTransaction(actor.tenantId, async (client) => {
        await client.query(
          `INSERT INTO message_delivery_retry_attempts
             (tenant_id,retry_id,attempt_no,smsc_id,excluded_smsc_ids,selection,outcome,
              message_ref,decision_id,charged,reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (tenant_id, retry_id, attempt_no) DO NOTHING`,
          [
            actor.tenantId,
            chain.id,
            attemptNo,
            value.selection.smscId,
            value.selection.excluded,
            value.selection.selection,
            value.outcome,
            value.messageRef,
            value.decisionId,
            value.charged,
            value.reason,
          ],
        );
      })
      .catch(() => undefined);
  }

  private outcome(
    retryId: string,
    outcome: DispatchOutcome['outcome'],
    attemptNo: number | null,
    smscId: string | null,
    messageRef: string | null,
    charged: number,
    reason: string,
  ): DispatchOutcome {
    return { retryId, outcome, attemptNo, smscId, messageRef, charged, reason };
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    newValue: unknown,
  ): Promise<unknown> {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, actor.userId, action, entityType, entityId, JSON.stringify(newValue ?? {})],
    );
  }
}

export interface DeliveryRetryStateRow {
  id: string;
  watermark_sql_id: string;
  poll_interval_seconds: number;
  last_scanned_at: string | Date | null;
  last_error: string | null;
  reports_seen: string;
  chains_opened: string;
  created_at: string | Date;
  updated_at: string | Date;
}
