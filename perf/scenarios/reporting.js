'use strict';

const { checkP95, checkErrorRate } = require('../lib/runner');
const { latencyP95, errorRateCeiling } = require('../config/slo');

/**
 * (c) Reporting / analytics.
 *
 * Exercises the dashboard analytics endpoints (aggregate queries). Maps to the
 * spec's "Dashboard API < 500 ms" objective (Section 6).
 */
const REPORTS = [
  { label: 'GET /reports/analytics/overview', path: '/reports/analytics/overview' },
  { label: 'GET /reports/analytics/traffic-trend', path: '/reports/analytics/traffic-trend?days=30' },
  { label: 'GET /reports/analytics/per-smsc', path: '/reports/analytics/per-smsc' },
  { label: 'GET /reports/analytics/per-route', path: '/reports/analytics/per-route' },
  { label: 'GET /reports/analytics/delivery-breakdown', path: '/reports/analytics/delivery-breakdown' },
  { label: 'GET /reports/analytics/smsc-success', path: '/reports/analytics/smsc-success' },
  { label: 'GET /reports/analytics/latency-sla', path: '/reports/analytics/latency-sla?days=7' },
];

module.exports = {
  name: 'reporting',
  description: 'Reporting/analytics dashboard queries',
  async iteration(client, metrics) {
    const r = REPORTS[Math.floor(Math.random() * REPORTS.length)];
    const res = await client.request('GET', client.apiPath(r.path));
    metrics.record(r.label, res.ms, res.status, res.ok, res.reason);
  },
  defaultSloChecks(metrics) {
    return [
      checkP95(metrics, '*', latencyP95('reporting'), 'analytics overall p95 (spec: <500ms)'),
      checkP95(
        metrics,
        'GET /reports/analytics/overview',
        latencyP95('reporting'),
        'overview p95 (spec: <500ms)',
      ),
      checkErrorRate(metrics, errorRateCeiling()),
    ];
  },
};
