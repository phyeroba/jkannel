// (e) Sustained soak — k6.
// Hold a low, steady rate for a long duration to surface latency drift and
// error accumulation. Pair with the Grafana dashboard (backend RSS panel) to
// watch for memory leaks — k6 itself does not read server-side RSS.
//
// Recommended:
//   PERF_DURATION=2h PERF_VUS=5 PERF_RPS=20 k6 run perf/k6/soak.js
import http from 'k6/http';
import { check } from 'k6';
import { api, login, authHeaders, scenarioOptions, p95, errorRate } from './common.js';

const MIX = [
  '/messages?limit=100',
  '/messages?limit=100',
  '/smscs?limit=50',
  '/routes?limit=50',
  '/reports/analytics/overview',
  '/reports/analytics/overview',
  '/alerts?limit=50',
  '/health',
];

export const options = {
  scenarios: scenarioOptions(),
  thresholds: {
    http_req_duration: [`p(95)<${p95('reporting')}`],
    http_req_failed: [`rate<${errorRate()}`],
  },
};

export function setup() {
  return { token: login() };
}

export default function (data) {
  const path = MIX[Math.floor(Math.random() * MIX.length)];
  const res = http.get(api(path), authHeaders(data.token));
  check(res, { '2xx': (r) => r.status >= 200 && r.status < 300 });
}
