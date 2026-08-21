#!/usr/bin/env node
/**
 * Which API endpoints have a console surface, and which do not.
 *
 * The question this answers is Peter's: *"ensure that all the api endpoints
 * that we have link to a gui and are fully functional."* Reading the router and
 * guessing does not answer it — there are 279 documented paths and 45 screens,
 * and the mismatch is not something a person can hold in their head.
 *
 * HOW IT DECIDES
 * ---------------------------------------------------------------------------
 * The truth on the API side is the OpenAPI document the backend serves, not a
 * scan of the controllers: a decorator can exist on a controller that is never
 * registered in a module, and that endpoint does not exist as far as any caller
 * is concerned.
 *
 * The truth on the console side is every path literal in `frontend/src`,
 * normalised so that a template hole and a documented parameter compare equal:
 *
 *     `/smscs/${id}/impact/${op}`   ->  /smscs/{}/impact/{}
 *     /smscs/{id}/impact/{operation} ->  /smscs/{}/impact/{}
 *
 * Paths assembled at runtime from a variable segment (the generic grid
 * workspace does this) are expanded from RESOURCE_ALIASES below, because a
 * literal scan cannot see them and reporting them as uncovered would bury the
 * genuine gaps under false ones.
 *
 * WHAT A GAP MEANS
 * ---------------------------------------------------------------------------
 * Not every endpoint needs a screen, and the script does not pretend otherwise.
 * `EXPECTED_HEADLESS` carries the ones that are deliberately machine-facing,
 * each with the reason. Everything else in the report is a real question:
 * either the console is missing a control, or the endpoint is dead code.
 *
 * Usage:  node scripts/endpoint-coverage.mjs [--json]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FRONTEND_SRC = join(ROOT, 'frontend', 'src');
const API_BASE = process.env.JKANNEL_API ?? 'http://127.0.0.1:13200/api/v1';
const CREDENTIALS = {
  tenant: process.env.JKANNEL_TENANT ?? 'default',
  username: process.env.JKANNEL_USER ?? 'operator',
  password: process.env.JKANNEL_PASSWORD ?? 'JkannelLocal2026!',
};

/**
 * Resources the generic grid workspace serves from one component. It builds
 * `/${resource}` at runtime, so a literal scan sees nothing at all.
 */
const RESOURCE_ALIASES = [
  'smscs',
  'routes',
  'users',
  'roles',
  'alerts',
  'configurations',
  'customers',
  'api-keys',
  'audit',
  'system/settings',
  'plugins',
  'notifications',
];

/**
 * Endpoints that are correctly invisible, and why. A machine-facing endpoint is
 * not a gap; an unexplained one is. Anything added here needs its reason.
 */
/**
 * Endpoints a NEWER route has replaced, and which the console correctly does
 * not call.
 *
 * These are not gaps and they are not headless either — they are live,
 * registered, reachable duplicates. `/backups/:id/restore` and
 * `/backup-dr/:id/restore` both exist and do NOT do the same thing: the newer
 * one restores into an isolated verify database, the legacy one calls the
 * platform-console repository directly. A caller who finds the wrong one in the
 * API document gets different behaviour than the console's own button.
 *
 * Reported separately rather than hidden, because "the console does not use
 * this" is a reason to consider removing the route, not a reason to stop
 * mentioning it.
 */
const SUPERSEDED = [
  [/^\/backups(\/|$)/, 'superseded by /backup-dr, which is what the console calls'],
];

