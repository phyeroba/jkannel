'use strict';

const { num } = require('./env');

/**
 * Service Level Objectives.
 *
 * `spec` values are transcribed verbatim from
 * docs/specifications/operations/PERFORMANCE_AND_SCALABILITY_ENGINEERING_SPECIFICATION.md
 * Section 6 (Response Time Objectives). They are the *release gate* targets and
 * apply to a properly provisioned deployment.
 *
 * `localDefault` values are pragmatic thresholds used when running the harness
 * against a single-node developer / Compose stack, where argon2 password
 * hashing, cold caches and a shared host make the spec's aggressive numbers
 * (e.g. auth < 100 ms) unrealistic. They are clearly labelled as CHOSEN local
 * defaults, NOT spec-derived pass criteria.
 *
 * Every threshold is overridable via env (PERF_SLO_*) so a run can be gated at
 * whichever bar the environment warrants. Set PERF_SLO_PROFILE=spec to gate on
 * the strict spec numbers instead of the local defaults.
 */
const profile = (process.env.PERF_SLO_PROFILE || 'local').toLowerCase();

function pick(spec, localDefault, envKey) {
  const base = profile === 'spec' ? spec : localDefault;
  return num(process.env[envKey], base);
}

// p95 latency ceilings (ms) per logical operation class.
const LATENCY = {
  // Spec: Authentication < 100 ms. Local: argon2 verification dominates (an
  // intentionally slow hash). Measured p95 on the dev Compose stack is ~500 ms;
  // 750 ms is a defensible single-node ceiling that still catches regressions
  // while the `spec` profile keeps the strict 100 ms bar (which correctly FAILS
  // locally, exposing the hardware gap honestly).
  auth: { spec: 100, local: 750, env: 'PERF_SLO_AUTH_P95_MS' },
  // Spec: Dashboard API < 500 ms (reporting/analytics overview et al).
  reporting: { spec: 500, local: 800, env: 'PERF_SLO_REPORTING_P95_MS' },
  // Spec: Message Search < 2 s (the messages grid over SQLBox).
  grid: { spec: 2000, local: 2000, env: 'PERF_SLO_GRID_P95_MS' },
  // Spec: Route Lookup < 50 ms (engine evaluate). The /routes/simulate endpoint
  // adds a DB read for rule data, so the local ceiling is looser.
  route: { spec: 50, local: 500, env: 'PERF_SLO_ROUTE_P95_MS' },
  // Spec: Health Check < 1 s.
  health: { spec: 1000, local: 1000, env: 'PERF_SLO_HEALTH_P95_MS' },
  // Write / send acceptance. Spec has no explicit submit latency; CHOSEN.
  send: { spec: 1000, local: 1500, env: 'PERF_SLO_SEND_P95_MS' },
};

function latencyP95(kind) {
  const c = LATENCY[kind];
  if (!c) throw new Error(`unknown SLO latency kind: ${kind}`);
  return pick(c.spec, c.local, c.env);
}

// Error-rate ceiling. The spec states no explicit number; 1% is a CHOSEN
// pragmatic default (0% would be too brittle under transient conditions).
function errorRateCeiling() {
  return num(process.env.PERF_SLO_ERROR_RATE, 0.01);
}

// Soak leak guard: max tolerated RSS growth (fraction) from warm baseline to
// end of soak. CHOSEN default; not a spec number.
function soakRssGrowthCeiling() {
  return num(process.env.PERF_SLO_SOAK_RSS_GROWTH, 0.25);
}

module.exports = {
  profile,
  latencyP95,
  errorRateCeiling,
  soakRssGrowthCeiling,
  LATENCY,
};
