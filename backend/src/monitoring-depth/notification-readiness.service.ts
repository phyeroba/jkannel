import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface ChannelReadiness {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  /** True only when this channel could actually deliver right now. */
  deliverable: boolean;
  /** Why it cannot deliver. Present exactly when `deliverable` is false. */
  reason?: string;
}

export interface TenantReadiness {
  tenantId: string;
  channels: ChannelReadiness[];
  deliverableChannels: number;
  openAlerts: number;
  /** Open alerts whose escalation could not reach anybody. */
  undeliverableAlerts: number;
  /** Open alerts nothing has tried to deliver yet. */
  unnotifiedAlerts: number;
  escalationPolicies: number;
  /** Human-readable warning, or null when the tenant can notify someone. */
  warning: string | null;
}

const MSISDN_PATTERN = /^\+?[0-9]{6,15}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const DEFAULT_DASHBOARD_CHANNEL = 'Default dashboard';
const DEFAULT_POLICY = 'Default escalation';
const DEFAULT_POLICY_STEPS = [
  { afterMinutes: 0, channelType: 'dashboard', target: DEFAULT_DASHBOARD_CHANNEL },
  { afterMinutes: 5, channelType: 'email', target: '' },
  { afterMinutes: 15, channelType: 'webhook', target: '' },
];

/**
 * Answers one question honestly: *if an alert fires right now, does anybody
 * hear about it?*
 *
 * A fresh install used to fail this quietly. An escalation policy existed but
 * its steps addressed email and webhook, neither of which is configured out of
 * the box, so every step recorded "no enabled channel" in a jsonb column nobody
 * reads and the alert sat open, unnotified, looking fine.
 *
 * Three things change that:
 *
 *  1. {@link ensureTenantDefaults} guarantees every tenant has a *dashboard*
 *     channel (always deliverable, in-app) as escalation step 0, including
 *     tenants provisioned after migration 037 ran.
 *  2. {@link readinessForTenant} classifies every channel as deliverable or
 *     not, with the reason, and counts the open alerts that reached nobody.
 *  3. {@link onModuleInit} logs a warning at boot for any tenant that has open
 *     alerts and no deliverable channel, so "nobody is being told" is itself
 *     visible. `GET /monitoring/notifications/readiness` returns the same data
 *     per tenant on demand.
 *
 * Nothing here reports a delivery: it reports capability. A channel is only
 * called deliverable when its transport is genuinely usable (SMTP_URL present
 * for email, an http(s) URL for a webhook, an MSISDN for SMS).
 */
