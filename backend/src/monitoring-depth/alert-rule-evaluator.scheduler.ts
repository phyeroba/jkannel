import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  AlertEvaluatorService,
  Comparison,
  MetricSample,
} from '../monitoring/alert-evaluator.service';
import { MaintenanceWindow, MaintenanceWindowService } from './maintenance-window.service';

// Namespace for the per-tenant transaction-level advisory lock (arbitrary).
const RULE_EVALUATOR_LOCK_NAMESPACE = 0x1f4a;

/**
 * Minimum window of samples considered when a rule has `sustain_seconds = 0`
 * (the console's default). The pure evaluator filters samples by the rule's
 * duration, so a literal zero would match nothing and the rule could never
 * fire — see {@link AlertRuleEvaluatorScheduler.evaluateRule}.
 */
const INSTANT_RULE_WINDOW_SECONDS = 120;

interface AlertRuleRow {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: string | number;
  sustain_seconds: number;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}

interface MetricSampleRow {
  metric: string;
  value: string | number;
  labels: Record<string, string> | null;
  observed_at: string | Date;
}

export interface RuleEvaluationOutcome {
  ruleId: string;
  ruleName: string;
  labels: Record<string, string>;
  state: 'inactive' | 'pending' | 'firing';
  value?: number;
  reason: string;
  opened: boolean;
  resolved: boolean;
  suppressed: boolean;
}

/** Stable, order-independent key for a sample's label set. */
export function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return keys.map((key) => `${key}=${labels[key]}`).join(',');
}

/**
 * Drives {@link AlertEvaluatorService} over the sample stream that
 * {@link SmscStatusPoller} writes into `metric_samples` (gap G3).
 *
 * `AlertEvaluatorService` was already a correct, tested, pure evaluator — and
 * it was injected nowhere. An operator could author "queue depth > 5000 for 5
 * minutes => critical" in the console, save it successfully, and it would never
 * fire: no scheduler called the evaluator, and there was no metric store for it
 * to read. This scheduler closes that loop without touching the evaluator:
 *
 *   - per enabled tenant, under a transaction advisory lock (so replicas do not
 *     double-open alerts), it loads every enabled `alert_rules` row;
 *   - it reads the recent `metric_samples` for that rule's metric and groups
 *     them by label set, so one rule on `smsc.queued` evaluates independently
 *     per bind rather than mashing every bind into one series;
 *   - each group is handed to the untouched pure evaluator;
 *   - a `firing` group opens a deduplicated `alert_instances` row
 *     (`dedup_key = rule:<ruleId>:<labels>`, `source='rule'`, `rule_id` set), a
 *     group that has gone clear resolves the open one.
 *
 * Opening the instance is the hand-off: `AlertEscalationService` already scans
 * open alerts, walks the escalation policy steps and delivers through
 * `NotificationDeliveryService`. Migration 031 seeds a default policy and a
 * dashboard channel so that chain is live on a fresh deployment instead of
 * being configured-but-empty.
 *
 * Active maintenance windows suppress *opening* (not resolving), reusing the
 * same {@link MaintenanceWindowService} predicate the escalation runner uses.
 *
 * Disabled under NODE_ENV=test and when ALERT_RULE_EVALUATOR_ENABLED=false.
 */
