import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { EngineBindSnapshot, EngineQueueSnapshot, KamexAdapter } from '../engine/kamex.adapter';
import { EngineSnapshotCache } from './engine-snapshot.cache';
import {
  BindState,
  isHardDown,
  isHealthy,
  severityFor,
  toBindState,
  toSmscHealthState,
} from './engine-bind-state';
import { ALERT_DEDUP_ESCALATION_SQL, readAlertUpsert } from './alert-correlation.service';

// Namespace for the per-tenant transaction-level advisory lock (arbitrary).
const POLLER_LOCK_NAMESPACE = 0x1e3f;

/** Dedup key for the "the engine itself is unreachable" alert. */
const ENGINE_UNREACHABLE_DEDUP = 'engine:unreachable';

/**
 * Canonical metric names the poller writes into `metric_samples`. Alert rules
 * authored in the console reference these strings in `alert_rules.metric`;
 * they are the contract between the poller and
 * {@link AlertRuleEvaluatorScheduler}. Per-bind metrics carry a `{smsc: <engine
 * id>}` label set, engine-wide metrics carry no labels.
 */
export const ENGINE_METRIC_NAMES = {
  bindUp: 'smsc.bind.up',
  bindQueued: 'smsc.queued',
  bindFailed: 'smsc.failed',
  bindSent: 'smsc.sent',
  bindReceived: 'smsc.received',
  bindOutboundRate: 'smsc.throughput.outbound',
  bindInboundRate: 'smsc.throughput.inbound',
  engineUp: 'engine.up',
  engineQueuedOutbound: 'engine.sms.queued.outbound',
  engineQueuedInbound: 'engine.sms.queued.inbound',
  engineDlrQueued: 'engine.dlr.queued',
  engineStoreSize: 'engine.store.size',
  engineBindsTotal: 'engine.binds.total',
  engineBindsBound: 'engine.binds.bound',
} as const;

interface SmscDefinitionRow {
  id: string;
  engine_id: string;
  name: string;
}

/**
 * Collapses the engine's per-connection bind reports into one entry per SMSC.
 *
 * Kamex's `instances = N` directive creates N connections from a single smsc
 * group, all sharing one `smsc-id`, and /status.json reports each separately.
 * Everything downstream is keyed on the SMSC definition, so they must be merged
 * before use.
 *
 * Health is OR, not last-seen: a carrier is reachable while at least one of its
 * connections is bound, and the engine spreads traffic across whichever are
 * usable. Queue depth and failure counts are summed, because those are the
 * carrier's totals. The surviving `status` is taken from a healthy connection
 * when one exists so the state vocabulary stays a real engine token rather than
 * a synthesised one; otherwise the first report is kept.
 */
export function collapseBindsByEngineId(binds: EngineBindSnapshot[]): EngineBindSnapshot[] {
  const merged = new Map<string, EngineBindSnapshot>();
  for (const bind of binds) {
    const current = merged.get(bind.engineId);
    if (!current) {
      merged.set(bind.engineId, { ...bind });
      continue;
    }
    const currentHealthy = isHealthy(toBindState(current.status));
    const incomingHealthy = isHealthy(toBindState(bind.status));
    merged.set(bind.engineId, {
      ...current,
      // Promote to a healthy token as soon as any connection reports one.
      status: currentHealthy || !incomingHealthy ? current.status : bind.status,
      queued: current.queued + bind.queued,
      failed: current.failed + bind.failed,
      sent: current.sent + bind.sent,
      received: current.received + bind.received,
    });
  }
  return [...merged.values()];
}

interface BindStateRow {
  state: string;
  consecutive_observations: number;
  failed_count: string | number;
  entered_at: string | Date;
}

export interface TenantPollResult {
  tenantId: string;
  /** Binds the engine reported that this tenant actually owns. */
  binds: number;
  transitions: number;
  alertsOpened: number;
  /** Open alerts re-sharpened because the condition got worse (see item 4). */
  alertsEscalated: number;
  alertsResolved: number;
  /** True when the advisory lock was held elsewhere and the cycle was skipped. */
  skipped: boolean;
}

