import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import {
  NotificationChannel,
  NotificationDeliveryService,
} from '../monitoring/notification-delivery.service';
import { AnomalyDetectionService } from '../monitoring/anomaly-detection.service';

export type ReportPeriodType = 'daily' | 'weekly';

export interface ReportPeriod {
  type: ReportPeriodType;
  /** Inclusive start (UTC midnight). */
  start: Date;
  /** Exclusive end (UTC midnight). */
  end: Date;
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The most recent fully-elapsed day (yesterday, UTC). */
export function previousDay(now: Date): ReportPeriod {
  const end = utcMidnight(now);
  const start = new Date(end.getTime() - 86_400_000);
  return { type: 'daily', start, end };
}

/** The most recent fully-elapsed ISO week (Monday to Monday, UTC). */
export function previousIsoWeek(now: Date): ReportPeriod {
  const today = utcMidnight(now);
  const dayOfWeek = (today.getUTCDay() + 6) % 7; // Monday = 0
  const currentWeekStart = new Date(today.getTime() - dayOfWeek * 86_400_000);
  const start = new Date(currentWeekStart.getTime() - 7 * 86_400_000);
  return { type: 'weekly', start, end: currentWeekStart };
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Scheduled message-volume reporting. For every tenant and every elapsed
 * period (previous day, previous ISO week) it stores immutable snapshot rows
 * (total, per SMSC, per route) and notifies report subscribers in-app.
 *
 * Runs are idempotent: report_job_runs has a UNIQUE(tenant, period) constraint
 * claimed inside the same transaction that writes the snapshots, so restarts
 * and multiple replicas cannot double-report or double-notify.
 *
 * Per-route counts are attributed through each route's target SMSC (the
 * engine does not stamp route ids on messages); rows carry
 * details.attribution = 'target_smsc' so consumers know the basis.
 */
@Injectable()
export class ReportJobsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly notifications?: NotificationDeliveryService,
    private readonly anomalies?: AnomalyDetectionService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.REPORT_JOBS_ENABLED === 'false') return;
    const interval = Number(process.env.REPORT_JOBS_INTERVAL_MS ?? 15 * 60_000);
    this.timer = setInterval(() => void this.runPending(), interval);
    this.timer.unref?.();
    // Catch up shortly after boot instead of waiting a full interval.
    setTimeout(() => void this.runPending(), 15_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Generates any missing reports for all tenants. Returns run summaries. */
  async runPending(
    now: Date = new Date(),
  ): Promise<
    Array<{ tenantId: string; period: ReportPeriodType; periodStart: string; generated: boolean }>
  > {
    if (this.running) return [];
    this.running = true;
    try {
      const probe = await this.sqlbox.probe();
      if (!probe.available) return [];
      const tenants = await this.database.query<{ id: string }>(
        'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
      );
      const results = [];
      for (const tenant of tenants.rows) {
        for (const period of [previousDay(now), previousIsoWeek(now)]) {
          const generated = await this.generateForTenant(tenant.id, period).catch((error) => {
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'report job failed',
                tenantId: tenant.id,
                period: period.type,
                error: String((error as Error).message ?? error),
              }),
            );
            return false;
          });
          results.push({
            tenantId: tenant.id,
            period: period.type,
            periodStart: isoDate(period.start),
            generated,
          });
        }
      }
      // Detect traffic anomalies once fresh daily snapshots exist.
      if (this.anomalies) await this.anomalies.runForAllTenants().catch(() => undefined);
      return results;
    } finally {
      this.running = false;
    }
  }

  /**
   * Generates one tenant's report for one period. Returns false when the
   * period was already reported (idempotency) or the tenant has no SMSCs.
   */
  async generateForTenant(tenantId: string, period: ReportPeriod): Promise<boolean> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const claim = await client.query(
        `INSERT INTO report_job_runs (tenant_id, period_type, period_start)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
        [tenantId, period.type, isoDate(period.start)],
      );
      if (claim.rowCount === 0) return false;

      const smscs = await client.query<{ id: string; engine_id: string; name: string }>(
        'SELECT id::text, engine_id, name FROM smsc_definitions',
      );
      const routes = await client.query<{ id: string; name: string; target_smsc_id: string }>(
        'SELECT id::text, name, target_smsc_id::text FROM routing_rules',
      );
      const engineIds = smscs.rows.map((row) => row.engine_id);
      const volume = await this.sqlbox.volumeSummary(
        Math.floor(period.start.getTime() / 1000),
        Math.floor(period.end.getTime() / 1000),
        engineIds,
      );
      const bySmscEngineId = new Map(volume.bySmsc.map((row) => [row.smscId, row]));

      const upsert = (
        scope: 'total' | 'smsc' | 'route',
        scopeKey: string,
        scopeLabel: string,
        messages: number,
        dlrs: number,
        details: Record<string, unknown> = {},
      ) =>
        client.query(
          `INSERT INTO report_snapshots
             (tenant_id, period_type, period_start, period_end, scope, scope_key, scope_label,
              message_count, dlr_count, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (tenant_id, period_type, period_start, scope, scope_key)
           DO UPDATE SET message_count = EXCLUDED.message_count,
                         dlr_count = EXCLUDED.dlr_count,
                         details = EXCLUDED.details,
                         generated_at = now()`,
          [
            tenantId,
            period.type,
            isoDate(period.start),
            isoDate(period.end),
            scope,
            scopeKey,
            scopeLabel,
            messages,
            dlrs,
            JSON.stringify(details),
          ],
        );

      await upsert('total', '', 'All traffic', volume.messages, volume.dlrs, {
        smscCount: engineIds.length,
      });
      for (const smsc of smscs.rows) {
        const counts = bySmscEngineId.get(smsc.engine_id);
        await upsert('smsc', smsc.engine_id, smsc.name, counts?.messages ?? 0, counts?.dlrs ?? 0);
      }
      const smscById = new Map(smscs.rows.map((row) => [row.id, row]));
      for (const route of routes.rows) {
        const target = smscById.get(route.target_smsc_id);
        const counts = target ? bySmscEngineId.get(target.engine_id) : undefined;
        await upsert('route', route.id, route.name, counts?.messages ?? 0, counts?.dlrs ?? 0, {
          attribution: 'target_smsc',
          targetSmscEngineId: target?.engine_id ?? null,
        });
      }

      await this.notifySubscribers(client, tenantId, period, volume.messages, volume.dlrs);
      return true;
    });
  }

  private async notifySubscribers(
    client: PoolClient,
    tenantId: string,
    period: ReportPeriod,
    messages: number,
    dlrs: number,
  ): Promise<void> {
    const recipients = await client.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code IN ('reports.view', 'system.manage') AND u.status = 'active'`,
    );
    const label = period.type === 'daily' ? 'Daily' : 'Weekly';
    const title = `${label} message report — ${isoDate(period.start)}`;
    const body =
      `${messages} messages and ${dlrs} delivery reports between ${isoDate(period.start)} ` +
      `and ${isoDate(period.end)}. Open Reports for per-route and per-SMSC detail.`;
    const data = {
      periodType: period.type,
      periodStart: isoDate(period.start),
      periodEnd: isoDate(period.end),
      messages,
      dlrs,
    };
    for (const recipient of recipients.rows) {
      await client.query(
        `INSERT INTO user_notifications (tenant_id, user_id, category, title, body, data)
         VALUES ($1, $2, 'report', $3, $4, $5)`,
        [tenantId, recipient.id, title, body, JSON.stringify(data)],
      );
    }
    await this.deliverToChannels(client, tenantId, title, body, data);
  }

  /**
   * Delivers the report to enabled email/webhook notification channels that
   * opted into the 'report' category (config.categories includes 'report', or
   * no categories restriction). Delivery attempts are recorded so operators can
   * see whether external delivery succeeded; failures never abort the report.
   */
  private async deliverToChannels(
    client: PoolClient,
    tenantId: string,
    subject: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.notifications) return;
    const channels = await client.query<NotificationChannel & { config: Record<string, unknown> }>(
      `SELECT id, name, type, enabled, severities, config FROM notification_channels
        WHERE enabled = true AND type IN ('email', 'webhook')`,
    );
    for (const channel of channels.rows) {
      const categories = channel.config?.categories;
      if (Array.isArray(categories) && !categories.includes('report')) continue;
      const attempt = await this.notifications.deliverPayload(
        { category: 'report', subject, body, data },
        channel,
      );
      await client
        .query(
          `INSERT INTO notification_deliveries
             (tenant_id, alert_id, channel_id, channel_type, status, target, response, attempted_by, delivered_at, category)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, 'report-scheduler', CASE WHEN $4 = 'succeeded' THEN now() ELSE NULL END, 'report')`,
          [
            tenantId,
            attempt.channelId,
            attempt.channelType,
            attempt.status,
            attempt.target ?? null,
            JSON.stringify(attempt.response ?? {}),
          ],
        )
        .catch(() => undefined); // delivery logging is best-effort
    }
  }
}
