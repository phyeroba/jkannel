import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ExportColumn, ExportService } from '../platform/export.service';
import {
  NotificationChannel,
  NotificationDeliveryService,
} from '../monitoring/notification-delivery.service';
import { ReportingAnalyticsService } from '../reporting/reporting-analytics.service';
import { ReportSchedule } from './report-definitions.repository';

// Namespace for the per-tenant transaction-level advisory lock (arbitrary).
const REPORT_SCHEDULE_LOCK_NAMESPACE = 0x1c2d;

const CADENCE_MS: Record<ReportSchedule, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

interface ScheduledDefinitionRow {
  id: string;
  name: string;
  report_type: string;
  parameters: Record<string, unknown> | null;
  schedule: string | null;
  format: string | null;
  last_ran_at: string | Date | null;
}

export interface RenderedReport {
  title: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  summary: string;
}

export type RunStatus = 'succeeded' | 'in-app-only' | 'skipped' | 'failed';

/**
 * Scheduled report export delivery. For every enabled report definition with a
 * schedule that is due, it re-runs the corresponding report kind (via
 * {@link ReportingAnalyticsService}), renders the result to CSV (or a short text
 * summary), and delivers it through the existing
 * {@link NotificationDeliveryService} email/webhook channels that opted into the
 * 'report' category — plus an in-app user_notification. Each attempt appends a
 * report_definition_runs row (migration 021).
 *
 * The runner is advisory-locked per tenant (transaction-level) so overlapping
 * ticks or multiple replicas never double-deliver. It is disabled under test
 * (NODE_ENV=test) and when REPORT_SCHEDULE_ENABLED=false. It is honest: when no
 * channels or SMTP are configured it records 'in-app-only' or 'skipped' rather
 * than pretending delivery happened.
 */
