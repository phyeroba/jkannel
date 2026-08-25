#!/usr/bin/env node
/**
 * IS FEATURES.md STILL TRUE?
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `FEATURES.md` is the document somebody reads to decide what this platform can
 * do, and its "Not yet implemented" section is the half that is supposed to be
 * honest. It was hand-verified once, against a commit three weeks old, and by
 * the time anybody asked "how far are we" four of its claims were wrong — roles
 * management, alert transitions, the log explorer and the encoding columns had
 * all been built and the document still said they had not.
 *
 * Wrong in the UNDERSTATING direction, which is the rarer and more expensive
 * way for a capability document to rot: work gets re-planned, and the people
 * deciding what to build next are reading a map of a place that no longer
 * exists.
 *
 * Prose cannot be kept true by intention. So each claim that CAN be mechanically
 * checked carries a probe, and this reports the ones that no longer hold.
 *
 * WHAT A PROBE CAN AND CANNOT SETTLE
 * ---------------------------------------------------------------------------
 * A probe answers "does the code for this exist and is it reachable" — a symbol
 * in a non-test file, a route in the live OpenAPI document, a view in the
 * router. That is exactly the standard FEATURES.md sets for itself: *code that
 * exists but nothing invokes is not listed as a feature*.
 *
 * It cannot settle "is this GOOD", and it cannot settle the external-evidence
 * claims — a penetration test or a carrier bind is not a symbol. Those are
 * listed as `external` and are never reported as stale, because no amount of
 * code makes them true.
 *
 *   node scripts/features-verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'd:/JKANNEL';
const API = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';

/**
 * Every claim in the "Not yet implemented" section, with how to check it.
 *
 *   kind 'absent'   — the claim is that X does NOT exist. It is STALE if the
 *                     probe finds X, which is the failure this tool exists for.
 *   kind 'closed'   — X WAS a gap and has since been built. Checked in the
 *                     OPPOSITE direction: if the probe stops finding it the
 *                     feature regressed and the gap list is wrong again, the
 *                     other way round. Keeping these rather than deleting them
 *                     is what stops the same five entries drifting back.
 *   kind 'external' — needs infrastructure or a third party. Never stale.
 *
 * `find` is a list of [glob-ish path, regex] pairs; a hit in ANY non-test file
 * counts. `route` is a path that must appear in the live OpenAPI document.
 */
const CLAIMS = [
  // --- Administration -------------------------------------------------------
  {
    id: 'roles-readonly',
    text: 'No role or permission management — the Roles screen is read-only',
    kind: 'closed',
    find: [['backend/src/console/console.controllers.ts', /@Post\('roles'\)/]],
    route: '/roles',
  },
  {
    // Probed by ROUTE, not by symbol. The first version matched /resolve|suppress/
    // anywhere under monitoring-depth and hit the word "unresolved" in a comment
    // about alert correlation — a true verdict reached by a false route, which
    // is worse than a wrong one because it survives review.
    id: 'alert-transitions',
    text: 'Alert resolve / assign / suppress / close',
    kind: 'closed',
    route: '/alerts/{id}/resolve',
  },
  {
    id: 'password-policy',
    text: 'Password policy, session limits and idle timeout are configurable but not enforced',
    kind: 'absent',
    find: [['backend/src/security', /passwordPolicy|enforcePasswordPolicy|idleTimeout/]],
  },
  // --- Observability --------------------------------------------------------
  {
    id: 'log-explorer',
    text: 'No log explorer, live tail, or correlation-ID search',
    kind: 'closed',
    find: [['frontend/src/views/LogExplorerView.vue', /correlation/i]],
  },
  {
    id: 'realtime-push',
    text: 'No real-time push — a few screens poll, the rest need a manual refresh',
    kind: 'absent',
    find: [['frontend/src', /EventSource|new WebSocket/]],
  },
  {
    id: 'container-metrics',
    text: 'No per-container resource metrics',
    kind: 'absent',
    find: [['backend/src', /dockerode|\/containers\/json|cpu_stats/]],
  },
  // --- Messaging & data -----------------------------------------------------
  {
    id: 'segment-columns',
    text: 'No encoding/segment/UDH columns',
    kind: 'closed',
    find: [['frontend/src/views/ModuleWorkspace.vue', /codingLabel|udhData/]],
  },
  {
    id: 'export-status-filter',
    text: 'Export ignores an active status filter',
    kind: 'absent',
    find: [['backend/src/platform/export.service.ts', /filter\.status|describeFilters/]],
  },
  {
    id: 'replay-dlr',
    text: 'No "replay DLR"',
    kind: 'absent',
    find: [['backend/src', /replayDlr|replay-dlr/]],
  },
  {
    id: 'billing',
    text: 'No billing, rating or multi-part segment accounting',
    kind: 'absent',
    find: [['backend/src', /class .*RatingService|billingRate|chargeFor/]],
  },
  // --- Platform & security --------------------------------------------------
  {
    id: 'https-listener',
    text: 'No HTTPS listener in the shipped gateway config',
    kind: 'absent',
    find: [['infrastructure/kannel', /ssl-server-cert-file|ssl-client-certkey-file/]],
  },
  {
    id: 'webhook-hmac',
    text: 'Webhook signing is a static secret, not HMAC',
    kind: 'absent',
    find: [['backend/src', /createHmac\([^)]*\)[\s\S]{0,200}webhook|webhook[\s\S]{0,200}createHmac/i]],
  },
  {
    id: 'oauth-webauthn',
    text: 'No OAuth2/OIDC, no WebAuthn',
    kind: 'absent',
    find: [['backend/src', /openid|oauth2|webauthn/i]],
  },
  {
    id: 'plugin-runtime',
    text: 'Plugins can be registered and validated but not executed',
    kind: 'absent',
    find: [['backend/src/plugins/plugin.runtime.ts', /child_process|spawn|execute/]],
  },
  {
    // SPLIT, because the original bundled two unrelated things and only one of
    // them was still true. A compound claim can only ever be half-verified, and
    // this one had shipped an S3 destination while still reading as though
    // backups could not leave the host at all.
    // Probed by IDENTIFIER, not by the words a PITR feature would use.
    // `archive_command` appears in this module as a string literal in the
    // message that explains PITR is unavailable — not a comment, so stripping
    // comments does not help. A codebase states the names of the things it
    // lacks, so a probe has to look for something only an implementation could
    // contain: a restore that takes a target time.
    id: 'pitr',
    text: 'No point-in-time recovery (no WAL archiving)',
    kind: 'absent',
    find: [['backend/src/backup-dr', /recoveryTargetTime|restoreToPointInTime|pitrRestore/]],
  },
  {
    id: 'offsite-backup',
    text: 'No object-storage backup target',
    kind: 'closed',
    find: [['backend/src/backup-dr/s3.destination.ts', /class S3Destination/]],
  },
  // --- External evidence ----------------------------------------------------
  { id: 'carrier-bind', text: 'A generated configuration has never bound to a live carrier', kind: 'external' },
  { id: 'pentest', text: 'No independent penetration test', kind: 'external' },
  { id: 'soak', text: 'No production-scale soak at the specification throughput targets', kind: 'external' },
  { id: 'ha-drill', text: 'No multi-node HA failover drill with measured RPO/RTO', kind: 'external' },
];

