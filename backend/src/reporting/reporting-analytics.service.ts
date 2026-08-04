import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface Actor {
  tenantId: string;
}

/**
 * Delivery outcome counts for one scope, plus the rates derived from them.
 * Sourced from the engine repository's latest-DLR correlation — see
 * {@link summariseOutcomes} for why the rate is not simply dlrs/messages.
 */
export interface DeliveryOutcomes {
  delivered: number;
  failed: number;
  rejected: number;
  buffered: number;
  accepted: number;
  pending: number;
  unknown: number;
  /** delivered + failed + rejected: messages whose fate is decided. */
  finalised: number;
  /** buffered + accepted: acknowledged by the SMSC but not yet resolved. */
  inFlight: number;
  /** delivered / finalised. null when nothing has finalised yet. */
  successRate: number | null;
  /** (failed + rejected) / finalised. null when nothing has finalised yet. */
  failureRate: number | null;
}

export interface SuccessRateGroup {
  label: string;
  messages: number;
  dlrs: number;
  /**
   * delivered / (delivered + failed + rejected). NOTE: this used to be
   * dlrs/messages, which counted a *failure* receipt as a success.
   */
  successRate: number | null;
  failureRate: number | null;
  /**
   * The former meaning of successRate, kept under an honest name: the share of
   * messages that produced any delivery report at all, of any outcome.
   */
  dlrRate: number | null;
  // Raw counts behind the rate, so an operator can see why it is what it is and
  // judge a rate computed over a tiny sample. null when SQLBox is unavailable.
  delivered: number | null;
  failed: number | null;
  rejected: number | null;
  pending: number | null;
  inFlight: number | null;
  finalised: number | null;
}
export interface HeatmapCell {
  dow: number;
  hour: number;
  count: number;
}

const UNAVAILABLE = {
  status: 'unavailable' as const,
  code: 'SQLBOX_NOT_AVAILABLE',
  message: 'KAMEX_SQLBOX_DATABASE_URL is not configured',
};
const AVAILABLE = { status: 'available' as const, type: 'kamex-sqlbox' };

/**
 * Honest zero-denominator division, rounded to 4dp. null (not 0, not 1) when
 * there is nothing to divide by — the convention used throughout this service.
 */
const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;

const percent = (rate: number | null): number | null =>
  rate === null ? null : Math.round(rate * 1000) / 10;

/**
 * Turns the engine repository's per-status counts into an outcome summary.
 *
 * successRate is delivered / (delivered + failed + rejected): only messages
 * whose outcome is final count. Messages still in flight (buffered/accepted) or
 * awaiting a receipt (pending) are excluded from both sides, so a backlog
 * neither flatters nor penalises the rate, and a carrier that rejects
 * everything scores 0 — not the 100% that a "does a DLR exist?" test reported.
 */
export function summariseOutcomes(counts: {
  delivered: number;
  failed: number;
  rejected: number;
  buffered: number;
  accepted: number;
  pending: number;
  unknown: number;
}): DeliveryOutcomes {
  const finalised = counts.delivered + counts.failed + counts.rejected;
  return {
    delivered: counts.delivered,
    failed: counts.failed,
    rejected: counts.rejected,
    buffered: counts.buffered,
    accepted: counts.accepted,
    pending: counts.pending,
    unknown: counts.unknown,
    finalised,
    inFlight: counts.buffered + counts.accepted,
    successRate: ratio(counts.delivered, finalised),
    failureRate: ratio(counts.failed + counts.rejected, finalised),
  };
}

/**
 * Explains the two different windows the success-rate reports combine, because
 * they are not the same period: messages/dlrs come from the immutable snapshot
 * for the period shown, while the delivery outcomes are derived live from raw
 * SQLBox rows (which the snapshot table does not record) and therefore cover
 * everything still inside the SQLBox retention window.
 */
const OUTCOME_NOTE =
  'successRate is delivered / (delivered + failed + rejected), derived from each ' +
  "message's latest delivery report (dlr_mask on the DLR row); pending and in-flight " +
  'messages are excluded from both sides and the rate is null when nothing has ' +
  'finalised. messages/dlrs are the snapshot counts for the period shown, while the ' +
  'delivery outcome counts are computed live over the SQLBox retention window.';

