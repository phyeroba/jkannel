#!/usr/bin/env node
/**
 * A LOAD GENERATOR FOR THIS GATEWAY, USING THE ENGINE'S OWN FAKE SMSC.
 *
 * WHAT IT IS
 * ---------------------------------------------------------------------------
 * Kannel ships `fakesmsc`, and the image this platform runs has it. A `fake`
 * SMSC is bearerbox LISTENING on a port; `fakesmsc` connects to that port and
 * becomes the far end of the link. Once attached it can push MO up the socket,
 * and every MT the engine routes to that smsc-id comes down it. One process
 * therefore exercises both directions with no carrier, no cost and no risk of
 * putting test traffic on a real network.
 *
 * WHAT IT MEASURES, AND WHY EACH NUMBER IS SEPARATE
 * ---------------------------------------------------------------------------
 *   accepted/s   how fast the API takes submissions. A number here proves the
 *                console and the queue keep up; it says NOTHING about delivery.
 *   engine/s     what bearerbox reports it actually put on the wire, read from
 *                its own status page. This is the throughput figure that means
 *                something.
 *   received     what the fake far end actually got. The only end-to-end proof;
 *                if this trails `engine`, messages left the engine and did not
 *                arrive.
 *
 * Three numbers rather than one because they fail independently and the
 * difference between them is the diagnosis. A gateway that accepts 2000/s and
 * delivers 40/s is not a fast gateway, and one number would have called it one.
 *
 * SAFETY
 * ---------------------------------------------------------------------------
 * Refuses to run against an SMSC that is not of type `fake`. Load-testing a
 * carrier bind means sending real messages to real handsets and being billed
 * for them, so this will not do it by accident.
 *
 *   node scripts/throughput-test.mjs                      # defaults below
 *   COUNT=2000 RATE=0 SMSC=local-fake node scripts/throughput-test.mjs
 *   DIRECTION=mo COUNT=500 node scripts/throughput-test.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const TENANT = process.env.JKANNEL_TENANT ?? 'default';
const USER = process.env.U ?? 'operator';
const PASS = process.env.P ?? 'JkannelLocal2026!';
const ENGINE = process.env.ENGINE_CONTAINER ?? 'jkannel-kamex-bearerbox-1';
const SMSC = process.env.SMSC ?? 'local-fake';
const COUNT = Number(process.env.COUNT ?? 500);
/** Submissions in flight. 0 means "as fast as the API will take them". */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const DIRECTION = (process.env.DIRECTION ?? 'mt').toLowerCase();
const RECIPIENT = process.env.RECIPIENT ?? '256770000001';
const SENDER = process.env.SENDER ?? 'JKANNEL';

const docker = (args) => run('docker', args, { maxBuffer: 32 * 1024 * 1024 });

/**
 * Kills every attached `fakesmsc`, by walking /proc.
 *
 * The engine image has no `pkill`, no `pgrep`, no `ps` and no `killall`, so the
 * obvious `pkill -f fakesmsc` silently did nothing — `sh` reported
 * "command not found" into a discarded stream and the run carried on. Stale
 * clients then accumulated across runs, and because bearerbox hands each
 * message to ONE attached client, the far-end count was read from a process
 * that was not the one receiving. It looked like total delivery failure.
 *
 * Left as `|| true` throughout: there is legitimately nothing to kill on a
 * first run, and that must not fail the test.
 */
// Reads `/proc/PID/comm`, which holds the executable name as plain text.
// `/proc/PID/cmdline` is NUL-separated, and carrying a NUL through a JS string
// into `execFile` is rejected outright — the argument must not contain one.
const REAP =
  'for p in /proc/[0-9]*; do ' +
  'if [ "$(cat $p/comm 2>/dev/null)" = "fakesmsc" ]; then kill -9 "${p#/proc/}" 2>/dev/null; fi; ' +
  'done; true';
