'use strict';

const { checkP95, checkErrorRate } = require('../lib/runner');
const { latencyP95, errorRateCeiling } = require('../config/slo');

/**
 * (b) Authentication throughput.
 *
 * Each iteration performs a fresh POST /auth/login. This is deliberately the
 * heaviest per-request path (argon2 password verification + token issue + a
 * session/audit write), so it stresses CPU and the auth repository.
 *
 * Spec Section 6: Authentication < 100 ms. That target assumes provisioned
 * hardware; the local SLO default (400 ms) accounts for argon2 cost on a shared
 * dev host. Gate against the spec value with PERF_SLO_PROFILE=spec.
 */
module.exports = {
  name: 'auth',
  description: 'Authentication throughput (POST /auth/login)',
  needsAuth: false, // this scenario logs in on every iteration itself
  async iteration(client, metrics, ctx) {
    const res = await client.request('POST', client.apiPath('/auth/login'), {
      body: { tenant: ctx.tenant, username: ctx.username, password: ctx.password },
    });
    // Login returns 200/201 on success; treat any 2xx as ok.
    const ok = res.status >= 200 && res.status < 300;
    metrics.record('POST /auth/login', res.ms, res.status, ok, ok ? undefined : res.reason);
  },
  setup(_client, config) {
    if (!config.password) {
      throw new Error('PERF_PASSWORD is required for the auth scenario.');
    }
    return { tenant: config.tenant, username: config.username, password: config.password };
  },
  defaultSloChecks(metrics) {
    return [
      checkP95(metrics, 'POST /auth/login', latencyP95('auth'), 'login p95 (spec: <100ms)'),
      checkErrorRate(metrics, errorRateCeiling()),
    ];
  },
};
