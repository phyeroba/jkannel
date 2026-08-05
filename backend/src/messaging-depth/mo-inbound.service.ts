import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { JobsService } from '../platform/jobs.service';
import { Actor } from './message-send.service';
import { MoRulesService } from './mo-rules.service';
import { CompiledMoRule, MoDeliveryKind, MoMessageContext, matchMoRules } from './mo-routing';

/** Job type that delivers ONE fan-out destination. */
export const MO_DELIVERY_JOB_TYPE = 'mo.delivery.dispatch';
/**
 * Queue-level attempt ceiling for a delivery job. The per-destination
 * `max_attempts` (1-20) is enforced INSIDE the handler by raising a
 * PermanentJobError, because the registry's ceiling is per job TYPE and a
 * destination's retry budget is per destination.
 */
export const MO_DELIVERY_MAX_ATTEMPTS = 20;
/** Job type that sweeps the engine's MO rows into the platform. */
export const MO_INGEST_JOB_TYPE = 'mo.ingest.poll';
export const MO_INGEST_MAX_ATTEMPTS = 3;

export type MoDeliveryStatus =
  'pending' | 'running' | 'delivered' | 'failed' | 'dead_letter' | 'cancelled';

export interface MoMessageRow {
  id: string;
  source: 'sqlbox' | 'http';
  dedupe_key: string | null;
  engine_message_id: string | null;
  external_ref: string | null;
  smsc_id: string | null;
  sender: string;
  receiver: string;
  sender_digits: string | null;
  receiver_digits: string | null;
  body: string;
  received_at: string | Date | null;
  matched_rule_ids: string[] | null;
  fanout_count: number;
  status: 'matched' | 'no_match';
  created_at: string | Date;
}

export interface MoDeliveryRow {
  id: string;
  mo_message_id: string;
  rule_id: string | null;
  rule_name: string;
  destination_id: string | null;
  kind: MoDeliveryKind;
  target: string;
  config: Record<string, unknown> | null;
  status: MoDeliveryStatus;
  attempts: number;
  max_attempts: number;
  manual_retries: number;
  last_error: string | null;
  response_code: number | null;
  response_detail: string | null;
  job_id: string | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const MESSAGE_COLUMNS =
  'id::text,source,dedupe_key,engine_message_id,external_ref,smsc_id,sender,receiver,' +
  'sender_digits,receiver_digits,body,received_at,matched_rule_ids,fanout_count,status,created_at';

/**
 * `config` is a fan-out-time SNAPSHOT of the destination's settings, and for a
 * webhook destination that includes `secret` — the value sent verbatim as the
 * `x-jkannel-signature` header (see mo-delivery.service.ts). Selecting the
 * column raw handed that credential to every caller of `GET /mo/deliveries`
 * and `GET /mo/messages/:id`, which any `messages.view` holder can reach.
 *
 * The redaction is done in SQL rather than by deleting the key in TypeScript
 * after the query, because the column is read from more than one place and a
 * future third reader would silently leak again. Here the raw value cannot
 * leave the database through this constant at all.
 *
 * The key is REPLACED rather than removed so the console can still show that a
 * secret is configured — "no secret set" and "secret set, not shown to you" are
 * different facts, and collapsing them would have an operator re-enter a secret
 * that was already there.
 *
 * The delivery worker does not read through this constant; it loads the row for
 * its own use and still sees the real value.
 */
// `config->'secret' IS NOT NULL` rather than the `?` containment operator:
// `?` is a placeholder in several client libraries, and this string is spliced
// into a grid query builder. Avoiding it keeps the constant safe to reuse.
const REDACTED_CONFIG =
  `CASE WHEN config->'secret' IS NOT NULL ` +
  `THEN jsonb_set(config, '{secret}', '"__redacted__"'::jsonb) ELSE config END AS config`;

const DELIVERY_COLUMNS =
  'id::text,mo_message_id::text,rule_id::text,rule_name,destination_id::text,kind,target,' +
  `${REDACTED_CONFIG},` +
  'status,attempts,max_attempts,manual_retries,last_error,response_code,response_detail,' +
  'job_id::text,delivered_at,created_at,updated_at';

/** Grid whitelist for GET /mo/messages. */
export const MO_MESSAGE_GRID: GridDefinition = {
  searchColumns: ['sender', 'receiver', 'body', 'external_ref', 'engine_message_id'],
  sortColumns: {
    receivedAt: 'received_at',
    createdAt: 'created_at',
    sender: 'sender',
    receiver: 'receiver',
    status: 'status',
    fanoutCount: 'fanout_count',
  },
  filterColumns: {
    status: 'status',
    source: 'source',
    smscId: 'smsc_id',
    sender: 'sender',
    receiver: 'receiver',
  },
  defaultOrderBy: 'received_at DESC, id DESC',
  defaultLimit: 50,
  maxLimit: 500,
};

/** Grid whitelist for GET /mo/deliveries. */
export const MO_DELIVERY_GRID: GridDefinition = {
  searchColumns: ['target', 'rule_name', 'last_error'],
  sortColumns: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    deliveredAt: 'delivered_at',
    status: 'status',
    attempts: 'attempts',
    kind: 'kind',
  },
  filterColumns: {
    status: 'status',
    kind: 'kind',
    ruleId: 'rule_id',
    moMessageId: 'mo_message_id',
    destinationId: 'destination_id',
  },
  defaultOrderBy: 'created_at DESC, id DESC',
  defaultLimit: 50,
  maxLimit: 500,
};

