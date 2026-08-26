#!/usr/bin/env node
/**
 * DOES A BLOCKED MESSAGE ACTUALLY GET BLOCKED?
 *
 * WHY
 * ---------------------------------------------------------------------------
 * The console has a Recipient Policy screen with blacklist, whitelist and DND
 * lists, and a Content Filtering screen with rules that can block. Both have a
 * "check" or "evaluate" endpoint that answers what WOULD happen. Neither answers
 * the only question that matters: when a real submission goes down the real send
 * path, is the message stopped?
 *
 * Those are different questions, and a preview that agrees with itself is worth
 * nothing — the routing simulator and the send path in this same codebase once
 * disagreed for exactly that reason. So this submits, and then reads the
 * outcome from the send path's own answer.
 *
 * WHAT IT PROVES, IN ORDER
 * ---------------------------------------------------------------------------
 *  1. A number with no policy against it is accepted. Without this, "everything
 *     was blocked" would read as a pass.
 *  2. The preview (`/messaging/blocklist/check`) says the listed number is
 *     blocked.
 *  3. The SEND PATH refuses it — the part a preview cannot tell you.
 *  4. Removing the entry lets the same number through again, so what was
 *     observed was the rule and not some unrelated rejection.
 *
 * SAFE TO RUN. The destinations are in a reserved test range and the SMSC it
 * sends through must be type `fake`; it refuses otherwise, because a test that
 * proves blocking works by sending real messages to real handsets is not a
 * test anybody should run twice.
 *
 *   node scripts/policy-e2e.mjs
 */
const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const TENANT = process.env.JKANNEL_TENANT ?? 'default';
const USER = process.env.U ?? 'operator';
const PASS = process.env.P ?? 'JkannelLocal2026!';
const SMSC = process.env.SMSC ?? 'local-fake';

/** Reserved test range, so a stray submission cannot reach a subscriber. */
const BLOCKED = process.env.BLOCKED_MSISDN ?? '256999000111';
const ALLOWED = process.env.ALLOWED_MSISDN ?? '256999000222';

const unwrap = (body) => (body && body.data !== undefined ? body.data : body);

let token = '';
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: unwrap(body), raw: body };
}

function line(label, verdict, detail) {
  console.log(`  ${label.padEnd(46)} ${verdict.padEnd(10)} ${detail ?? ''}`);
}

console.log('='.repeat(88));
console.log('RECIPIENT POLICY END TO END — is a blocked number actually stopped?');
console.log('='.repeat(88));

token = (
  await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ tenant: TENANT, username: USER, password: PASS }),
  })
).body.accessToken;
if (!token) {
  console.error('Could not log in.');
  process.exit(1);
}

// --- The safety gate --------------------------------------------------------
const register = await api('/smscs?limit=500&offset=0');
const items = Array.isArray(register.body) ? register.body : (register.body.items ?? []);
const target = items.find((s) => (s.engine_id ?? s.engineId) === SMSC);
if (!target) {
  console.error(`\nNo SMSC with engine id "${SMSC}".`);
  process.exit(1);
}
if (target.type !== 'fake') {
  console.error(
    `\nREFUSING: "${SMSC}" is type "${target.type}", not "fake". This test submits real ` +
      'messages to prove they are refused, and a real bind would deliver the ones that are not.',
  );
  process.exit(1);
}

/** One submission, reporting whether the SEND PATH accepted it. */
async function submit(msisdn, note) {
  const response = await api('/messages', {
    method: 'POST',
    body: JSON.stringify({
      sender: 'JKANNEL',
      receiver: msisdn,
      // Unique, so the duplicate-submission guard cannot be mistaken for a
      // policy block — they are both refusals and only one of them is the
      // thing under test.
      text: `policy-e2e ${note} ${Math.floor(performance.now() * 1000)}`,
      smscId: SMSC,
    }),
  });
  const message =
    typeof response.body === 'object' ? (response.body.message ?? '') : String(response.body ?? '');
  return { accepted: response.status < 400, status: response.status, message };
}

let failures = 0;
const expect = (label, ok, detail) => {
  line(label, ok ? 'ok' : 'FAILED', detail);
  if (!ok) failures += 1;
};

// --- 1. The control ---------------------------------------------------------
console.log('\nBefore any policy exists:\n');
const controlBefore = await submit(ALLOWED, 'control');
expect(
  `a number with no policy against it (${ALLOWED})`,
  controlBefore.accepted,
  controlBefore.accepted ? 'accepted' : `refused ${controlBefore.status}: ${controlBefore.message}`,
);

// --- 2. Add the blacklist entry --------------------------------------------
console.log('\nWith a blacklist entry in place:\n');
const added = await api('/messaging/blocklist', {
  method: 'POST',
  body: JSON.stringify({
    listType: 'blacklist',
    msisdn: BLOCKED,
    reason: 'policy-e2e: proving the send path honours the list',
    source: 'policy-e2e',
  }),
});
if (added.status >= 400) {
  console.error(`\nCould not add the blacklist entry: ${added.status} ${JSON.stringify(added.body).slice(0, 200)}`);
  process.exit(1);
}
const entryId = added.body?.id;