const EXPECTED_HEADLESS = [
  [/^\/auth\//, 'authentication plumbing — the login screen and the token refresh use it'],
  [/^\/health/, 'liveness and readiness probes, for Docker and the load balancer'],
  [/^\/metrics/, 'Prometheus scrape target'],
  [/^\/openapi/, 'the API document itself, which the API Reference screen renders'],
  [/^\/gateway\//, 'the public send API — customers call it, the console documents it'],
  [/^\/mo\/inbound/, 'engine push ingest, called by Kannel and not by a person'],
  [/^\/webhooks?\//, 'inbound callbacks from external systems'],
];

// --- OpenAPI ---------------------------------------------------------------

async function login() {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREDENTIALS),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const token = payload?.data?.accessToken ?? payload?.data?.token;
  if (!token) throw new Error('login returned no access token');
  return token;
}

async function openApiPaths(token) {
  const response = await fetch(`${API_BASE}/openapi.json`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`openapi fetch failed: ${response.status}`);
  const document = await response.json();
  const operations = [];
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      operations.push({
        path,
        method: method.toUpperCase(),
        summary: operation?.summary ?? '',
        tags: operation?.tags ?? [],
      });
    }
  }
  return operations;
}

// --- The console side ------------------------------------------------------

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|vue|js)$/.test(entry)) files.push(full);
  }
  return files;
}

/**
 * Replaces every `${...}` with `{}` BEFORE the path literals are scanned.
 *
 * Without this the scan truncates a template at the first quote inside a hole,
 * and holes routinely contain quotes:
 *
 *     `/diagnostics/messages/${encodeURIComponent(id)}/lifecycle${r ? '?reveal=true' : ''}`
 *
 * The string extractor stops at the `'` in `'?reveal=true'`, yields a fragment
 * that matches no documented path, and Message Trace's own endpoint gets
 * reported as having no console surface. Collapsing holes first turns the
 * template into a plain path the scanner can read whole.
 *
 * Run repeatedly for one level of nesting (`${a ? `${b}` : c}`), which does
 * occur; deeper nesting does not, and would only cost a false gap.
 */
function collapseHoles(source) {
  let text = source;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(/\$\{[^{}]*\}/g, '{}');
    if (next === text) break;
    text = next;
  }
  return text;
}

/** `/smscs/${id}/impact` and `/smscs/{id}/impact` both become `/smscs/{}/impact`. */
function normalise(path) {
  return (
    path
      .split('?')[0]
      .split('#')[0]
      // A template hole or a documented parameter — the same thing to a reader.
      .replace(/\$\{[^}]*\}/g, '{}')
      .replace(/\{[^}]*\}/g, '{}')
      // A hole GLUED to a literal is a composed suffix, not a path segment:
      // `/…/lifecycle${reveal ? '?reveal=true' : ''}` collapses to
      // `/…/lifecycle{}`, which would never match the documented
      // `/…/lifecycle`. A hole that IS the whole segment is preceded by `/`
      // and is left alone, because that one really is a parameter.
      .replace(/([A-Za-z0-9_\-.])\{\}/g, '$1')
      // The console picks the export format and appends it — `apiDownloadFile`
      // is given `/messages/export` and builds `.csv` or `.pdf` from the
      // operator's choice. Comparing with the extension attached reports every
      // export endpoint as unsurfaced while the button sits right there.
      .replace(/\.(csv|pdf|json|xlsx)$/i, '')
      .replace(/\/+$/, '') || '/'
  );
}

/**
 * Every path literal in the console, with the file that holds it.
 *
 * Deliberately greedy: it matches any quoted string starting with a slash, not
 * only the arguments of `apiRequest`. A path assembled into a variable first,
 * or passed to a helper this script has never heard of, still counts as a
 * surface — and a false positive here only ever hides a gap that a human would
 * then have to find, which is the failure mode worth avoiding.
 */
