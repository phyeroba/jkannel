/**
 * The alert vocabulary shared by the Alerts register and the response screen
 * (spec §13, UC-ALT-01).
 *
 * The design's Alerts grid has Category, Started, Duration and Acknowledgement
 * columns. None of those are columns in `alert_instances` — but all four are
 * derivable from what the emitters DO write, and this module is where that
 * derivation lives so the two screens cannot disagree about what an alert is.
 *
 * CATEGORY IS A TRANSLATION, NOT AN INVENTION. Four emitters write alerts and
 * each stamps `details.kind`:
 *
 *   smsc-status.poller          engine_unreachable · bind_state
 *   anomaly-detection.service   volume_drop · volume_spike · dlr_failure
 *   alert-rule-evaluator        rule_threshold, plus `details.metric`
 *   backup-dr.repository        the `backup:` dedup namespace
 *
 * CATEGORY_OF maps those to the design's category words. A kind this build has
 * never heard of falls back to the raw kind rather than to a default bucket:
 * putting an unrecognised alert under "Infrastructure" would file a real
 * problem under a heading nobody is watching.
 */
import type { Tone } from './connectivity';
import { formatDuration } from './traffic';

/** The design's category words, in the order the filter offers them. */
export const ALERT_CATEGORIES = [
  'Availability',
  'Connectivity quality',
  'Capacity',
  'Delivery quality',
  'Traffic anomaly',
  'Infrastructure',
  'Telemetry',
] as const;

export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** `details.kind` → category, for every kind the backend actually emits. */
const CATEGORY_OF: Record<string, AlertCategory> = {
  engine_unreachable: 'Availability',
  bind_state: 'Connectivity quality',
  bind_failures: 'Connectivity quality',
  volume_drop: 'Traffic anomaly',
  volume_spike: 'Traffic anomaly',
  dlr_failure: 'Delivery quality',
};

/**
 * A rule alert's category comes from the metric it watches, because the rule
 * itself is user-authored and its name says nothing reliable. Ordered: the
 * first pattern that matches wins.
 */
const METRIC_CATEGORIES: Array<[RegExp, AlertCategory]> = [
  [/^(smsc\.bind\.up|engine\.up|engine\.binds)/, 'Availability'],
  [/^(smsc\.queued|smsc\.throughput|engine\.sms\.queued|engine\.dlr\.queued|engine\.store)/, 'Capacity'],
  [/^smsc\.failed/, 'Delivery quality'],
  [/^smsc\.(sent|received)/, 'Traffic anomaly'],
];