const reapFakesmsc = () => docker(['exec', ENGINE, 'sh', '-c', REAP]).catch(() => {});

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
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${body.message ?? ''}`);
  return body.data ?? body;
}

/** bearerbox's own counters, which is the only honest source for engine rate. */
async function engineCounters() {
  const { stdout } = await docker([
    'exec', ENGINE, 'sh', '-c',
    'curl -s "http://127.0.0.1:13000/status.txt?password=$KAMEX_STATUS_PASSWORD"',
  ]);
  const sms = stdout.match(/SMS: received (\d+) \((\d+) queued\), sent (\d+) \((\d+) queued\)/);
  return sms
    ? { received: +sms[1], receiveQueue: +sms[2], sent: +sms[3], sendQueue: +sms[4] }
    : { received: 0, receiveQueue: 0, sent: 0, sendQueue: 0 };
}

console.log('='.repeat(78));
console.log(`THROUGHPUT TEST — ${DIRECTION.toUpperCase()} · ${COUNT} messages · smsc "${SMSC}"`);
console.log('='.repeat(78));

// `tenant` is required and is NOT optional-with-a-default on the server: omit
// it and the answer is a flat 401 "Invalid credentials", which reads as a wrong
// password rather than a missing field.
const token = (
  await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ tenant: TENANT, username: USER, password: PASS }),
  })
).accessToken;

// --- The safety gate --------------------------------------------------------
const smscs = await api('/smscs?limit=500&offset=0', {}, token);
const items = Array.isArray(smscs) ? smscs : (smscs.items ?? []);
const target = items.find((s) => (s.engine_id ?? s.engineId) === SMSC);
if (!target) {
  console.error(
    `\nNo SMSC with engine id "${SMSC}". Known: ${items.map((s) => s.engine_id ?? s.engineId).join(', ') || '(none)'}`,
  );
  process.exit(1);
}
if (target.type !== 'fake') {
  console.error(
    `\nREFUSING: "${SMSC}" is type "${target.type}", not "fake". Driving load through a real ` +
      `bind sends real messages to real handsets and is billed. Create a fake SMSC to test with.`,
  );
  process.exit(1);
}

// --- Attach the far end -----------------------------------------------------
// Detached, with its output kept, so it stays connected for the whole run and
// can be counted afterwards. `-m 0` sends no MO of its own in the MT case.
const port = target.port ?? 10000;
const LOG = `/tmp/fakesmsc-${SMSC}.log`;
await reapFakesmsc();
await docker(['exec', ENGINE, 'sh', '-c', `rm -f ${LOG}`]).catch(() => {});

const moArgs =
  DIRECTION === 'mo'
    ? `-i 0 -m ${COUNT} '${RECIPIENT} 25670000000 text throughput-probe'`
    : `-i 3600 -m 0 '1 2 text idle'`;
// `stdbuf -oL`: fakesmsc block-buffers stdout, so everything it had received
// was lost when the process was killed at the end of the run — the far-end
// count read zero while the engine reported hundreds sent.
docker([
  'exec', '-d', ENGINE, 'sh', '-c',
  `stdbuf -oL -eL fakesmsc -H 127.0.0.1 -r ${port} ${moArgs} > ${LOG} 2>&1`,
]).catch(() => {});
// The socket has to be up before anything is submitted, or the first messages
// queue against a bind with no far end and the rate reads low for the wrong
// reason.
await new Promise((r) => setTimeout(r, 2500));

const before = await engineCounters();
const startedAt = Date.now();
let accepted = 0;
let rejected = 0;
const failures = new Map();

if (DIRECTION === 'mt') {
  // A fixed pool of workers rather than 500 simultaneous fetches: the number we
  // want is the gateway's rate, and burying it under connection-pool contention
  // in this script would measure the script.
  const queue = Array.from({ length: COUNT }, (_, i) => i);
  const worker = async () => {
    for (;;) {
      const index = queue.pop();
      if (index === undefined) return;
      try {
        await api(
          '/messages',
          {
            method: 'POST',
            // `sender`/`receiver`, which is what the API and the console use —
            // not `from`/`to`. The refusal is a flat 400 naming one field, so
            // getting this wrong reads as a broken gateway rather than a
            // mistyped client.
            body: JSON.stringify({
              sender: SENDER,
              receiver: RECIPIENT,
              text: `throughput probe ${index}`,
              smscId: SMSC,
            }),
          },
          token,
        );
        accepted += 1;
      } catch (cause) {
        rejected += 1;
        const key = cause instanceof Error ? cause.message.slice(0, 120) : 'unknown';
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
} else {
  // MO is generated by fakesmsc itself; nothing to submit from here.
  accepted = COUNT;
}

const submitSeconds = (Date.now() - startedAt) / 1000;

// Let the engine drain before reading its counters, and say how long that took
// — the drain time IS the throughput story for a queue-backed gateway.
/**
 * Waits for the engine to STOP MOVING, not for its queue to read zero.
 *
 * An empty queue is true a fraction of a second after submission — before the
 * messages have been dequeued into it — so breaking on `queue === 0` stopped
 * the clock early and read the counter mid-flight. It reported the engine
 * sending fewer messages than the far end received, which is impossible and
 * was a measurement artefact rather than a finding.
 *
 * Settling on "the counter has not moved for two consecutive seconds" is what
 * actually means done, and it is true whether the engine is fast or slow.
 */
let after = await engineCounters();
const counterOf = (c) => (DIRECTION === 'mt' ? c.sent : c.received);
const drainStart = Date.now();
let still = 0;
let last = counterOf(after);
for (let tick = 0; tick < 120 && still < 2; tick += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  after = await engineCounters();
  const now = counterOf(after);
  const queue = DIRECTION === 'mt' ? after.sendQueue : after.receiveQueue;
  still = now === last && queue === 0 ? still + 1 : 0;
  last = now;
}
// The two settling seconds are not drain time; subtracting them keeps the rate
// from being quietly understated on a fast run.
const drainSeconds = Math.max(0, (Date.now() - drainStart) / 1000 - 2);

const { stdout: fakeLog } = await docker([
  'exec', ENGINE, 'sh', '-c', `cat ${LOG} 2>/dev/null || true`,
]);
// fakesmsc prints one line per received MT. Both spellings are matched because
// the wording differs across Kannel builds and pinning one would silently
// report zero on the other.
const receivedAtFarEnd = (fakeLog.match(/Got message|Received message/g) ?? []).length;
const sentByFarEnd = (fakeLog.match(/sent message/g) ?? []).length;

// Stop the generator; it is a client, so nothing about the engine is disturbed.
await reapFakesmsc();

const engineDelta = DIRECTION === 'mt' ? after.sent - before.sent : after.received - before.received;
const wall = submitSeconds + drainSeconds;
const rate = (n, s) => (s > 0 ? (n / s).toFixed(1) : '—');

console.log(`\n  submitted            ${accepted} accepted, ${rejected} rejected in ${submitSeconds.toFixed(1)}s`);
console.log(`  accepted/s           ${rate(accepted, submitSeconds)}   (API intake — not delivery)`);
console.log(`  engine drain         ${drainSeconds.toFixed(1)}s to empty the queue`);
console.log(`  engine ${DIRECTION === 'mt' ? 'sent' : 'received'}         ${engineDelta}`);
console.log(`  engine/s             ${rate(engineDelta, wall)}   (bearerbox's own counter)`);
console.log(
  `  far end              ${DIRECTION === 'mt' ? `${receivedAtFarEnd} received` : `${sentByFarEnd} sent`}   (fakesmsc — end to end)`,
);
console.log(`  configured ceiling   ${target.tps ?? 'unset'} TPS`);

if (failures.size) {
  console.log('\n  rejections:');
  for (const [reason, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 5))
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
}

// The reading, stated rather than left to the reader.
console.log(`\n${'='.repeat(78)}`);
if (rejected > accepted * 0.01)
  console.log(`${rejected} of ${accepted + rejected} submissions were REJECTED — see the reasons above.`);
else if (engineDelta === 0 && accepted > 0)
  console.log(
    'The API accepted everything and the engine moved NOTHING. The messages are queued ' +
      'against a bind that is not delivering, or they were routed to a different smsc-id.',
  );
else if (DIRECTION === 'mt' && receivedAtFarEnd < engineDelta)
  console.log(
    `The engine reports ${engineDelta} sent but the far end saw ${receivedAtFarEnd}. Messages ` +
      'left the engine and did not arrive.',
  );
else {
  console.log(
    `Sustained ${rate(engineDelta, wall)} msg/s end to end against a ${target.tps ?? '(unset)'} TPS ceiling.`,
  );
  /*
   * WHETHER THE CEILING WAS TESTED AT ALL, which is a different question from
   * whether the run stayed under it.
   *
   * An earlier run reported 9.5 msg/s against a 10 TPS ceiling and read as
   * perfect throttle compliance. It was nothing of the kind: the machine was
   * busy with a container build, the API could only accept 9.6/s, and the
   * engine was never asked for more than it delivered. The number that looked
   * like proof of a working limit was a coincidence of a starved client.
   *
   * The limit is only exercised when INTAKE outruns it. Below that, the run
   * says nothing about the ceiling either way, and must not imply otherwise.
   */
  const ceiling = Number(target.tps);
  const engineRate = Number(rate(engineDelta, wall));
  const intakeRate = Number(rate(accepted, wall));
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    console.log('No TPS ceiling is configured on this SMSC, so none was tested.');
  } else if (intakeRate <= ceiling * 1.1) {
    console.log(
      `Intake only reached ${intakeRate} msg/s, at or below the ${ceiling} TPS ceiling, so the ` +
        'ceiling was never pushed against. This run does NOT show the limit working — re-run ' +
        'on an idle machine, or with more submitters, before reading anything into it.',
    );
  } else if (engineRate > ceiling * 1.2) {
    console.log(
      `THE CEILING IS NOT BEING ENFORCED: intake pushed ${intakeRate} msg/s and the engine ` +
        `passed ${engineRate} msg/s through an SMSC configured for ${ceiling} TPS. Note that ` +
        'Kamex implements throughput shaping in the individual SMSC drivers, and the `fake` ' +
        'driver does not — so a fake SMSC is the wrong instrument for testing a rate limit, ' +
        'however useful it is for testing delivery.',
    );
  } else {
    console.log(
      `Intake pushed ${intakeRate} msg/s and the engine held to ${engineRate} against a ` +
        `${ceiling} TPS ceiling, so the limit is being enforced.`,
    );
  }
}
