#!/usr/bin/env node
/**
 * What actually happens when you click.
 *
 * The design system is explicit about this and it is the part the port got
 * wrong most often:
 *
 *   Add / New / Create        a centred Dialog on a scrim
 *   a record from a register  a Drawer, or navigation to that record's page
 *   a controlled action       ConfirmAction
 *
 * and never, anywhere, a div that unfolds underneath the table. An inline
 * expander pushes the rest of the list down, loses the operator's place, and on
 * a long register puts the detail off-screen entirely — which is why the kit
 * does not have one.
 *
 * Nothing static can check this: the markup for an inline panel and for a
 * drawer is the same until it is rendered and clicked. So this clicks, and
 * classifies what came back:
 *
 *   dialog     a `.dialog-backdrop` appeared          (the kit's Dialog)
 *   drawer     a `.drawer-scrim` appeared             (the kit's Drawer)
 *   navigate   the URL changed                        (record's own page)
 *   INLINE     the page grew, with neither of those   <-- the finding
 *   nothing    the click did nothing at all           <-- also a finding
 *
 *   BASE=http://127.0.0.1:15173 node scripts/interaction-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';

/** Registers: a screen whose job is a list you open things from. */
const SCREENS = [
  '/carriers',
  '/smsc',
  '/routing',
  '/routing-advanced',
  '/customers',
  '/users',
  '/roles',
  '/api-gateway',
  '/alerts',
  '/alert-lifecycle',
  '/configuration',
  '/plugins',
  '/backup',
  '/messages',
  '/delivery-reports',
  '/notifications',
  '/logs-audit',
  '/sessions',
  '/sessions-smpp',
  '/mo-routing',
  '/content-rules',
  '/recipient-policy',
  '/scheduled-sends',
  '/delivery-retries',
  '/jobs',
  '/data-integrity',
  '/services',
  '/docker',
];

/**
 * Labels the console uses for "make a new one".
 *
 * Tested against a TRIMMED label, in JavaScript, rather than through
 * Playwright's `filter({ hasText })`. That filter matches a regex against the
 * element's text with the surrounding whitespace intact, so an anchored `^new`
 * silently failed on every button whose label is written on its own line —
 *
 *     <button ...>
 *       New carrier
 *     </button>
 *
 * — which is most of them. The audit reported "no add control" for /carriers,
 * /roles and /data-integrity, all of which have one. Eighth false negative
 * found in these tools, and the same shape as the others: a matcher that is
 * quietly stricter than it reads, reporting absence rather than failure.
 */
const ADD = /^(add|new|create|invite|register|bind route|set quota|\+)\b/i;

/**
 * Registers whose rows deliberately open nothing, and why.
 *
 * Every entry was checked against the OpenAPI document: the API has no
 * per-record READ, so a sheet would hold nothing the row is not already
 * showing. Listing them here rather than leaving them in the findings is the
 * same discipline `endpoint-coverage.mjs` uses for its headless operations — a
 * decision that has been made must stop reading as a defect nobody has looked
 * at, or the real ones stop standing out.
 *
 * Deleting a line turns that screen back into a finding, which is exactly what
 * should happen the day one of these gains a GET.
 */
const NO_RECORD_TO_OPEN = {
  '/api-gateway': '/api-gateway/clients/{id} is PATCH and DELETE only — there is no GET',
  '/backup': '/backups/{id} offers restore and verify, no GET',
  '/sessions': '/sessions/{id} offers revoke, no GET',
  '/data-integrity':
    'the row IS the editor — every value is an input in its own cell, so a sheet adds nothing',
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);

/** What is on screen that a click could have produced. */
const snapshot = () =>
  page.evaluate(() => ({
    dialog: Boolean(document.querySelector('.dialog-backdrop, .command-dialog')),
    drawer: Boolean(document.querySelector('.drawer-scrim, [data-testid="detail-drawer"]')),
    url: location.pathname,
    height: document.querySelector('main')?.scrollHeight ?? 0,
    chars: (document.querySelector('main')?.innerText ?? '').length,
    // Which row a master/detail screen is currently showing. Identity, not a
    // count: the count never changes when selection moves from one row to
    // another, which is exactly the case this exists to catch.
    selected: [...document.querySelectorAll('main table tbody tr.selected')]
      .map((tr) => tr.textContent?.trim().slice(0, 60))
      .join('|'),
  }));

async function classify(before) {
  await page.waitForTimeout(1200);
  const after = await snapshot();
  if (after.dialog) return 'dialog';
  if (after.drawer) return 'drawer';
  if (after.url !== before.url) return `navigate ${after.url}`;
  // A MASTER/DETAIL SCREEN, which is a legitimate pattern and is not an
  // expander: the detail lives in a fixed pane and the row click changes which
  // record fills it. /services was reported inert for two compounding reasons —
  // its first row is preselected, and picking a different component made the
  // page SHORTER, so a growth-only test saw nothing happen.
  if (after.selected && after.selected !== before.selected) return 'select';
  // A meaningful growth in content with no overlay and no navigation is the
  // inline expander the design system does not have.
  if (after.chars > before.chars + 120) return 'INLINE';
  if (after.height > before.height + 60) return 'INLINE';
  return 'nothing';
}