/**
 * Analytics behind the Reports screen: KPI cards, chart series and grouped
 * breakdowns computed from the persisted daily/weekly report snapshots (see
 * ReportJobsService) plus live SQLBox queue depth. Also publishes the catalog
 * of report categories/kinds the spec defines so the UI can offer more than one
 * kind of report.
 */
@Injectable()
export class ReportingAnalyticsService implements OnModuleDestroy {
  // Read-only pool onto the engine-owned SQLBox database, used by the heatmap
  // and latency report kinds that aggregate raw sent_sms rows. Lazily created
  // (and only when configured) so unit tests and SQLBox-less deployments never
  // open a connection. `undefined` = not yet resolved, `null` = unconfigured.
  private sqlboxPool?: Pool | null;

  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  private pool(): Pool | null {
    if (this.sqlboxPool === undefined) {
      const url = process.env.KAMEX_SQLBOX_DATABASE_URL;
      this.sqlboxPool = url
        ? new Pool({
            connectionString: url,
            max: 2,
            application_name: 'jkannel-reporting-analytics',
          })
        : null;
    }
    return this.sqlboxPool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sqlboxPool?.end();
  }

  /** Engine-level SMSC identifiers the tenant owns (RLS-scoped). */
  private tenantSmscEngineIds(actor: Actor): Promise<string[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) =>
      (
        await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      ).rows.map((row) => row.engine_id),
    );
  }

  /**
   * Delivery outcomes for the tenant's SMSCs (optionally a single one), via the
   * engine repository's shared latest-DLR derivation. Deliberately delegates
   * rather than re-deriving the mask mapping: two implementations of "what does
   * dlr_mask mean" would inevitably diverge, and only the DLR row's mask is an
   * event — an MT row's dlr_mask (usually 31) is a subscription, not a status.
   *
   * Returns null when SQLBox is unconfigured or the query fails, so callers
   * report an honest null rate instead of a wrong one.
   */
  private async outcomesFor(
    allowedSmscIds: string[],
    smscId?: string,
  ): Promise<DeliveryOutcomes | null> {
    if (!allowedSmscIds.length) return null;
    try {
      return summariseOutcomes(await this.sqlbox.deliveryStatusCounts({ allowedSmscIds, smscId }));
    } catch {
      return null;
    }
  }

  /** KPI cards for the reports/overview header. */
  async overview(actor: Actor) {
    const snapshot = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const latestDaily = (
        await client.query<{ messages: string; dlrs: string; period_start: string }>(
          `SELECT message_count messages, dlr_count dlrs, period_start
             FROM report_snapshots WHERE period_type='daily' AND scope='total'
            ORDER BY period_start DESC LIMIT 1`,
        )
      ).rows[0];
      const weekly = (
        await client.query<{ messages: string; dlrs: string }>(
          `SELECT message_count messages, dlr_count dlrs
             FROM report_snapshots WHERE period_type='weekly' AND scope='total'
            ORDER BY period_start DESC LIMIT 1`,
        )
      ).rows[0];
      const smsc = (
        await client.query<{ total: string; enabled: string; degraded: string }>(
          `SELECT count(*)::text total,
                  count(*) FILTER (WHERE enabled)::text enabled,
                  count(*) FILTER (WHERE lifecycle_state IN ('degraded','disabled'))::text degraded
             FROM smsc_definitions`,
        )
      ).rows[0];
      const alerts = (
        await client.query<{ open: string; critical: string }>(
          `SELECT count(*) FILTER (WHERE status<>'resolved')::text open,
                  count(*) FILTER (WHERE status<>'resolved' AND severity='critical')::text critical
             FROM alert_instances`,
        )
      ).rows[0];
      const routes = (
        await client.query<{ c: string }>('SELECT count(*)::text c FROM routing_rules')
      ).rows[0];
      const engineIds = (
        await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      ).rows.map((row) => row.engine_id);
      return { latestDaily, weekly, smsc, alerts, routes, engineIds };
    });

    const { latestDaily, weekly, smsc, alerts, routes } = snapshot;
    const messages = Number(latestDaily?.messages ?? 0);
    const dlrs = Number(latestDaily?.dlrs ?? 0);
    // dlrs/messages is DLR *coverage*, not success: a failure receipt counts here.
    const dlrCoverage = percent(ratio(dlrs, messages));
    const outcomes = await this.outcomesFor(snapshot.engineIds);

    return {
      cards: [
        { key: 'messages_today', label: 'Messages (latest day)', value: messages },
        { key: 'dlrs_today', label: 'Delivery reports (latest day)', value: dlrs },
        {
          key: 'delivery_rate',
          label: 'Delivery report coverage',
          value: dlrCoverage,
          unit: '%',
        },
        {
          key: 'delivery_success_rate',
          label: 'Delivery success rate',
          value: percent(outcomes?.successRate ?? null),
          unit: '%',
        },
        { key: 'delivered', label: 'Delivered', value: outcomes?.delivered ?? null },
        {
          key: 'delivery_failures',
          label: 'Failed/rejected',
          value: outcomes ? outcomes.failed + outcomes.rejected : null,
        },
        {
          key: 'delivery_pending',
          label: 'Awaiting delivery report',
          value: outcomes?.pending ?? null,
        },
        {
          key: 'messages_week',
          label: 'Messages (latest week)',
          value: Number(weekly?.messages ?? 0),
        },
        { key: 'smsc_total', label: 'SMSC connections', value: Number(smsc.total) },
        { key: 'smsc_degraded', label: 'SMSCs degraded/disabled', value: Number(smsc.degraded) },
        { key: 'routes', label: 'Routes', value: Number(routes.c) },
        { key: 'alerts_open', label: 'Open alerts', value: Number(alerts.open) },
      ],
      latestDailyPeriod: latestDaily?.period_start ?? null,
      outcomes,
      note: OUTCOME_NOTE,
      source: outcomes ? AVAILABLE : UNAVAILABLE,
    };
  }

  /** Daily message/DLR time series for a trend chart. */
  async trafficTrend(actor: Actor, days = 30) {
    const bounded = Math.min(Math.max(days, 1), 180);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rows = (
        await client.query<{ period_start: string; messages: string; dlrs: string }>(
          `SELECT period_start, message_count messages, dlr_count dlrs
             FROM report_snapshots
            WHERE period_type='daily' AND scope='total'
              AND period_start >= (current_date - ($1 || ' days')::interval)
            ORDER BY period_start ASC`,
          [bounded],
        )
      ).rows;
      return {
        series: rows.map((r) => ({
          date: r.period_start,
          messages: Number(r.messages),
          dlrs: Number(r.dlrs),
        })),
        window: `${bounded}d`,
      };
    });
  }

  /** Latest-day totals grouped by SMSC (for a bar chart / table). */
  perSmsc(actor: Actor) {
    return this.groupedLatest(actor, 'smsc');
  }
  /** Latest-day totals grouped by route. */
  perRoute(actor: Actor) {
    return this.groupedLatest(actor, 'route');
  }

  private async groupedLatest(actor: Actor, scope: 'smsc' | 'route') {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const latest = (
        await client.query<{ period_start: string }>(
          `SELECT period_start FROM report_snapshots WHERE period_type='daily' AND scope=$1 ORDER BY period_start DESC LIMIT 1`,
          [scope],
        )
      ).rows[0];
      if (!latest) return { period: null, groups: [] };
      const rows = (
        await client.query<{ scope_label: string; messages: string; dlrs: string }>(
          `SELECT scope_label, message_count messages, dlr_count dlrs
             FROM report_snapshots WHERE period_type='daily' AND scope=$1 AND period_start=$2
            ORDER BY message_count DESC`,
          [scope, latest.period_start],
        )
      ).rows;
      return {
        period: latest.period_start,
        groups: rows.map((r) => ({
          label: r.scope_label,
          messages: Number(r.messages),
          dlrs: Number(r.dlrs),
        })),
      };
    });
  }

  /**
   * Delivery outcome breakdown. Segments are the real Kannel outcomes derived
   * from each message's latest DLR — the previous version labelled "has a
   * delivery report of any kind" as "Confirmed delivered", which counted
   * failures and rejections as deliveries. Falls back to the snapshot's DLR
   * coverage (honestly labelled) when SQLBox cannot be read.
   */
  async deliveryBreakdown(actor: Actor) {
    const snapshot = await this.database.tenantTransaction(
      actor.tenantId,
      async (client: PoolClient) => {
        const row = (
          await client.query<{ messages: string; dlrs: string }>(
            `SELECT message_count messages, dlr_count dlrs FROM report_snapshots
            WHERE period_type='daily' AND scope='total' ORDER BY period_start DESC LIMIT 1`,
          )
        ).rows[0];
        const engineIds = (
          await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
        ).rows.map((r) => r.engine_id);
        return { row, engineIds };
      },
    );
    const messages = Number(snapshot.row?.messages ?? 0);
    const dlrs = Math.min(Number(snapshot.row?.dlrs ?? 0), messages);
    const outcomes = await this.outcomesFor(snapshot.engineIds);
    if (!outcomes)
      return {
        segments: [
          { label: 'Has a delivery report (outcome unknown)', value: dlrs },
          { label: 'Awaiting/unconfirmed', value: Math.max(messages - dlrs, 0) },
        ],
        total: messages,
        successRate: null,
        outcomes: null,
        note: OUTCOME_NOTE,
        source: UNAVAILABLE,
      };
    const segments = [
      { label: 'Delivered', value: outcomes.delivered },
      { label: 'Failed', value: outcomes.failed },
      { label: 'Rejected', value: outcomes.rejected },
      { label: 'In flight (buffered/accepted)', value: outcomes.inFlight },
      { label: 'Awaiting delivery report', value: outcomes.pending },
      { label: 'Unknown', value: outcomes.unknown },
    ];
    return {
      segments,
      total: segments.reduce((sum, segment) => sum + segment.value, 0),
      successRate: outcomes.successRate,
      outcomes,
      note: OUTCOME_NOTE,
      source: AVAILABLE,
    };
  }

  /**
   * Per-SMSC success/failure for the latest daily period. successRate is
   * delivered / (delivered + failed + rejected) — see {@link summariseOutcomes}.
   */
  smscSuccess(actor: Actor) {
    return this.successRates(actor, 'smsc');
  }
  /** Per-route success/failure for the latest daily period. */
  routePerformance(actor: Actor) {
    return this.successRates(actor, 'route');
  }

  private async successRates(actor: Actor, scope: 'smsc' | 'route') {
    const snapshot = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const latest = (
        await client.query<{ period_start: string }>(
          `SELECT period_start FROM report_snapshots WHERE period_type='daily' AND scope=$1 ORDER BY period_start DESC LIMIT 1`,
          [scope],
        )
      ).rows[0];
      if (!latest) return { period: null as string | null, rows: [], engineIds: [] as string[] };
      const rows = (
        await client.query<{
          scope_key: string | null;
          scope_label: string;
          messages: string;
          dlrs: string;
          details: { targetSmscEngineId?: string | null } | null;
        }>(
          `SELECT scope_key, scope_label, message_count messages, dlr_count dlrs, details
             FROM report_snapshots WHERE period_type='daily' AND scope=$1 AND period_start=$2
            ORDER BY message_count DESC`,
          [scope, latest.period_start],
        )
      ).rows;
      const engineIds = (
        await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      ).rows.map((row) => row.engine_id);
      return { period: latest.period_start, rows, engineIds };
    });

    if (snapshot.period === null)
      return {
        period: null,
        groups: [] as SuccessRateGroup[],
        note: OUTCOME_NOTE,
        source: UNAVAILABLE,
      };

    // One outcome query per distinct SMSC, memoised: several routes can share a
    // target SMSC (the same 'target_smsc' attribution the snapshot writer uses).
    const cache = new Map<string, DeliveryOutcomes | null>();
    const groups: SuccessRateGroup[] = [];
    let anyOutcomes = false;
    for (const row of snapshot.rows) {
      const messages = Number(row.messages);
      const dlrs = Math.min(Number(row.dlrs), messages);
      const engineId =
        scope === 'smsc' ? (row.scope_key ?? null) : (row.details?.targetSmscEngineId ?? null);
      let outcomes: DeliveryOutcomes | null = null;
      if (engineId && snapshot.engineIds.includes(engineId)) {
        if (!cache.has(engineId))
          cache.set(engineId, await this.outcomesFor(snapshot.engineIds, engineId));
        outcomes = cache.get(engineId) ?? null;
      }
      if (outcomes) anyOutcomes = true;
      groups.push({
        label: row.scope_label,
        messages,
        dlrs,
        successRate: outcomes ? outcomes.successRate : null,
        failureRate: outcomes ? outcomes.failureRate : null,
        dlrRate: ratio(dlrs, messages),
        delivered: outcomes ? outcomes.delivered : null,
        failed: outcomes ? outcomes.failed : null,
        rejected: outcomes ? outcomes.rejected : null,
        pending: outcomes ? outcomes.pending : null,
        inFlight: outcomes ? outcomes.inFlight : null,
        finalised: outcomes ? outcomes.finalised : null,
      });
    }
    return {
      period: snapshot.period,
      groups,
      note: OUTCOME_NOTE,
      source: anyOutcomes ? AVAILABLE : UNAVAILABLE,
    };
  }

  /**
   * Day-of-week × hour-of-day matrix of outbound message counts over the last
   * `days` days, from raw SQLBox sent_sms rows scoped to the tenant's SMSCs.
   * Honest empty (with a source note) when SQLBox is unavailable.
   */
  async hourlyHeatmap(actor: Actor, days = 7) {
    const bounded = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
    const window = `${bounded}d`;
    const pool = this.pool();
    if (!pool) return { cells: [] as HeatmapCell[], maxCount: 0, window, source: UNAVAILABLE };
    const smscIds = await this.tenantSmscEngineIds(actor);
    if (!smscIds.length)
      return { cells: [] as HeatmapCell[], maxCount: 0, window, source: AVAILABLE };
    const fromEpoch = Math.floor(Date.now() / 1000) - bounded * 86400;
    try {
      const rows = (
        await pool.query<{ dow: string; hour: string; count: string }>(
          `SELECT extract(dow from to_timestamp(time))::int dow,
                  extract(hour from to_timestamp(time))::int hour,
                  count(*)::text count
             FROM sent_sms
            WHERE time >= $1 AND smsc_id = ANY($2) AND momt IS DISTINCT FROM 'DLR'
            GROUP BY dow, hour`,
          [fromEpoch, smscIds],
        )
      ).rows;
      const cells = rows.map((row): HeatmapCell => ({
        dow: Number(row.dow),
        hour: Number(row.hour),
        count: Number(row.count),
      }));
      const maxCount = cells.reduce((max, cell) => Math.max(max, cell.count), 0);
      return { cells, maxCount, window, source: AVAILABLE };
    } catch (error) {
      return {
        cells: [] as HeatmapCell[],
        maxCount: 0,
        window,
        source: {
          status: 'unavailable' as const,
          code: 'SQLBOX_QUERY_FAILED',
          message: (error as Error).message,
        },
      };
    }
  }

  /**
   * Time-to-DLR latency percentiles over the last `days` days. Latency is
   * approximated by matching an MT message to its DLR on the shared foreign_id
   * (latency = dlr.time - mt.time); messages without a DLR are excluded. Returns
   * honest nulls with a note when nothing is computable or SQLBox is offline.
   */
  async latencySla(actor: Actor, days = 7) {
    const bounded = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
    const note =
      'Latency approximated by matching MT and DLR rows on foreign_id; excludes messages without a delivery report.';
    const empty = {
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      unit: 'seconds',
      window: `${bounded}d`,
      note,
    };
    const pool = this.pool();
    if (!pool) return { ...empty, source: UNAVAILABLE };
    const smscIds = await this.tenantSmscEngineIds(actor);
    if (!smscIds.length) return { ...empty, source: AVAILABLE };
    const fromEpoch = Math.floor(Date.now() / 1000) - bounded * 86400;
    try {
      const row = (
        await pool.query<{
          count: string;
          p50: string | null;
          p95: string | null;
          p99: string | null;
        }>(
          `WITH mt AS (
             SELECT foreign_id, min(time) sent_time FROM sent_sms
              WHERE time >= $1 AND smsc_id = ANY($2) AND momt IS DISTINCT FROM 'DLR' AND foreign_id IS NOT NULL
              GROUP BY foreign_id),
           dlr AS (
             SELECT foreign_id, min(time) dlr_time FROM sent_sms
              WHERE time >= $1 AND smsc_id = ANY($2) AND momt = 'DLR' AND foreign_id IS NOT NULL
              GROUP BY foreign_id),
           lat AS (
             SELECT (dlr.dlr_time - mt.sent_time)::double precision latency
               FROM mt JOIN dlr USING (foreign_id)
              WHERE dlr.dlr_time >= mt.sent_time)
           SELECT count(*)::text count,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency)::text p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency)::text p95,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency)::text p99
             FROM lat`,
          [fromEpoch, smscIds],
        )
      ).rows[0];
      const count = Number(row?.count ?? 0);
      const num = (value: string | null) =>
        value === null ? null : Math.round(Number(value) * 100) / 100;
      return {
        count,
        p50: count > 0 ? num(row.p50) : null,
        p95: count > 0 ? num(row.p95) : null,
        p99: count > 0 ? num(row.p99) : null,
        unit: 'seconds',
        window: `${bounded}d`,
        note,
        source: AVAILABLE,
      };
    } catch (error) {
      return {
        ...empty,
        source: {
          status: 'unavailable' as const,
          code: 'SQLBOX_QUERY_FAILED',
          message: (error as Error).message,
        },
      };
    }
  }

  /**
   * Catalog of report categories and kinds the platform can produce, so the UI
   * can present a menu of report types (Reporting spec §3–10). Availability
   * reflects what is wired to real data today vs planned.
   */
  catalog() {
    return {
      categories: [
        {
          key: 'traffic',
          name: 'Traffic',
          description: 'Message volume, delivery reports and trends over time.',
          kinds: [
            { key: 'daily_volume', name: 'Daily volume', available: true },
            { key: 'weekly_volume', name: 'Weekly volume', available: true },
            { key: 'traffic_trend', name: 'Traffic trend', available: true },
            { key: 'delivery_breakdown', name: 'Delivery breakdown', available: true },
            { key: 'hourly_heatmap', name: 'Hourly traffic heatmap', available: true },
          ],
        },
        {
          key: 'per_smsc',
          name: 'Per-SMSC',
          description: 'Submitted, delivered and failure rates by SMSC connection.',
          kinds: [
            { key: 'smsc_volume', name: 'Volume by SMSC', available: true },
            { key: 'smsc_success_rate', name: 'Success rate by SMSC', available: true },
            { key: 'smsc_success', name: 'SMSC success/failure', available: true },
          ],
        },
        {
          key: 'per_route',
          name: 'Per-Route',
          description: 'Usage, success and failover by routing rule.',
          kinds: [
            { key: 'route_volume', name: 'Volume by route', available: true },
            { key: 'route_success_rate', name: 'Success rate by route', available: true },
            { key: 'route_performance', name: 'Route performance', available: true },
          ],
        },
        {
          key: 'performance',
          name: 'Performance & SLA',
          description: 'Delivery latency percentiles and time-of-day traffic distribution.',
          kinds: [
            { key: 'latency_sla', name: 'Time-to-DLR latency (SLA)', available: true },
            { key: 'hourly_heatmap', name: 'Hourly traffic heatmap', available: true },
          ],
        },
        {
          key: 'operational',
          name: 'Operational',
          description: 'Live queue, engine health, alerts and recent changes.',
          kinds: [
            { key: 'queue_status', name: 'Queue status', available: true },
            { key: 'engine_health', name: 'Engine health', available: true },
            { key: 'recent_changes', name: 'Recent configuration changes', available: true },
          ],
        },
        {
          key: 'audit_security',
          name: 'Audit & Security',
          description: 'Who did what and when; login and access activity.',
          kinds: [{ key: 'audit_activity', name: 'Audit activity', available: true }],
        },
        {
          key: 'financial',
          name: 'Financial / Vendor',
          description: 'Cost and vendor performance reporting.',
          kinds: [
            { key: 'route_cost', name: 'Route cost', available: false },
            { key: 'vendor_performance', name: 'Vendor performance', available: false },
          ],
        },
        {
          key: 'customer',
          name: 'Customer',
          description: 'Per-customer usage and quotas.',
          kinds: [{ key: 'customer_usage', name: 'Customer usage', available: false }],
        },
      ],
    };
  }
}
