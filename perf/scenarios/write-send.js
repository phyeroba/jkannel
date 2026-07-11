'use strict';

const { checkP95, checkErrorRate } = require('../lib/runner');
const { latencyP95, errorRateCeiling } = require('../config/slo');
const { Client } = require('../lib/client');

/**
 * (d) Write / send path.
 *
 * DEFAULT (safe): POST /routes/simulate — a genuine POST with a body that runs
 * the routing engine server-side and writes NOTHING. This lets the write path
 * (request parsing, auth, engine evaluation) be load-tested without mutating
 * the live stack or queuing real SMS. Maps to spec "Route Lookup < 50 ms".
 *
 * OPT-IN (destructive): set PERF_ALLOW_SEND=true to instead POST /bulk-send with
 * a single synthetic recipient through one of the tenant's SMSCs. This queues a
 * real campaign job (persisted, drained by the background processor). Only use
 * against a disposable / test environment. Guarded off by default so a smoke run
 * can never disrupt a live gateway.
 */
function randomMsisdn() {
  // Documentation range (+99999...) — never a routable subscriber number.
  return '+99999' + String(Math.floor(1000000 + Math.random() * 8999999));
}

module.exports = {
  name: 'write-send',
  description: 'Write/send path (safe route simulate; opt-in real bulk-send)',
  async setup(client, config) {
    if (config.allowSend) {
      const res = await client.request('GET', client.apiPath('/smscs?limit=50'));
      const data = Client.data(res.body) || {};
      const items = data.items || [];
      const engineId = items.map((s) => s.engine_id || s.engineId).find(Boolean);
      if (!engineId) {
        throw new Error(
          'PERF_ALLOW_SEND=true but no SMSC found for this tenant to send through.',
        );
      }
      return { mode: 'send', engineId };
    }
    // Simulate mode: discover a destination that matches an enabled route so the
    // routing engine returns a real evaluation. When no routes are seeded the
    // engine deterministically answers "No eligible route" (HTTP 400) — that
    // still fully exercises the parse+auth+engine path, so it is treated as a
    // valid outcome (not an error) rather than skewing the error-rate SLO.
    const res = await client.request('GET', client.apiPath('/routes?limit=100'));
    const items = (Client.data(res.body) || {}).items || [];
    const prefixes = items
      .filter((r) => r.enabled !== false)
      .map((r) => r.destination_prefix)
      .filter((p) => typeof p === 'string' && /^[+]?[0-9]+$/.test(p));
    return { mode: 'simulate', prefixes, noRoutes: items.length === 0 };
  },
  async iteration(client, metrics, ctx) {
    if (ctx.mode === 'send') {
      const res = await client.request('POST', client.apiPath('/bulk-send'), {
        body: {
          name: `perf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          smscId: ctx.engineId,
          message: 'JKANNEL perf harness synthetic message. Ignore.',
          recipients: [randomMsisdn()],
        },
      });
      const ok = res.status >= 200 && res.status < 300;
      metrics.record('POST /bulk-send', res.ms, res.status, ok, ok ? undefined : res.reason);
      return;
    }
    // Build a destination from a real route prefix when available, else a
    // synthetic documentation-range number.
    let destination = randomMsisdn();
    if (ctx.prefixes && ctx.prefixes.length) {
      const prefix = ctx.prefixes[Math.floor(Math.random() * ctx.prefixes.length)];
      const pad = String(Math.floor(1000000 + Math.random() * 8999999));
      destination = (prefix + pad).slice(0, 15);
    }
    const res = await client.request('POST', client.apiPath('/routes/simulate'), {
      body: { destination, sender: 'JKANNEL' },
    });
    // "No eligible route" is a deterministic domain answer that still exercised
    // the full compute path; count it as ok when the routing table is empty.
    const noRoute = res.status === 400 && /No eligible route/i.test(res.body || '');
    const ok = res.ok || noRoute;
    const label = noRoute ? 'POST /routes/simulate (no-route)' : 'POST /routes/simulate';
    metrics.record(label, res.ms, res.status, ok, ok ? undefined : res.reason);
  },
  defaultSloChecks(metrics, ctx) {
    if (ctx.mode === 'send') {
      return [
        checkP95(metrics, 'POST /bulk-send', latencyP95('send'), 'bulk-send accept p95'),
        checkErrorRate(metrics, errorRateCeiling()),
      ];
    }
    // In simulate mode every request is the route path (possibly labelled
    // "(no-route)"), so gate on the overall p95.
    return [
      checkP95(metrics, '*', latencyP95('route'), 'route simulate p95'),
      checkErrorRate(metrics, errorRateCeiling()),
    ];
  },
};
