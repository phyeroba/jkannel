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

      const policies = (
        await client.query<{ id: string; steps: EscalationStep[] }>(
          'SELECT id, steps FROM escalation_policies WHERE enabled = true',
        )
      ).rows;
      if (!policies.length) return 0;

      const alerts = (
        await client.query<OpenAlertRow>(
          "SELECT id, opened_at, details, rule_id FROM alert_instances WHERE status = 'open' ORDER BY opened_at ASC LIMIT 500",
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
          const last = await this.lastStepIndex(client, tenantId, alert.id, policy.id);
          const due = this.nextDueStep(steps, new Date(alert.opened_at), now, last);
          if (!due) continue;
          await this.recordEscalation(client, tenantId, alert.id, policy.id, due, suppressed);
          recorded += 1;
        }
      }
      return recorded;
    });
  }

  private async lastStepIndex(
    client: PoolClient,
    tenantId: string,
    alertId: string,
    policyId: string,
  ): Promise<number | null> {
    const row = (
      await client.query<{ max: number | null }>(
        'SELECT max(step_index) AS max FROM alert_escalations WHERE tenant_id=$1 AND alert_id=$2 AND policy_id=$3',
        [tenantId, alertId, policyId],
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
      const channel = (
        await client.query<NotificationChannel & { config: Record<string, unknown> }>(
          'SELECT id,name,type,enabled,severities,config FROM notification_channels WHERE enabled=true AND type=$1 LIMIT 1',
          [due.step.channelType],
        )
      ).rows[0];
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
            status: 'failed' as const,
            response: { error: String((error as Error).message) },
          }));
        detail.delivery = attempt;
        status = attempt.status === 'succeeded' ? 'notified' : 'failed';
      } else {
        detail.delivery = { reason: `no enabled ${due.step.channelType} channel` };
      }
    }

    await client.query(
      `INSERT INTO alert_escalations(tenant_id,alert_id,policy_id,step_index,status,detail)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,alert_id,policy_id,step_index) DO NOTHING`,
      [tenantId, alertId, policyId, due.stepIndex, status, JSON.stringify(detail)],
    );
  }
}
