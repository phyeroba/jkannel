// (b) Authentication throughput — k6.
import http from 'k6/http';
import { check } from 'k6';
import { api, TENANT, USERNAME, PASSWORD, scenarioOptions, p95, errorRate } from './common.js';

export const options = {
  scenarios: scenarioOptions(),
  thresholds: {
    // Spec Section 6: Authentication < 100 ms (PERF_SLO_PROFILE=spec to gate there).
    http_req_duration: [`p(95)<${p95('auth')}`],
    http_req_failed: [`rate<${errorRate()}`],
  },
};

export default function () {
  if (!PASSWORD) throw new Error('PERF_PASSWORD is required.');
  const res = http.post(
    api('/auth/login'),
    JSON.stringify({ tenant: TENANT, username: USERNAME, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  check(res, { 'login 2xx': (r) => r.status >= 200 && r.status < 300 });
}