@Injectable()
export class AlertRuleEvaluatorScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly evaluator: AlertEvaluatorService,
    private readonly maintenance: MaintenanceWindowService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.ALERT_RULE_EVALUATOR_ENABLED === 'false')
      return;
    const interval = Number(process.env.ALERT_RULE_EVALUATOR_INTERVAL_MS ?? 60_000);
    this.timer = setInterval(
      () => void this.runCycle(),
      Number.isFinite(interval) ? interval : 60_000,
    );
    this.timer.unref?.();
    // After the poller's first cycle (10s), so there are samples to judge.
    setTimeout(() => void this.runCycle(), 30_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Evaluates every enabled tenant's rules. Never throws. */
  async runCycle(
    now: Date = new Date(),
  ): Promise<Array<{ tenantId: string; outcomes: RuleEvaluationOutcome[] }>> {
    if (this.running) return [];
    this.running = true;
    try {
      const tenants = await this.database
        .query<{ id: string }>('SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived')
        .catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'alert rule evaluation could not list tenants',
              error: String((error as Error).message ?? error),
            }),
          );
          return { rows: [] as Array<{ id: string }> };
        });
      const results = [];
      for (const tenant of tenants.rows) {
        const outcomes = await this.runForTenant(tenant.id, now).catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'alert rule evaluation failed for tenant',
              tenantId: tenant.id,
              error: String((error as Error).message ?? error),
            }),
          );
          return [] as RuleEvaluationOutcome[];
        });
        results.push({ tenantId: tenant.id, outcomes });
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  /** Evaluates one tenant's enabled rules against its recent samples. */
  async runForTenant(tenantId: string, now: Date = new Date()): Promise<RuleEvaluationOutcome[]> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [RULE_EVALUATOR_LOCK_NAMESPACE, Number(tenantId) % 2147483647],
      );
      if (!lock.rows[0]?.locked) return [];

      const rules = (
        await client.query<AlertRuleRow>(
          `SELECT id::text, name, metric, operator, threshold, sustain_seconds, severity, enabled
             FROM alert_rules WHERE enabled = true ORDER BY created_at ASC LIMIT 500`,
        )
      ).rows;
      if (!rules.length) return [];

      const windows = (
        await client.query<MaintenanceWindow>(
          'SELECT id, name, starts_at, ends_at, scope FROM maintenance_windows WHERE starts_at <= $1 AND ends_at > $1',
          [now],
        )
      ).rows;

      const outcomes: RuleEvaluationOutcome[] = [];
      for (const rule of rules) {
        outcomes.push(...(await this.evaluateRule(client, tenantId, rule, windows, now)));
      }
      return outcomes;
    });
  }

  /**
   * Evaluates a single rule across every label set present in its metric.
   *
   * `sustain_seconds = 0` means "fire as soon as the threshold is crossed", but
   * the pure evaluator filters samples to `now - durationSeconds`, which for a
   * zero duration selects nothing. Rather than fork the evaluator, the rule is
   * widened to a short window and a `pending` result (threshold met but not yet
   * sustained) is accepted as firing — which is precisely the requested
   * semantics for a no-sustain rule.
   */
  private async evaluateRule(
    client: PoolClient,
    tenantId: string,
    rule: AlertRuleRow,
    windows: MaintenanceWindow[],
    now: Date,
  ): Promise<RuleEvaluationOutcome[]> {
    const sustain = Math.max(0, Number(rule.sustain_seconds) || 0);
    const durationSeconds = sustain > 0 ? sustain : INSTANT_RULE_WINDOW_SECONDS;
    const since = new Date(now.getTime() - durationSeconds * 1000);
    const rows = (
      await client.query<MetricSampleRow>(
        `SELECT metric, value, labels, observed_at
           FROM metric_samples
          WHERE metric = $1 AND observed_at >= $2
          ORDER BY observed_at ASC
          LIMIT 5000`,
        [rule.metric, since],
      )
    ).rows;

    const grouped = new Map<string, { labels: Record<string, string>; samples: MetricSample[] }>();
    for (const row of rows) {
      const labels = row.labels ?? {};
      const key = labelKey(labels);
      const group = grouped.get(key) ?? { labels, samples: [] };
      group.samples.push({
        metric: row.metric,
        value: Number(row.value),
        observedAt: new Date(row.observed_at),
        labels,
      });
      grouped.set(key, group);
    }

    // No samples at all is itself worth surfacing: a rule on a metric nothing
    // produces is a rule that will never fire, and the operator should be able
    // to see that in the outcome rather than infer it from silence.
    if (!grouped.size)
      return [
        {
          ruleId: rule.id,
          ruleName: rule.name,
          labels: {},
          state: 'inactive',
          reason: `no samples for metric '${rule.metric}' in the last ${durationSeconds}s`,
          opened: false,
          resolved: false,
          suppressed: false,
        },
      ];

    const outcomes: RuleEvaluationOutcome[] = [];
    for (const [key, group] of grouped) {
      const evaluation = this.evaluator.evaluate(
        {
          id: rule.id,
          metric: rule.metric,
          comparison: rule.operator as Comparison,
          threshold: Number(rule.threshold),
          durationSeconds,
          severity: rule.severity,
          enabled: true,
        },
        group.samples,
        now,
      );
      const fires = sustain > 0 ? evaluation.state === 'firing' : evaluation.state !== 'inactive';
      const dedupKey = key ? `rule:${rule.id}:${key}` : `rule:${rule.id}`;
      const suppressed =
        fires &&
        this.maintenance.isSuppressed(now, { smsc: group.labels.smsc ?? undefined }, windows);

      let opened = false;
      let resolved = false;
      if (fires && !suppressed) {
        opened =
          (await this.openAlert(client, tenantId, rule, group.labels, dedupKey, evaluation.value)) >
          0;
      } else if (!fires && evaluation.state === 'inactive') {
        resolved = (await this.resolveAlert(client, dedupKey, now)) > 0;
      }

      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        labels: group.labels,
        state: evaluation.state,
        value: evaluation.value,
        reason: evaluation.reason,
        opened,
        resolved,
        suppressed,
      });
    }
    return outcomes;
  }

  private async openAlert(
    client: PoolClient,
    tenantId: string,
    rule: AlertRuleRow,
    labels: Record<string, string>,
    dedupKey: string,
    value: number | undefined,
  ): Promise<number> {
    const scope = labels.smsc ? ` on ${labels.smsc}` : '';
    const summary = `${rule.name}: ${rule.metric}${scope} ${rule.operator} ${rule.threshold} (observed ${value ?? 'n/a'})`;
    const result = await client.query(
      `INSERT INTO alert_instances (tenant_id, rule_id, status, severity, source, dedup_key, summary, details)
       VALUES ($1, $2, 'open', $3, 'rule', $4, $5, $6)
       ON CONFLICT (tenant_id, dedup_key) WHERE status <> 'resolved' AND dedup_key IS NOT NULL
       DO NOTHING`,
      [
        tenantId,
        rule.id,
        rule.severity,
        dedupKey,
        summary,
        JSON.stringify({
          kind: 'rule_threshold',
          metric: rule.metric,
          operator: rule.operator,
          threshold: Number(rule.threshold),
          sustainSeconds: Number(rule.sustain_seconds) || 0,
          observed: value ?? null,
          // `smsc` is the key AlertEscalationService and MaintenanceWindowService
          // both read for scoping, so it must live at the top of details.
          ...(labels.smsc ? { smsc: labels.smsc } : {}),
          labels,
        }),
      ],
    );
    return result.rowCount ?? 0;
  }

  private async resolveAlert(client: PoolClient, dedupKey: string, now: Date): Promise<number> {
    const result = await client.query(
      `UPDATE alert_instances SET status = 'resolved', resolved_at = $2
        WHERE dedup_key = $1 AND status <> 'resolved'`,
      [dedupKey, now],
    );
    return result.rowCount ?? 0;
  }
}
