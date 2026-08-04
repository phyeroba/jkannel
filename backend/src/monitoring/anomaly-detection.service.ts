import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ALERT_DEDUP_ESCALATION_SQL } from '../monitoring-depth/alert-correlation.service';

export interface AnomalyFinding {
  smscEngineId: string;
  smscLabel: string;
  kind: 'volume_drop' | 'volume_spike' | 'dlr_failure';
  severity: 'info' | 'warning' | 'critical';
  observed: number;
  baseline: number;
  summary: string;
}

const DEFAULTS = {
  minBaselineDays: 3,
  minBaselineMean: 20, // ignore low-traffic SMSCs where ratios are noisy
  dropRatio: 0.5, // observed < 50% of baseline mean → drop
  spikeRatio: 3, // observed > 3× baseline mean → spike
  dlrFailureRatio: 0.3, // >30% of a day's messages produced no DLR/failed
};

/**
 * Traffic anomaly detection over the daily per-SMSC report snapshots. For each
 * tenant it compares the most recent completed day against the trailing
 * baseline (mean of prior daily snapshots) and opens deduplicated alert
 * instances for significant volume drops/spikes and DLR-failure ratios. Alerts
 * flow into the existing alert pipeline (acknowledge/notify), so no separate
 * surfacing is required.
 *
 * Statistics-based and deliberately simple; it is the substrate the AI
 * anomaly/prediction pipeline in the AI Operations spec can later refine.
 */
@Injectable()
export class AnomalyDetectionService {
  constructor(private readonly database: DatabaseService) {}

  /** Runs detection for every enabled tenant. Returns findings per tenant. */
  async runForAllTenants(): Promise<Array<{ tenantId: string; findings: AnomalyFinding[] }>> {
    const tenants = await this.database.query<{ id: string }>(
      'SELECT id::text FROM tenants WHERE is_enabled AND NOT is_archived',
    );
    const results = [];
    for (const tenant of tenants.rows) {
      const findings = await this.runForTenant(tenant.id).catch((error) => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'anomaly detection failed',
            tenantId: tenant.id,
            error: String((error as Error).message ?? error),
          }),
        );
        return [] as AnomalyFinding[];
      });
      results.push({ tenantId: tenant.id, findings });
    }
    return results;
  }

  async runForTenant(tenantId: string): Promise<AnomalyFinding[]> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const rows = await client.query<{
        scope_key: string;
        scope_label: string;
        period_start: string;
        message_count: string;
        dlr_count: string;
      }>(
        `SELECT scope_key, scope_label, period_start, message_count, dlr_count
           FROM report_snapshots
          WHERE period_type = 'daily' AND scope = 'smsc'
          ORDER BY scope_key, period_start DESC`,
      );
      const bySmsc = new Map<string, typeof rows.rows>();
      for (const row of rows.rows) {
        const list = bySmsc.get(row.scope_key) ?? [];
        list.push(row);
        bySmsc.set(row.scope_key, list);
      }

      const findings: AnomalyFinding[] = [];
      for (const [engineId, series] of bySmsc) {
        const finding = this.evaluateSeries(engineId, series);
        if (finding) findings.push(finding);
      }
      for (const finding of findings) await this.openAlert(client, tenantId, finding);
      return findings;
    });
  }

  private evaluateSeries(
    engineId: string,
    series: Array<{
      scope_label: string;
      message_count: string;
      dlr_count: string;
    }>,
  ): AnomalyFinding | null {
    if (series.length < DEFAULTS.minBaselineDays + 1) return null;
    const [latest, ...history] = series;
    const label = latest.scope_label || engineId;
    const observed = Number(latest.message_count);
    const baselineWindow = history.slice(0, 14).map((row) => Number(row.message_count));
    const mean = baselineWindow.reduce((sum, v) => sum + v, 0) / baselineWindow.length;

    if (mean >= DEFAULTS.minBaselineMean) {
      if (observed < mean * DEFAULTS.dropRatio) {
        return {
          smscEngineId: engineId,
          smscLabel: label,
          kind: 'volume_drop',
          severity: observed === 0 ? 'critical' : 'warning',
          observed,
          baseline: Math.round(mean),
          summary: `Traffic drop on ${label}: ${observed} messages vs ${Math.round(mean)}/day baseline`,
        };
      }
      if (observed > mean * DEFAULTS.spikeRatio) {
        return {
          smscEngineId: engineId,
          smscLabel: label,
          kind: 'volume_spike',
          severity: 'warning',
          observed,
          baseline: Math.round(mean),
          summary: `Traffic spike on ${label}: ${observed} messages vs ${Math.round(mean)}/day baseline`,
        };
      }
    }

    const dlrs = Number(latest.dlr_count);
    if (observed >= DEFAULTS.minBaselineMean) {
      const failureRatio = 1 - Math.min(dlrs / observed, 1);
      if (failureRatio > DEFAULTS.dlrFailureRatio) {
        return {
          smscEngineId: engineId,
          smscLabel: label,
          kind: 'dlr_failure',
          severity: failureRatio > 0.6 ? 'critical' : 'warning',
          observed: Math.round(failureRatio * 100),
          baseline: 0,
          summary: `Low delivery confirmation on ${label}: ${Math.round(failureRatio * 100)}% of ${observed} messages had no delivery report`,
        };
      }
    }
    return null;
  }

  private async openAlert(
    client: PoolClient,
    tenantId: string,
    finding: AnomalyFinding,
  ): Promise<void> {
    const dedupKey = `anomaly:${finding.kind}:${finding.smscEngineId}`;
    // The partial unique index (migration 014) makes this idempotent while an
    // instance for the same anomaly is still open/acknowledged; a worsening
    // finding re-sharpens the open alert instead of leaving stale wording.
    await client.query(
      `INSERT INTO alert_instances (tenant_id, rule_id, status, severity, source, dedup_key, summary, details)
       VALUES ($1, NULL, 'open', $2, 'anomaly', $3, $4, $5)
       ${ALERT_DEDUP_ESCALATION_SQL}`,
      [
        tenantId,
        finding.severity,
        dedupKey,
        finding.summary,
        JSON.stringify({
          kind: finding.kind,
          smsc: finding.smscEngineId,
          observed: finding.observed,
          baseline: finding.baseline,
          detector: 'baseline-statistics',
        }),
      ],
    );
  }
}
