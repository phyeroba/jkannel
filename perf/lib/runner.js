'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./client');
const { Metrics } = require('./stats');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Evenly spaces iteration starts to hit an aggregate arrival rate across all
 * VUs (open-loop). Used by the soak profile and any run with PERF_RPS set.
 */
function makePacer(targetRps) {
  if (!targetRps || targetRps <= 0) return null;
  const interval = 1000 / targetRps;
  let nextAt = performanceNow();
  return {
    async wait() {
      const now = performanceNow();
      if (nextAt < now) nextAt = now; // never accumulate backlog after a stall
      const delay = nextAt - now;
      nextAt += interval;
      if (delay > 0) await sleep(delay);
    },
  };
}

function performanceNow() {
  return Date.now();
}

/**
 * Core load engine.
 *
 * scenario = {
 *   name, description,
 *   setup?(client) -> ctx,          // run once with an authenticated client
 *   iteration(client, metrics, ctx) // one unit of virtual-user work
 *   evaluate?(metrics, ctx) -> [{ name, pass, detail }]  // extra SLO checks
 *   defaultSloChecks?()             // list of built-in SLO checks
 *   needsAuth?: boolean (default true)
 *   sampleMemory?: boolean          // poll /metrics rss during the run
 * }
 */
async function run(scenario, config) {
  const client = new Client(config.baseUrl, config.apiPrefix);
  const metrics = new Metrics();
  const memorySamples = [];

  process.stdout.write(
    `\n[perf] scenario="${scenario.name}" base=${config.baseUrl}${config.apiPrefix} ` +
      `vus=${config.vus} duration=${Math.round(config.durationMs / 1000)}s ` +
      `rps=${config.targetRps || 'max'}\n`,
  );

  if (scenario.needsAuth !== false) {
    if (!config.password) {
      throw new Error(
        'PERF_PASSWORD is not set. Authenticated scenarios require operator credentials ' +
          '(see perf/.env.example). Set PERF_PASSWORD or run the health scenario.',
      );
    }
    await client.login(config.tenant, config.username, config.password);
  }

  const ctx = scenario.setup ? await scenario.setup(client, config) : {};

  const pacer = makePacer(config.targetRps);
  const deadline = Date.now() + config.durationMs;
  const warmupUntil = Date.now() + (config.warmupMs || 0);

  // Optional RSS sampler (soak leak detection) reads the backend /metrics.
  let sampler;
  if (scenario.sampleMemory) {
    sampler = setInterval(async () => {
      const rss = await readBackendRss(client, config);
      if (rss !== null) memorySamples.push({ t: Date.now(), rss });
    }, 5000);
  }

  metrics.startedAt = Date.now();

  const vu = async () => {
    while (Date.now() < deadline) {
      if (pacer) await pacer.wait();
      if (Date.now() >= deadline) break;
      const recording = Date.now() >= warmupUntil; // discard warmup samples
      try {
        await scenario.iteration(client, recording ? metrics : new Metrics(), ctx);
      } catch (err) {
        if (recording) metrics.record('iteration_error', 0, 0, false, `exn_${err.code || 'x'}`);
      }
      if (!pacer && config.thinkMs > 0) await sleep(config.thinkMs);
    }
  };

  // Progress line for long runs.
  const progress = setInterval(() => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    process.stdout.write(
      `\r[perf] running… ${metrics.requests} reqs, ` +
        `${metrics.rps.toFixed(0)} rps, ${(metrics.errorRate * 100).toFixed(2)}% err, ` +
        `${remaining}s left   `,
    );
  }, 2000);

  await Promise.all(Array.from({ length: config.vus }, () => vu()));

  metrics.endedAt = Date.now();
  clearInterval(progress);
  if (sampler) clearInterval(sampler);
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  client.destroy();

  const checks = evaluate(scenario, metrics, ctx, memorySamples);
  const report = buildReport(scenario, config, metrics, checks, memorySamples);
  writeResult(config, scenario, report);
  printReport(report);
  return report;
}

async function readBackendRss(client, config) {
  // MetricsController is @Controller('metrics') under the global prefix and has
  // no auth guard, so the scrape endpoint is at {apiPrefix}/metrics.
  const res = await client.request('GET', `${config.apiPrefix}/metrics`, { timeoutMs: 5000 });
  if (!res.ok) return null;
  const m = /jkannel_backend_memory_bytes\{kind="rss"\}\s+(\d+)/.exec(res.body || '');
  return m ? Number(m[1]) : null;
}

function evaluate(scenario, metrics, ctx, memorySamples) {
  const checks = [];
  if (scenario.defaultSloChecks) checks.push(...scenario.defaultSloChecks(metrics, ctx));
  if (scenario.evaluate) checks.push(...scenario.evaluate(metrics, ctx, memorySamples));
  return checks;
}

