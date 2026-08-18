/**
 * The services-board and node-view vocabulary (spec §14).
 *
 * The one rule this file exists to hold: **an unwatched component and a healthy
 * component must never render the same.** `unknown` here means "nothing probes
 * this", and if the board let that read as green then the more blind spots the
 * deployment has, the healthier it would look.
 */
import type { Tone } from './connectivity';

export type ServiceState = 'healthy' | 'degraded' | 'critical' | 'unknown';
export type Observation = 'probed' | 'derived' | 'unobserved';

export interface ServiceReading {
  name: string;
  role: string;
  state: ServiceState;
  observation: Observation;
  detail: string;
  dependsOn: string[];
  affects: string[];
  rootCause: string | null;
  observedAt: string | null;
}

export interface ServiceBoard {
  services: ServiceReading[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    critical: number;
    unknown: number;
    worst: ServiceState;
    rootFailures: string[];
    statement: string;
  };
  observedAt: string;
}

export interface NodeReading {
  name: string;
  role: string;
  scope: 'container' | 'process-only';
  memory: { usedBytes: number | null; limitBytes: number | null; percent: number | null };
  cpu: { usageMicros: number | null; limitCores: number | null; percent: number | null };
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  unavailableReason: string | null;
  notMeasured: string[];
  pressure: string;
  observedAt: string;
}

/** Colour is never the only signal (§17.1); the word is always rendered too. */
export function stateTone(state: ServiceState): Tone {
  switch (state) {
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
 * The word shown in the state column.
 *
 * `unknown` becomes "not observed" deliberately. "Unknown" reads as a transient
 * gap that might resolve on the next poll; "not observed" says the truth, which
 * is that nothing is looking and nothing will change until someone configures a
 * probe.
 */
export function stateWord(reading: Pick<ServiceReading, 'state' | 'observation'>): string {
  if (reading.state === 'unknown')
    return reading.observation === 'unobserved' ? 'not observed' : 'unknown';
  return reading.state;
}

/**
 * Sort order for the board: worst first, then unobserved, then healthy.
 *
 * Unobserved sits ABOVE healthy rather than at the bottom. A component nobody
 * watches is a gap to close, and burying it under the green rows is how it
 * stays unwatched.
 */
const RANK: Record<ServiceState, number> = { critical: 0, degraded: 1, unknown: 2, healthy: 3 };

export function byUrgency(a: ServiceReading, b: ServiceReading): number {
  return RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name);
}

/**
 * What to do about this row, in one sentence.
 *
 * Root-cause attribution is the whole value of having a dependency graph: it is
 * the difference between restarting bearerbox six times and noticing that
 * PostgreSQL is down.
 */
export function advise(reading: ServiceReading): string {
  if (reading.state === 'healthy') return 'Nothing to do.';
  if (reading.observation === 'unobserved')
    return 'Not a fault — nothing is watching this component. Its state is unknown, not healthy.';
  if (reading.rootCause)
    return `Fix ${reading.rootCause} first. Restarting ${reading.name} while its dependency is unhealthy usually changes nothing.`;
  return reading.affects.length
    ? `No unhealthy dependency explains this, so treat it as the root failure. ${reading.affects.join(', ')} ${reading.affects.length === 1 ? 'depends' : 'depend'} on it.`
    : 'No unhealthy dependency explains this, so treat it as the root failure.';
}

/** Bytes as an operator reads them. Null stays null — never rendered as 0 B. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 100 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/** "3d 4h", "4h 12m", "12m". Uptime is context, not a stopwatch. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'unknown';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

/**
 * A percentage, or the word "unknown".
 *
 * Never 0. The whole §17 rule: `0%` reads as "idle" and is a measurement an
 * operator will act on, so it must never stand in for "not measured".
 */
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'unknown'
    : `${value}%`;
}

export function pressureTone(percent: number | null): Tone {
  if (percent === null) return 'muted';
  if (percent > 85) return 'bad';
  if (percent > 70) return 'warn';
  return 'good';
}