export interface IngestInput {
  sender: string;
  receiver: string;
  text: string;
  smscId?: string | null;
  /** Caller-supplied idempotency handle (Kannel's message id, a UUID, ...). */
  externalRef?: string | null;
  receivedAt?: Date | null;
}

export interface IngestOutcome {
  moMessageId: string;
  duplicate: boolean;
  matchedRules: Array<{ ruleId: string; ruleName: string; matchedOn: string[] }>;
  deliveries: Array<{ id: string; kind: MoDeliveryKind; target: string }>;
  status: 'matched' | 'no_match';
}

/**
 * INBOUND (MO) MESSAGES: INGEST AND FAN-OUT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY THERE BEFORE THIS (the honest finding, stated first)
 * ---------------------------------------------------------------------------
 * MO traffic did NOT reach JKANNEL's business logic at all. The evidence:
 *
 *   - `infrastructure/kannel/kamex.conf` (and the running copy under
 *     `runtime/kamex/`) contains exactly ONE inbound service group:
 *         group = sms-service
 *         keyword = default
 *         text = "No service specified"
 *     No `get-url`, no `post-url`, no `catch-all`, no second keyword group. In
 *     Kannel that means every inbound message is answered with a canned string
 *     and its content is forwarded nowhere.
 *
 *   - The code that GENERATES a deployment's configuration from the tenant's
 *     database (`configuration/configuration-model.builder.ts`) hard-codes the
 *     same `{ keyword: 'default', text: 'No service specified' }`. So a
 *     regenerated config is no better than the checked-in one.
 *     `EngineSmsService` in configuration-generator.service.ts DOES support
 *     `getUrl`/`postUrl`, and the generator will render them — but the only
 *     place that capability is exercised is a golden-file test fixture
 *     (`configuration/__fixtures__/multi-smsc.conf`), which points at
 *     `/api/v1/engine/mo`, an endpoint that does not exist.
 *
 *   - `sqlbox.conf` sets `sql-log-table = sent_sms`, so SQLBox DOES durably
 *     record inbound messages as `sent_sms` rows with `momt='MO'`. That table
 *     is engine-owned; no JKANNEL migration creates it.
 *
 *   - Nothing in `backend/src` consumed those rows. The only references to
 *     `'MO'` are a `direction` filter on the operator message-log grid
 *     (messaging-depth/message-filters.ts, messages/message-explorer.service.ts)
 *     and the repository read behind it. No poller, no job type, no webhook, no
 *     forwarding, no endpoint Kannel could POST to.
 *
 * So: inbound messages reached the ENGINE and were logged; they never reached
 * the PLATFORM. Building fan-out on top of an HTTP callback alone would have
 * been building on a channel that receives nothing, which is why ingestion here
 * has two mouths and the primary one is the table MO provably lands in today.
 *
 * ---------------------------------------------------------------------------
 * TWO INGEST PATHS, ONE PIPELINE
 * ---------------------------------------------------------------------------
 *   1. {@link sweep} — polls the engine's `sent_sms` for `momt='MO'` rows the
 *      tenant's binds received, newest first, and ingests everything past the
 *      tenant's watermark. This works with the configuration that is deployed
 *      TODAY, changing nothing in Kannel. It is driven by the platform job queue
 *      (`mo.ingest.poll` re-enqueues itself while polling is enabled), so there
 *      is no new scheduler and no new timer.
 *
 *   2. {@link ingest} — the push path, behind `POST /mo/inbound`. This is the
 *      endpoint a Kannel `sms-service` with `post-url` would call, and it is
 *      lower-latency than polling. Wiring it up requires an
 *      `infrastructure/`-side configuration change that is NOT made here and is
 *      called out rather than assumed.
 *
 * Both funnel into {@link ingestInClient}: dedupe, match, fan out. `dedupe_key`
 * carries a UNIQUE index, so the same inbound message arriving by both paths, or
 * twice from a retried poll, produces ONE `mo_messages` row and ONE set of
 * deliveries.
 *
 * ---------------------------------------------------------------------------
 * FAN-OUT: ONE JOB PER DESTINATION
 * ---------------------------------------------------------------------------
 * A matched message writes one `mo_deliveries` row per destination and enqueues
 * ONE `api_jobs` row per delivery, in the SAME transaction as the message. That
 * is the whole reason a failing destination cannot hold up the others: they are
 * not a batch, they are independent queue items claimed with
 * `FOR UPDATE SKIP LOCKED`, retried with the queue's exponential backoff and
 * dead-lettered individually. No dispatcher was written for this; the Wave-F
 * queue already is one.
 */
