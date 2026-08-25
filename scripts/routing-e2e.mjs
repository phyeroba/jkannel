#!/usr/bin/env node
/**
 * DOES ROUTING ACTUALLY ROUTE?
 *
 * WHAT THIS PROVES, AND WHY THE OBVIOUS TEST DOES NOT
 * ---------------------------------------------------------------------------
 * A route says "traffic to this prefix goes to that connection". The simulator
 * (`POST /routes/simulate`) will tell you which route it WOULD pick, and it is
 * useful — but it exercises the resolver, not the send path. A resolver that
 * agrees with itself while the submit path ignores it entirely would pass that
 * test and fail every real message.
 *
 * So this sends real traffic and reads where it landed:
 *
 *   1. two `fake` connections, each with its own far end attached
 *   2. a route per destination prefix, each pointing at a different one
 *   3. messages submitted with NO smscId — the point is that routing chooses
 *   4. the answer read from `sent_sms.smsc_id`, which is what the engine
 *      actually did, not from what the console predicted it would do
 *
 * Step 3 is the whole test. Submitting with an explicit `smscId` and then
 * observing that it went there proves nothing about routing at all, and is the
 * shape most "routing tests" quietly take.
 *
 * IT ALSO CHECKS THE SIMULATOR AGREES
 * ---------------------------------------------------------------------------
 * Having established where a message really goes, the simulator's prediction
 * for the same destination is compared against it. A simulator that disagrees
 * with the send path is worse than no simulator: an operator uses it to decide
 * whether a change is safe.
 *
 *   node scripts/routing-e2e.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const docker = (args) => run('docker', args, { maxBuffer: 32 * 1024 * 1024 });

const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const TENANT = process.env.JKANNEL_TENANT ?? 'default';
const USER = process.env.U ?? 'operator';
const PASS = process.env.P ?? 'JkannelLocal2026!';
const ENGINE = process.env.ENGINE_CONTAINER ?? 'jkannel-kamex-bearerbox-1';
const DB = process.env.DB_CONTAINER ?? 'jkannel-postgres-1';

/** Two prefixes that exist nowhere else, so nothing else can claim them. */
// Distinct priorities: the API rejects two routes at the same priority within a
// scope, which is correct — evaluation is first-match-wins and a tie would make
// the winner arbitrary. The test has to respect that rather than work around it.
const CASES = [
  { prefix: '25690100', smsc: 'local-fake', label: 'route A', priority: 11 },
  { prefix: '25690200', smsc: 'local-fake-b', label: 'route B', priority: 12 },
];

