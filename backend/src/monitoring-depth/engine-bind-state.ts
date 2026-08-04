/**
 * Normalised SMSC bind vocabulary.
 *
 * KANNEL_ENGINE_ADAPTER Ch.22 requires the adapter to normalise every SMSC
 * connection onto eight states. The Kamex/Kannel bearerbox emits its own,
 * looser tokens (`online 0d 0h 3m`, `connecting`, `re-connecting`, `dead`, …);
 * `KamexAdapter.queueSnapshot()` already lowercases and collapses `online`/
 * `running`, and this module maps whatever it produces onto the spec's eight
 * values. Anything unrecognised becomes `unknown` — never `bound`, so the
 * platform can never silently claim a bind is healthy.
 */
export const BIND_STATES = [
  'connecting',
  'binding',
  'bound',
  'unbinding',
  'disconnected',
  'retrying',
  'failed',
  'unknown',
] as const;

export type BindState = (typeof BIND_STATES)[number];

const ENGINE_TOKEN_TO_BIND_STATE: Record<string, BindState> = {
  online: 'bound',
  running: 'bound',
  bound: 'bound',
  active: 'bound',
  connecting: 'connecting',
  connected: 'connecting',
  binding: 'binding',
  unbinding: 'unbinding',
  shutdown: 'unbinding',
  stopping: 'unbinding',
  dead: 'disconnected',
  disconnected: 'disconnected',
  stopped: 'disconnected',
  disabled: 'disconnected',
  down: 'disconnected',
  're-connecting': 'retrying',
  reconnecting: 'retrying',
  retrying: 'retrying',
  wait: 'retrying',
  waiting: 'retrying',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  killed: 'failed',
};

/** Maps an engine-reported status token onto the Ch.22 vocabulary. */
export function toBindState(engineStatus: string | null | undefined): BindState {
  if (typeof engineStatus !== 'string') return 'unknown';
  const token = engineStatus.trim().toLowerCase().split(/\s+/)[0];
  if (!token) return 'unknown';
  return ENGINE_TOKEN_TO_BIND_STATE[token] ?? 'unknown';
}

/** Only `bound` counts as healthy; everything else is a reason to look. */
export function isHealthy(state: BindState): boolean {
  return state === 'bound';
}

/** States that mean the carrier link is down right now, not merely settling. */
export function isHardDown(state: BindState): boolean {
  return state === 'disconnected' || state === 'failed';
}

/**
 * Projection onto the `smsc_health.state` CHECK vocabulary from migration 006
 * (`unknown | reachable | unreachable | active | degraded | disabled`), so the
 * poller can keep the console's existing health surface current without a
 * second, competing state model.
 */
export function toSmscHealthState(
  state: BindState,
): 'unknown' | 'active' | 'degraded' | 'unreachable' {
  if (state === 'bound') return 'active';
  if (state === 'unknown') return 'unknown';
  if (isHardDown(state)) return 'unreachable';
  return 'degraded';
}

/** Severity a transition into `state` should be alerted at. */
export function severityFor(state: BindState): 'info' | 'warning' | 'critical' {
  if (isHealthy(state)) return 'info';
  return isHardDown(state) ? 'critical' : 'warning';
}