function consolePaths() {
  const found = new Map();
  for (const file of walk(FRONTEND_SRC)) {
    const source = collapseHoles(readFileSync(file, 'utf8'));
    const where = relative(ROOT, file).replace(/\\/g, '/');
    for (const match of source.matchAll(/['"`](\/[A-Za-z0-9_\-{}$][^'"`\n]*)['"`]/g)) {
      const path = normalise(match[1]);
      if (path === '/' || path.startsWith('//')) continue;
      if (!found.has(path)) found.set(path, new Set());
      found.get(path).add(where);
    }
  }
  for (const resource of RESOURCE_ALIASES) {
    const path = `/${resource}`;
    if (!found.has(path)) found.set(path, new Set());
    found.get(path).add('frontend/src/views/ModuleWorkspace.vue (generic grid)');
    const withId = `/${resource}/{}`;
    if (!found.has(withId)) found.set(withId, new Set());
    found.get(withId).add('frontend/src/views/ModuleWorkspace.vue (generic grid)');
  }
  return found;
}

function headlessReason(path) {
  for (const [pattern, reason] of EXPECTED_HEADLESS) if (pattern.test(path)) return reason;
  return null;
}

function supersededReason(path) {
  for (const [pattern, reason] of SUPERSEDED) if (pattern.test(path)) return reason;
  return null;
}

/**
 * Segment-wise match, where `{}` on EITHER side matches anything.
 *
 * Exact string equality is wrong in both directions and the alert lifecycle
 * screen shows why: it posts to `/alerts/${id}/${transition}`, one call that
 * serves acknowledge, resolve, assign, suppress, reopen and close. That
 * normalises to `/alerts/{}/{}`, which is not the string `/alerts/{}/acknowledge`
 * — so six real surfaces were reported as six gaps. A hole means "this segment
 * is computed", and a computed segment can hold any of them.
 *
 * The cost is that a console call to `/alerts/{}/{}` also matches a documented
 * `/alerts/{}/anything-else`, so a genuinely unreached sibling can hide behind
 * a reached one. That is the right way to be wrong here: this report exists to
 * find screens to build, and a false gap sends someone to build a control that
 * already exists.
 */
function segmentsMatch(consolePath, apiPath) {
  const a = consolePath.split('/');
  const b = apiPath.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segment === '{}' || b[index] === '{}' || segment === b[index]);
}

// --- Report ----------------------------------------------------------------

const token = await login();
const operations = await openApiPaths(token);
const surfaces = consolePaths();

const covered = [];
const headless = [];
const superseded = [];
const gaps = [];

const surfaceKeys = [...surfaces.keys()];

for (const operation of operations) {
  const key = normalise(operation.path);
  const reason = headlessReason(operation.path);
  const hit = surfaces.has(key)
    ? key
    : surfaceKeys.find((candidate) => segmentsMatch(candidate, key));
  const replaced = supersededReason(operation.path);
  if (hit) covered.push({ ...operation, files: [...surfaces.get(hit)] });
  else if (reason) headless.push({ ...operation, reason });
  else if (replaced) superseded.push({ ...operation, reason: replaced });
  else gaps.push({ ...operation, key });
}

/** Groups by first path segment, which is how the API is organised anyway. */
function group(items) {
  const buckets = new Map();
  for (const item of items) {
    const segment = item.path.split('/')[1] ?? '(root)';
    if (!buckets.has(segment)) buckets.set(segment, []);
    buckets.get(segment).push(item);
  }
  return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
}

if (process.argv.includes('--json')) {
  writeFileSync(
    join(ROOT, 'docs', 'endpoint-coverage.json'),
    JSON.stringify({ covered: covered.length, headless, gaps }, null, 2),
  );
}

console.log('='.repeat(78));
console.log('ENDPOINT COVERAGE — does every API operation have a console surface?');
console.log('='.repeat(78));
console.log(
  `${operations.length} operations · ${covered.length} surfaced · ${headless.length} deliberately headless · ${superseded.length} superseded · ${gaps.length} with NO surface\n`,
);

if (superseded.length) {
  console.log('### SUPERSEDED — live, reachable, and replaced by a newer route');
  for (const item of superseded)
    console.log(`    ${item.method.padEnd(6)} ${item.path}  — ${item.reason}`);
  console.log('    These are candidates for removal, not for building a screen.\n');
}

for (const [segment, items] of group(gaps)) {
  console.log(`### /${segment}  (${items.length})`);
  for (const item of items.sort((a, b) => a.path.localeCompare(b.path)))
    console.log(`    ${item.method.padEnd(6)} ${item.path}${item.summary ? `  — ${item.summary}` : ''}`);
  console.log('');
}

console.log('='.repeat(78));
console.log(`TOTAL ${gaps.length} operations have no console surface`);
