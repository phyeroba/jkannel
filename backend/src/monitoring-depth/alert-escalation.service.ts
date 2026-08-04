import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  NotificationChannel,
  NotificationDeliveryService,
} from '../monitoring/notification-delivery.service';
import { EscalationStep } from './monitoring-depth.repository';
import { MaintenanceWindow, MaintenanceWindowService } from './maintenance-window.service';

export interface DueStep {
  stepIndex: number;
  step: EscalationStep;
}

interface OpenAlertRow {
  id: string;
  opened_at: string | Date;
  /**
   * When the alert's current notification cycle began: max(opened_at,
   * escalated_at, reopened_at). Migration 037; absent on older rows.
   */
  cycle_started_at?: string | Date | null;
  /** Which notification cycle the alert is in (migration 037). */
  escalation_cycle?: number | null;
  details: { smsc?: string | null } | null;
  rule_id: string | null;
}

// Namespace for the per-tenant transaction-level advisory lock (arbitrary).
const ESCALATION_LOCK_NAMESPACE = 0x1a2b;

/**
 * Time-based alert escalation. When an alert stays open (unacknowledged) past a
 * policy step's `afterMinutes`, the runner records the next step in
 * `alert_escalations` and, best-effort, delivers a notification through the
 * existing {@link NotificationDeliveryService}. Steps advance one at a time and
 * are consulted against the tenant's active maintenance windows so covered
 * scopes are suppressed rather than escalated.
 *
 * The runner is advisory-locked per tenant (transaction-level) so overlapping
 * ticks or multiple replicas never double-escalate. It is disabled under test
 * (NODE_ENV=test) and when ESCALATION_RUNNER_ENABLED=false.
 */
