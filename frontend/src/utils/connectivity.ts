/**
 * The Carrier → SMSC → bind vocabulary shared by the four connectivity screens
 * (PLAN.md §2, items 2.3–2.5).
 *
 * Everything here exists to keep one rule: a figure the engine did not report
 * must never be rendered as a measurement. `displayValue` from `data-state.ts`
 * covers the numeric case; the two additions below cover the two places where
 * an em dash is not enough.
 *
 * - Utilisation has to read the WORD `unknown`, because "—" next to a column of
 *   percentages is easy to read as "small" and 0%/100% are both plausible real
 *   readings for a link nobody is watching.
 * - Health and bind state have to carry a word as well as a colour (§17.1), so
 *   the tone and the label are produced together and never separately.
 */
import { isMeasured, type DataState } from './data-state';

export type CarrierHealth = 'healthy' | 'degraded' | 'critical' | 'unknown';
export type Tone = 'good' | 'warn' | 'bad' | 'muted';

/** `GET /carriers` and `GET /carriers/:id` — carrier.service.ts CarrierSummary. */
export interface CarrierSummary {
  id: string;
  name: string;
  country_code: string | null;
  network_code: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  smscCount: number;
  bindsHealthy: number;
  bindsTotal: number;
  bindsUnobserved: number;
  health: CarrierHealth;
  queuedMessages: number;
  failedMessages: number;
  capacityTps: number | null;
  observedTps: number | null;
  utilisation: number | null;
  /**
   * SMPP sessions configured across the carrier's enabled connections
   * (`instances = N`, summed). Configuration, never an observation — the engine
   * collapses all N behind one smsc-id and cannot say how many are up.
   */
  configuredSessions: number;
  /** Latest inbound rate summed across the carrier's binds. */
  observedTpsIn?: number | null;
  /** Newest bind transition across the carrier's SMSCs — §4.1's last event. */
  lastEvent?: string | null;
  openAlerts: number;
}

/** `GET /carriers/unassigned-smscs`. */
export interface UnassignedSmsc {
  id: string;
  engine_id: string;
  name: string;
  type: string;
  enabled: boolean;
  lifecycle_state: string;
}

/** `GET /smscs` — the console grid row, used to enumerate the estate. */
export interface SmscRow {
  id: string;
  engine_id: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  tps: number | null;
  enabled: boolean;
  lifecycle_state: string;
}

/** smsc-detail.service.ts CapacityView. */
export interface CapacityView {
  perConnectionTps: number | null;
  connections: number;
  effectiveTps: number | null;
  observedTps: number | null;
  /** observed / effective, 0..n. Null when either side is unknown. */
  utilisation: number | null;
  note: string;
}

/** smsc-detail.service.ts ObservabilityLimits — rendered, never summarised away. */
export interface ObservabilityLimits {
  unavailable: string[];
  reason: string;
  sessionsCollapsed: boolean;
  configuredInstances: number;
}

export interface BindTransition {
  kind: string;
  fromState: string | null;
  toState: string | null;
  detail: Record<string, unknown> | null;
  observedAt: string;
}

/** `GET /smscs/:engineId/detail`. */
export interface SmscDetail {
  id: string;
  engineId: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  enabled: boolean;
  lifecycleState: string;
  carrierId: string | null;
  carrierName: string | null;
  bindState: string | null;
  bindStateSince: string | null;
  bindObservedAt: string | null;
  queued: number | null;
  failed: number | null;
  sent: number | null;
  received: number | null;
  outboundRate: number | null;
  inboundRate: number | null;
  capacity: CapacityView;
  transitions: BindTransition[];
  limits: ObservabilityLimits;
}

export const CARRIER_STATUSES = ['active', 'suspended', 'retired'] as const;

/** §3.3's four values, worst first — the order the register sorts in. */
export const HEALTH_ORDER: Record<CarrierHealth, number> = {
  critical: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
};

export function healthTone(health: string | null | undefined): Tone {
  switch (health) {
    case 'healthy':
      return 'good';
    case 'degraded':
      return 'warn';
    case 'critical':
      return 'bad';
    default:
      return 'muted';
  }
}

/**
 * The sentence behind the badge. `unknown` gets the longest one on purpose:
 * §3.3 forbids presenting it as healthy, and an operator who reads "unknown"
 * as "probably fine" has made exactly the mistake the value exists to prevent.
 */