/** Reads a nested value without assuming the row's casing or completeness. */
function detail(row: AlertRow, key: string): string | null {
  const details = row.details as Record<string, unknown> | null | undefined;
  const value = details?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export interface AlertRow {
  id?: unknown;
  severity?: unknown;
  status?: unknown;
  summary?: unknown;
  source?: unknown;
  details?: unknown;
  dedup_key?: unknown;
  dedupKey?: unknown;
  dedup_count?: unknown;
  dedupCount?: unknown;
  opened_at?: unknown;
  openedAt?: unknown;
  resolved_at?: unknown;
  resolvedAt?: unknown;
  acknowledged_at?: unknown;
  acknowledgedAt?: unknown;
  acknowledged_by?: unknown;
  acknowledgedBy?: unknown;
  acknowledgement_note?: unknown;
  acknowledgementNote?: unknown;
}

function first(...values: unknown[]): string | null {
  for (const value of values)
    if (typeof value === 'string' && value.trim()) return value;
  return null;
}

/**
 * The alert's category, or the raw kind when this build cannot place it.
 *
 * Returning the kind verbatim is the point of the fallback. A new emitter
 * shipping a kind we have not mapped shows up as an unfamiliar word in the
 * Category column, which is a visible prompt to map it — whereas silently
 * bucketing it as "Infrastructure" hides a real alert under a heading whoever
 * is on call is not filtering for.
 */
export function alertCategory(row: AlertRow): string {
  const kind = detail(row, 'kind');
  if (kind && CATEGORY_OF[kind]) return CATEGORY_OF[kind];
  if (kind === 'rule_threshold') {
    const metric = detail(row, 'metric');
    if (metric) {
      for (const [pattern, category] of METRIC_CATEGORIES)
        if (pattern.test(metric)) return category;
      return metric;
    }
  }
  const dedup = first(row.dedup_key, row.dedupKey) ?? '';
  if (dedup.startsWith('backup:')) return 'Infrastructure';
  return kind ?? 'uncategorised';
}

/**
 * What the alert is about.
 *
 * `details.smsc` is preferred because the escalation and maintenance services
 * both read that key, so it is the one the backend itself treats as the
 * subject. The dedup key is the fallback, and its namespaces are stable
 * contracts — the partial unique index depends on them.
 */
export function alertObject(row: AlertRow): string {
  const smsc = detail(row, 'smsc');
  if (smsc) return smsc;
  const dedup = first(row.dedup_key, row.dedupKey);
  if (!dedup) return 'the platform';
  const parts = dedup.split(':');
  if (dedup === 'engine:unreachable') return 'the SMS engine';
  // engine:bind:<id> · engine:bind-failures:<id> · anomaly:<kind>:<id> ·
  // backup:<state>:<label> — in every namespace the subject is the tail.
  if (parts.length >= 3) return parts.slice(2).join(':');
  return dedup;
}

/** When it started. Null when the row carries no open timestamp at all. */
export function alertStarted(row: AlertRow): string | null {
  return first(row.opened_at, row.openedAt);
}

/**
 * How long the alert has been (or was) active, in seconds.
 *
 * An unresolved alert measures to now, which is what makes the column worth
 * having — "critical, 40 minutes" reads very differently from "critical". A
 * resolved one measures to its resolution and stops, so the grid does not show
 * a closed incident ageing.
 */
export function alertDurationSeconds(row: AlertRow, now: number = Date.now()): number | null {
  const started = alertStarted(row);
  if (!started) return null;
  const from = Date.parse(started);
  if (!Number.isFinite(from)) return null;
  const resolved = first(row.resolved_at, row.resolvedAt);
  const to = resolved ? Date.parse(resolved) : now;
  if (!Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/** The duration column. Never `0s` from a missing timestamp — that is unknown. */
export function alertDuration(row: AlertRow, now: number = Date.now()): string {
  const seconds = alertDurationSeconds(row, now);
  return seconds === null ? 'unknown' : formatDuration(seconds);
}

/**
 * Who acknowledged it, when, and what they said.
 *
 * "unacknowledged" is a real state and the design prints it as a word rather
 * than leaving the cell blank — a blank cell reads as a rendering fault on a
 * screen where every other row has text.
 */
export function alertAcknowledgement(row: AlertRow): string {
  const by = first(row.acknowledged_by, row.acknowledgedBy);
  const at = first(row.acknowledged_at, row.acknowledgedAt);
  if (!by && !at) return 'unacknowledged';
  const who = by ?? 'someone';
  const when = at ? new Date(at).toLocaleString() : null;
  const note = first(row.acknowledgement_note, row.acknowledgementNote);
  return [when ? `${who} · ${when}` : who, note].filter(Boolean).join(' — ');
}

/** Occurrences. The dedup counter, which starts at 1 for a first sighting. */
export function alertOccurrences(row: AlertRow): number {
  const value = Number(row.dedup_count ?? row.dedupCount ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Severity tone. An unrecognised severity is muted, never quietly `info`. */
export function alertSeverityTone(severity: unknown): Tone {
  switch (String(severity ?? '').toLowerCase()) {
    case 'critical':
      return 'bad';
    case 'warning':
      return 'warn';
    case 'info':
      return 'good';
    default:
      return 'muted';
  }
}