@Injectable()
export class ReportScheduleService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly analytics: ReportingAnalyticsService,
    private readonly exporter: ExportService,
    private readonly notifications?: NotificationDeliveryService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.REPORT_SCHEDULE_ENABLED === 'false') return;
    const interval = Number(process.env.REPORT_SCHEDULE_INTERVAL_MS ?? 5 * 60_000);
    this.timer = setInterval(() => void this.runDue(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runDue(), 25_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Pure cadence check: is a definition due given its last run time? */
  isDue(schedule: string | null, lastRanAt: Date | null, now: Date): boolean {
    if (!schedule || !(schedule in CADENCE_MS)) return false;
    if (!lastRanAt) return true;
    return now.getTime() - lastRanAt.getTime() >= CADENCE_MS[schedule as ReportSchedule];
  }

  /** Evaluates due scheduled reports for every enabled tenant. */
  async runDue(now: Date = new Date()): Promise<Array<{ tenantId: string; delivered: number }>> {
    if (this.running) return [];
    this.running = true;
    try {
      const tenants = await this.database.query<{ id: string }>(
        'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
      );
      const results = [];
      for (const tenant of tenants.rows) {
        const delivered = await this.runForTenant(tenant.id, now).catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'scheduled report delivery failed',
              tenantId: tenant.id,
              error: String((error as Error).message ?? error),
            }),
          );
          return 0;
        });
        results.push({ tenantId: tenant.id, delivered });
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /** Runs due definitions for one tenant. Returns the number of runs recorded. */
  async runForTenant(tenantId: string, now: Date = new Date()): Promise<number> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [REPORT_SCHEDULE_LOCK_NAMESPACE, Number(tenantId) % 2147483647],
      );
      if (!lock.rows[0]?.locked) return 0;

      const definitions = (
        await client.query<ScheduledDefinitionRow>(
          `SELECT d.id, d.name, d.report_type, d.parameters, d.schedule, d.format,
                  (SELECT max(ran_at) FROM report_definition_runs r WHERE r.definition_id = d.id) AS last_ran_at
             FROM report_definitions d
            WHERE d.enabled AND d.schedule IS NOT NULL
            ORDER BY d.created_at ASC LIMIT 500`,
        )
      ).rows;

      let recorded = 0;
      for (const definition of definitions) {
        const lastRanAt = definition.last_ran_at ? new Date(definition.last_ran_at) : null;
        if (!this.isDue(definition.schedule, lastRanAt, now)) continue;
        await this.deliverDefinition(client, tenantId, definition);
        recorded += 1;
      }
      return recorded;
    });
  }

  private async deliverDefinition(
    client: PoolClient,
    tenantId: string,
    definition: ScheduledDefinitionRow,
  ): Promise<void> {
    try {
      const report = await this.renderReport(
        definition.report_type,
        tenantId,
        definition.parameters,
      );
      const subject = `Scheduled report: ${definition.name}`;
      const body =
        definition.format === 'summary'
          ? report.summary
          : `${report.summary}\n\n${this.exporter.toCsv(report.rows, report.columns)}`;
      const data = {
        definitionId: definition.id,
        reportType: definition.report_type,
        schedule: definition.schedule,
        format: definition.format,
        rows: report.rows.length,
      };

      const inApp = await this.recordInApp(client, tenantId, subject, report.summary, data);
      const channels = await this.deliverToChannels(client, tenantId, subject, body, data);
      const status: RunStatus =
        channels.delivered > 0 ? 'succeeded' : inApp > 0 ? 'in-app-only' : 'skipped';
      await this.recordRun(client, tenantId, definition.id, status, {
        rows: report.rows.length,
        inAppRecipients: inApp,
        channels: channels.attempts,
      });
    } catch (error) {
      await this.recordRun(client, tenantId, definition.id, 'failed', {
        error: String((error as Error).message ?? error),
      });
    }
  }

  /**
   * Re-runs a catalog report kind and shapes it into exportable rows plus a
   * one-line summary. Throws for report types that produce no tabular output.
   */
  async renderReport(
    reportType: string,
    tenantId: string,
    parameters: Record<string, unknown> | null,
  ): Promise<RenderedReport> {
    const actor = { tenantId };
    const days = Number(parameters?.days) > 0 ? Number(parameters?.days) : undefined;
    switch (reportType) {
      case 'smsc_success':
      case 'route_performance': {
        const result =
          reportType === 'smsc_success'
            ? await this.analytics.smscSuccess(actor)
            : await this.analytics.routePerformance(actor);
        return {
          title: reportType === 'smsc_success' ? 'SMSC success/failure' : 'Route performance',
          columns: [
            { key: 'label', header: reportType === 'smsc_success' ? 'SMSC' : 'Route' },
            { key: 'messages', header: 'Messages' },
            { key: 'dlrs', header: 'DLRs' },
            { key: 'successRate', header: 'Success rate' },
            { key: 'failureRate', header: 'Failure rate' },
          ],
          rows: result.groups as unknown as Array<Record<string, unknown>>,
          summary: `${result.groups.length} rows for period ${result.period ?? 'n/a'}.`,
        };
      }
      case 'smsc_volume':
      case 'route_volume': {
        const result =
          reportType === 'smsc_volume'
            ? await this.analytics.perSmsc(actor)
            : await this.analytics.perRoute(actor);
        return {
          title: reportType === 'smsc_volume' ? 'Volume by SMSC' : 'Volume by route',
          columns: [
            { key: 'label', header: reportType === 'smsc_volume' ? 'SMSC' : 'Route' },
            { key: 'messages', header: 'Messages' },
            { key: 'dlrs', header: 'DLRs' },
          ],
          rows: result.groups as unknown as Array<Record<string, unknown>>,
          summary: `${result.groups.length} rows for period ${result.period ?? 'n/a'}.`,
        };
      }
      case 'traffic_trend': {
        const result = await this.analytics.trafficTrend(actor, days ?? 30);
        return {
          title: 'Traffic trend',
          columns: [
            { key: 'date', header: 'Date' },
            { key: 'messages', header: 'Messages' },
            { key: 'dlrs', header: 'DLRs' },
          ],
          rows: result.series as unknown as Array<Record<string, unknown>>,
          summary: `${result.series.length} days (${result.window}).`,
        };
      }
      case 'daily_volume':
      case 'weekly_volume': {
        const result = await this.analytics.overview(actor);
        return {
          title: reportType === 'daily_volume' ? 'Daily volume' : 'Weekly volume',
          columns: [
            { key: 'label', header: 'Metric' },
            { key: 'value', header: 'Value' },
            { key: 'unit', header: 'Unit' },
          ],
          rows: result.cards as unknown as Array<Record<string, unknown>>,
          summary: `Overview KPIs (latest period ${result.latestDailyPeriod ?? 'n/a'}).`,
        };
      }
      case 'delivery_breakdown': {
        const result = await this.analytics.deliveryBreakdown(actor);
        return {
          title: 'Delivery breakdown',
          columns: [
            { key: 'label', header: 'Segment' },
            { key: 'value', header: 'Messages' },
          ],
          rows: result.segments as unknown as Array<Record<string, unknown>>,
          summary: `${result.total} total messages.`,
        };
      }
      case 'hourly_heatmap': {
        const result = await this.analytics.hourlyHeatmap(actor, days ?? 7);
        return {
          title: 'Hourly traffic heatmap',
          columns: [
            { key: 'dow', header: 'Day of week' },
            { key: 'hour', header: 'Hour' },
            { key: 'count', header: 'Messages' },
          ],
          rows: result.cells as unknown as Array<Record<string, unknown>>,
          summary: `${result.cells.length} populated cells (peak ${result.maxCount}, ${result.window}).`,
        };
      }
      case 'latency_sla': {
        const result = await this.analytics.latencySla(actor, days ?? 7);
        return {
          title: 'Time-to-DLR latency (SLA)',
          columns: [
            { key: 'count', header: 'Sampled messages' },
            { key: 'p50', header: 'p50 (s)' },
            { key: 'p95', header: 'p95 (s)' },
            { key: 'p99', header: 'p99 (s)' },
          ],
          rows: [{ count: result.count, p50: result.p50, p95: result.p95, p99: result.p99 }],
          summary: `${result.count} sampled messages; p95 ${result.p95 ?? 'n/a'}s (${result.window}).`,
        };
      }
      default:
        throw new Error(`report type '${reportType}' is not runnable by the scheduler`);
    }
  }

  /** Records an in-app notification for every report-permitted active user. */
  private async recordInApp(
    client: PoolClient,
    tenantId: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    const recipients = await client.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code IN ('reports.view', 'system.manage') AND u.status = 'active'`,
    );
    for (const recipient of recipients.rows) {
      await client.query(
        `INSERT INTO user_notifications (tenant_id, user_id, category, title, body, data)
         VALUES ($1, $2, 'report', $3, $4, $5)`,
        [tenantId, recipient.id, title, body, JSON.stringify(data)],
      );
    }
    return recipients.rows.length;
  }

  /**
   * Delivers to enabled email/webhook channels that opted into the 'report'
   * category. Returns the count of successful deliveries and per-channel
   * attempt summaries. Failures never abort the run.
   */
  private async deliverToChannels(
    client: PoolClient,
    tenantId: string,
    subject: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<{ delivered: number; attempts: Array<Record<string, unknown>> }> {
    const attempts: Array<Record<string, unknown>> = [];
    if (!this.notifications) return { delivered: 0, attempts };
    const channels = await client.query<NotificationChannel & { config: Record<string, unknown> }>(
      `SELECT id, name, type, enabled, severities, config FROM notification_channels
        WHERE enabled = true AND type IN ('email', 'webhook')`,
    );
    let delivered = 0;
    for (const channel of channels.rows) {
      const categories = channel.config?.categories;
      if (Array.isArray(categories) && !categories.includes('report')) continue;
      const attempt = await this.notifications
        .deliverPayload({ category: 'report', subject, body, data }, channel)
        .catch((error) => ({
          channelId: channel.id,
          channelType: channel.type,
          status: 'failed' as const,
          response: { error: String((error as Error).message) },
        }));
      if (attempt.status === 'succeeded') delivered += 1;
      attempts.push({ channel: channel.name, type: channel.type, status: attempt.status });
      await client
        .query(
          `INSERT INTO notification_deliveries
             (tenant_id, alert_id, channel_id, channel_type, status, target, response, attempted_by, delivered_at, category)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, 'report-scheduler', CASE WHEN $4 = 'succeeded' THEN now() ELSE NULL END, 'report')`,
          [
            tenantId,
            channel.id,
            channel.type,
            attempt.status,
            ('target' in attempt ? attempt.target : null) ?? null,
            JSON.stringify(('response' in attempt ? attempt.response : {}) ?? {}),
          ],
        )
        .catch(() => undefined);
    }
    return { delivered, attempts };
  }

  private recordRun(
    client: PoolClient,
    tenantId: string,
    definitionId: string,
    status: RunStatus,
    detail: Record<string, unknown>,
  ) {
    return client.query(
      `INSERT INTO report_definition_runs (tenant_id, definition_id, status, detail)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, definitionId, status, JSON.stringify(detail)],
    );
  }
}
