#!/usr/bin/env node
/**
 * Migration sanity check for database/migrations/.
 *
 * Migration numbers in this repo are hand-assigned and several agents add
 * migrations in parallel, so the two mistakes that actually happen are:
 *
 *   1. an `NNN_name.up.sql` landing without its matching `NNN_name.down.sql`
 *      (or vice versa), which breaks rollback; and
 *   2. two branches both claiming the same number, or a number being skipped,
 *      which makes the applied-migration ledger ambiguous.
 *
 * This script catches both. It reads files only — it never touches a database.
 *
 * Severity split:
 *   ERROR   missing/duplicated up|down pair, duplicate number, malformed name.
 *           These break `migration-runner.ts`, so they always fail the check.
 *   WARNING a gap in the numbering. The runner sorts lexicographically and does
 *           not require contiguity, so a gap is a review smell rather than a
 *           breakage. Pass --strict to promote warnings to errors.
 *
 * Usage: node .github/scripts/check-migrations.mjs [migrationsDir] [--strict]
 * Exit code 0 = clean, 1 = problems found (each printed on its own line).
 */

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const dirArg = args.find((a) => !a.startsWith('--'));
const dir = dirArg ? resolve(dirArg) : join(repoRoot, 'database', 'migrations');

/** `001_foundation.up.sql` -> { number: '001', name: 'foundation', direction: 'up' } */
const FILENAME = /^(\d+)_([A-Za-z0-9][A-Za-z0-9_-]*)\.(up|down)\.sql$/;

const problems = [];
const warnings = [];

let entries;
try {
  entries = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
} catch (error) {
  console.error(`Cannot read migrations directory ${dir}: ${error.message}`);
  process.exit(1);
}

const sqlFiles = entries.filter((f) => f.endsWith('.sql'));
if (sqlFiles.length === 0) {
  console.error(`No .sql files found in ${dir} — is the path correct?`);
  process.exit(1);
}

/** parsed number -> { digits, names: Set<string>, up: string[], down: string[] } */
const byNumber = new Map();

for (const file of sqlFiles) {
  const match = FILENAME.exec(file);
  if (!match) {
    problems.push(
      `Malformed migration filename: ${file} (expected NNN_name.up.sql / NNN_name.down.sql)`,
    );
    continue;
  }
  const [, digits, name, direction] = match;
  const number = Number.parseInt(digits, 10);

  let record = byNumber.get(number);
  if (!record) {
    record = { digits, names: new Set(), up: [], down: [] };
    byNumber.set(number, record);
  }
  if (record.digits !== digits) {
    problems.push(
      `Inconsistent zero-padding for migration ${number}: "${record.digits}" vs "${digits}" (${file})`,
    );
  }
  record.names.add(name);
  record[direction].push(file);
}

for (const [, record] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
  // 1. Every number must be claimed by exactly one migration name.
  if (record.names.size > 1) {
    problems.push(
      `Duplicate migration number ${record.digits}: claimed by ${[...record.names]
        .sort()
        .map((n) => `"${n}"`)
        .join(' and ')} — renumber one of them`,
    );
  }
  // 2. Up/down must pair up, exactly one of each.
  if (record.up.length === 0) {
    problems.push(`Migration ${record.digits} (${[...record.names][0]}) has no .up.sql`);
  }
  if (record.down.length === 0) {
    problems.push(
      `Migration ${record.digits} (${[...record.names][0]}) has no matching .down.sql — rollback would be impossible`,
    );
  }
  if (record.up.length > 1) {
    problems.push(`Migration ${record.digits} has multiple .up.sql files: ${record.up.join(', ')}`);
  }
  if (record.down.length > 1) {
    problems.push(
      `Migration ${record.digits} has multiple .down.sql files: ${record.down.join(', ')}`,
    );
  }
}

// 3. Numbers should start at 1 and be contiguous — a gap means a migration was
//    deleted or a branch grabbed a number out of sequence. Warning by default
//    (the runner sorts lexicographically and tolerates gaps); --strict escalates.
const numbers = [...byNumber.keys()].sort((a, b) => a - b);
if (numbers.length > 0) {
  if (numbers[0] !== 1) {
    warnings.push(`Migration numbering should start at 001, but the lowest is ${numbers[0]}`);
  }
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] - numbers[i - 1] > 1) {
      const missing = [];
      for (let n = numbers[i - 1] + 1; n < numbers[i]; n += 1) {
        missing.push(String(n).padStart(3, '0'));
      }
      warnings.push(
        `Gap in migration numbering between ${String(numbers[i - 1]).padStart(3, '0')} and ${String(
          numbers[i],
        ).padStart(3, '0')}: missing ${missing.join(', ')}`,
      );
    }
  }
}

for (const warning of warnings) {
  // GitHub Actions renders `::warning::` as an annotation on the run.
  console.log(`::warning::migrations: ${warning}`);
  console.warn(`  ! ${warning}`);
}

const fatal = strict ? [...problems, ...warnings] : problems;
if (fatal.length > 0) {
  console.error(`Migration check FAILED (${fatal.length} problem(s)) in ${dir}:`);
  for (const problem of fatal) console.error(`  - ${problem}`);
  process.exit(1);
}

const highest = numbers.length ? String(numbers[numbers.length - 1]).padStart(3, '0') : 'none';
console.log(
  `Migration check OK: ${numbers.length} migrations (001..${highest}), each with a matching up/down pair and no duplicate numbers.` +
    (warnings.length ? ` ${warnings.length} numbering warning(s) — see above.` : ''),
);