function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Continuous SMSC bind/status polling (gap G14).
 *
 * Before this existed, `smsc_health` was written *only* inside
 * `completeSmscOperation` — i.e. only when an operator clicked something — so a
 * carrier bind that dropped at 03:00 was observed by nobody until someone
 * opened the page the next morning.
 *
 * Every cycle it:
 *
 *   1. calls the adapter's typed {@link KamexAdapter.queueSnapshot} exactly once
 *      (one engine, many tenants) and publishes it to {@link EngineSnapshotCache}
 *      so the Prometheus scrape can be served from cache and never blocks on the
 *      engine;
 *   2. for each enabled tenant, under a per-tenant transaction advisory lock,
 *      resolves which reported binds that tenant owns via
 *      `smsc_definitions.engine_id` — a bind no tenant owns is written nowhere,
 *      so one tenant can never read another's topology;
 *   3. persists the observation (`engine_poll_snapshots`, `smsc_bind_snapshots`,
 *      `metric_samples`);
 *   4. diffs the normalised Ch.22 state against `smsc_bind_state` and, on a
 *      change (or a jump in the failure counter), appends an immutable
 *      `smsc_bind_transitions` row plus an `audit_log` record and raises a
 *      deduplicated alert instance, which the existing escalation/notification
 *      machinery then delivers.
 *
 * Flap resistance comes from three independent mechanisms:
 *
 *   - a transition is only recorded when the *normalised* state actually
 *     differs, so a steady bind writes no history and raises nothing;
 *   - an unhealthy state must be confirmed by `consecutive_observations`
 *     successive polls before it alerts (1 for a hard-down state, 3 for a
 *     transitional one such as `connecting`, both configurable);
 *   - alerts carry a per-bind `dedup_key`, and migration 014's partial unique
 *     index makes re-raising a no-op while one is still open. Recovery resolves
 *     the open alert rather than opening a second one.
 *
 * An unreachable engine is handled explicitly: no bind is marked dead on
 * hearsay (we did not observe those binds at all), a single engine-level alert
 * is raised instead, and it is resolved when the engine answers again.
 *
 * Disabled under NODE_ENV=test and when SMSC_POLLER_ENABLED=false.
 */
