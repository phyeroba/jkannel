'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Loads perf/.env (if present) into process.env WITHOUT overriding values
 * already set in the real environment. Keeps the harness self-contained and
 * secret-free in git while letting an operator drop credentials in a local
 * .env file. No dependency on dotenv.
 */
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Parses "30s" / "5m" / "2h" / "500" (ms) into milliseconds. */
function parseDuration(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid duration: ${value}`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return Math.round(n * mult);
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Resolves the full runtime config from environment variables. */
function loadConfig(overrides = {}) {
  loadDotEnv();
  const e = process.env;
  return {
    baseUrl: overrides.baseUrl || e.PERF_BASE_URL || 'http://127.0.0.1:3000',
    apiPrefix: e.PERF_API_PREFIX || '/api/v1',
    tenant: e.PERF_TENANT || 'default',
    username: e.PERF_USERNAME || 'operator',
    password: e.PERF_PASSWORD || '',
    vus: num(overrides.vus ?? e.PERF_VUS, 10),
    durationMs: parseDuration(overrides.duration ?? e.PERF_DURATION, 30000),
    warmupMs: parseDuration(e.PERF_WARMUP, 0),
    // Optional target arrival rate (requests/sec across all VUs). 0 = unpaced
    // (VUs fire as fast as they can — closed-loop / max throughput).
    targetRps: num(overrides.rps ?? e.PERF_RPS, 0),
    // Per-VU think time between iterations (ms) when unpaced.
    thinkMs: num(e.PERF_THINK_MS, 0),
    allowSend: bool(e.PERF_ALLOW_SEND, false),
    resultsDir: e.PERF_RESULTS_DIR || require('path').join(__dirname, '..', 'results'),
  };
}

module.exports = { loadConfig, parseDuration, num, bool };
