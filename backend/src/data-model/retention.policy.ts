/**
 * Retention / archive policy registry for the high-volume log tables.
 *
 * Each policy names a source table, its cold-storage archive table, the
 * timestamp column that ages rows, a retention window (days), and whether rows
 * may be DELETED from the source after archiving.
 *
 *   - notification_deliveries / gateway_request_log are ordinary tables:
 *     archived then pruned (deleteAfterArchive = true).
 *   - audit_log is append-only (an immutability trigger from migration 001
 *     rejects UPDATE/DELETE) AND already RANGE-partitioned by created_at, so it
 *     is archived COPY-ONLY (deleteAfterArchive = false). Genuine space reclaim
 *     is done by dropping old partitions at the DB/ops layer — see the note at
 *     the foot of migration 027. The `watermark` column of
 *     data_model_retention_state stops copy-only policies re-scanning old rows.
 *
 * Retention windows are overridable per policy via an environment variable
 * (e.g. DATA_MODEL_RETENTION_AUDIT_LOG_DAYS) so operators can tune without a
 * code change; defaults are conservative.
 */
export interface RetentionPolicy {
  sourceTable: string;
  archiveTable: string;
  /** Column used to age rows (all current policies use created_at). */
  timestampColumn: string;
  /** Default retention window in days. */
  retentionDays: number;
  /** Env var that overrides retentionDays when set to a positive integer. */
  retentionEnvVar: string;
  /** When true, prune (DELETE) source rows after archiving; else copy-only. */
  deleteAfterArchive: boolean;
  /** Column list copied into the archive table (must exist on both). */
  columns: string[];
}

export const RETENTION_POLICIES: RetentionPolicy[] = [
  {
    sourceTable: 'audit_log',
    archiveTable: 'audit_log_archive',
    timestampColumn: 'created_at',
    retentionDays: 365,
    retentionEnvVar: 'DATA_MODEL_RETENTION_AUDIT_LOG_DAYS',
    deleteAfterArchive: false,
    columns: [
      'id',
      'uuid',
      'tenant_id',
      'actor_id',
      'action',
      'entity_type',
      'entity_id',
      'old_value',
      'new_value',
      'reason',
      'correlation_id',
      'source_ip',
      'row_hash',
      'prev_hash',
      'created_at',
    ],
  },
  {
    sourceTable: 'notification_deliveries',
    archiveTable: 'notification_deliveries_archive',
    timestampColumn: 'created_at',
    retentionDays: 90,
    retentionEnvVar: 'DATA_MODEL_RETENTION_NOTIFICATION_DELIVERIES_DAYS',
    deleteAfterArchive: true,
    columns: [
      'id',
      'tenant_id',
      'alert_id',
      'channel_id',
      'channel_type',
      'status',
      'target',
      'response',
      'attempted_by',
      'category',
      'created_at',
      'delivered_at',
    ],
  },
  {
    sourceTable: 'gateway_request_log',
    archiveTable: 'gateway_request_log_archive',
    timestampColumn: 'created_at',
    retentionDays: 90,
    retentionEnvVar: 'DATA_MODEL_RETENTION_GATEWAY_REQUEST_LOG_DAYS',
    deleteAfterArchive: true,
    columns: [
      'id',
      'tenant_id',
      'api_key_id',
      'key_prefix',
      'route',
      'method',
      'status_code',
      'outcome',
      'ip_address',
      'correlation_id',
      'created_at',
    ],
  },
];

/** Effective retention window for a policy, honoring its env override. */
export function effectiveRetentionDays(
  policy: RetentionPolicy,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[policy.retentionEnvVar]);
  return Number.isInteger(raw) && raw > 0 ? raw : policy.retentionDays;
}

/** The cutoff instant: rows strictly older than this are eligible for archive. */
export function retentionCutoff(policy: RetentionPolicy, now: Date, env?: NodeJS.ProcessEnv): Date {
  return new Date(now.getTime() - effectiveRetentionDays(policy, env) * 86_400_000);
}

/** A row with an ageable timestamp, used by the pure eligibility selector. */
export interface AgeableRow {
  created_at: string | Date;
}

/**
 * Pure eligibility selector (unit-testable without a database): a row is
 * eligible for archive when its timestamp is strictly older than the cutoff and
 * — for copy-only policies with a watermark — not already archived (timestamp
 * at or after the watermark). Returned rows preserve input order.
 */
export function selectEligible<T extends AgeableRow>(
  rows: T[],
  cutoff: Date,
  watermark?: Date | null,
): T[] {
  const cutoffMs = cutoff.getTime();
  const watermarkMs = watermark ? watermark.getTime() : null;
  return rows.filter((row) => {
    const ts = new Date(row.created_at).getTime();
    if (ts >= cutoffMs) return false;
    if (watermarkMs !== null && ts < watermarkMs) return false;
    return true;
  });
}
