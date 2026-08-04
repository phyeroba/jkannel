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

/** Ordering used everywhere a severity is compared. */
export const SEVERITY_RANK: Readonly<Record<string, number>> = {
  info: 1,
  warning: 2,
  critical: 3,
};

/** Rank of a severity string; unknown values rank lowest. */
export function severityRank(severity?: string | null): number {
  return SEVERITY_RANK[String(severity ?? '').toLowerCase()] ?? 0;
}

/** True when `next` describes a worse condition than `current`. */
export function isSeverityEscalation(current?: string | null, next?: string | null): boolean {
  return severityRank(next) > severityRank(current);
}

const SEVERITY_CASE = (column: string): string =>
  `(CASE ${column} WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END)`;

/**
 * The `ON CONFLICT` tail shared by every `INSERT INTO alert_instances` path
 * (rule evaluator, SMSC poller, anomaly detector).
 *
 * It used to be `DO NOTHING`, which meant a deduplicated alert kept the wording
 * and severity of the *first* observation: a bind that went `connecting` ->
 * `disconnected` still read "is connecting" at warning severity while the link
 * was hard down. Now a re-observation that is genuinely worse re-sharpens the
 * open alert — new summary, new severity, `previous_severity` and
 * `escalated_at` recorded, `dedup_count` incremented, and the old wording kept
 * in `details.escalatedFrom` so the history is not lost. A re-observation that
 * is not worse still changes nothing (the `WHERE` below), so a flapping
 * condition cannot rewrite the incident every poll.
 *
 * Because `escalated_at` moves, AlertEscalationService restarts the escalation
 * chain from step 0 for the sharpened alert: the people already told about a
 * warning are told again when it becomes critical. A lifecycle-suppressed alert
 * keeps its suppression (the operator asked for silence) but still gets the
 * corrected wording; a closed one is reopened, because the condition came back.
 *
 * `RETURNING (xmax = 0) AS inserted` distinguishes a fresh incident from a
 * sharpened one: xmax is zero only on the row the INSERT actually inserted.
 */
export const ALERT_DEDUP_ESCALATION_SQL = `ON CONFLICT (tenant_id, dedup_key) WHERE status <> 'resolved' AND dedup_key IS NOT NULL
       DO UPDATE SET
         severity = EXCLUDED.severity,
         summary = EXCLUDED.summary,
         previous_severity = alert_instances.severity,
         escalated_at = now(),
         escalation_cycle = alert_instances.escalation_cycle + 1,
         dedup_count = alert_instances.dedup_count + 1,
         details = alert_instances.details || EXCLUDED.details ||
                   jsonb_build_object('escalatedFrom', jsonb_build_object(
                     'severity', alert_instances.severity,
                     'summary', alert_instances.summary,
                     'at', now())),
         status = CASE WHEN alert_instances.status = 'closed' THEN 'open' ELSE alert_instances.status END,
         closed_at = CASE WHEN alert_instances.status = 'closed' THEN NULL ELSE alert_instances.closed_at END,
         resolved_at = CASE WHEN alert_instances.status = 'closed' THEN NULL ELSE alert_instances.resolved_at END,
         notification_state = CASE WHEN alert_instances.status = 'suppressed'
                                   THEN alert_instances.notification_state ELSE 'pending' END
       WHERE ${SEVERITY_CASE('EXCLUDED.severity')} > ${SEVERITY_CASE('alert_instances.severity')}
       RETURNING (xmax = 0) AS inserted, id, severity, previous_severity`;

/**
 * Reads the outcome of an insert that used {@link ALERT_DEDUP_ESCALATION_SQL}.
 * `opened` means a new incident; `escalated` means an existing open one was
 * re-sharpened; neither means the duplicate was correctly ignored.
 */
export function readAlertUpsert(result: {
  rows: Array<{ inserted?: boolean; id?: string; severity?: string; previous_severity?: string }>;
}): { opened: boolean; escalated: boolean; alertId?: string } {
  const row = result.rows[0];
  if (!row) return { opened: false, escalated: false };
  return { opened: row.inserted === true, escalated: row.inserted === false, alertId: row.id };
}

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
