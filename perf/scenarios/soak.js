'use strict';

const { checkP95, checkErrorRate } = require('../lib/runner');
const { latencyP95, errorRateCeiling, soakRssGrowthCeiling } = require('../config/slo');

/**
 * (e) Sustained soak profile.
 *
 * A LOW, steady request rate held over a LONG duration, mixing representative
 * read traffic. The point is not peak throughput but stability: latency drift,
 * error accumulation, and — via periodic /metrics scrapes — backend RSS growth
 * that would indicate a leak.
 *
 * Recommended invocation (hours):
 *   PERF_DURATION=2h PERF_VUS=5 PERF_RPS=20 node run.js soak
 * The defaults below run a short, CI-friendly soak so the profile is exercised
 * without a multi-hour wait; a real leak hunt needs hours (documented in README).
 */
const MIX = [
  { label: 'GET /messages', path: '/messages?limit=100', weight: 4 },
  { label: 'GET /smscs', path: '/smscs?limit=50', weight: 2 },
  { label: 'GET /routes', path: '/routes?limit=50', weight: 2 },
  { label: 'GET /reports/analytics/overview', path: '/reports/analytics/overview', weight: 2 },
  { label: 'GET /alerts', path: '/alerts?limit=50', weight: 1 },
  { label: 'GET /health', path: '/health', weight: 1, health: true },
];

const WEIGHTED = MIX.flatMap((e) => Array.from({ length: e.weight }, () => e));

module.exports = {
  name: 'soak',
  description: 'Sustained low-RPS mixed read soak with leak detection',
  sampleMemory: true,
  async iteration(client, metrics) {
    const e = WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)];
    const res = await client.request('GET', client.apiPath(e.path));
    metrics.record(e.label, res.ms, res.status, res.ok, res.reason);
  },
  evaluate(metrics, _ctx, memorySamples) {
    const checks = [
      checkP95(metrics, '*', latencyP95('reporting'), 'soak overall p95 stable'),
      checkErrorRate(metrics, errorRateCeiling()),
    ];
    if (memorySamples && memorySamples.length >= 2) {
      const first = memorySamples[0].rss;
      const last = memorySamples[memorySamples.length - 1].rss;
      const growth = (last - first) / first;
      const ceiling = soakRssGrowthCeiling();
      checks.push({
        name: `backend RSS growth ≤ ${(ceiling * 100).toFixed(0)}%`,
        pass: growth <= ceiling,
        detail:
          `${(first / 1e6).toFixed(1)}MB → ${(last / 1e6).toFixed(1)}MB ` +
          `= ${(growth * 100).toFixed(1)}% over ${memorySamples.length} samples`,
      });
    } else {
      checks.push({
        name: 'backend RSS leak check',
        pass: true,
        detail: 'insufficient /metrics samples (need a longer run); check skipped',
      });
    }
    return checks;
  },
};