@Injectable()
export class SmscStatusPoller implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private cycles = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly adapter: KamexAdapter,
    private readonly cache: EngineSnapshotCache,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.SMSC_POLLER_ENABLED === 'false') return;
    // KANNEL_ENGINE_ADAPTER Ch.21 asks for a configurable 5s/10s/1min refresh.
    const interval = this.clampInterval(Number(process.env.SMSC_POLLER_INTERVAL_MS ?? 30_000));
    this.timer = setInterval(() => void this.runCycle(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runCycle(), 10_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private clampInterval(value: number): number {
    if (!Number.isFinite(value)) return 30_000;
    return Math.min(Math.max(value, 5_000), 600_000);
  }

  /** Consecutive confirmations required before an unhealthy state alerts. */
  private confirmationsFor(state: BindState): number {
    if (isHardDown(state))
      return Math.max(1, toInt(process.env.SMSC_BIND_DOWN_CONFIRMATIONS ?? 1, 1));
    // `connecting` / `retrying` / `binding` are legitimate for a short while
    // after a restart, so they need to persist before anyone is woken.
    return Math.max(1, toInt(process.env.SMSC_BIND_TRANSITIONAL_CONFIRMATIONS ?? 3, 3));
  }

  private failureJumpThreshold(): number {
    return Math.max(1, toInt(process.env.SMSC_FAILURE_JUMP_THRESHOLD ?? 10, 10));
  }

  private retentionHours(): number {
    return Math.max(1, toInt(process.env.ENGINE_SAMPLE_RETENTION_HOURS ?? 72, 72));
  }

  /**
   * Polls the engine once and reconciles every enabled tenant against it.
   * Never throws: the engine adapter reports unreachability through
   * `source.status`, and a per-tenant database failure is logged and isolated.
   */
  async runCycle(now: Date = new Date()): Promise<TenantPollResult[]> {
    if (this.running) return [];
    this.running = true;
    this.cycles += 1;
    try {
      const snapshot = await this.adapter.queueSnapshot().catch((error): EngineQueueSnapshot => ({
        observedAt: now.toISOString(),
        engine: {
          status: 'unknown',
          version: null,
          uptimeSeconds: null,
          smsQueuedOut: null,
          smsQueuedIn: null,
          dlrQueued: null,
          storeSize: null,
        },
        binds: [],
        source: {
          status: 'unavailable',
          detail: `Engine poll threw: ${String((error as Error).message ?? error)}`,
        },
      }));
      // Publish before touching the database so /metrics reflects the engine
      // even when persistence is the thing that is broken.
      this.cache.set(snapshot, now);

      const tenants = await this.database
        .query<{ id: string }>('SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived')
        .catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'smsc status poll could not list tenants',
              error: String((error as Error).message ?? error),
            }),
          );
          return { rows: [] as Array<{ id: string }> };
        });

      const results: TenantPollResult[] = [];
      for (const tenant of tenants.rows) {
        const result = await this.runForTenant(tenant.id, snapshot, now).catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'smsc status poll failed for tenant',
              tenantId: tenant.id,
              error: String((error as Error).message ?? error),
            }),
          );
          return {
            tenantId: tenant.id,
            binds: 0,
            transitions: 0,
            alertsOpened: 0,
            alertsEscalated: 0,
            alertsResolved: 0,
            skipped: true,
          } satisfies TenantPollResult;
        });
        results.push(result);
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /** Reconciles one tenant against an already-taken engine snapshot. */
  async runForTenant(
    tenantId: string,
    snapshot: EngineQueueSnapshot,
    now: Date = new Date(),
  ): Promise<TenantPollResult> {
    const empty: TenantPollResult = {
      tenantId,
      binds: 0,
      transitions: 0,
      alertsOpened: 0,
      alertsEscalated: 0,
      alertsResolved: 0,
      skipped: true,
    };
    return this.database.tenantTransaction(tenantId, async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [POLLER_LOCK_NAMESPACE, Number(tenantId) % 2147483647],
      );
      if (!lock.rows[0]?.locked) return empty;

      const definitions = (
        await client.query<SmscDefinitionRow>(
          'SELECT id::text, engine_id, name FROM smsc_definitions WHERE enabled = true',
        )
      ).rows;
      const owned = new Map(definitions.map((row) => [row.engine_id, row]));
      // Only binds this tenant owns are ever considered; the engine is shared.
      const observed = snapshot.binds.filter((bind) => owned.has(bind.engineId));
      // Count every physical connection, before collapsing them per SMSC.
      const boundCount = observed.filter((bind) => isHealthy(toBindState(bind.status))).length;
      // One row per SMSC definition, not per connection. With `instances = N`
      // the engine reports N binds sharing one engine_id; smsc_bind_state is
      // keyed (tenant_id, smsc_id), so writing each one separately made N
      // upserts race into a single row and the last writer won. A carrier with
      // two healthy binds and one reconnecting could therefore be recorded as
      // unbound and dropped from availableSmscIds, taking working capacity out
      // of service. Collapse first: a carrier is usable while ANY of its
      // connections is bound, and its depth/failures are the sum across them.
      const binds = collapseBindsByEngineId(observed);

      await client.query(
        `INSERT INTO engine_poll_snapshots
           (tenant_id, source_status, source_detail, engine_status, engine_version,
            uptime_seconds, sms_queued_out, sms_queued_in, dlr_queued, store_size,
            binds_total, binds_online, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          tenantId,
          snapshot.source.status,
          snapshot.source.detail,
          snapshot.engine.status,
          snapshot.engine.version,
          snapshot.engine.uptimeSeconds,
          snapshot.engine.smsQueuedOut,
          snapshot.engine.smsQueuedIn,
          snapshot.engine.dlrQueued,
          // Null (not 0) when bearerbox reports the -1 "store unknown" sentinel.
          snapshot.engine.storeSize,
          binds.length,
          boundCount,
          now,
        ],
      );

      const result: TenantPollResult = {
        tenantId,
        binds: binds.length,
        transitions: 0,
        alertsOpened: 0,
        alertsEscalated: 0,
        alertsResolved: 0,
        skipped: false,
      };

      if (snapshot.source.status === 'unavailable') {
        // We did not observe the binds at all. Marking them dead would be a
        // guess; raise one honest engine-level alert instead.
        await this.sample(client, tenantId, ENGINE_METRIC_NAMES.engineUp, 0, {}, now);
        // Two different failures used to read identically as "SMS engine
        // unreachable". A rejected credential leaves the engine running and
        // healthy while JKANNEL slowly degrades its admin port with retries —
        // an entirely different fix from an engine that is down, in a different
        // system. The adapter can tell them apart (the unauthenticated /health
        // probe answers in one case and not the other), so the alert says which.
        const gate = this.adapter.gateState?.() ?? {
          kind: 'unknown' as const,
          suppressed: false,
          consecutiveFailures: 0,
        };
        const credentialFault = gate.kind === 'credentials';
        const unreachable = await this.openAlert(client, tenantId, {
          dedupKey: ENGINE_UNREACHABLE_DEDUP,
          severity: 'critical',
          summary: credentialFault
            ? 'SMS engine is UP but rejecting our credential — check KAMEX_STATUS_PASSWORD. ' +
              'Polling has been throttled because repeated bad authentications degrade the ' +
              "engine's admin port until it is restarted."
            : `SMS engine unreachable: ${snapshot.source.detail}`,
          details: {
            kind: credentialFault ? 'engine_credential_rejected' : 'engine_unreachable',
            detail: snapshot.source.detail,
            pollingSuppressed: gate.suppressed,
            consecutiveFailures: gate.consecutiveFailures,
          },
        });
        result.alertsOpened += unreachable.opened ? 1 : 0;
        result.alertsEscalated += unreachable.escalated ? 1 : 0;
        await this.pruneIfDue(client, now);
        return result;
      }

      result.alertsResolved += await this.resolveAlert(client, ENGINE_UNREACHABLE_DEDUP, now);
      await this.recordEngineSamples(client, tenantId, snapshot, binds.length, boundCount, now);

      for (const bind of binds) {
        const definition = owned.get(bind.engineId)!;
        const outcome = await this.reconcileBind(client, tenantId, definition, bind, now);
        result.transitions += outcome.transitions;
        result.alertsOpened += outcome.alertsOpened;
        result.alertsEscalated += outcome.alertsEscalated;
        result.alertsResolved += outcome.alertsResolved;
      }

      await this.pruneIfDue(client, now);
      return result;
    });
  }

  /** Persists, diffs and (if warranted) alerts on a single bind. */
  private async reconcileBind(
    client: PoolClient,
    tenantId: string,
    definition: SmscDefinitionRow,
    bind: EngineBindSnapshot,
    now: Date,
  ): Promise<{
    transitions: number;
    alertsOpened: number;
    alertsEscalated: number;
    alertsResolved: number;
  }> {
    const state = toBindState(bind.status);
    const label = definition.name || bind.name || bind.engineId;
    let transitions = 0;
    let alertsOpened = 0;
    let alertsEscalated = 0;
    let alertsResolved = 0;

    await client.query(
      `INSERT INTO smsc_bind_snapshots
         (tenant_id, smsc_id, engine_id, state, queued, failed, sent, received,
          outbound_rate, inbound_rate, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        tenantId,
        definition.id,
        bind.engineId,
        state,
        bind.queued,
        bind.failed,
        bind.sent,
        bind.received,
        bind.outboundRate[0] ?? 0,
        bind.inboundRate[0] ?? 0,
        now,
      ],
    );
    await this.recordBindSamples(client, tenantId, bind, state, now);

    // FOR UPDATE so two replicas cannot both decide they saw the transition
    // (belt and braces: the advisory lock already serialises the cycle).
    const previous = (
      await client.query<BindStateRow>(
        'SELECT state, consecutive_observations, failed_count, entered_at FROM smsc_bind_state WHERE smsc_id = $1 FOR UPDATE',
        [definition.id],
      )
    ).rows[0];

    const changed = !previous || previous.state !== state;
    const consecutive = changed ? 1 : previous.consecutive_observations + 1;

    if (changed) {
      transitions += 1;
      const kind = previous ? 'state_change' : 'first_observation';
      await client.query(
        `INSERT INTO smsc_bind_transitions
           (tenant_id, smsc_id, engine_id, kind, from_state, to_state, detail, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          tenantId,
          definition.id,
          bind.engineId,
          kind,
          previous?.state ?? null,
          state,
          JSON.stringify({
            engineStatus: bind.status,
            queued: bind.queued,
            failed: bind.failed,
            name: label,
          }),
          now,
        ],
      );
      await this.audit(client, tenantId, {
        action: `smsc.bind.${kind}`,
        entityId: definition.id,
        oldValue: previous ? { state: previous.state } : null,
        newValue: { state, engineId: bind.engineId, engineStatus: bind.status },
        reason: previous
          ? `Bind ${label} moved ${previous.state} -> ${state}`
          : `Bind ${label} first observed as ${state}`,
      });
      // Keep the console's existing health surface current; migration 006's
      // vocabulary is narrower than Ch.22's, so project onto it.
      await client.query(
        'INSERT INTO smsc_health (tenant_id, smsc_id, state, detail, observed_at) VALUES ($1,$2,$3,$4,$5)',
        [
          tenantId,
          definition.id,
          toSmscHealthState(state),
          `poller: engine reports '${bind.status}' (${state})`,
          now,
        ],
      );
    }

    await client.query(
      `INSERT INTO smsc_bind_state
         (tenant_id, smsc_id, engine_id, state, previous_state, consecutive_observations,
          failed_count, queued_count, entered_at, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, smsc_id) DO UPDATE SET
         engine_id = EXCLUDED.engine_id,
         state = EXCLUDED.state,
         previous_state = CASE WHEN smsc_bind_state.state = EXCLUDED.state
                               THEN smsc_bind_state.previous_state ELSE smsc_bind_state.state END,
         consecutive_observations = EXCLUDED.consecutive_observations,
         failed_count = EXCLUDED.failed_count,
         queued_count = EXCLUDED.queued_count,
         entered_at = CASE WHEN smsc_bind_state.state = EXCLUDED.state
                           THEN smsc_bind_state.entered_at ELSE EXCLUDED.entered_at END,
         observed_at = EXCLUDED.observed_at`,
      [
        tenantId,
        definition.id,
        bind.engineId,
        state,
        previous?.state ?? null,
        consecutive,
        bind.failed,
        bind.queued,
        now,
        now,
      ],
    );

    const bindDedup = `engine:bind:${bind.engineId}`;
    if (isHealthy(state)) {
      alertsResolved += await this.resolveAlert(client, bindDedup, now);
    } else if (consecutive >= this.confirmationsFor(state)) {
      const bindAlert = await this.openAlert(client, tenantId, {
        dedupKey: bindDedup,
        severity: severityFor(state),
        summary: `SMSC bind ${label} is ${state} (engine reports '${bind.status}')`,
        details: {
          kind: 'bind_state',
          smsc: bind.engineId,
          smscId: definition.id,
          state,
          previousState: previous?.state ?? null,
          consecutiveObservations: consecutive,
          queued: bind.queued,
          failed: bind.failed,
        },
      });
      alertsOpened += bindAlert.opened ? 1 : 0;
      // connecting -> disconnected is the canonical case: the same dedup key,
      // a worse severity, so the open alert is re-worded instead of left stale.
      alertsEscalated += bindAlert.escalated ? 1 : 0;
    }

    // A bind can stay nominally "bound" while the carrier rejects everything;
    // a jump in bearerbox's own failure counter is the signal for that.
    const previousFailed = toInt(previous?.failed_count, bind.failed);
    const jump = bind.failed - previousFailed;
    if (previous && jump >= this.failureJumpThreshold()) {
      transitions += 1;
      await client.query(
        `INSERT INTO smsc_bind_transitions
           (tenant_id, smsc_id, engine_id, kind, from_state, to_state, detail, observed_at)
         VALUES ($1,$2,$3,'failure_jump',$4,$5,$6,$7)`,
        [
          tenantId,
          definition.id,
          bind.engineId,
          previous.state,
          state,
          JSON.stringify({ from: previousFailed, to: bind.failed, jump }),
          now,
        ],
      );
      await this.audit(client, tenantId, {
        action: 'smsc.bind.failure_jump',
        entityId: definition.id,
        oldValue: { failed: previousFailed },
        newValue: { failed: bind.failed },
        reason: `Bind ${label} failure counter rose by ${jump}`,
      });
      const failureAlert = await this.openAlert(client, tenantId, {
        dedupKey: `engine:bind-failures:${bind.engineId}`,
        severity: 'warning',
        summary: `SMSC bind ${label} failure counter rose by ${jump} (now ${bind.failed})`,
        details: {
          kind: 'bind_failure_jump',
          smsc: bind.engineId,
          smscId: definition.id,
          from: previousFailed,
          to: bind.failed,
        },
      });
      alertsOpened += failureAlert.opened ? 1 : 0;
      alertsEscalated += failureAlert.escalated ? 1 : 0;
    }

    return { transitions, alertsOpened, alertsEscalated, alertsResolved };
  }

  private async recordBindSamples(
    client: PoolClient,
    tenantId: string,
    bind: EngineBindSnapshot,
    state: BindState,
    now: Date,
  ): Promise<void> {
    const labels = { smsc: bind.engineId };
    const pairs: Array<[string, number]> = [
      [ENGINE_METRIC_NAMES.bindUp, isHealthy(state) ? 1 : 0],
      [ENGINE_METRIC_NAMES.bindQueued, bind.queued],
      [ENGINE_METRIC_NAMES.bindFailed, bind.failed],
      [ENGINE_METRIC_NAMES.bindSent, bind.sent],
      [ENGINE_METRIC_NAMES.bindReceived, bind.received],
      [ENGINE_METRIC_NAMES.bindOutboundRate, bind.outboundRate[0] ?? 0],
      [ENGINE_METRIC_NAMES.bindInboundRate, bind.inboundRate[0] ?? 0],
    ];
    for (const [metric, value] of pairs)
      await this.sample(client, tenantId, metric, value, labels, now);
  }

  private async recordEngineSamples(
    client: PoolClient,
    tenantId: string,
    snapshot: EngineQueueSnapshot,
    bindsTotal: number,
    bindsBound: number,
    now: Date,
  ): Promise<void> {
    const pairs: Array<[string, number | null]> = [
      [ENGINE_METRIC_NAMES.engineUp, 1],
      [ENGINE_METRIC_NAMES.engineQueuedOutbound, snapshot.engine.smsQueuedOut],
      [ENGINE_METRIC_NAMES.engineQueuedInbound, snapshot.engine.smsQueuedIn],
      [ENGINE_METRIC_NAMES.engineDlrQueued, snapshot.engine.dlrQueued],
      // Deliberately omitted (not zeroed) when bearerbox reports -1.
      [ENGINE_METRIC_NAMES.engineStoreSize, snapshot.engine.storeSize],
      [ENGINE_METRIC_NAMES.engineBindsTotal, bindsTotal],
      [ENGINE_METRIC_NAMES.engineBindsBound, bindsBound],
    ];
    for (const [metric, value] of pairs) {
      if (value === null || value === undefined) continue;
      await this.sample(client, tenantId, metric, value, {}, now);
    }
  }

  private sample(
    client: PoolClient,
    tenantId: string,
    metric: string,
    value: number,
    labels: Record<string, string>,
    now: Date,
  ) {
    return client.query(
      'INSERT INTO metric_samples (tenant_id, metric, value, labels, observed_at) VALUES ($1,$2,$3,$4,$5)',
      [tenantId, metric, value, JSON.stringify(labels), now],
    );
  }

  private async audit(
    client: PoolClient,
    tenantId: string,
    entry: {
      action: string;
      entityId: string;
      oldValue: Record<string, unknown> | null;
      newValue: Record<string, unknown>;
      reason: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, old_value, new_value, reason)
       VALUES ($1, 'smsc-status-poller', $2, 'smsc_bind', $3, $4, $5, $6)`,
      [
        tenantId,
        entry.action,
        entry.entityId,
        entry.oldValue ? JSON.stringify(entry.oldValue) : null,
        JSON.stringify(entry.newValue),
        entry.reason,
      ],
    );
  }

  /** Opens a deduplicated alert instance. Returns 1 when a new one was created. */
  private async openAlert(
    client: PoolClient,
    tenantId: string,
    alert: {
      dedupKey: string;
      severity: 'info' | 'warning' | 'critical';
      summary: string;
      details: Record<string, unknown>;
    },
  ): Promise<{ opened: boolean; escalated: boolean }> {
    // The partial unique index from migration 014 makes this idempotent while
    // an instance for the same condition is still open/acknowledged, so a bind
    // that stays down cannot generate an alert per poll. When the *same*
    // condition degrades further the open alert is re-sharpened rather than
    // left with its first wording — see ALERT_DEDUP_ESCALATION_SQL.
    const result = await client.query(
      `INSERT INTO alert_instances (tenant_id, rule_id, status, severity, source, dedup_key, summary, details)
       VALUES ($1, NULL, 'open', $2, 'engine', $3, $4, $5)
       ${ALERT_DEDUP_ESCALATION_SQL}`,
      [tenantId, alert.severity, alert.dedupKey, alert.summary, JSON.stringify(alert.details)],
    );
    return readAlertUpsert(result);
  }

  /** Resolves any open alert for the dedup key. Returns how many were closed. */
  private async resolveAlert(client: PoolClient, dedupKey: string, now: Date): Promise<number> {
    // 'closed' is an operator's terminal decision; auto-resolution leaves it be.
    const result = await client.query(
      `UPDATE alert_instances SET status = 'resolved', resolved_at = $2
        WHERE dedup_key = $1 AND status NOT IN ('resolved', 'closed')`,
      [dedupKey, now],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Prunes the rolling sample tables. `smsc_bind_transitions` is deliberately
   * never pruned: Ch.22 requires bind history to be kept.
   */
  private async pruneIfDue(client: PoolClient, now: Date): Promise<void> {
    if (this.cycles % 20 !== 1) return;
    const cutoff = new Date(now.getTime() - this.retentionHours() * 3_600_000);
    await client.query('DELETE FROM metric_samples WHERE observed_at < $1', [cutoff]);
    await client.query('DELETE FROM smsc_bind_snapshots WHERE observed_at < $1', [cutoff]);
    await client.query('DELETE FROM engine_poll_snapshots WHERE observed_at < $1', [cutoff]);
  }
}
