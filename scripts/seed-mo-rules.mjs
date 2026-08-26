#!/usr/bin/env node
/**
 * SEED THE INBOUND RULES A GATEWAY SHOULD NEVER BE WITHOUT.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * `inbound-e2e.mjs` proved MO routing works and, in the same run, reported that
 * this deployment had ZERO rules — so every inbound message matched nothing and
 * was stored unrouted. Production had never received one at all, which means
 * the first real subscriber reply would have been the first test.
 *
 * WHAT IS SEEDED, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------------
 * Only rules that are correct for ANY SMS gateway, because what a short code
 * does is a business decision and this script does not know the business:
 *
 *   STOP / UNSUBSCRIBE / END / CANCEL — opt-out. A subscriber who texts STOP
 *     has withdrawn consent, and a gateway that cannot see that has a
 *     regulatory problem, not a routing one. One rule per keyword, because MO
 *     keyword matching takes a single word (`first_word`) and has no
 *     alternation — the `*|#|$` grammar exists for MT routing, not here.
 *   HELP / INFO — the other keyword every aggregator is expected to answer.
 *   A CATCH-ALL at the lowest priority, so nothing is silently unrouted. An
 *     unmatched message is stored either way; the difference is whether it is
 *     ATTRIBUTED, and "matched the catch-all" is a fact you can filter on
 *     where "no_match" is an absence you have to go looking for.
 *
 * NO DESTINATIONS ARE ATTACHED. A destination decides where subscriber traffic
 * is forwarded, which is not something to guess at on a live gateway — and a
 * webhook pointed at nothing would just accumulate failed attempts. The rules
 * match and record now; attach destinations when the endpoint is known.
 *
 * `continueAfterMatch` is TRUE on the specific rules and false on the
 * catch-all, so an opt-out is seen by both its own rule and the catch-all,
 * and the catch-all does not swallow anything after itself.
 *
 * IDEMPOTENT. Re-running adds nothing: rules are matched by name, and an
 * existing one is left exactly as it is rather than overwritten, because by
 * then somebody may have attached a destination to it.
 *
 *   node scripts/seed-mo-rules.mjs            # against JKANNEL_API
 *   JKANNEL_API=... U=... P=... node scripts/seed-mo-rules.mjs
 */
const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const TENANT = process.env.JKANNEL_TENANT ?? 'default';
const USER = process.env.U ?? 'operator';
const PASS = process.env.P ?? 'JkannelLocal2026!';

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

/**
 * Priority orders evaluation. The opt-outs come first because an opt-out must
 * never be shadowed by anything, HELP next, and the catch-all last by a wide
 * margin so there is room to insert real business rules between them without
 * renumbering.
 */
const RULES = [
  ...['STOP', 'UNSUBSCRIBE', 'END', 'CANCEL'].map((keyword, index) => ({
    name: `Opt-out — ${keyword}`,
    description:
      `A subscriber texting ${keyword} has withdrawn consent. Matched on any short code, ` +
      'because an opt-out addressed to the wrong number is still an opt-out.',
    priority: 10 + index,
    matchDestinationType: 'any',
    matchKeyword: keyword,
    matchKeywordType: 'first_word',
    caseSensitive: false,
    continueAfterMatch: true,
    enabled: true,
  })),
  ...['HELP', 'INFO'].map((keyword, index) => ({
    name: `Assistance — ${keyword}`,
    description: `The keyword an aggregator is expected to answer. Matched on any short code.`,
    priority: 20 + index,
    matchDestinationType: 'any',
    matchKeyword: keyword,
    matchKeywordType: 'first_word',
    caseSensitive: false,
    continueAfterMatch: true,
    enabled: true,
  })),
  {
    name: 'Catch-all — record every inbound message',
    description:
      'Lowest priority, matches everything. Without it an unrecognised message reports ' +
      '"no_match", which is an absence you have to go looking for rather than a fact you can ' +
      'filter on. Attach a destination here only if EVERY inbound message should be forwarded.',
    priority: 1000,
    matchDestinationType: 'any',
    matchKeywordType: 'any',
    caseSensitive: false,
    continueAfterMatch: false,
    enabled: true,
  },
];

console.log('='.repeat(88));
console.log(`SEED MO ROUTING RULES — ${API}`);
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

const existing = await api('/mo/rules?limit=500&offset=0');
const rows = Array.isArray(existing.body) ? existing.body : (existing.body.items ?? []);
const byName = new Set(rows.map((r) => r.name));
console.log(`\n  ${rows.length} rule(s) already configured.\n`);

let created = 0;
let skipped = 0;
let failed = 0;

for (const rule of RULES) {
  if (byName.has(rule.name)) {
    console.log(`  skip    ${rule.name}  (already present, left untouched)`);
    skipped += 1;
    continue;
  }
  const result = await api('/mo/rules', { method: 'POST', body: JSON.stringify(rule) });
  if (result.status >= 400) {
    console.log(
      `  FAILED  ${rule.name}  ${result.status} ${JSON.stringify(result.body).slice(0, 140)}`,
    );
    failed += 1;
    continue;
  }
  console.log(`  created ${rule.name}`);
  created += 1;
}

console.log(`\n${'='.repeat(88)}`);
console.log(`${created} created, ${skipped} already present, ${failed} failed.`);
if (created || skipped)
  console.log(
    'No destinations are attached. These rules make inbound traffic visible and attributed;\n' +
      'forwarding it anywhere is a separate, deliberate decision.',
  );
process.exitCode = failed ? 1 : 0;
