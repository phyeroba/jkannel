/**
 * The service register (spec §14, UC-SYS-01).
 *
 * A gateway is not one process. When submissions stop, the operator's question
 * is "which component, and is it the cause or a symptom" — and today there is
 * no screen that answers it. `/monitoring` covers bearerbox alone; `/health`
 * covers PostgreSQL and Redis; `/docker/containers` is a hardcoded catalogue
 * with three probes bolted on. Nothing puts them together, and nothing says
 * which components are NOT being watched.
 *
 * ---------------------------------------------------------------------------
 * OBSERVED, DECLARED, AND WHY THE DIFFERENCE IS THE POINT
 * ---------------------------------------------------------------------------
 * Every component here carries how it is observed. A row that says `unknown`
 * because nobody probes it must be visibly different from one that says
 * `healthy` because a probe succeeded — otherwise the board's green count is a
 * measure of how little we check, and the more blind spots we have the
 * healthier the gateway looks.
 *
 * That is not hypothetical here. sqlbox's container healthcheck is `kill -0 1`
 * — PID 1 exists — so a wedged sqlbox that has stopped draining `send_sms`
 * reports healthy to Docker. This module's sqlbox probe reads its tables, which
 * is a stronger signal but still not proof the daemon is draining, and it says
 * so rather than implying otherwise.
 */

export type ServiceState = 'healthy' | 'degraded' | 'critical' | 'unknown';

/** How a component's state was arrived at. Reported, never inferred. */
export type Observation =
  /** A live probe ran and answered. */
  | 'probed'
  /** Deduced from another component's probe, not measured directly. */
  | 'derived'
  /** Nothing watches this. `unknown` is the only honest state. */
  | 'unobserved';

export interface ServiceDescriptor {
  name: string;
  /** What it does, in one phrase, for an operator who does not know Kannel. */
  role: string;
  /** Components this one needs. Used to separate a root failure from a symptom. */
  dependsOn: string[];
  /** Whether losing it stops traffic. Drives the impact preview on restart. */
  critical: boolean;
}

export interface ServiceReading {
  name: string;
  role: string;
  state: ServiceState;
  observation: Observation;
  /** One sentence of evidence. Verbatim from the probe where there was one. */
  detail: string;
  dependsOn: string[];
  /** Components that would be affected if this one failed. */
  affects: string[];
  /** An unhealthy dependency, when one explains this component's state. */
  rootCause: string | null;
  observedAt: string | null;
}

/**
 * The components JKANNEL can say anything about.
 *
 * Deliberately NOT the Compose service list. A `docker-compose.yml` entry is a
 * deployment detail; this is the set of things whose failure an operator has to
 * reason about. Grafana is in Compose and is not here, because Grafana being
 * down does not affect a single message.
 */
export const SERVICE_CATALOGUE: ServiceDescriptor[] = [
  {
    name: 'bearerbox',
    role: 'Holds the carrier SMPP binds and moves every message',
    dependsOn: ['database'],
    critical: true,
  },
  {
    name: 'smsbox',
    role: 'Accepts HTTP submissions and hands them to bearerbox',
    dependsOn: ['bearerbox'],
    critical: true,
  },
  {
    name: 'sqlbox',
    role: 'The spool and the message history — send_sms, sent_sms, DLRs',
    dependsOn: ['bearerbox', 'database'],
    critical: true,
  },
  {
    name: 'database',
    role: 'JKANNEL’s own store: routes, tenants, audit, jobs',
    dependsOn: [],
    critical: true,
  },
  {
    name: 'cache',
    role: 'Sessions and rate-limit counters',
    dependsOn: [],
    critical: false,
  },
  {
    name: 'engine-poller',
    role: 'Collects engine telemetry into the console',
    dependsOn: ['bearerbox'],
    critical: false,
  },
  {
    name: 'job-worker',
    role: 'Runs scheduled sends, MO fan-out, retries and reports',
    dependsOn: ['database'],
    critical: false,
  },
  {
    name: 'metrics-collector',
    role: 'Scrapes and stores the Prometheus time series',
    dependsOn: [],
    critical: false,
  },
];

/** Components that would be affected if `name` failed, per the catalogue. */
export function dependentsOf(name: string, catalogue = SERVICE_CATALOGUE): string[] {
  return catalogue.filter((entry) => entry.dependsOn.includes(name)).map((entry) => entry.name);
}

const SEVERITY: Record<ServiceState, number> = {
  critical: 3,
  degraded: 2,
  unknown: 1,
  healthy: 0,
};

/**
 * Whichever dependency best explains this component's state, or null.
 *
 * "Best" means most severe, so a component sitting on both a degraded and a
 * critical dependency is attributed to the critical one. Returns null when the
 * component itself is healthy — a healthy service has nothing to explain, and
 * naming a wobbly dependency there would send the operator to the wrong place.
 */
export function attributeRootCause(
  state: ServiceState,
  dependsOn: string[],
  states: Map<string, ServiceState>,
): string | null {
  if (state === 'healthy') return null;
  let best: { name: string; severity: number } | null = null;
  for (const dependency of dependsOn) {
    const dependencyState = states.get(dependency);
    if (!dependencyState || dependencyState === 'healthy') continue;
    const severity = SEVERITY[dependencyState];
    if (!best || severity > best.severity) best = { name: dependency, severity };
  }
  return best?.name ?? null;
}

/**
 * The board's one-line verdict.
 *
 * `unknown` is counted separately and never folded into either healthy or
 * unhealthy. A summary that said "7 of 8 healthy" while two of those were
 * merely unwatched would be the exact false reassurance §17 forbids.
 */
export function summarise(readings: ServiceReading[]): {
  total: number;
  healthy: number;
  degraded: number;
  critical: number;
  unknown: number;
  worst: ServiceState;
  /** Components in trouble that no unhealthy dependency explains. */
  rootFailures: string[];
  statement: string;
} {
  const count = (state: ServiceState) => readings.filter((r) => r.state === state).length;
  const critical = count('critical');
  const degraded = count('degraded');
  const unknown = count('unknown');
  const healthy = count('healthy');
  const worst: ServiceState =
    critical > 0 ? 'critical' : degraded > 0 ? 'degraded' : unknown > 0 ? 'unknown' : 'healthy';

  const rootFailures = readings
    .filter((r) => (r.state === 'critical' || r.state === 'degraded') && !r.rootCause)
    .map((r) => r.name);

  const parts: string[] = [];
  if (critical) parts.push(`${critical} failing`);
  if (degraded) parts.push(`${degraded} degraded`);
  if (unknown) parts.push(`${unknown} not observable`);
  const statement = parts.length
    ? `${parts.join(', ')} of ${readings.length} components. ` +
      (rootFailures.length
        ? `Start with ${rootFailures.join(', ')} — nothing upstream explains ${rootFailures.length === 1 ? 'it' : 'them'}.`
        : 'Every problem here is explained by a dependency; fix those first.')
    : `All ${healthy} components healthy on their last probe.`;

  return { total: readings.length, healthy, degraded, critical, unknown, worst, rootFailures, statement };
}