@Injectable()
export class NotificationReadinessService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.NOTIFICATION_READINESS_CHECK === 'false') return;
    // Deferred so boot is not blocked by (or failed by) the database.
    setTimeout(() => void this.runStartupCheck().catch(() => undefined), 5_000).unref?.();
  }

  /**
   * Seeds defaults for every enabled tenant and warns about the ones that still
   * cannot notify anybody. Returns the per-tenant readiness it evaluated.
   */
  async runStartupCheck(): Promise<TenantReadiness[]> {
    const tenants = await this.database.query<{ id: string }>(
      'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
    );
    const results: TenantReadiness[] = [];
    for (const tenant of tenants.rows) {
      try {
        await this.ensureTenantDefaults(tenant.id);
        const readiness = await this.readinessForTenant(tenant.id);
        results.push(readiness);
        if (readiness.warning) this.warn(readiness);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'notification readiness check failed',
            tenantId: tenant.id,
            error: String((error as Error).message ?? error),
          }),
        );
      }
    }
    return results;
  }

  private warn(readiness: TenantReadiness): void {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        context: 'NotificationReadiness',
        message: readiness.warning,
        tenantId: readiness.tenantId,
        deliverableChannels: readiness.deliverableChannels,
        openAlerts: readiness.openAlerts,
        undeliverableAlerts: readiness.undeliverableAlerts,
      }),
    );
  }

  /**
   * Idempotently gives a tenant the always-deliverable dashboard channel and a
   * default escalation policy whose first step uses it. Mirrors the seed in
   * migration 037 so tenants created later are not left mute.
   */
  async ensureTenantDefaults(tenantId: string): Promise<{ channel: boolean; policy: boolean }> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const channel = await client.query(
        `INSERT INTO notification_channels(tenant_id,name,type,enabled,severities,config,created_by)
         SELECT $1, $2, 'dashboard', true, ARRAY['info','warning','critical']::text[],
                '{"categories":["alert"]}'::jsonb, 'notification-readiness'
          WHERE NOT EXISTS (SELECT 1 FROM notification_channels WHERE type='dashboard')`,
        [tenantId, DEFAULT_DASHBOARD_CHANNEL],
      );
      const policy = await client.query(
        `INSERT INTO escalation_policies(tenant_id,name,steps,enabled,created_by)
         SELECT $1, $2, $3::jsonb, true, 'notification-readiness'
          WHERE NOT EXISTS (SELECT 1 FROM escalation_policies WHERE enabled)`,
        [tenantId, DEFAULT_POLICY, JSON.stringify(DEFAULT_POLICY_STEPS)],
      );
      return { channel: (channel.rowCount ?? 0) > 0, policy: (policy.rowCount ?? 0) > 0 };
    });
  }

  /**
   * Classifies a channel. Pure: no I/O, so the rules are unit-testable and the
   * endpoint, the startup warning and the tests all agree on what "deliverable"
   * means.
   */
  describeChannel(channel: {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    config?: Record<string, unknown> | null;
  }): ChannelReadiness {
    const base = {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
    };
    const config = channel.config ?? {};
    if (!channel.enabled) return { ...base, deliverable: false, reason: 'channel disabled' };
    if (channel.type === 'dashboard') return { ...base, deliverable: true };
    if (channel.type === 'email') {
      if (!process.env.SMTP_URL)
        return { ...base, deliverable: false, reason: 'SMTP_URL is not configured' };
      if (!EMAIL_PATTERN.test(String(config.to ?? '')))
        return { ...base, deliverable: false, reason: 'config.to is not an email address' };
      return { ...base, deliverable: true };
    }
    if (channel.type === 'webhook') {
      if (!/^https?:\/\//i.test(String(config.url ?? '')))
        return { ...base, deliverable: false, reason: 'config.url is not an http(s) URL' };
      return { ...base, deliverable: true };
    }
    if (channel.type === 'sms') {
      const msisdn = String(config.msisdn ?? config.to ?? config.recipient ?? '');
      if (!MSISDN_PATTERN.test(msisdn))
        return { ...base, deliverable: false, reason: 'config.msisdn is not an MSISDN' };
      return { ...base, deliverable: true };
    }
    return {
      ...base,
      deliverable: false,
      reason: `transport '${channel.type}' is not implemented`,
    };
  }

  /** Builds the warning line (or null) from the counted facts. */
  warningFor(counts: {
    deliverableChannels: number;
    openAlerts: number;
    undeliverableAlerts: number;
    escalationPolicies: number;
  }): string | null {
    if (counts.deliverableChannels === 0)
      return counts.openAlerts > 0
        ? `${counts.openAlerts} open alert(s) and no deliverable notification channel: nobody is being told. Configure a channel under /alerts/channels.`
        : 'No deliverable notification channel is configured: an alert would reach nobody.';
    if (counts.escalationPolicies === 0)
      return 'No enabled escalation policy: alerts open but no step ever fires.';
    if (counts.undeliverableAlerts > 0)
      return `${counts.undeliverableAlerts} open alert(s) had an escalation step that could not be delivered.`;
    return null;
  }

  /** Full readiness picture for one tenant (RLS-scoped). */
  async readinessForTenant(tenantId: string): Promise<TenantReadiness> {
    return this.database.tenantTransaction(tenantId, (client) =>
      this.readinessIn(client, tenantId),
    );
  }

  private async readinessIn(client: PoolClient, tenantId: string): Promise<TenantReadiness> {
    const channels = (
      await client.query<{
        id: string;
        name: string;
        type: string;
        enabled: boolean;
        config: Record<string, unknown> | null;
      }>('SELECT id,name,type,enabled,config FROM notification_channels ORDER BY type, name')
    ).rows.map((row) => this.describeChannel(row));

    const counts = (
      await client.query<{
        open_alerts: string;
        undeliverable: string;
        unnotified: string;
      }>(
        `SELECT count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::text AS open_alerts,
                count(*) FILTER (WHERE status NOT IN ('resolved','closed') AND notification_state='undeliverable')::text AS undeliverable,
                count(*) FILTER (WHERE status NOT IN ('resolved','closed') AND notification_state='pending')::text AS unnotified
           FROM alert_instances`,
      )
    ).rows[0];

    const policies = (
      await client.query<{ count: string }>(
        'SELECT count(*)::text FROM escalation_policies WHERE enabled',
      )
    ).rows[0];

    const summary = {
      deliverableChannels: channels.filter((channel) => channel.deliverable).length,
      openAlerts: Number(counts?.open_alerts ?? 0),
      undeliverableAlerts: Number(counts?.undeliverable ?? 0),
      escalationPolicies: Number(policies?.count ?? 0),
    };
    return {
      tenantId,
      channels,
      ...summary,
      unnotifiedAlerts: Number(counts?.unnotified ?? 0),
      warning: this.warningFor(summary),
    };
  }
}