function buildReport(scenario, config, metrics, checks, memorySamples) {
  const passed = checks.every((c) => c.pass);
  return {
    scenario: scenario.name,
    description: scenario.description,
    startedAt: new Date(metrics.startedAt).toISOString(),
    endedAt: new Date(metrics.endedAt).toISOString(),
    target: `${config.baseUrl}${config.apiPrefix}`,
    config: {
      vus: config.vus,
      durationSec: Math.round(config.durationMs / 1000),
      targetRps: config.targetRps || null,
      sloProfile: (process.env.PERF_SLO_PROFILE || 'local').toLowerCase(),
    },
    metrics: metrics.toJSON(),
    memory: memorySamples.length
      ? {
          samples: memorySamples.length,
          firstRssBytes: memorySamples[0].rss,
          lastRssBytes: memorySamples[memorySamples.length - 1].rss,
          growth:
            Math.round(
              ((memorySamples[memorySamples.length - 1].rss - memorySamples[0].rss) /
                memorySamples[0].rss) *
                10000,
            ) / 10000,
        }
      : null,
    slo: checks,
    passed,
  };
}

function writeResult(config, scenario, report) {
  try {
    fs.mkdirSync(config.resultsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.resultsDir, `${scenario.name}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    report._file = file;
  } catch (err) {
    process.stderr.write(`[perf] could not write result file: ${err.message}\n`);
  }
}

function printReport(report) {
  const m = report.metrics;
  const line = '─'.repeat(60);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`  SCENARIO: ${report.scenario}  —  ${report.description}\n`);
  process.stdout.write(`  target:   ${report.target}\n`);
  process.stdout.write(
    `  load:     ${report.config.vus} VUs / ${report.config.durationSec}s / ` +
      `rps=${report.config.targetRps || 'max'} / SLO profile=${report.config.sloProfile}\n`,
  );
  process.stdout.write(`${line}\n`);
  process.stdout.write(
    `  requests=${m.requests}  errors=${m.errors} (${(m.errorRate * 100).toFixed(2)}%)  ` +
      `throughput=${m.rps} rps\n`,
  );
  process.stdout.write(
    `  latency ms  p50=${m.overall.p50}  p90=${m.overall.p90}  ` +
      `p95=${m.overall.p95}  p99=${m.overall.p99}  max=${m.overall.max}\n`,
  );
  process.stdout.write(`  status: ${JSON.stringify(m.statusClasses)}\n`);
  const groupLabels = Object.keys(m.groups);
  if (groupLabels.length > 1) {
    process.stdout.write('  per-endpoint p95 (ms):\n');
    for (const label of groupLabels) {
      const g = m.groups[label];
      process.stdout.write(`    - ${label.padEnd(28)} p95=${g.p95}  n=${g.count}\n`);
    }
  }
  if (report.memory) {
    process.stdout.write(
      `  backend RSS: ${(report.memory.firstRssBytes / 1e6).toFixed(1)}MB → ` +
        `${(report.memory.lastRssBytes / 1e6).toFixed(1)}MB ` +
        `(${(report.memory.growth * 100).toFixed(1)}% over ${report.memory.samples} samples)\n`,
    );
  }
  if (Object.keys(m.errorSamples).length) {
    process.stdout.write(`  error breakdown: ${JSON.stringify(m.errorSamples)}\n`);
  }
  process.stdout.write(`${line}\n  SLO CHECKS:\n`);
  for (const c of report.slo) {
    process.stdout.write(`    [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}\n`);
  }
  process.stdout.write(`${line}\n`);
  process.stdout.write(`  RESULT: ${report.passed ? 'PASS ✅' : 'FAIL ❌'}\n`);
  if (report._file) process.stdout.write(`  saved:  ${report._file}\n`);
  process.stdout.write(`${line}\n\n`);
}

/** Standard SLO check builders shared by scenarios. */
function checkP95(metrics, group, ceilingMs, label) {
  const g = group === '*' ? metrics.overall : metrics.groups.get(group);
  const p95 = g ? g.percentile(95) : 0;
  return {
    name: label || `${group} p95 < ${ceilingMs}ms`,
    pass: (g ? g.count : 0) > 0 ? p95 <= ceilingMs : true,
    detail: `p95=${p95}ms (ceiling ${ceilingMs}ms, n=${g ? g.count : 0})`,
  };
}

function checkErrorRate(metrics, ceiling) {
  return {
    name: `error rate ≤ ${(ceiling * 100).toFixed(2)}%`,
    pass: metrics.errorRate <= ceiling,
    detail: `${(metrics.errorRate * 100).toFixed(3)}% (${metrics.errors}/${metrics.requests})`,
  };
}

module.exports = { run, checkP95, checkErrorRate, sleep };
