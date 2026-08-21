#!/usr/bin/env node
/**
 * Every in-page link, checked against the router.
 *
 * The menu audit proves the SIDEBAR reaches real screens. It says nothing about
 * the links inside them — the "Open Carriers", "All events", "Open DLR
 * Performance" buttons that cross-reference one screen from another. There are
 * far more of those than menu items, they are written by hand, and a typo in
 * one produces a click that goes nowhere with no error: Vue Router matches
 * nothing, the shell stays put, and the operator concludes the button is dead.
 *
 * So this reads every route the router declares and every internal link target
 * in the views, and reports the ones that match no route.
 *
 * Dynamic targets (`/smsc/${id}`) are resolved against parameterised routes by
 * comparing segment counts and literal prefixes, so a real link is not reported
 * merely because its id is computed.
 *
 * Usage:  node scripts/link-check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'frontend', 'src');
const ROUTER = join(SRC, 'router', 'index.ts');

// --- What the router actually declares ---------------------------------------

const routerSource = readFileSync(ROUTER, 'utf8');

/**
 * Routes come from two shapes in this file: the `[path, title, desc, perm]`
 * tuples the workspace routes are generated from, and explicit `path:` entries.
 * Both are read, because missing either would report live routes as dead.
 */
const declared = new Set([
  ...[...routerSource.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...routerSource.matchAll(/^\s*'(\/[a-z0-9/_-]*)',\s*$/gim)].map((m) => m[1]),
]);

/** `/smsc/:engineId` -> a matcher that accepts `/smsc/<anything>`. */
function matches(target) {
  if (declared.has(target)) return true;
  const parts = target.split('/');
  for (const route of declared) {
    const routeParts = route.split('/');
    if (routeParts.length !== parts.length) continue;
    const ok = routeParts.every(
      (segment, index) => segment.startsWith(':') || segment === parts[index],
    );
    if (ok) return true;
  }
  return false;
}

// --- Every internal link in the views ----------------------------------------

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(vue|ts)$/.test(entry)) files.push(full);
  }
  return files;
}

/** `${expr}` becomes a wildcard segment, so a computed id is not a false alarm. */
function normalise(target) {
  return target
    .replace(/\$\{[^}]*\}/g, ':param')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '');
}

const findings = [];
const checked = new Set();

for (const file of walk(SRC)) {
  if (file.endsWith(join('router', 'index.ts'))) continue;
  const source = readFileSync(file, 'utf8');
  const where = relative(ROOT, file).replace(/\\/g, '/');

  // `to="/x"`, `:to="`/x/${id}`"`, `to: '/x'`, and router.push('/x').
  const patterns = [
    /\bto="(\/[^"]*)"/g,
    /\b:to="`(\/[^`]*)`"/g,
    /\bto:\s*'(\/[^']*)'/g,
    /\bto:\s*`(\/[^`]*)`/g,
    /router\.(?:push|replace)\(\s*'(\/[^']*)'/g,
    /router\.(?:push|replace)\(\s*`(\/[^`]*)`/g,
    /\bpath:\s*'(\/[^']*)'/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1];
      const target = normalise(raw);
      if (!target || target === '/') continue;
      const key = `${where}::${target}`;
      if (checked.has(key)) continue;
      checked.add(key);
      // A `:param` link is checked against the parameterised routes above.
      if (!matches(target.replace(/:param/g, 'x')))
        findings.push({ where, raw, target });
    }
  }
}

console.log('='.repeat(84));
console.log('LINK CHECK — does every in-page link go to a route that exists?');
console.log('='.repeat(84));
console.log(`${declared.size} routes declared · ${checked.size} distinct links checked\n`);

if (!findings.length) {
  console.log('Every internal link resolves to a declared route.');
} else {
  for (const finding of findings)
    console.log(`  ${finding.raw.padEnd(38)} ${finding.where}`);
  console.log(`\n${findings.length} link(s) go nowhere.`);
}
process.exitCode = findings.length ? 1 : 0;
