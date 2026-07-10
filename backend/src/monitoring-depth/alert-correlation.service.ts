import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

export interface DedupKeyParts {
  ruleId?: string | null;
  smsc?: string | null;
  kind?: string | null;
}

export interface DedupDecision {
  deduped: boolean;
  alertId?: string;
  dedupCount?: number;
}

const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Duplicate suppression and correlation grouping for alerts.
 *
 * `dedupeIfOpen` is the helper the alert/anomaly insert paths can call *before*
 * opening a new alert: if an unresolved alert with the same dedup key already
 * exists within the window, it increments that alert's `dedup_count` and reports
 * `deduped: true` instead of creating a duplicate incident. `correlationGroupFor`
 * derives a stable group id (by SMSC, else rule) so related alerts collapse into
 * one logical group surfaced by GET /monitoring/correlations.
 *
 * The service is deliberately standalone (helper + endpoint): it does not rewire
 * the existing anomaly/alert insert paths. See the module docs for where a
 * maintainer would call `dedupeIfOpen`.
 */
@Injectable()
export class AlertCorrelationService {
  /** Stable dedup key from the rule/smsc/kind triple. */
  dedupKey(parts: DedupKeyParts): string {
    return ['rule', parts.ruleId ?? '-', 'smsc', parts.smsc ?? '-', 'kind', parts.kind ?? '-'].join(
      ':',
    );
  }

  /** Correlation group id: prefer the SMSC, fall back to the rule. */
  correlationGroupFor(parts: DedupKeyParts): string | null {
    if (parts.smsc) return `smsc:${parts.smsc}`;
    if (parts.ruleId) return `rule:${parts.ruleId}`;
    return null;
  }

  /**
   * If an unresolved alert with `dedupKey` exists within `windowMinutes`,
   * increments its dedup_count and returns the deduped decision; otherwise
   * returns `{ deduped: false }` so the caller proceeds to open a new alert.
   * Runs inside the caller's tenant transaction (RLS applies).
   */
  async dedupeIfOpen(
    client: PoolClient,
    tenantId: string,
    dedupKey: string,
    windowMinutes: number = DEFAULT_WINDOW_MINUTES,
  ): Promise<DedupDecision> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM alert_instances
        WHERE tenant_id = $1 AND dedup_key = $2 AND status <> 'resolved'
          AND opened_at >= now() - ($3 || ' minutes')::interval
        ORDER BY opened_at DESC
        LIMIT 1`,
      [tenantId, dedupKey, String(windowMinutes)],
    );
    if (!existing.rows.length) return { deduped: false };
    const id = existing.rows[0].id;
    const updated = await client.query<{ dedup_count: number }>(
      `UPDATE alert_instances
          SET dedup_count = dedup_count + 1
        WHERE tenant_id = $1 AND id = $2
        RETURNING dedup_count`,
      [tenantId, id],
    );
    return { deduped: true, alertId: id, dedupCount: updated.rows[0]?.dedup_count };
  }
}