/** Non-test source files under a path, or the single file if it is one. */
function sourceFiles(target) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
        walk(child);
      } else if (/\.(ts|vue|conf|css)$/.test(entry.name) && !/\.spec\.|\.test\./.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk(full);
  return out;
}

/**
 * Source with comments removed.
 *
 * A claim must not be judged by prose ABOUT the claim. The PITR probe matched
 * `archive_command` inside a comment in `backup-dr.service.ts` whose entire
 * point is that point-in-time recovery is unavailable *because* WAL archiving
 * is not configured — so the tool read an explanation of the gap as evidence
 * the gap was closed. Every honest codebase describes what it does not do, and
 * a matcher that reads comments will find every one of those descriptions and
 * call each of them a feature.
 *
 * Crude on purpose: it only has to be good enough that a comment cannot supply
 * evidence. A string literal containing `//` costs a false NEGATIVE — the claim
 * stays listed as still-true — which is the safe direction for a document whose
 * job is to be honest about gaps.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^\s*[#*][^\n]*/gm, ' ');
}

function probeFind(pairs) {
  for (const [target, pattern] of pairs)
    for (const file of sourceFiles(target)) {
      if (pattern.test(withoutComments(fs.readFileSync(file, 'utf8'))))
        return path.relative(ROOT, file).replace(/\\/g, '/');
    }
  return null;
}

/** The live OpenAPI paths, so a route claim is checked against what is served. */
let openapi = new Set();
try {
  const raw = execFileSync('curl', ['-s', `${API}/openapi.json`], { maxBuffer: 32 * 1024 * 1024 });
  openapi = new Set(Object.keys(JSON.parse(raw.toString()).paths ?? {}));
} catch {
  console.log('  (OpenAPI unreachable — route probes skipped, symbol probes still run)\n');
}

const stale = [];
const holds = [];
const external = [];
const closed = [];
const regressed = [];

for (const claim of CLAIMS) {
  if (claim.kind === 'external') {
    external.push(claim);
    continue;
  }
  const bySymbol = claim.find ? probeFind(claim.find) : null;
  const byRoute = claim.route && openapi.size ? (openapi.has(claim.route) ? claim.route : null) : null;
  const evidence = bySymbol ?? byRoute;
  // A closed claim is checked the other way round: the evidence must still be
  // there. Losing it means a feature went away and the gap list is wrong again.
  if (claim.kind === 'closed') {
    (evidence ? closed : regressed).push({ ...claim, evidence });
    continue;
  }
  if (evidence) stale.push({ ...claim, evidence });
  else holds.push(claim);
}

console.log('='.repeat(92));
console.log('FEATURES.md — is the "Not yet implemented" section still true?');
console.log('='.repeat(92));

if (stale.length) {
  console.log(`\nSTALE — claimed missing, but the code is there:\n`);
  for (const claim of stale) console.log(`  ${claim.text}\n      evidence: ${claim.evidence}\n`);
}
console.log(`STILL TRUE — ${holds.length} claim(s) hold:\n`);
for (const claim of holds) console.log(`  ${claim.text}`);

console.log(`\nCLOSED — ${closed.length} former gap(s), evidence still present:\n`);
for (const claim of closed) console.log(`  ${claim.text}\n      ${claim.evidence}`);

if (regressed.length) {
  console.log(`\nREGRESSED — built once, and the evidence is gone:\n`);
  for (const claim of regressed) console.log(`  ${claim.text}`);
}

console.log(`\nEXTERNAL — ${external.length} need infrastructure or a third party, not code:\n`);
for (const claim of external) console.log(`  ${claim.text}`);

console.log(`\n${'='.repeat(92)}`);
console.log(
  stale.length || regressed.length
    ? `${stale.length} claim(s) out of date · ${regressed.length} regressed — FEATURES.md needs a pass.`
    : `FEATURES.md holds: ${holds.length} gap(s) real, ${closed.length} former gap(s) still built, ` +
      `${external.length} awaiting evidence rather than code.`,
);
fs.writeFileSync(
  path.join(ROOT, 'docs/features-verify.json'),
  JSON.stringify({ stale, holds, closed, regressed, external }, null, 2),
);
process.exitCode = stale.length || regressed.length ? 1 : 0;