export function healthExplanation(carrier: {
  health: string;
  smscCount: number;
  bindsTotal: number;
  bindsHealthy: number;
  bindsUnobserved: number;
}): string {
  const { health, smscCount, bindsTotal, bindsHealthy, bindsUnobserved } = carrier;
  if (health === 'unknown' && smscCount === 0)
    return 'No SMSC is attached to this carrier, so there is nothing to be healthy. Attach one below.';
  if (health === 'unknown' && bindsTotal === 0)
    return 'Every SMSC attached to this carrier is disabled, so no bind is expected to be up.';
  if (health === 'unknown')
    return `None of the ${bindsTotal} enabled bind(s) has ever been observed, so this carrier's health is not known. Unknown is not healthy.`;
  if (health === 'critical')
    return `No enabled bind is up: 0 of ${bindsTotal} bound. Traffic for this carrier is not moving.`;
  if (health === 'degraded' && bindsUnobserved > 0 && bindsHealthy === bindsTotal - bindsUnobserved)
    return `${bindsHealthy} of ${bindsTotal} bind(s) are up, but ${bindsUnobserved} has never been observed, so the carrier cannot be called healthy.`;
  if (health === 'degraded')
    return `${bindsHealthy} of ${bindsTotal} enabled bind(s) are up. The rest are not serving traffic.`;
  return `All ${bindsTotal} enabled bind(s) are bound and observed.`;
}

/** Only `bound` serves traffic; the rest are all reasons to look (§Ch.22). */
export function bindTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'bound':
      return 'good';
    case 'connecting':
    case 'binding':
    case 'retrying':
    case 'unbinding':
      return 'warn';
    case 'disconnected':
    case 'failed':
      return 'bad';
    default:
      return 'muted';
  }
}

/**
 * The word for a bind state, including the one case that is not a state at all.
 * A null `bindState` means the poller has never written a row for this SMSC —
 * which is emphatically not "disconnected", and saying so would invent an
 * observation.
 */
export function bindWord(state: string | null | undefined): string {
  return state && state.trim() ? state : 'never observed';
}

/**
 * Utilisation as a percentage, or the literal word `unknown`.
 *
 * The backend returns null whenever either side of the ratio is missing — no
 * configured ceiling, or no observed rate. Rendering that as 0% would tell an
 * operator the link is idle and 100% would tell them it is saturated; both are
 * assertions about traffic nobody measured.
 */
export function formatUtilisation(
  value: number | null | undefined,
  state: DataState = 'live',
): string {
  if (!isMeasured(state)) return '—';
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `${Math.round(value * 100)}%`;
}

/** Utilisation bands, for the badge beside the figure. Null is never `good`. */
export function utilisationTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'muted';
  if (value >= 1) return 'bad';
  if (value >= 0.8) return 'warn';
  return 'good';
}

/**
 * The configured ceiling in one phrase. `capacity.note` carries the per-
 * connection explanation and is rendered verbatim next to it — never
 * paraphrased, because the multiplier is the part that surprises people.
 */
export function formatCeiling(capacity: CapacityView | null | undefined): string {
  if (!capacity || capacity.effectiveTps === null) return 'no ceiling configured';
  return capacity.connections > 1
    ? `${capacity.effectiveTps}/s (${capacity.perConnectionTps}/s × ${capacity.connections} connections)`
    : `${capacity.effectiveTps}/s`;
}

/** A rate with its unit, or an em dash. Never a bare zero from a failed read. */
export function formatRate(value: number | null | undefined, state: DataState = 'live'): string {
  if (!isMeasured(state)) return '—';
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100) / 100}/s`;
}

/** Local, seconds-resolution timestamp. Falls back to the raw string. */
export function formatMoment(value: string | null | undefined): string {
  if (!value) return 'never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Two-letter ISO country code plus network code, as one market label. */
export function formatMarket(carrier: {
  country_code: string | null;
  network_code: string | null;
}): string {
  const parts = [carrier.country_code, carrier.network_code].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'not recorded';
}

/**
 * Runs `worker` over `items` with at most `width` in flight.
 *
 * The estate has no endpoint that returns bind state for every SMSC at once —
 * `GET /smscs` carries neither `carrier_id` nor bind state, so the only source
 * for either is `GET /smscs/:engineId/detail`, one call per connection. Firing
 * fifty of those simultaneously at a NOC's API is worse than taking a moment.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  width: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