@Injectable()
export class AlertEscalationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly maintenance: MaintenanceWindowService,
    private readonly notifications?: NotificationDeliveryService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.ESCALATION_RUNNER_ENABLED === 'false')
      return;
    const interval = Number(process.env.ESCALATION_RUNNER_INTERVAL_MS ?? 60_000);
    this.timer = setInterval(() => void this.runDueEscalations(), interval);
    this.timer.unref?.();
    setTimeout(() => void this.runDueEscalations(), 20_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Pure step-advancement math: given the ordered steps, the alert's open time,
   * and the last escalated step index (null = none yet), returns the next step
   * that is now due, or null when none is due / the chain is exhausted.
   */
  nextDueStep(
    steps: EscalationStep[],
    openedAt: Date,
    now: Date,
    lastStepIndex: number | null,
  ): DueStep | null {
    const nextIndex = (lastStepIndex ?? -1) + 1;
    if (nextIndex >= steps.length) return null;
    const step = steps[nextIndex];
    const elapsedMinutes = (now.getTime() - openedAt.getTime()) / 60_000;
    if (elapsedMinutes >= step.afterMinutes) return { stepIndex: nextIndex, step };
    return null;
  }

  /** Evaluates due escalations for every enabled tenant. */
  async runDueEscalations(
    now: Date = new Date(),
  ): Promise<Array<{ tenantId: string; escalated: number }>> {
    if (this.running) return [];
    this.running = true;
    try {
      const tenants = await this.database.query<{ id: string }>(
        'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
      );
      const results = [];
      for (const tenant of tenants.rows) {
        const escalated = await this.runForTenant(tenant.id, now).catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'alert escalation failed',
              tenantId: tenant.id,
              error: String((error as Error).message ?? error),
            }),
          );
          return 0;
        });
        results.push({ tenantId: tenant.id, escalated });
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /** Advances due escalations for one tenant. Returns the number recorded. */
  async runForTenant(tenantId: string, now: Date = new Date()): Promise<number> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      // Transaction-level advisory lock: skip if another worker holds it.
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [ESCALATION_LOCK_NAMESPACE, Number(tenantId) % 2147483647],
      );
      if (!lock.rows[0]?.locked) return 0;

      // A lifecycle suppression that has run its course returns the alert to
      // 'open' here, at the one place that would otherwise skip it forever.
      await client.query(
        `UPDATE alert_instances
            SET status='open', suppressed_until=NULL
          WHERE status='suppressed' AND suppressed_until IS NOT NULL AND suppressed_until <= $1`,
        [now],
      );

      const policies = (
        await client.query<{ id: string; steps: EscalationStep[] }>(
          'SELECT id, steps FROM escalation_policies WHERE enabled = true',
        )
      ).rows;
      if (!policies.length) return 0;

      // Only 'open' alerts escalate: a lifecycle-suppressed one stays visible
      // everywhere else but is deliberately not paged while its window runs.
      const alerts = (
        await client.query<OpenAlertRow>(
          `SELECT id, opened_at, details, rule_id,
                  COALESCE(escalation_cycle, 0) AS escalation_cycle,
                  GREATEST(opened_at, COALESCE(escalated_at, opened_at),
                           COALESCE(reopened_at, opened_at)) AS cycle_started_at
             FROM alert_instances WHERE status = 'open' ORDER BY opened_at ASC LIMIT 500`,
        )
      ).rows;
      if (!alerts.length) return 0;

      const windows = (
        await client.query<MaintenanceWindow>(
          'SELECT id, name, starts_at, ends_at, scope FROM maintenance_windows WHERE starts_at <= $1 AND ends_at > $1',
          [now],
        )
      ).rows;

      let recorded = 0;
      for (const policy of policies) {
        const steps = Array.isArray(policy.steps) ? policy.steps : [];
        if (!steps.length) continue;
        for (const alert of alerts) {
          const suppressed = this.maintenance.isSuppressed(
            now,
            { smsc: alert.details?.smsc ?? undefined },
            windows,
          );
          // When a dedup re-observation sharpened the alert (warning ->
          // critical) or an operator reopened it, the cycle counter moves and
          // the chain runs again from that moment: whoever was told about the
          // milder condition is told again about the worse one.
          const cycle = Number(alert.escalation_cycle ?? 0);
          const baseline = new Date(alert.cycle_started_at ?? alert.opened_at);
          const last = await this.lastStepIndex(client, tenantId, alert.id, policy.id, cycle);
          const due = this.nextDueStep(steps, baseline, now, last);
          if (!due) continue;
          await this.recordEscalation(
            client,
            tenantId,
            alert.id,
            policy.id,
            due,
            suppressed,
            cycle,
          );
          recorded += 1;
        }
      }
      return recorded;
    });
  }

  /**
   * Resolves which notification channel a step actually addresses.
   *
   * `recordEscalation` used to run `WHERE enabled AND type=$1 LIMIT 1` and
   * ignore `step.target` entirely, so every level of an escalation chain paged
   * the same first channel: a policy reading "email L1 at 5 min, email the duty
   * manager at 15 min" delivered to L1 twice and the manager never heard.
   *
   * Resolution order, most specific first:
   *   1. a channel whose id, name or transport address equals the target;
   *   2. when nothing matches but exactly one channel of the type exists, that
   *      channel with its address overridden by the target — an operator
   *      naming an address that has no channel of its own means "send there";
   *   3. otherwise the first channel of the type, recorded as `type-default`
   *      so `alert_escalations.detail` shows the target was not honoured.
   *
   * The chosen resolution is always written to the escalation row, so who was
   * paged (and why) is auditable rather than implied.
   */
  routeToTarget(
    candidates: Array<NotificationChannel & { config: Record<string, unknown> }>,
    step: EscalationStep,
  ): {
    channel?: NotificationChannel & { config: Record<string, unknown> };
    resolution: 'target-match' | 'target-override' | 'type-default' | 'none';
  } {
    if (!candidates.length) return { resolution: 'none' };
    const target = (step.target ?? '').trim();
    if (!target) return { channel: candidates[0], resolution: 'type-default' };

    const lowered = target.toLowerCase();
    const addressOf = (channel: NotificationChannel): string[] =>
      [
        channel.id,
        channel.name,
        channel.config?.to,
        channel.config?.url,
        channel.config?.msisdn,
        channel.config?.recipient,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => value.toLowerCase());

    const matched = candidates.find((channel) => addressOf(channel).includes(lowered));
    if (matched) return { channel: matched, resolution: 'target-match' };

    if (candidates.length === 1) {
      const addressKey =
        step.channelType === 'email'
          ? 'to'
          : step.channelType === 'webhook'
            ? 'url'
            : step.channelType === 'sms'
              ? 'msisdn'
              : null;
      if (addressKey)
        return {
          channel: {
            ...candidates[0],
            config: { ...candidates[0].config, [addressKey]: target },
          },
          resolution: 'target-override',
        };
    }
    return { channel: candidates[0], resolution: 'type-default' };
  }

  /**
   * Highest step already recorded for the alert's *current* cycle. Scoping by
   * cycle is what lets a sharpened or reopened alert page the chain again
   * instead of being permanently exhausted by the earlier, milder run.
   */
  private async lastStepIndex(
    client: PoolClient,
    tenantId: string,
    alertId: string,
    policyId: string,
    cycle: number,
  ): Promise<number | null> {
    const row = (
      await client.query<{ max: number | null }>(
        'SELECT max(step_index) AS max FROM alert_escalations WHERE tenant_id=$1 AND alert_id=$2 AND policy_id=$3 AND COALESCE(cycle,0)=$4',
        [tenantId, alertId, policyId, cycle],
      )
    ).rows[0];
    return row?.max ?? null;
  }

  /**
   * Records the escalation step and attempts best-effort delivery through a
   * matching enabled notification channel. When suppressed by a maintenance
   * window the step is recorded with status 'suppressed' and no delivery.
   */
  private async recordEscalation(
    client: PoolClient,
    tenantId: string,
    alertId: string,
    policyId: string,
    due: DueStep,
    suppressed: boolean,
    cycle = 0,
  ): Promise<void> {
    let status: 'escalated' | 'notified' | 'failed' | 'suppressed' = suppressed
      ? 'suppressed'
      : 'escalated';
    const detail: Record<string, unknown> = {
      channelType: due.step.channelType,
      target: due.step.target,
      afterMinutes: due.step.afterMinutes,
    };

    if (!suppressed && this.notifications) {
      const candidates = (
        await client.query<NotificationChannel & { config: Record<string, unknown> }>(
          'SELECT id,name,type,enabled,severities,config FROM notification_channels WHERE enabled=true AND type=$1 ORDER BY created_at ASC',
          [due.step.channelType],
        )
      ).rows;
      const routed = this.routeToTarget(candidates, due.step);
      const channel = routed.channel;
      detail.targetResolution = routed.resolution;
      if (channel) {
        const alert = (
          await client.query<{ summary: string; status: string; severity: string }>(
            'SELECT summary,status,severity FROM alert_instances WHERE id=$1',
            [alertId],
          )
        ).rows[0];
        const attempt = await this.notifications
          .deliver(
            {
              id: alertId,
              summary: alert?.summary ?? 'alert',
              status: alert?.status ?? 'open',
              severity: due.step.severity ?? alert?.severity,
            },
            channel,
          )
          .catch((error) => ({
            channelId: channel.id,
            channelType: channel.type,
            status: 'failed' as const,
            response: { error: String((error as Error).message) },
          }));
        detail.delivery = attempt;
        status = attempt.status === 'succeeded' ? 'notified' : 'failed';
        // Mirror the attempt into notification_deliveries so it shows up on
        // GET /alerts/:id/notifications next to operator-triggered sends —
        // an automatic page that only lived in a jsonb column was invisible.
        await client
          .query(
            `INSERT INTO notification_deliveries
               (tenant_id,alert_id,channel_id,channel_type,status,target,response,attempted_by,delivered_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,'alert-escalation',CASE WHEN $5='succeeded' THEN now() ELSE NULL END)`,
            [
              tenantId,
              alertId,
              channel.id,
              channel.type,
              attempt.status,
              (attempt as { target?: string }).target ?? due.step.target ?? null,
              JSON.stringify(attempt.response ?? {}),
            ],
          )
          .catch(() => undefined);
      } else {
        // No channel of this type exists. Record it loudly: this is exactly the
        // "an alert fired and nobody was told" case that used to be silent.
        status = 'failed';
        detail.undeliverable = true;
        detail.delivery = {
          status: 'undeliverable',
          reason: due.step.target
            ? `no enabled ${due.step.channelType} channel for target '${due.step.target}'`
            : `no enabled ${due.step.channelType} channel`,
        };
      }
    }

    await client.query(
      `INSERT INTO alert_escalations(tenant_id,alert_id,policy_id,step_index,status,detail,cycle)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,alert_id,policy_id,step_index,cycle) DO NOTHING`,
      [tenantId, alertId, policyId, due.stepIndex, status, JSON.stringify(detail), cycle],
    );

    await this.markAlertNotificationState(client, alertId, status, detail);
  }

  /**
   * Surfaces the outcome on the alert itself. `notified` is sticky: once
   * somebody has been reached, a later step that cannot deliver does not
   * downgrade the alert to 'undeliverable'. Nothing here ever writes 'notified'
   * for a delivery that did not succeed.
   */
  private async markAlertNotificationState(
    client: PoolClient,
    alertId: string,
    status: 'escalated' | 'notified' | 'failed' | 'suppressed',
    detail: Record<string, unknown>,
  ): Promise<void> {
    const state =
      status === 'notified'
        ? 'notified'
        : status === 'suppressed'
          ? 'suppressed'
          : status === 'failed'
            ? 'undeliverable'
            : null;
    if (!state) return;
    await client.query(
      `UPDATE alert_instances
          SET notification_state=$2, notification_detail=$3
        WHERE id=$1 AND (notification_state <> 'notified' OR $2='notified')`,
      [
        alertId,
        state,
        JSON.stringify({
          at: new Date().toISOString(),
          escalationStatus: status,
          channelType: detail.channelType ?? null,
          target: detail.target ?? null,
          delivery: detail.delivery ?? null,
        }),
      ],
    );
  }
}
