import { Injectable } from '@nestjs/common';
export type Comparison = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export interface AlertRule {
  id: string;
  metric: string;
  comparison: Comparison;
  threshold: number;
  durationSeconds: number;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}
export interface MetricSample {
  metric: string;
  value: number;
  observedAt: Date;
  labels: Readonly<Record<string, string>>;
}
export interface AlertEvaluation {
  ruleId: string;
  state: 'inactive' | 'pending' | 'firing';
  severity: AlertRule['severity'];
  value?: number;
  reason: string;
}
@Injectable()
export class AlertEvaluatorService {
  evaluate(rule: AlertRule, samples: ReadonlyArray<MetricSample>, now: Date): AlertEvaluation {
    if (!rule.enabled)
      return {
        ruleId: rule.id,
        state: 'inactive',
        severity: rule.severity,
        reason: 'rule disabled',
      };
    const relevant = samples
      .filter(
        (s) =>
          s.metric === rule.metric &&
          now.getTime() - s.observedAt.getTime() <= rule.durationSeconds * 1000,
      )
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    if (!relevant.length)
      return {
        ruleId: rule.id,
        state: 'inactive',
        severity: rule.severity,
        reason: 'no fresh samples',
      };
    const matches = relevant.filter((s) => this.compare(s.value, rule.comparison, rule.threshold));
    const latest = relevant.at(-1)!;
    if (!this.compare(latest.value, rule.comparison, rule.threshold))
      return {
        ruleId: rule.id,
        state: 'inactive',
        severity: rule.severity,
        value: latest.value,
        reason: 'threshold clear',
      };
    const continuous =
      matches.length === relevant.length &&
      relevant[0].observedAt.getTime() <= now.getTime() - rule.durationSeconds * 1000 * 0.8;
    return {
      ruleId: rule.id,
      state: continuous ? 'firing' : 'pending',
      severity: rule.severity,
      value: latest.value,
      reason: continuous ? 'threshold sustained' : 'threshold not yet sustained',
    };
  }
  private compare(v: number, c: Comparison, t: number) {
    return c === 'gt'
      ? v > t
      : c === 'gte'
        ? v >= t
        : c === 'lt'
          ? v < t
          : c === 'lte'
            ? v <= t
            : v === t;
  }
}
