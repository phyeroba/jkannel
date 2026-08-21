// Does every menu item actually DO something?
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `route-smoke.mjs` answers "does this route render without crashing". That is
// a lower bar than the one Peter set: a screen can render a heading, three
// empty panels and a spinner that never resolves, and the sweep calls it `ok`.
// The question here is different — does clicking this menu item reach the API
// at all, and does what it reaches actually answer?
//
// So this records, per menu item:
//
//   requests   which /api/v1 calls the screen made on load
//   answered   how many came back 2xx
//   broken     4xx/5xx, with the status and the path
//   verdict    inert | broken | permission | thin | ok
//
// `inert` is the finding that matters and the one route-smoke cannot see: a
// menu item that renders and asks the API for nothing. Either the screen is
// static (which some legitimately are — Help, API Reference) or it is wired to
// nothing, and the two look identical until you watch the network.
//
// A screen is only judged after its requests have settled, and the settle wait
// is generous: a slow first paint reported as inert would be the same class of
// false positive that has bitten every other tool in this repo.
//
//   BASE=http://127.0.0.1:15173 node scripts/menu-audit.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';
const NAV = path.join(ROOT, 'frontend/src/navigation.ts');

/**
 * Screens that legitimately make no API call, with the reason.
 *
 * Kept small and justified. Anything added here is a claim that the screen has
 * nothing to ask the server, and that claim should be obvious from the screen.
 */
const EXPECTED_STATIC = {
  '/help': 'a guide index; every link goes to documentation, not to the API',
  '/api-reference':
    'renders the OpenAPI document it already holds plus static examples; the fetch happens once at app load',
};

// Read the menu from navigation.ts, so an item added later is audited without
// anybody remembering to update a list here.
const source = fs.readFileSync(NAV, 'utf8');
const items = [...source.matchAll(/label:\s*'([^']+)',\s*\n\s*to:\s*'([^']+)'/g)].map((m) => ({
  label: m[1],
  to: m[2],
}));
if (!items.length) throw new Error('No menu items parsed from navigation.ts — check the shape.');

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

let seen = [];
page.on('response', async (r) => {
  const url = r.url();
  if (!url.includes('/api/v1/')) return;
  seen.push({ path: url.split('/api/v1/')[1]?.split('?')[0] ?? url, status: r.status() });
});

const rows = [];
for (const item of items) {
  seen = [];
  await page.goto(BASE + item.to, { waitUntil: 'domcontentloaded' });
  // Generous: a screen judged inert because it had not finished starting is the
  // same false positive that has bitten every other tool here.
  await page.waitForTimeout(5000);

  const probe = await page.evaluate(() => {
    const main = document.querySelector('main');
    const text = (main?.innerText ?? '').trim();
    return {
      chars: text.length,
      panels: main ? main.querySelectorAll('.panel, article.panel, section.panel').length : 0,
      // Controls the operator can actually use. A screen with content and no
      // control is a readout; one with neither is a placeholder.
      controls: main
        ? main.querySelectorAll('button, a[href], input, select, textarea').length
        : 0,
      /*
       * Anchored to actual refusal copy.
       *
       * `/requires the/` was in this alternation and matched the privacy
       * notice — "Revealing requires the messages.reveal permission" — which
       * appears on every masking screen and is an EXPLANATION, not a refusal.
       * Messages, Queues and Delivery Reports were all reported as
       * permission-denied for an administrator.
       *
       * Seventh false positive of this shape in these tools. They keep erring
       * the same way: matching prose that describes a state instead of the
       * state itself.
       */
      denied:
        /you do not have permission|permission denied|not authorised to|access restricted|your current role does not permit/i.test(
          text,
        ),
    };
  });

  // 401 is the token refresh working, not a failure.
  const calls = seen.filter((c) => c.status !== 401);
  const broken = calls.filter((c) => c.status >= 400);
  const answered = calls.filter((c) => c.status < 400);

  let verdict = 'ok';
  if (broken.length) verdict = 'broken';
  else if (!calls.length && !EXPECTED_STATIC[item.to]) verdict = 'inert';
  else if (probe.denied) verdict = 'permission';
  else if (probe.panels <= 1 && probe.controls < 3) verdict = 'thin';

  rows.push({ ...item, ...probe, calls: calls.length, answered: answered.length, broken, verdict });
}
await browser.close();

const width = Math.max(...items.map((i) => i.label.length)) + 2;
console.log('='.repeat(96));
console.log('MENU AUDIT — does each item reach a working endpoint?');
console.log('='.repeat(96));
console.log(
  `${'menu item'.padEnd(width)}${'route'.padEnd(22)}${'calls'.padStart(6)}${'ok'.padStart(4)}${'panels'.padStart(8)}  verdict`,
);
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    `${r.label.padEnd(width)}${r.to.padEnd(22)}${String(r.calls).padStart(6)}${String(r.answered).padStart(4)}${String(r.panels).padStart(8)}  ${r.verdict}`,
  );
}

const problems = rows.filter((r) => ['inert', 'broken'].includes(r.verdict));
if (problems.length) {
  console.log(`\n${'='.repeat(96)}\nNEEDS ATTENTION\n${'='.repeat(96)}`);
  for (const r of problems) {
    console.log(`\n### ${r.label}  (${r.to})  — ${r.verdict}`);
    if (r.verdict === 'inert')
      console.log('    Rendered, and asked the API for nothing. Either static or wired to nothing.');
    for (const b of r.broken) console.log(`    ${b.status}  ${b.path}`);
  }
}

const thin = rows.filter((r) => r.verdict === 'thin');
if (thin.length) {
  console.log(`\n${'='.repeat(96)}\nTHIN — one panel and almost no controls; worth a look\n${'='.repeat(96)}`);
  for (const r of thin) console.log(`    ${r.label.padEnd(width)} ${r.to}`);
}

fs.writeFileSync(path.join(ROOT, 'docs/menu-audit.json'), JSON.stringify(rows, null, 2));
console.log(
  `\n${'='.repeat(96)}\n${rows.length} menu items · ${problems.length} need attention · ${thin.length} thin`,
);
