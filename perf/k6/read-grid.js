// (a) Read-heavy grid browsing — k6.
import http from 'k6/http';
import { check } from 'k6';
import { api, login, authHeaders, scenarioOptions, p95, errorRate } from './common.js';

const GRIDS = [
  '/messages?limit=100',
  '/smscs?limit=100',
  '/routes?limit=100',
  '/alerts?limit=100',
  '/users?limit=100',
  '/audit-events?limit=100',
  '/bulk-send?limit=50',
];

export const options = {
  scenarios: scenarioOptions(),
  thresholds: {
    // Message search maps to spec "Message Search < 2 s".
    'http_req_duration{group:messages}': [`p(95)<${p95('grid')}`],
    http_req_duration: [`p(95)<${p95('grid')}`],
    http_req_failed: [`rate<${errorRate()}`],
  },
};

export function setup() {
  return { token: login() };
}

export default function (data) {
  const path = GRIDS[Math.floor(Math.random() * GRIDS.length)];
  const tags = path.startsWith('/messages') ? { group: 'messages' } : {};
  const res = http.get(api(path), { ...authHeaders(data.token), tags });
  check(res, { 'grid 2xx': (r) => r.status >= 200 && r.status < 300 });
}
