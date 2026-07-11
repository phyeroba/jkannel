// (c) Reporting / analytics — k6.
import http from 'k6/http';
import { check } from 'k6';
import { api, login, authHeaders, scenarioOptions, p95, errorRate } from './common.js';

const REPORTS = [
  '/reports/analytics/overview',
  '/reports/analytics/traffic-trend?days=30',
  '/reports/analytics/per-smsc',
  '/reports/analytics/per-route',
  '/reports/analytics/delivery-breakdown',
  '/reports/analytics/smsc-success',
  '/reports/analytics/latency-sla?days=7',
];

export const options = {
  scenarios: scenarioOptions(),
  thresholds: {
    // Spec Section 6: Dashboard API < 500 ms.
    http_req_duration: [`p(95)<${p95('reporting')}`],
    http_req_failed: [`rate<${errorRate()}`],
  },
};

export function setup() {
  return { token: login() };
}

export default function (data) {
  const path = REPORTS[Math.floor(Math.random() * REPORTS.length)];
  const res = http.get(api(path), authHeaders(data.token));
  check(res, { 'report 2xx': (r) => r.status >= 200 && r.status < 300 });
}
