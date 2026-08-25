#!/usr/bin/env node
/**
 * IS ANYTHING THAT MUST NOT BE PUBLISHED ABOUT TO BE?
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Twice in one session, carrier bind details nearly reached a public
 * repository, by two different routes and neither of them a mistake anybody
 * would call careless:
 *
 *  1. A SCREENSHOT. The first README capture photographed the SMSC register of
 *     a stack that has the real carrier configured, showing the hostname, its
 *     port and the egress IP in plain text.
 *  2. A DEPLOYED ARTEFACT. `runtime/kamex/kamex.conf` is the file the deployment
 *     service writes the GENERATED configuration to, and it was also tracked in
 *     git with a safe hand-written seed. The first local deploy replaced tracked
 *     content with carrier details, and the next `git add -A` committed them.
 *
 * Both were caught by looking. Looking does not scale, and the second one is a
 * booby trap: the file is supposed to change, so nothing about the diff looks
 * wrong. So this runs over what git is ACTUALLY TRACKING and fails if a
 * forbidden value appears in it.
 *
 * WHERE THE LIST LIVES, AND WHY NOT HERE
 * ---------------------------------------------------------------------------
 * In the gitignored `.env`, as `SECRET_SCAN_TERMS`. A scanner that hardcodes
 * the hostname it is protecting publishes the hostname it is protecting — which
 * is the third version of the same mistake, and one this file made in its first
 * draft.
 *
 *   SECRET_SCAN_TERMS=host.example,username node scripts/secret-scan.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/JKANNEL';

/** `.env` is gitignored, so reading it here does not spread anything. */
function terms() {
  const fromEnv = process.env.SECRET_SCAN_TERMS;
  if (fromEnv) return fromEnv.split(',').map((t) => t.trim()).filter(Boolean);
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    // Reuse the screenshot redaction list when a dedicated one is not set: the
    // two answer the same question — "what must never be published".
    const line =
      /^SECRET_SCAN_TERMS=(.*)$/m.exec(env)?.[1] ??
      /^SHOT_REDACTIONS=(.*)$/m.exec(env)?.[1] ??
      '';
    return line
      .split(',')
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const FORBIDDEN = terms();
if (!FORBIDDEN.length) {
  console.log('No terms configured (SECRET_SCAN_TERMS or SHOT_REDACTIONS in .env). Nothing to check.');
  process.exit(0);
}

/**
 * Files git is TRACKING, not files on disk. An untracked or ignored file may
 * hold whatever it needs to — `.env` holds the values themselves — and scanning
 * the working tree would report those and train everyone to ignore the tool.
 */
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split('\n')
  .filter(Boolean);

/**
 * Files allowed to name a forbidden term, with the reason.
 *
 * `docs/HANDOVER.md` states the rule "never commit these" and quotes the values
 * to say what it means. That is itself a disclosure and it predates this tool —
 * flagged in the report rather than silently exempted, because the right fix is
 * to rewrite the line, which is a decision about published history and not
 * one a script should make.
 */
const ALLOWED = new Map([['docs/HANDOVER.md', 'states the rule and quotes the values — see the note below']]);

const findings = [];
for (const file of tracked) {
  const full = path.join(ROOT, file);
  let content;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
    content = fs.readFileSync(full);
  } catch {
    continue;
  }
  // Binaries are scanned too: the leak that started this was a PNG.
  const text = content.toString('binary');
  for (const term of FORBIDDEN)
    if (text.includes(term)) findings.push({ file, term, allowed: ALLOWED.get(file) });
}

console.log('='.repeat(92));
console.log(`SECRET SCAN — ${FORBIDDEN.length} term(s) across ${tracked.length} tracked files`);
console.log('='.repeat(92));

const blocking = findings.filter((f) => !f.allowed);
const known = findings.filter((f) => f.allowed);

if (known.length) {
  console.log('\nKNOWN, and still a disclosure:\n');
  for (const f of known) console.log(`  ${f.file}\n      ${f.allowed}`);
}
if (blocking.length) {
  console.log('\nMUST NOT BE COMMITTED:\n');
  for (const f of blocking) console.log(`  ${f.file}  contains a forbidden term`);
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  blocking.length
    ? `${blocking.length} tracked file(s) carry a value that must not be published.`
    : 'No tracked file carries a forbidden value.' +
        (known.length ? ` (${known.length} known disclosure(s) listed above.)` : ''),
);
process.exitCode = blocking.length ? 1 : 0;
