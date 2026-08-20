/**
 * The Traffic vocabulary shared by Live Traffic, Queues and DLR Performance
 * (PLAN.md Phase 3, spec §6 §7 §8).
 *
 * `connectivity.ts` holds the Carrier → SMSC → bind vocabulary and is imported
 * here rather than copied; this file adds only what the three traffic screens
 * need on top of it — durations, shares, growth, and the two things Phase 3 must
 * never get wrong:
 *
 * - **A drain estimate that does not exist is a SENTENCE, not a symbol.** §7 and
 *   UC-QUE-01 are explicit: when egress is zero the answer is "unavailable",
 *   never infinity. The backend already writes the sentence — four different
 *   ones, for four different causes — and `describeDrain` renders whichever it
 *   sent word for word. Paraphrasing it would collapse "the engine restarted"
 *   and "nothing is leaving this queue" into one meaningless "unavailable", and
 *   those two have completely different fixes.
 * - **A share of nothing is not zero per cent.** `formatShare` returns the em
 *   dash for a null rate, because `deliveryRate` is null precisely when no
 *   message in the window has settled yet — and "0%" is how an operator
 *   declares an outage that is not happening.
 */
import { isMeasured, type DataState } from './data-state';
import type { Tone } from './connectivity';

// --- GET /queue-console/live ------------------------------------------------

export interface LiveEngine {
  status?: string | null;
  version?: string | null;
  uptimeSeconds?: number | null;
  smsQueuedOut?: number | null;
  smsQueuedIn?: number | null;
  dlrQueued?: number | null;
  storeSize?: number | null;
}

export interface LiveBind {
  engineId?: string;
  name?: string | null;
  smscName?: string | null;
  status?: string | null;
  queued?: number | null;
  failed?: number | null;
  sent?: number | null;
  received?: number | null;
  /** bearerbox reports three rolling averages: [1 minute, 5 minutes, 15 minutes]. */
  outboundRate?: number[] | null;
  inboundRate?: number[] | null;
  /** False when the engine reports a bind the console has no SMSC record for. */
  known?: boolean;
}

export interface LiveSnapshot {
  observedAt?: string;
  engine?: LiveEngine;
  binds?: LiveBind[];
  spool?: { queued?: number | null; oldestEpoch?: number | null };
  source?: { status?: string; detail?: string };
}

/**
 * What the three numbers in `outboundRate` / `inboundRate` actually are.
 *
 * They are bearerbox's own rolling averages, not samples JKANNEL took, and the
 * labels say so on screen — "current" for a 1-minute mean is close enough to be
 * useful and wrong enough to matter when an operator is timing a recovery.
 */
export const RATE_WINDOWS = [
  { index: 0, label: 'last minute', short: '1m' },
  { index: 1, label: 'last 5 minutes', short: '5m' },
  { index: 2, label: 'last 15 minutes', short: '15m' },
] as const;

