#!/usr/bin/env node
'use strict';

/**
 * JKANNEL performance harness — CLI entrypoint.
 *
 * Usage:
 *   node run.js <scenario> [--vus N] [--duration 30s] [--rps N] [--base URL]
 *
 * Scenarios: read-grid | auth | reporting | write-send | soak | all
 *
 * All parameters can also come from env (see perf/.env.example). CLI flags win.
 * Exit code is non-zero if any SLO check fails, so a run is an objective gate.
 */

const { loadConfig } = require('./config/env');
const { run } = require('./lib/runner');

const SCENARIOS = {
  'read-grid': () => require('./scenarios/read-grid'),
  auth: () => require('./scenarios/auth'),
  reporting: () => require('./scenarios/reporting'),
  'write-send': () => require('./scenarios/write-send'),
  soak: () => require('./scenarios/soak'),
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
      flags[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage() {
  process.stdout.write(
    'JKANNEL perf harness\n\n' +
      'Usage: node run.js <scenario> [--vus N] [--duration 30s] [--rps N] [--base URL]\n\n' +
      'Scenarios:\n' +
      '  read-grid    Read-heavy grid browsing\n' +
      '  auth         Authentication throughput\n' +
      '  reporting    Reporting/analytics dashboard queries\n' +
      '  write-send   Write path (safe route simulate; PERF_ALLOW_SEND=true for real bulk-send)\n' +
      '  soak         Sustained low-RPS mixed read soak with leak detection\n' +
      '  all          Run read-grid, reporting and write-send sequentially\n\n' +
      'Env: PERF_BASE_URL, PERF_USERNAME, PERF_PASSWORD, PERF_VUS, PERF_DURATION,\n' +
      '     PERF_RPS, PERF_SLO_PROFILE=local|spec, PERF_ALLOW_SEND (see .env.example)\n',
  );
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const name = positional[0];
  if (!name || flags.help) {
    usage();
    process.exit(name ? 0 : 1);
  }

  const overrides = {
    vus: flags.vus,
    duration: flags.duration,
    rps: flags.rps,
    baseUrl: flags.base,
  };
  const config = loadConfig(overrides);

  const names =
    name === 'all' ? ['read-grid', 'reporting', 'write-send'] : [name];
  for (const n of names) {
    if (!SCENARIOS[n]) {
      process.stderr.write(`Unknown scenario: ${n}\n\n`);
      usage();
      process.exit(1);
    }
  }

  let allPassed = true;
  for (const n of names) {
    const scenario = SCENARIOS[n]();
    const report = await run(scenario, config);
    allPassed = allPassed && report.passed;
  }
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\n[perf] FATAL: ${err.message}\n`);
  process.exit(2);
});
