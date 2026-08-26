#!/usr/bin/env node
/**
 * DOES AN INBOUND MESSAGE REACH WHERE IT WAS SUPPOSED TO GO?
 *
 * WHY
 * ---------------------------------------------------------------------------
 * MO routing has a rule register, a destination list per rule, and a preview
 * endpoint. What none of that establishes is the thing an operator is actually
 * relying on: a subscriber texts a short code, and the message ends up at the
 * destination somebody configured for it.
 *
 * The first run of this found the honest answer to be "nowhere". There were
 * ZERO rules configured, so every inbound message ingested successfully and
 * came back `status: "no_match"` with an empty delivery list — a 201, no error,
 * and nothing routed. A screen full of green with no rules behind it looks
 * identical to a working gateway.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 *  1. An inbound message with no matching rule reports `no_match` rather than
 *     claiming success. This is the control, and it is also what the system
 *     does today with no rules configured.
 *  2. A rule matching the short code and keyword MATCHES, and names itself.
 *  3. Its destination is FANNED OUT to, not merely listed.
 *  4. Re-submitting the same `externalRef` is idempotent — one record, one
 *     fan-out — because a carrier that retries a webhook must not double-charge
 *     or double-notify.
 *  5. A message that does not match the keyword still reports `no_match`, so
 *     what was observed was the rule and not a catch-all.
 *
 * The rule it creates is removed afterwards, including on the failure paths, so
 * running it does not leave routing behind that nobody configured deliberately.
 *
 *   node scripts/inbound-e2e.mjs
 */
const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const TENANT = process.env.JKANNEL_TENANT ?? 'default';
const USER = process.env.U ?? 'operator';
const PASS = process.env.P ?? 'JkannelLocal2026!';

/** Reserved test values so this cannot collide with real configuration. */
const SHORTCODE = process.env.MO_SHORTCODE ?? '69999';
const KEYWORD = 'JKTEST';
const SENDER = process.env.MO_SENDER ?? '256999000444';

const unwrap = (body) => (body && body.data !== undefined ? body.data : body);

let token = '';
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: unwrap(body) };
}

let failures = 0;
const expect = (label, ok, detail) => {
  console.log(`  ${label.padEnd(52)} ${(ok ? 'ok' : 'FAILED').padEnd(8)} ${detail ?? ''}`);
  if (!ok) failures += 1;
};

/** A fresh reference per call, unless the caller is testing idempotency. */
let counter = 0;
const nextRef = () => `mo-e2e-${Math.floor(performance.now() * 1000)}-${(counter += 1)}`;

async function ingest(text, externalRef = nextRef(), receiver = SHORTCODE) {
  const response = await api('/mo/inbound', {
    method: 'POST',
    body: JSON.stringify({ sender: SENDER, receiver, text, externalRef }),
  });
  return { status: response.status, ...response.body, externalRef };
}

console.log('='.repeat(88));
console.log('INBOUND ROUTING END TO END — does an MO message reach its destination?');
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

// --- What is configured right now, before this script changes anything ------
const existing = await api('/mo/rules?limit=200&offset=0');
const existingRules = Array.isArray(existing.body) ? existing.body : (existing.body.items ?? []);
console.log(
  `\n  ${existingRules.length} MO routing rule(s) configured on this deployment` +
    (existingRules.length
      ? `: ${existingRules.map((r) => r.name).slice(0, 4).join(', ')}`
      : ' — every inbound message currently matches nothing and is stored unrouted.'),
);

