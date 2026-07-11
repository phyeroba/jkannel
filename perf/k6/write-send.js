// (d) Write / send path — k6.
// DEFAULT: POST /routes/simulate (non-destructive; writes nothing).
// OPT-IN:  PERF_ALLOW_SEND=true -> POST /bulk-send (queues real jobs). Use only
//          against a disposable environment.
import http from 'k6/http';
import { check } from 'k6';
import {
  api,
  login,
  authHeaders,
  jsonHeaders,
  scenarioOptions,
  p95,
  errorRate,
  randomMsisdn,
} from './common.js';

const ALLOW_SEND = /^(1|true|yes|on)$/i.test(__ENV.PERF_ALLOW_SEND || '');

export const options = {
  scenarios: scenarioOptions(),
  thresholds: {
    http_req_duration: [`p(95)<${p95(ALLOW_SEND ? 'send' : 'route')}`],
    http_req_failed: [`rate<${errorRate()}`],
  },
};

export function setup() {
  const token = login();
  let engineId = null;
  if (ALLOW_SEND) {
    const res = http.get(api('/smscs?limit=50'), authHeaders(token));
    const items = res.json('data.items') || [];
    for (const s of items) {
      if (s.engine_id || s.engineId) {
        engineId = s.engine_id || s.engineId;
        break;
      }
    }
    if (!engineId) throw new Error('PERF_ALLOW_SEND=true but no SMSC available to send through.');
  }
  return { token, engineId };
}

export default function (data) {
  if (ALLOW_SEND) {
    const body = JSON.stringify({
      name: `perf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      smscId: data.engineId,
      message: 'JKANNEL perf harness synthetic message. Ignore.',
      recipients: [randomMsisdn()],
    });
    const res = http.post(api('/bulk-send'), body, jsonHeaders(data.token));
    check(res, { 'bulk-send 2xx': (r) => r.status >= 200 && r.status < 300 });
    return;
  }
  const body = JSON.stringify({ destination: randomMsisdn(), sender: 'JKANNEL' });
  const res = http.post(api('/routes/simulate'), body, jsonHeaders(data.token));
  check(res, { 'simulate 2xx': (r) => r.status >= 200 && r.status < 300 });
}
