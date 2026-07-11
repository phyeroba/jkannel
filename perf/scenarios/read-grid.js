'use strict';

const { checkP95, checkErrorRate } = require('../lib/runner');
const { latencyP95, errorRateCeiling } = require('../config/slo');

/**
 * (a) Read-heavy grid browsing.
 *
 * Simulates operators paging through the console's data grids. All endpoints
 * return the standard grid shape ({ items, total|nextCursor, ... }). The
 * messages grid maps to the spec's "Message Search < 2 s" objective; the other
 * grids are lightweight Postgres reads.
 */
const GRIDS = [
  { label: 'GET /messages', path: '/messages?limit=100', slo: 'grid' },
  { label: 'GET /smscs', path: '/smscs?limit=100', slo: 'grid' },
  { label: 'GET /routes', path: '/routes?limit=100', slo: 'grid' },
  { label: 'GET /alerts', path: '/alerts?limit=100', slo: 'grid' },
  { label: 'GET /users', path: '/users?limit=100', slo: 'grid' },
  { label: 'GET /audit-events', path: '/audit-events?limit=100', slo: 'grid' },
  { label: 'GET /bulk-send', path: '/bulk-send?limit=50', slo: 'grid' },
];

module.exports = {
  name: 'read-grid',
  description: 'Read-heavy grid browsing across console data grids',
  async iteration(client, metrics) {
    const grid = GRIDS[Math.floor(Math.random() * GRIDS.length)];
    const res = await client.request('GET', client.apiPath(grid.path));
    metrics.record(grid.label, res.ms, res.status, res.ok, res.reason);
  },
  defaultSloChecks(metrics) {
    return [
      checkP95(metrics, 'GET /messages', latencyP95('grid'), 'messages search p95 (spec: <2s)'),
      checkP95(metrics, '*', latencyP95('grid'), 'grid browsing overall p95'),
      checkErrorRate(metrics, errorRateCeiling()),
    ];
  },
};