// --- 3. The preview ---------------------------------------------------------
const preview = await api(`/messaging/blocklist/check?msisdn=${encodeURIComponent(BLOCKED)}`);
const previewBlocks = preview.body?.blocked === true || preview.body?.allowed === false;
expect(
  'the preview says it is blocked',
  previewBlocks,
  `check → ${JSON.stringify(preview.body).slice(0, 120)}`,
);

// --- 4. The send path, which is the actual question -------------------------
const blockedSend = await submit(BLOCKED, 'blocked');
expect(
  `the SEND PATH refuses it (${BLOCKED})`,
  !blockedSend.accepted,
  blockedSend.accepted
    ? 'ACCEPTED — the list is decoration; the message went through'
    : `refused ${blockedSend.status}: ${blockedSend.message.slice(0, 90)}`,
);

// A second control WHILE the entry exists, so a blanket outage cannot pass as
// a working block.
const controlDuring = await submit(ALLOWED, 'control-during');
expect(
  'an unlisted number still gets through',
  controlDuring.accepted,
  controlDuring.accepted ? 'accepted' : `refused ${controlDuring.status}: ${controlDuring.message}`,
);

// --- 5. Remove it and confirm the block lifts -------------------------------
console.log('\nAfter removing the entry:\n');
if (entryId) await api(`/messaging/blocklist/${entryId}`, { method: 'DELETE' });
const afterRemoval = await submit(BLOCKED, 'after-removal');
expect(
  `the same number is accepted again (${BLOCKED})`,
  afterRemoval.accepted,
  afterRemoval.accepted
    ? 'accepted — so what was observed was the rule, not something else'
    : `still refused ${afterRemoval.status}: ${afterRemoval.message.slice(0, 90)}`,
);

// --- 6. Content filtering ---------------------------------------------------
/*
 * The same question about a different rule set. Content rules match on the
 * message BODY rather than the destination, so a rule can be proved without any
 * number being listed — and the two must be shown to be independent, or a pass
 * here could just be the blacklist still in force from above.
 *
 * Note for anyone extending this: content rules take `substring`, `exact`,
 * `prefix` and `regex`. They do NOT take the `*`/`#`/`$`/`|` wildcard grammar,
 * which exists only for routing.
 */
console.log('\nContent filtering, on the message body rather than the destination:\n');

const PHRASE = `policy-e2e-forbidden-${Math.floor(performance.now())}`;
const rule = await api('/messaging/content-rules', {
  method: 'POST',
  body: JSON.stringify({
    name: 'policy-e2e block phrase',
    description: 'Temporary rule proving the send path honours content filtering.',
    // `body`, not `text`: the field names are body / sender / recipient / any.
    matchField: 'body',
    matchType: 'substring',
    pattern: PHRASE,
    action: 'block',
    enabled: true,
  }),
});

if (rule.status >= 400) {
  expect(
    'a content rule can be created',
    false,
    `${rule.status}: ${JSON.stringify(rule.body).slice(0, 160)}`,
  );
} else {
  const ruleId = rule.body?.id;
  const carrying = await api('/messages', {
    method: 'POST',
    body: JSON.stringify({
      sender: 'JKANNEL',
      receiver: ALLOWED,
      text: `hello ${PHRASE} world`,
      smscId: SMSC,
    }),
  });
  const carryingMessage =
    typeof carrying.body === 'object' ? (carrying.body.message ?? '') : String(carrying.body ?? '');
  expect(
    'a message carrying the phrase is refused',
    carrying.status >= 400,
    carrying.status >= 400
      ? `refused ${carrying.status}: ${carryingMessage.slice(0, 90)}`
      : 'ACCEPTED — the content rule did not stop it',
  );

  // The same destination without the phrase. This is what separates "the rule
  // matched" from "this number is blocked", which the section above just spent
  // five checks establishing can happen.
  const withoutPhrase = await submit(ALLOWED, 'no-phrase');
  expect(
    'the same destination without the phrase is accepted',
    withoutPhrase.accepted,
    withoutPhrase.accepted
      ? 'accepted — so it was the phrase, not the number'
      : `refused ${withoutPhrase.status}: ${withoutPhrase.message.slice(0, 90)}`,
  );

  if (ruleId) await api(`/messaging/content-rules/${ruleId}`, { method: 'DELETE' });
  const afterRule = await api('/messages', {
    method: 'POST',
    body: JSON.stringify({
      sender: 'JKANNEL',
      receiver: ALLOWED,
      text: `hello ${PHRASE} again`,
      smscId: SMSC,
    }),
  });
  expect(
    'removing the rule lets the phrase through',
    afterRule.status < 400,
    afterRule.status < 400 ? 'accepted' : `still refused ${afterRule.status}`,
  );
}

console.log(`\n${'='.repeat(88)}`);
console.log(
  failures
    ? `${failures} check(s) failed. A policy that does not stop a send is decoration.`
    : 'Both the recipient blacklist and content filtering stop a real submission on the real ' +
        'send path, and removing either lets the same message through.',
);
process.exitCode = failures ? 1 : 0;