async function dismiss() {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

const rows = [];
for (const route of SCREENS) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  // --- the Add control -------------------------------------------------------
  let addResult = 'no add control';
  const candidates = page.locator('main button:visible, main a:visible');
  let addButton = null;
  let label = '';
  for (let i = 0; i < (await candidates.count()); i += 1) {
    const control = candidates.nth(i);
    const text = (await control.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    if (ADD.test(text)) {
      addButton = control;
      label = text.slice(0, 24);
      break;
    }
  }
  if (addButton) {
    const before = await snapshot();
    await addButton.click({ timeout: 4000 }).catch(() => {});
    addResult = `${await classify(before)}  ("${label}")`;
    await dismiss();
  }

  // --- opening a record from the register ------------------------------------
  //
  // EVERY table, not just the first one. A screen often carries more than one:
  // /carriers leads with the unassigned-connection worklist and puts the carrier
  // register below it, so measuring `table` singular reported the register as
  // inert when it was the worklist above it — whose rows correctly do nothing —
  // being clicked. The verdict is the best outcome any table produced, and the
  // count says how many were tried.
  let rowResult = 'no rows';
  const RANK = { drawer: 4, dialog: 3, select: 3, INLINE: 2, nothing: 1 };
  const rank = (verdict) => (verdict.startsWith('navigate') ? 5 : (RANK[verdict] ?? 0));
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const tables = page.locator('main table');
  const tableCount = await tables.count();
  let best = null;
  for (let i = 0; i < tableCount; i += 1) {
    const body = tables.nth(i).locator('tbody tr');
    // Never the row that is ALREADY open. A master/detail screen renders with
    // its first component selected, so clicking that row changes nothing and
    // the screen reads as inert when it is simply already showing the answer.
    // /services was reported that way for exactly this reason.
    const first = body.first();
    const preselected = (await first.count())
      ? ((await first.getAttribute('class')) ?? '').includes('selected')
      : false;
    const row = preselected && (await body.count()) > 1 ? body.nth(1) : first;
    if (!(await row.count()) || (await row.locator('td').count()) <= 1) continue;
    const before = await snapshot();
    // Prefer an explicit Open/View control, as an operator would; fall back to
    // the row itself, which the kit makes clickable via `.selectable`.
    const open = row.locator('button, a').filter({ hasText: /^(open|view|expand|details?)$/i });
    if (await open.count()) await open.first().click({ timeout: 4000 }).catch(() => {});
    else await row.click({ timeout: 4000 }).catch(() => {});
    const verdict = await classify(before);
    if (!best || rank(verdict) > rank(best)) best = verdict;
    await dismiss();
    // Navigation moves off the screen; go back before trying the next table.
    if (!page.url().endsWith(route)) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
  }
  if (best) rowResult = tableCount > 1 ? `${best} (of ${tableCount} tables)` : best;

  rows.push({ route, add: addResult, row: rowResult });
}
await browser.close();

const width = Math.max(...SCREENS.map((s) => s.length)) + 2;
console.log('='.repeat(96));
console.log('INTERACTION AUDIT — what a click actually opens');
console.log('='.repeat(96));
console.log(`${'screen'.padEnd(width)}${'Add control'.padEnd(34)}open a record`);
console.log('-'.repeat(96));
for (const r of rows)
  console.log(`${r.route.padEnd(width)}${r.add.padEnd(34)}${r.row}`);

const bad = rows.filter((r) => r.add.includes('INLINE') || r.row.includes('INLINE'));
const inert = rows.filter((r) => r.row.startsWith('nothing'));
const explained = inert.filter((r) => NO_RECORD_TO_OPEN[r.route]);
const unexplained = inert.filter((r) => !NO_RECORD_TO_OPEN[r.route]);
if (explained.length) {
  console.log(`\n${explained.length} register(s) open nothing on purpose — there is no record:`);
  for (const r of explained) console.log(`  ${r.route.padEnd(18)}${NO_RECORD_TO_OPEN[r.route]}`);
}
// The reverse case is worth saying too: an allowlisted screen that started
// opening something means the entry is stale and should come out.
const stale = Object.keys(NO_RECORD_TO_OPEN).filter(
  (route) => !inert.some((r) => r.route === route) && rows.some((r) => r.route === route),
);
if (stale.length)
  console.log(`\nSTALE allowlist entries — these DO open something now: ${stale.join(', ')}`);
if (unexplained.length)
  console.log(
    `\n${unexplained.length} register(s) where no table row opens anything, and nothing says why:\n  ` +
      unexplained.map((r) => r.route).join('\n  '),
  );
console.log(`\n${'='.repeat(96)}`);
console.log(
  bad.length
    ? `${bad.length} screen(s) open an inline panel where the design system opens an overlay.`
    : 'No screen opens an inline panel.',
);
fs.writeFileSync(path.join(ROOT, 'docs/interaction-audit.json'), JSON.stringify(rows, null, 2));