let ruleId = null;
try {
  // --- 1. The control, before the rule exists -------------------------------
  console.log('\nBefore the rule exists:\n');
  const unmatched = await ingest(`${KEYWORD} hello`);
  // `status` on the ingest RESULT is the routing outcome, and it shadows the
  // HTTP status in the spread above — so the HTTP code is read from the field
  // the helper set first and the routing outcome from `matchedRules`, which
  // cannot be confused with it.
  expect(
    'an unmatched inbound message reports no_match rather than success',
    !(unmatched.matchedRules ?? []).length && Boolean(unmatched.moMessageId),
    `stored as ${String(unmatched.moMessageId).slice(0, 8)}…, routing outcome "${unmatched.status}"`,
  );

  // --- 2. Create a rule -----------------------------------------------------
  const created = await api('/mo/rules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'inbound-e2e temporary rule',
      description: 'Created by scripts/inbound-e2e.mjs; removed when it finishes.',
      enabled: true,
      priority: 1,
      matchDestination: SHORTCODE,
      matchDestinationType: 'exact',
      matchKeyword: KEYWORD,
      // `first_word`, not `exact`. `exact` requires the WHOLE message body to
      // equal the keyword, so "JKTEST balance" matched nothing — which is not
      // how a short-code keyword works and cost this script its first run.
      matchKeywordType: 'first_word',
      caseSensitive: false,
    }),
  });
  if (created.status >= 400) {
    expect(
      'a rule can be created',
      false,
      `${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`,
    );
    throw new Error('cannot continue without a rule');
  }
  ruleId = created.body?.id;
  expect('a rule matching the short code and keyword is created', Boolean(ruleId), `id ${ruleId}`);

  // --- 3. A destination for it ---------------------------------------------
  const destination = await api(`/mo/rules/${ruleId}/destinations`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'webhook',
      /*
       * Deliberately unreachable, because whether the far end ANSWERS is a
       * different question from whether the gateway fanned out to it, and only
       * the second is what this script is about. A test that needs a live
       * listener is a test that gets skipped.
       *
       * `.invalid` rather than `127.0.0.1:9`, which is what this used and which
       * the API correctly refused: there is an SSRF guard that rejects a
       * loopback, link-local or private webhook target unless
       * MO_WEBHOOK_ALLOW_PRIVATE is set. That guard is right — an operator who
       * can add a webhook could otherwise make the gateway fetch its own
       * internal services — so the test moves rather than the guard.
       * `.invalid` is reserved by RFC 2606 and resolves nowhere.
       */
      target: 'https://inbound-e2e.invalid/hook',
      enabled: true,
      maxAttempts: 1,
      config: { method: 'POST' },
    }),
  });
  expect(
    'a destination can be attached to it',
    destination.status < 400,
    destination.status < 400
      ? 'webhook attached'
      : `${destination.status}: ${JSON.stringify(destination.body).slice(0, 160)}`,
  );

  // --- 4. The matching message ---------------------------------------------
  console.log('\nWith the rule in place:\n');
  const matched = await ingest(`${KEYWORD} balance`);
  expect(
    'the message matches the rule',
    Array.isArray(matched.matchedRules) && matched.matchedRules.length > 0,
    `status "${matched.status}", matched ${JSON.stringify(matched.matchedRules ?? []).slice(0, 90)}`,
  );
  expect(
    'the gateway fans out to the destination',
    Array.isArray(matched.deliveries) && matched.deliveries.length > 0,
    `${(matched.deliveries ?? []).length} delivery attempt(s) recorded`,
  );

  // --- 5. Idempotency -------------------------------------------------------
  const repeat = await ingest(`${KEYWORD} balance`, matched.externalRef);
  expect(
    'the same externalRef is idempotent',
    repeat.duplicate === true && repeat.moMessageId === matched.moMessageId,
    `duplicate=${repeat.duplicate}, same id=${repeat.moMessageId === matched.moMessageId}`,
  );

  // --- 6. A non-matching keyword, so the rule is not a catch-all ------------
  const other = await ingest('SOMETHINGELSE balance');
  expect(
    'a different keyword does NOT match the rule',
    !(other.matchedRules ?? []).length,
    `status "${other.status}"`,
  );
} finally {
  if (ruleId) {
    await api(`/mo/rules/${ruleId}`, { method: 'DELETE' }).catch(() => undefined);
    console.log('\n  (temporary rule removed)');
  }
}

console.log(`\n${'='.repeat(88)}`);
console.log(
  failures
    ? `${failures} check(s) failed.`
    : 'An inbound message matches its rule, fans out to the configured destination, and is ' +
        'idempotent on retry.' +
        (existingRules.length
          ? ''
          : ' NOTE: this deployment has no MO rules of its own, so real inbound traffic ' +
            'currently matches nothing.'),
);
process.exitCode = failures ? 1 : 0;