async function api(path, init = {}, token) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${body.message ?? ''}`);
  return body.data ?? body;
}

const REAP =
  'for p in /proc/[0-9]*; do ' +
  'if [ "$(cat $p/comm 2>/dev/null)" = "fakesmsc" ]; then kill -9 "${p#/proc/}" 2>/dev/null; fi; ' +
  'done; true';

console.log('='.repeat(80));
console.log('ROUTING END TO END — where does a message actually land?');
console.log('='.repeat(80));

const token = (
  await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ tenant: TENANT, username: USER, password: PASS }),
  })
).accessToken;

const listed = await api('/smscs?limit=500&offset=0', {}, token);
const smscs = Array.isArray(listed) ? listed : (listed.items ?? []);
const byEngineId = new Map(smscs.map((s) => [s.engine_id ?? s.engineId, s]));

for (const testCase of CASES) {
  const smsc = byEngineId.get(testCase.smsc);
  if (!smsc) {
    console.error(`\nMissing SMSC "${testCase.smsc}". Create it before running this.`);
    process.exit(1);
  }
  if (smsc.type !== 'fake') {
    console.error(
      `\nREFUSING: "${testCase.smsc}" is type "${smsc.type}". This test sends real messages; ` +
        'it will only drive fake connections.',
    );
    process.exit(1);
  }
  testCase.smscRow = smsc;
}

// --- Routes -----------------------------------------------------------------
// Reused if they already exist. Creating a duplicate prefix at the same
// priority is rejected by the API, and it would also make the test's own
// premise ambiguous.
const existing = await api('/routes?limit=200&offset=0', {}, token);
const routes = Array.isArray(existing) ? existing : (existing.items ?? []);
for (const testCase of CASES) {
  const already = routes.find(
    (r) => (r.destination_prefix ?? r.destinationPrefix) === testCase.prefix,
  );
  if (already) {
    console.log(`  route for ${testCase.prefix} already exists — reusing it`);
    testCase.routeId = already.id;
    continue;
  }
  const created = await api(
    '/routes',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `e2e ${testCase.label} ${testCase.prefix}`,
        priority: testCase.priority,
        destinationPrefix: testCase.prefix,
        targetSmscId: testCase.smscRow.id,
      }),
    },
    token,
  );
  testCase.routeId = created.id;
  console.log(`  created route ${testCase.prefix} → ${testCase.smsc}`);
}

// --- Far ends ---------------------------------------------------------------
await docker(['exec', ENGINE, 'sh', '-c', REAP]).catch(() => {});
for (const testCase of CASES) {
  const port = testCase.smscRow.port;
  if (!port) {
    console.error(`\n"${testCase.smsc}" has no port set, so nothing can attach to it.`);
    process.exit(1);
  }
  docker([
    'exec', '-d', ENGINE, 'sh', '-c',
    `stdbuf -oL -eL fakesmsc -H 127.0.0.1 -r ${port} -i 3600 -m 0 '1 2 text idle' ` +
      `> /tmp/route-${testCase.smsc}.log 2>&1`,
  ]).catch(() => {});
}
/**
 * Wait until the platform has OBSERVED the binds, not merely until they exist.
 *
 * Routing only selects an SMSC whose `smsc_bind_state` reads `bound`, and that
 * row is written by the status poller every 30s — so for up to half a minute
 * after a far end attaches, the database still says `retrying` and every
 * message is refused with "no available SMSC". Sleeping three seconds and
 * sending produced exactly that, and it looked like a routing failure when it
 * was the test outrunning the poller.
 *
 * A `fake` connection is only "online" in the engine while a client is
 * attached, which is why this has to happen after the far ends are up.
 */
process.stdout.write('  waiting for the poller to observe the binds');
const wanted = CASES.map((c) => c.smsc);
let bound = [];
for (let attempt = 0; attempt < 24; attempt += 1) {
  const { stdout } = await docker([
    'exec', DB, 'psql', '-U', 'jkannel', '-d', 'jkannel', '-t', '-A', '-c',
    `select d.engine_id from smsc_definitions d join smsc_bind_state s on s.smsc_id=d.id ` +
      `where s.state='bound' and d.engine_id in (${wanted.map((w) => `'${w}'`).join(',')});`,
  ]).catch(() => ({ stdout: '' }));
  bound = stdout
    .trim()
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);
  if (wanted.every((w) => bound.includes(w))) break;
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(bound.length ? ` bound: ${bound.join(', ')}` : ' none became bound');
if (!wanted.every((w) => bound.includes(w)))
  console.log(
    `  NOTE: ${wanted.filter((w) => !bound.includes(w)).join(', ')} never reached "bound". ` +
      'Routing will refuse them, and the failures below are that, not a routing bug.',
  );

// --- Send, WITHOUT naming a connection --------------------------------------
const stamp = Date.now();
for (const testCase of CASES) {
  testCase.receiver = `${testCase.prefix}${String(stamp).slice(-4)}`;
  testCase.text = `routing-probe-${testCase.prefix}-${stamp}`;
  await api(
    '/messages',
    {
      method: 'POST',
      // No smscId. If one were named here the test would prove only that the
      // engine honours an explicit target, which is not routing.
      body: JSON.stringify({
        sender: 'JKANNEL',
        receiver: testCase.receiver,
        text: testCase.text,
      }),
    },
    token,
  ).catch((cause) => {
    testCase.submitError = cause instanceof Error ? cause.message : String(cause);
  });
}
await new Promise((r) => setTimeout(r, 5000));

// --- Where did they land? ---------------------------------------------------
for (const testCase of CASES) {
  const { stdout } = await docker([
    'exec', DB, 'psql', '-U', 'jkannel', '-d', 'jkannel', '-t', '-A', '-F', '|',
    '-c',
    `select coalesce(smsc_id,'(null)'), coalesce(receiver,'') from sent_sms ` +
      `where msgdata like '%${testCase.text}%' order by time desc limit 1;`,
  ]).catch(() => ({ stdout: '' }));
  const [landed] = stdout.trim().split('\n');
  testCase.landedOn = landed ? landed.split('|')[0] : null;

  // And what the simulator predicted for the same destination.
  try {
    const simulated = await api(
      '/routes/simulate',
      { method: 'POST', body: JSON.stringify({ destination: testCase.receiver }) },
      token,
    );
    // The simulator answers with the SMSC's UUID;  holds its
    // ENGINE id. Comparing them directly reports a disagreement between two
    // names for the same connection — so the UUID is mapped back before the
    // comparison, and the report shows the engine id an operator recognises.
    const predictedId =
      simulated.smscId ??
      simulated.engineId ??
      simulated.targetSmscId ??
      simulated.route?.targetSmscId ??
      null;
    const matched = smscs.find((row) => row.id === predictedId);
    testCase.predicted = matched ? (matched.engine_id ?? matched.engineId) : predictedId;
    testCase.notInForce = simulated.notInForceNote;
  } catch (cause) {
    testCase.simulateError = cause instanceof Error ? cause.message : String(cause);
  }
}
await docker(['exec', ENGINE, 'sh', '-c', REAP]).catch(() => {});

// --- Report -----------------------------------------------------------------
console.log(`\n${'prefix'.padEnd(12)}${'expected'.padEnd(16)}${'landed on'.padEnd(16)}verdict`);
console.log('-'.repeat(80));
let failures = 0;
for (const testCase of CASES) {
  const ok = testCase.landedOn === testCase.smsc;
  if (!ok) failures += 1;
  console.log(
    `${testCase.prefix.padEnd(12)}${testCase.smsc.padEnd(16)}${String(testCase.landedOn ?? 'nowhere').padEnd(16)}${ok ? 'ok' : 'WRONG'}`,
  );
  if (testCase.submitError) console.log(`             submit refused: ${testCase.submitError}`);
}

console.log('\nSimulator agreement (does the preview match the send path?)');
for (const testCase of CASES) {
  if (testCase.simulateError) {
    console.log(`  ${testCase.prefix}  simulate failed: ${testCase.simulateError}`);
    continue;
  }
  const agrees = testCase.predicted === testCase.landedOn;
  console.log(
    `  ${testCase.prefix}  predicted ${testCase.predicted ?? '(none)'} · actual ${testCase.landedOn ?? '(none)'} · ${agrees ? 'agrees' : 'DISAGREES'}`,
  );
  if (!agrees) failures += 1;
}

console.log(`\n${'='.repeat(80)}`);
console.log(
  failures === 0
    ? 'Routing sends each prefix to its configured connection, and the simulator agrees.'
    : `${failures} problem(s). A message that lands on the wrong connection is billed to the ` +
        'wrong carrier and may not be deliverable at all.',
);
process.exitCode = failures === 0 ? 0 : 1;
