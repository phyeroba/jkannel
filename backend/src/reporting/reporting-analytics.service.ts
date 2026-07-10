import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface Actor {
  tenantId: string;
}

/**
 * Analytics behind the Reports screen: KPI cards, chart series and grouped
 * breakdowns computed from the persisted daily/weekly report snapshots (see
 * ReportJobsService) plus live SQLBox queue depth. Also publishes the catalog
 * of report categories/kinds the spec defines so the UI can offer more than one
 * kind of report.
 */
@Injectable()
export class ReportingAnalyticsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  /** KPI cards for the reports/overview header. */
  async overview(actor: Actor) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
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

      const messages = Number(latestDaily?.messages ?? 0);
      const dlrs = Number(latestDaily?.dlrs ?? 0);
      const deliveryRate = messages > 0 ? Math.round((dlrs / messages) * 1000) / 10 : null;

      return {
        cards: [
          { key: 'messages_today', label: 'Messages (latest day)', value: messages },
          { key: 'dlrs_today', label: 'Delivery reports (latest day)', value: dlrs },
          {
            key: 'delivery_rate',
            label: 'Delivery confirmation rate',
            value: deliveryRate,
            unit: '%',
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
      };
    });
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

  /** Delivered vs unconfirmed breakdown from the latest daily total snapshot. */
  async deliveryBreakdown(actor: Actor) {
    return this.database.tenantTransaction(actor.tenantId, async (client: PoolClient) => {
      const row = (
        await client.query<{ messages: string; dlrs: string }>(
          `SELECT message_count messages, dlr_count dlrs FROM report_snapshots
            WHERE period_type='daily' AND scope='total' ORDER BY period_start DESC LIMIT 1`,
        )
      ).rows[0];
      const messages = Number(row?.messages ?? 0);
      const dlrs = Math.min(Number(row?.dlrs ?? 0), messages);
      return {
        segments: [
          { label: 'Confirmed delivered', value: dlrs },
          { label: 'Awaiting/unconfirmed', value: Math.max(messages - dlrs, 0) },
        ],
        total: messages,
      };
    });
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
          ],
        },
        {
          key: 'per_smsc',
          name: 'Per-SMSC',
          description: 'Submitted, delivered and failure rates by SMSC connection.',
          kinds: [
            { key: 'smsc_volume', name: 'Volume by SMSC', available: true },
            { key: 'smsc_success_rate', name: 'Success rate by SMSC', available: true },
          ],
        },
        {
          key: 'per_route',
          name: 'Per-Route',
          description: 'Usage, success and failover by routing rule.',
          kinds: [
            { key: 'route_volume', name: 'Volume by route', available: true },
            { key: 'route_success_rate', name: 'Success rate by route', available: true },
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
