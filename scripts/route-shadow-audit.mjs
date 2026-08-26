#!/usr/bin/env node
/**
 * DOES A PARAMETER ROUTE SWALLOW A LITERAL ONE DECLARED BELOW IT?
 *
 * WHY
 * ---------------------------------------------------------------------------
 * Nest matches routes in declaration order. `@Get(':id')` therefore captures
 * every literal path declared after it in the same controller, and the failure
 * is silent at every layer that could have caught it: the code compiles, the
 * route exists, the request is authorised, and the handler runs — with the
 * literal segment as the parameter.
 *
 * `BackupDrController` had exactly this. `@Get(':id')` sat above
 * `@Get('schedules')`, so `GET /backup-dr/schedules` reached the single-record
 * handler, passed the word "schedules" to a uuid column, and answered 500. The
 * Backup screen showed "An internal error occurred" on every visit for as long
 * as that ordering stood. The method even carried a comment asserting it was
 * declared after the literal paths, which was untrue of its own file — so
 * reading the code confirmed the bug rather than revealing it.
 *
 * WHAT IT CHECKS
 * ---------------------------------------------------------------------------
 * Per controller, per HTTP verb, in declaration order: once a route whose FIRST
 * segment is a parameter has been seen, any later route whose first segment is
 * a literal is unreachable. Same verb only — `@Get(':id')` cannot shadow a
 * `@Post('schedules')`.
 *
 * Multi-segment parameter routes like `:id/verify` are not shadows: they
 * require a literal second segment, so `retention/apply` still matches its own
 * handler. Only a bare `:param` at depth one swallows everything.
 *
 *   node scripts/route-shadow-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/JKANNEL/backend/src';

/** Every *.controller.ts under the backend, recursively. */
function controllers(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...controllers(full));
    else if (/\.controllers?\.ts$/.test(entry.name) && !entry.name.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

const VERB = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/g;

const findings = [];
let routesSeen = 0;
const files = controllers(ROOT);

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  // Controllers are split per @Controller block: two classes in one file have
  // independent route tables and must not be compared against each other.
  const blocks = source.split(/@Controller\(/).slice(1);
  for (const block of blocks) {
    const controllerPath = /^\s*(?:'([^']*)'|"([^"]*)")?/.exec(block);
    const base = controllerPath?.[1] ?? controllerPath?.[2] ?? '';
    /** The first parameter-at-depth-one route seen, per verb. */
    const paramSeen = new Map();
    let match;
    VERB.lastIndex = 0;
    while ((match = VERB.exec(block)) !== null) {
      const verb = match[1];
      const routePath = match[2] ?? match[3] ?? match[4] ?? '';
      routesSeen += 1;
      const first = routePath.split('/')[0];
      const isBareParam = first.startsWith(':') && routePath.split('/').length === 1;
      if (isBareParam) {
        if (!paramSeen.has(verb)) paramSeen.set(verb, routePath);
        continue;
      }
      const isLiteralFirst = first && !first.startsWith(':');
      const shadow = paramSeen.get(verb);
      if (isLiteralFirst && shadow)
        findings.push({
          file: path.relative('d:/JKANNEL', file).replace(/\\/g, '/'),
          controller: base,
          verb,
          shadowed: routePath,
          by: shadow,
        });
    }
  }
}

console.log('='.repeat(92));
console.log(`ROUTE SHADOWING — ${routesSeen} routes across ${files.length} controller file(s)`);
console.log('='.repeat(92));

if (findings.length) {
  console.log('\nUNREACHABLE — a parameter route declared earlier captures these:\n');
  for (const f of findings)
    console.log(
      `  ${f.file}\n      @${f.verb}('${f.shadowed}') is captured by the earlier @${f.verb}('${f.by}')` +
        `${f.controller ? ` in @Controller('${f.controller}')` : ''}`,
    );
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  findings.length
    ? `${findings.length} route(s) can never be reached. Move the parameter route below them.`
    : 'No literal route is shadowed by an earlier parameter route.',
);
process.exitCode = findings.length ? 1 : 0;