/** One window out of a bearerbox rate triple, or null when it was not reported. */
export function rateAt(rates: number[] | null | undefined, index: number): number | null {
  if (!Array.isArray(rates)) return null;
  const value = rates[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Engine bind vocabulary: `online`, `connecting`, `re-connecting`, `dead`, … */
export function engineStatusTone(status: string | null | undefined): Tone {
  switch ((status ?? '').toLowerCase()) {
    case 'online':
    case 'running':
    case 'ok':
      return 'good';
    case 'connecting':
    case 're-connecting':
    case 'reconnecting':
    case 'degraded':
      return 'warn';
    case 'dead':
    case 'stopped':
    case 'unavailable':
    case 'error':
      return 'bad';
    default:
      return 'muted';
  }
}

/** The word beside the badge. Never blank, never a colour on its own (§17.1). */
export function engineStatusWord(status: string | null | undefined): string {
  return status && String(status).trim() ? String(status) : 'unknown';
}

// --- GET /queue-metrics -----------------------------------------------------

export interface QueueDestination {
  engineId: string;
  smscName: string | null;
  carrierId: string | null;
  carrierName: string | null;
  bindState: string | null;
  depth: number | null;
  ingressPerSecond: number | null;
  egressPerSecond: number | null;
  growthPerSecond: number | null;
  drainSeconds: number | null;
  drainUnavailableReason: string | null;
  windowSeconds: number | null;
  samples: number;
  resetsDetected: number;
  oldestSpoolAgeSeconds: number | null;
}

export interface QueueOverview {
  observedAt: string;
  windowMinutes: number;
  destinations: QueueDestination[];
  spool: { queued: number; oldestAgeSeconds: number | null; available: boolean; detail: string };
  notes: string[];
}

/**
 * Windows the API will actually honour: `windowMinutes` is validated as an
 * integer in 1..1440, so nothing longer than a day is offered. The global time
 * range goes to 30 days and is deliberately NOT wired to this control — silently
 * clamping 30d to 24h would label the panel with a window it did not measure.
 */
export const QUEUE_RATE_WINDOWS = [5, 15, 30, 60, 240, 1440] as const;

// --- GET /reports/dlr-performance -------------------------------------------

export interface DeliveryFunnel {
  submitted: number;
  accepted: number;
  receiptsReceived: number;
  delivered: number;
  failed: number;
  expired: number;
  rejected: number;
  pending: number;
  unknown: number;
}

export interface MaturityAssessment {
  immature: boolean;
  pendingShare: number;
  windowOverlapShare: number;
  warning: string | null;
}

export interface DeliveryQuality {
  funnel: DeliveryFunnel;
  /** delivered ÷ settled outcomes. Pending is excluded from the denominator. */
  deliveryRate: number | null;
  /** delivered ÷ accepted. Every pending message counted as a failure. */
  deliveryRateIncludingPending: number | null;
  noReceiptRate: number | null;

  /**

   * Round-trip receipt latency in seconds, over delivered receipts only.

   * Optional because an aggregate funnel has no meaningful percentile —

   * percentiles cannot be summed across binds.

   */

  latency?: { p50: number | null; p95: number | null; p99: number | null };
  maturity: MaturityAssessment;
}

export interface BindQuality {
  engineId: string;
  smscName: string | null;
  carrierId: string | null;
  carrierName: string | null;
  quality: DeliveryQuality;
}

export interface DlrPerformanceReport {
  from: string;
  to: string;
  overall: DeliveryQuality;
  byBind: BindQuality[];
  available: boolean;
  detail: string;
}

/**
 * The two delivery rates, always rendered together (spec §8).
 *
 * Presenting one of these alone is the whole failure mode. The settled rate on
 * its own hides a window where nothing has come back at all; the including-
 * pending rate on its own reads as a collapse on any fresh window. Side by side
 * the gap between them IS the pending backlog, and an operator can see it.
 */
export const DELIVERY_RATE_VIEWS = [
  {
    key: 'settled' as const,
    label: 'Settled delivery rate',
    caption:
      'delivered ÷ delivered + failed + rejected + expired — messages still pending are left out',
  },
  {
    key: 'worstCase' as const,
    label: 'Worst-case delivery rate',
    caption: 'delivered ÷ accepted — every message still awaiting a receipt counted as a failure',
  },
];

// --- Formatters -------------------------------------------------------------

/** Seconds → a compact human duration. Sub-second rounds up to `1s`, never `0s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** An age in seconds, or an em dash. A missing age is never rendered as `0s`. */
export function formatAge(seconds: number | null | undefined, state: DataState = 'live'): string {
  if (!isMeasured(state)) return '—';
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds <= 0) return 'under a second';
  return formatDuration(seconds);
}

/** A 0..1 share as a percentage. Only ever called with a real measurement. */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A share, or the em dash. Null means the denominator was empty — no settled
 * outcome, no accepted message — and `0.0%` would state a failure that was
 * never measured.
 */
export function formatShare(value: number | null | undefined, state: DataState = 'live'): string {
  if (!isMeasured(state)) return '—';
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return formatPercent(value);
}

/** Growth carries its sign: `+2.5/s` is a queue filling, `−2.5/s` one draining. */
export function formatSignedRate(
  value: number | null | undefined,
  state: DataState = 'live',
): string {
  if (!isMeasured(state)) return '—';
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return '0/s';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}/s`;
}

/** A growing queue is the warning; a draining one is not "good", it is expected. */
export function growthTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'muted';
  if (value > 0) return 'warn';
  return 'good';
}

export interface DrainView {
  /** What to render in the cell. Never `∞`, never blank. */
  text: string;
  tone: Tone;
  /** True only when a real estimate came back. */
  estimated: boolean;
}

/**
 * The drain cell.
 *
 * `drainUnavailableReason` is returned VERBATIM whenever the backend set it.
 * That string is the answer to "why is there no estimate", and it distinguishes
 * a stalled queue from an engine restart from throughput too volatile to
 * extrapolate. Those look identical if they are all rendered as "unavailable",
 * and they are three different incidents.
 */
export function describeDrain(
  destination: Pick<QueueDestination, 'depth' | 'drainSeconds' | 'drainUnavailableReason'>,
  state: DataState = 'live',
): DrainView {
  if (!isMeasured(state)) return { text: '—', tone: 'muted', estimated: false };
  const reason = destination.drainUnavailableReason;
  if (typeof reason === 'string' && reason.trim())
    return { text: reason, tone: 'warn', estimated: false };
  const seconds = destination.drainSeconds;
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return {
      // Neither an estimate nor a reason came back. Saying so is the only
      // honest option; a blank cell reads as "nothing to worry about".
      text: 'No estimate was returned, and the API gave no reason for its absence.',
      tone: 'warn',
      estimated: false,
    };
  if (seconds <= 0) return { text: 'already empty', tone: 'good', estimated: true };
  return {
    text: `about ${formatDuration(seconds)}`,
    tone: seconds >= 3600 ? 'warn' : 'good',
    estimated: true,
  };
}

/**
 * How much of the measurement window actually carried observations.
 *
 * Two samples thirty seconds apart inside a fifteen-minute window produce a
 * perfectly real rate over a very small slice of it, and the operator should be
 * able to see that before trusting a growth figure.
 */
export function describeCoverage(
  destination: Pick<QueueDestination, 'samples' | 'windowSeconds' | 'resetsDetected'>,
): string {
  const parts: string[] = [];
  parts.push(`${destination.samples} sample(s)`);
  if (destination.windowSeconds !== null && Number.isFinite(destination.windowSeconds))
    parts.push(`over ${formatDuration(destination.windowSeconds)}`);
  if (destination.resetsDetected > 0)
    parts.push(`${destination.resetsDetected} engine restart(s) discarded`);
  return parts.join(' · ');
}

/**
 * Round-trip receipt latency, in the units an operator thinks in.
 *
 * `unknown` rather than a dash or a zero when the percentile is null: a
 * percentile over zero delivered receipts is not "0 seconds", and a bind that
 * delivered nothing must not appear to be the fastest on the screen.
 */
export function formatLatency(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'unknown';
  if (seconds < 1) return '<1s';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
