// Shared helpers for the JKANNEL k6 scripts.
//
// k6 is the industry-standard load tool but is NOT bundled with this repo (it
// is a single standalone Go binary). These scripts are the "preferred tool"
// path; the zero-dependency Node runner in ../ is the always-runnable
// equivalent. Install k6 from https://k6.io/docs/get-started/installation/ then:
//
//   k6 run perf/k6/read-grid.js
//   PERF_BASE_URL=http://127.0.0.1:3000 PERF_PASSWORD=... k6 run perf/k6/auth.js
//
// Config comes from the same PERF_* env vars as the Node harness.

import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = (__ENV.PERF_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const API_PREFIX = __ENV.PERF_API_PREFIX || '/api/v1';
export const TENANT = __ENV.PERF_TENANT || 'default';
export const USERNAME = __ENV.PERF_USERNAME || 'operator';
export const PASSWORD = __ENV.PERF_PASSWORD || '';
export const SLO_PROFILE = (__ENV.PERF_SLO_PROFILE || 'local').toLowerCase();

const NUM = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const VUS = NUM(__ENV.PERF_VUS, 10);
export const DURATION = __ENV.PERF_DURATION || '30s';
export const RPS = NUM(__ENV.PERF_RPS, 0);

export function api(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${API_PREFIX}${p}`;
}

// SLO ceilings mirror ../config/slo.js. spec = strict spec Section 6 numbers;
// local = pragmatic single-node defaults.
const SLO = {
  auth: { spec: 100, local: 750 },
  reporting: { spec: 500, local: 800 },
  grid: { spec: 2000, local: 2000 },
  route: { spec: 50, local: 500 },
  send: { spec: 1000, local: 1500 },
};

export function p95(kind) {
  const key = `PERF_SLO_${kind.toUpperCase()}_P95_MS`;
  if (__ENV[key]) return Number(__ENV[key]);
  return SLO_PROFILE === 'spec' ? SLO[kind].spec : SLO[kind].local;
}

export function errorRate() {
  return __ENV.PERF_SLO_ERROR_RATE ? Number(__ENV.PERF_SLO_ERROR_RATE) : 0.01;
}

// Standard executor: closed-loop constant VUs, or open-loop constant arrival
// rate when PERF_RPS is set.
export function scenarioOptions() {
  if (RPS > 0) {
    return {
      main: {
        executor: 'constant-arrival-rate',
        rate: RPS,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: VUS,
        maxVUs: VUS * 4,
      },
    };
  }
  return {
    main: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  };
}

// Authenticates once per VU init and returns the bearer token.
export function login() {
  if (!PASSWORD) {
    throw new Error('PERF_PASSWORD is required (see perf/.env.example).');
  }
  const res = http.post(
    api('/auth/login'),
    JSON.stringify({ tenant: TENANT, username: USERNAME, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  check(res, { 'login 2xx': (r) => r.status >= 200 && r.status < 300 });
  const token = res.json('data.accessToken');
  if (!token) throw new Error(`login failed: HTTP ${res.status}`);
  return token;
}

export function authHeaders(token) {
  return { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } };
}

export function jsonHeaders(token) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
  };
}

export function randomMsisdn() {
  return '+99999' + String(Math.floor(1000000 + Math.random() * 8999999));
}