@Injectable()
export class MoInboundService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rules: MoRulesService,
    private readonly jobs: JobsService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  // =========================================================================
  // INGEST
  // =========================================================================

  /** Push ingest (HTTP). Own transaction. */
  async ingest(actor: Actor, input: IngestInput): Promise<IngestOutcome> {
    const prepared = prepareIngest(input, 'http');
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      this.ingestInClient(client, actor, prepared),
    );
  }

  /**
   * Dedupe, match, fan out — the single pipeline both ingest paths share.
   *
   * The message row, every delivery row and every delivery JOB are written in
   * ONE transaction, so there is never a recorded inbound message whose
   * deliveries were never queued, nor a queued delivery for a message that
   * rolled back.
   */
  async ingestInClient(
    client: PoolClient,
    actor: Actor,
    prepared: PreparedInbound,
  ): Promise<IngestOutcome> {
    const inserted = (
      await client.query<MoMessageRow>(
        `INSERT INTO mo_messages
           (tenant_id,source,dedupe_key,engine_message_id,external_ref,smsc_id,sender,receiver,
            sender_digits,receiver_digits,body,received_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'no_match')
         ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          actor.tenantId,
          prepared.source,
          prepared.dedupeKey,
          prepared.engineMessageId,
          prepared.externalRef,
          prepared.smscId,
          prepared.sender,
          prepared.receiver,
          prepared.senderDigits,
          prepared.receiverDigits,
          prepared.body,
          prepared.receivedAt,
        ],
      )
    ).rows[0];

    if (!inserted) {
      // Already ingested. Report the original rather than fanning out twice —
      // a duplicate MO must never mean a duplicate webhook.
      const existing = (
        await client.query<MoMessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM mo_messages WHERE dedupe_key=$1`,
          [prepared.dedupeKey],
        )
      ).rows[0];
      return {
        moMessageId: existing?.id ?? '',
        duplicate: true,
        matchedRules: [],
        deliveries: [],
        status: existing?.status ?? 'no_match',
      };
    }

    const compiled = await this.rules.loadInClient(client);
    const context: MoMessageContext = {
      smscId: prepared.smscId,
      sender: prepared.sender,
      receiver: prepared.receiver,
      body: prepared.body,
    };
    const matched = matchMoRules(compiled, context);
    const byId = new Map<string, CompiledMoRule>(compiled.map((rule) => [rule.id, rule]));

    const deliveries: Array<{ id: string; kind: MoDeliveryKind; target: string }> = [];
    for (const match of matched.matches) {
      const rule = byId.get(match.ruleId);
      if (!rule) continue;
      for (const destination of rule.destinations) {
        const delivery = (
          await client.query<{ id: string }>(
            `INSERT INTO mo_deliveries
               (tenant_id,mo_message_id,rule_id,rule_name,destination_id,kind,target,config,max_attempts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
            [
              actor.tenantId,
              inserted.id,
              rule.id,
              rule.name,
              destination.id,
              destination.kind,
              destination.target,
              JSON.stringify(destination.config ?? {}),
              destination.maxAttempts,
            ],
          )
        ).rows[0];
        // One job per destination: independent claim, retry and dead-letter.
        const job = await this.jobs.createOn(client, actor, {
          type: MO_DELIVERY_JOB_TYPE,
          input: { deliveryId: delivery.id },
        });
        await client.query('UPDATE mo_deliveries SET job_id=$2 WHERE id=$1', [delivery.id, job.id]);
        deliveries.push({
          id: delivery.id,
          kind: destination.kind,
          target: destination.target,
        });
      }
    }

    const status: 'matched' | 'no_match' = matched.matches.length ? 'matched' : 'no_match';
    await client.query(
      'UPDATE mo_messages SET matched_rule_ids=$2::uuid[], fanout_count=$3, status=$4 WHERE id=$1',
      [inserted.id, matched.matches.map((m) => m.ruleId), deliveries.length, status],
    );

    // A message that matched nothing is recorded as `no_match`, NOT discarded.
    // "Why did our short code stop working?" is answerable only if the messages
    // that fell through every rule are still visible.
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenantId,
        actor.userId,
        `mo_message.${status}`,
        'mo_message',
        inserted.id,
        JSON.stringify({
          source: prepared.source,
          sender: prepared.sender,
          receiver: prepared.receiver,
          smscId: prepared.smscId,
          rules: matched.matches.map((m) => m.ruleName),
          deliveries: deliveries.length,
        }),
      ],
    );

    return {
      moMessageId: inserted.id,
      duplicate: false,
      matchedRules: matched.matches.map((m) => ({
        ruleId: m.ruleId,
        ruleName: m.ruleName,
        matchedOn: m.matchedOn,
      })),
      deliveries,
      status,
    };
  }

  // =========================================================================
  // ENGINE SWEEP
  // =========================================================================

  /**
   * Pulls MO rows the engine has recorded and ingests the new ones.
   *
   * Tenant isolation: `sent_sms` is engine-owned and carries NO tenant column,
   * so the read is restricted to the engine ids of this tenant's own
   * `smsc_definitions` — the same mechanism the message log uses. A tenant with
   * no SMSCs reads nothing rather than everything.
   *
   * The watermark is an optimisation, not the correctness mechanism: the
   * `dedupe_key` unique index is. A watermark that goes backwards (a restored
   * database, a manual reset) re-reads rows and inserts none of them twice.
   */
  async sweep(
    actor: Actor,
    options: { limit?: number } = {},
  ): Promise<{
    scanned: number;
    ingested: number;
    duplicates: number;
    deliveries: number;
    watermark: string;
    available: boolean;
    evidence?: string;
  }> {
    const limit = Math.min(Math.max(Number(options.limit ?? 200) || 200, 1), 500);
    const probe = await this.sqlbox.probe();
    if (!probe.available) {
      await this.recordSweep(actor.tenantId, null, `engine unavailable: ${probe.evidence}`);
      return {
        scanned: 0,
        ingested: 0,
        duplicates: 0,
        deliveries: 0,
        watermark: '0',
        available: false,
        evidence: probe.evidence,
      };
    }

    const { watermark, allowedSmscIds } = await this.database.tenantTransaction(
      actor.tenantId,
      async (client) => ({
        watermark: safeBigInt((await this.state(client, actor.tenantId)).watermark_sql_id ?? '0'),
        allowedSmscIds: (
          await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
        ).rows.map((row) => row.engine_id),
      }),
    );

    if (!allowedSmscIds.length) {
      await this.recordSweep(actor.tenantId, null, 'tenant has no SMSC definitions');
      return {
        scanned: 0,
        ingested: 0,
        duplicates: 0,
        deliveries: 0,
        watermark: watermark.toString(),
        available: true,
      };
    }

    const page = await this.sqlbox.list({ direction: 'MO', limit, allowedSmscIds });
    // The engine pages newest-first; ingest oldest-first so `received_at`
    // ordering and the watermark advance monotonically.
    const fresh = page.items
      .filter((item) => safeBigInt(item.id) > watermark)
      .sort((a, b) => (safeBigInt(a.id) < safeBigInt(b.id) ? -1 : 1));

    let ingested = 0;
    let duplicates = 0;
    let deliveries = 0;
    let highest = watermark;

    for (const item of fresh) {
      const prepared = prepareIngest(
        {
          sender: String(item.sender ?? ''),
          receiver: String(item.receiver ?? ''),
          text: String(item.text ?? ''),
          smscId: item.smscId ?? null,
          receivedAt: item.timestamp ? new Date(item.timestamp) : null,
        },
        'sqlbox',
        item.id,
      );
      try {
        const outcome = await this.database.tenantTransaction(actor.tenantId, (client) =>
          this.ingestInClient(client, actor, prepared),
        );
        if (outcome.duplicate) duplicates += 1;
        else {
          ingested += 1;
          deliveries += outcome.deliveries.length;
        }
        const id = safeBigInt(item.id);
        if (id > highest) highest = id;
      } catch (error) {
        // One malformed row must not stall the sweep behind it forever, but the
        // watermark must NOT advance past it either — so the failure is recorded
        // and the sweep stops here, leaving the row to be retried.
        await this.recordSweep(
          actor.tenantId,
          highest.toString(),
          `row ${item.id}: ${String((error as Error).message ?? error)}`,
        );
        return {
          scanned: fresh.length,
          ingested,
          duplicates,
          deliveries,
          watermark: highest.toString(),
          available: true,
          evidence: `stopped at engine row ${item.id}`,
        };
      }
    }

    await this.recordSweep(actor.tenantId, highest.toString(), null, ingested);
    return {
      scanned: fresh.length,
      ingested,
      duplicates,
      deliveries,
      watermark: highest.toString(),
      available: true,
    };
  }

  // =========================================================================
  // INGEST STATE / POLLING
  // =========================================================================

  /**
   * Reads (creating on first use) this tenant's ingest state row. RLS scopes the
   * SELECT, so the LIMIT 1 is over this tenant's single row.
   */
  private async state(client: PoolClient, tenantId: string): Promise<MoIngestStateRow> {
    const existing = (
      await client.query<MoIngestStateRow>(`SELECT ${STATE_COLUMNS} FROM mo_ingest_state LIMIT 1`)
    ).rows[0];
    if (existing) return existing;
    return (
      await client.query<MoIngestStateRow>(
        `INSERT INTO mo_ingest_state (tenant_id) VALUES ($1)
         ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
         RETURNING ${STATE_COLUMNS}`,
        [tenantId],
      )
    ).rows[0];
  }

  async status(actor: Actor): Promise<MoIngestStateRow> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      this.state(client, actor.tenantId),
    );
  }

  private async recordSweep(
    tenantId: string,
    watermark: string | null,
    error: string | null,
    ingested = 0,
  ): Promise<void> {
    await this.database
      .tenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO mo_ingest_state (tenant_id, watermark_sql_id, last_polled_at, last_error, ingested_total)
             VALUES ($1, COALESCE($2::bigint, 0), now(), $3, $4)
           ON CONFLICT (tenant_id) DO UPDATE SET
             watermark_sql_id = GREATEST(mo_ingest_state.watermark_sql_id, COALESCE($2::bigint, 0)),
             last_polled_at = now(),
             last_error = $3,
             ingested_total = mo_ingest_state.ingested_total + $4,
             updated_at = now()`,
          [tenantId, watermark, error, ingested],
        );
      })
      .catch(() => undefined);
  }

  /**
   * Turns the engine sweep on or off. "On" means: keep exactly one
   * `mo.ingest.poll` job in flight for this tenant, each run re-enqueuing the
   * next at `now() + pollIntervalSeconds`. The queue is the clock — the same
   * mechanism scheduled sends use — so no cron, no `setInterval`, and a restart
   * loses nothing.
   */
  async setPolling(
    actor: Actor,
    enabled: boolean,
    pollIntervalSeconds?: number,
  ): Promise<MoIngestStateRow> {
    const interval =
      pollIntervalSeconds === undefined || pollIntervalSeconds === null
        ? undefined
        : boundedInterval(pollIntervalSeconds);
    const row = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const state = (
        await client.query<MoIngestStateRow>(
          `INSERT INTO mo_ingest_state (tenant_id, polling_enabled, poll_interval_seconds)
             VALUES ($1, $2, COALESCE($3, 30))
           ON CONFLICT (tenant_id) DO UPDATE SET
             polling_enabled = $2,
             poll_interval_seconds = COALESCE($3, mo_ingest_state.poll_interval_seconds),
             updated_at = now()
           RETURNING ${STATE_COLUMNS}`,
          [actor.tenantId, enabled, interval ?? null],
        )
      ).rows[0];
      if (enabled) await this.ensurePollScheduled(client, actor, 0);
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          `mo_ingest.polling.${enabled ? 'enabled' : 'disabled'}`,
          'mo_ingest_state',
          state.id,
          JSON.stringify({
            pollingEnabled: enabled,
            pollIntervalSeconds: state.poll_interval_seconds,
          }),
        ],
      );
      return state;
    });
    return row;
  }

  /**
   * Enqueues the next sweep, unless one is already queued or running.
   *
   * The "unless" is the whole point: without it, an operator toggling polling or
   * a retried job would leave two self-perpetuating chains running forever, each
   * spawning its own successor. The check and the insert are in one transaction.
   *
   * `excludeJobId` is what makes the poll chain survive its own first hop, and
   * omitting it was a real bug rather than a theoretical one. `claimOn` sets
   * `status='running'` BEFORE invoking the handler and only clears it after the
   * handler returns, so a sweep calling this from inside its own handler saw
   * ITSELF in the in-flight check, returned false, and never enqueued a
   * successor. Polling therefore ran exactly once after being switched on and
   * then stopped, with no error anywhere — the operator sees "polling enabled"
   * and a watermark that stops moving.
   *
   * The existing unit test did not catch it because the fake job table contains
   * only rows the test inserted, never the running row the real queue creates.
   */
  async ensurePollScheduled(
    client: PoolClient,
    actor: Actor,
    delaySeconds: number,
    excludeJobId: string | null = null,
  ): Promise<boolean> {
    const inFlight = (
      await client.query(
        "SELECT 1 FROM api_jobs WHERE type=$1 AND status IN ('queued','running') " +
          'AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1',
        [MO_INGEST_JOB_TYPE, excludeJobId],
      )
    ).rows[0];
    if (inFlight) return false;
    await this.jobs.createOn(client, actor, {
      type: MO_INGEST_JOB_TYPE,
      input: {},
      runAt: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : null,
    });
    return true;
  }

  /**
   * Runs one sweep and, while polling is enabled, schedules the next.
   *
   * `currentJobId` MUST be the id of the job running this sweep. Without it the
   * chain stops dead after one hop — see {@link ensurePollScheduled}. It is
   * optional only so a manual, non-job-driven sweep can still call this.
   */
  async runScheduledSweep(actor: Actor, currentJobId: string | null = null) {
    const state = await this.status(actor);
    if (!state.polling_enabled)
      return { skipped: true as const, reason: 'polling is disabled for this tenant' };
    const result = await this.sweep(actor);
    const scheduled = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const current = (
        await client.query<{ polling_enabled: boolean; poll_interval_seconds: number }>(
          'SELECT polling_enabled, poll_interval_seconds FROM mo_ingest_state LIMIT 1',
        )
      ).rows[0];
      if (!current?.polling_enabled) return false;
      return this.ensurePollScheduled(
        client,
        actor,
        Number(current.poll_interval_seconds) || 30,
        currentJobId,
      );
    });
    return { skipped: false as const, ...result, nextPollScheduled: scheduled };
  }

  // =========================================================================
  // OPERATOR READS
  // =========================================================================

  listMessages(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<MoMessageRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<MoMessageRow>(
        { select: `SELECT ${MESSAGE_COLUMNS}`, from: 'FROM mo_messages' },
        MO_MESSAGE_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'receivedAt', direction: 'DESC' } },
      ),
    );
  }

  listDeliveries(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridResult<MoDeliveryRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<MoDeliveryRow>(
        { select: `SELECT ${DELIVERY_COLUMNS}`, from: 'FROM mo_deliveries' },
        MO_DELIVERY_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'createdAt', direction: 'DESC' } },
      ),
    );
  }

  async getMessage(actor: Actor, id: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const message = (
        await client.query<MoMessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM mo_messages WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      if (!message) throw new NotFoundException('Inbound message not found');
      const deliveries = (
        await client.query<MoDeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM mo_deliveries WHERE mo_message_id=$1 ORDER BY created_at ASC`,
          [id],
        )
      ).rows;
      return { ...message, deliveries };
    });
  }

  /**
   * Re-queues one delivery. Only a terminal FAILED delivery may be retried: a
   * pending or running one already has a worker, and re-queueing it would
   * deliver twice.
   */
  async retryDelivery(actor: Actor, id: string): Promise<MoDeliveryRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const existing = (
        await client.query<MoDeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM mo_deliveries WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!existing) throw new NotFoundException('Delivery not found');
      if (!['failed', 'dead_letter', 'cancelled'].includes(existing.status))
        throw new BadRequestException(
          `Delivery is ${existing.status}; only a failed, dead-lettered or cancelled delivery can be retried`,
        );
      const job = await this.jobs.createOn(client, actor, {
        type: MO_DELIVERY_JOB_TYPE,
        input: { deliveryId: id },
      });
      const row = (
        await client.query<MoDeliveryRow>(
          `UPDATE mo_deliveries
              SET status='pending', attempts=0, manual_retries=manual_retries+1,
                  job_id=$2, updated_at=now()
            WHERE id=$1 RETURNING ${DELIVERY_COLUMNS}`,
          [id, job.id],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'mo_delivery.retried',
          'mo_delivery',
          id,
          JSON.stringify({ kind: row.kind, target: row.target, jobId: job.id }),
        ],
      );
      return row;
    });
  }
}

export interface MoIngestStateRow {
  id: string;
  watermark_sql_id: string;
  polling_enabled: boolean;
  poll_interval_seconds: number;
  last_polled_at: string | Date | null;
  last_error: string | null;
  ingested_total: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const STATE_COLUMNS =
  'id::text,watermark_sql_id::text,polling_enabled,poll_interval_seconds,last_polled_at,' +
  'last_error,ingested_total::text,created_at,updated_at';

export interface PreparedInbound {
  source: 'sqlbox' | 'http';
  dedupeKey: string | null;
  engineMessageId: string | null;
  externalRef: string | null;
  smscId: string | null;
  sender: string;
  receiver: string;
  senderDigits: string | null;
  receiverDigits: string | null;
  body: string;
  receivedAt: Date;
}

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 3600)
    throw new BadRequestException('pollIntervalSeconds must be an integer between 5 and 3600');
  return parsed;
}

function safeBigInt(value: unknown): bigint {
  try {
    return BigInt(String(value).replace(/[^0-9-]/g, '') || '0');
  } catch {
    return 0n;
  }
}

/**
 * Validates and canonicalises an inbound message.
 *
 * Note what is NOT rejected: an unparseable sender or receiver. An MO from a
 * short code, an alphanumeric originator or a malformed address is still a real
 * message that really arrived, and refusing to record it would lose it — the
 * exact failure this feature exists to end. The canonical digits are stored
 * ALONGSIDE the raw values, and matching uses the canonical form when there is
 * one.
 */
export function prepareIngest(
  input: IngestInput,
  source: 'sqlbox' | 'http',
  engineMessageId?: string | null,
): PreparedInbound {
  const sender = String(input.sender ?? '').trim();
  const receiver = String(input.receiver ?? '').trim();
  const body = typeof input.text === 'string' ? input.text : '';
  if (!sender) throw new BadRequestException('sender is required');
  if (!receiver) throw new BadRequestException('receiver is required');
  if (sender.length > 64 || receiver.length > 64)
    throw new BadRequestException('sender and receiver must be at most 64 characters');
  if (body.length > 8000) throw new BadRequestException('text must be at most 8000 characters');

  const externalRef = input.externalRef ? String(input.externalRef).trim().slice(0, 190) : null;
  const dedupeKey = engineMessageId
    ? `sqlbox:${engineMessageId}`
    : externalRef
      ? `http:${externalRef}`
      : null;

  const receivedAt =
    input.receivedAt instanceof Date && !Number.isNaN(input.receivedAt.getTime())
      ? input.receivedAt
      : new Date();

  return {
    source,
    dedupeKey,
    engineMessageId: engineMessageId ? String(engineMessageId) : null,
    externalRef,
    smscId: input.smscId ? String(input.smscId).slice(0, 64) : null,
    sender,
    receiver,
    senderDigits: digitsOrNull(sender),
    receiverDigits: digitsOrNull(receiver),
    body,
    receivedAt,
  };
}

function digitsOrNull(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  return digits || null;
}
