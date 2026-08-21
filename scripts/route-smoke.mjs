// Walks every route in the console and reports anything that looks broken.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The unit suite is green on every commit, and that is not the same as "the app
// still works". A test mounts one component with a mocked fetch; it cannot see
// a view that throws on mount against a real API, a request that 500s, or a
// screen that renders its error state instead of its content. Reshaping screens
// against the design system touches a lot of views at once, so the question
// "did I break something that used to work" needs an answer that is measured
// rather than asserted.
//
// For each route this records: uncaught page errors, console errors, failed
// network requests, whether the view rendered any content at all, and whether
// it is showing an error/permission state.
//
//   BASE=http://127.0.0.1:15173 node scripts/route-smoke.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const NAV = 'd:/JKANNEL/frontend/src/navigation.ts';

// Read the routes from navigation.ts itself, so a screen added later is swept
// automatically rather than being missed because nobody updated a list here.
const source = fs.readFileSync(NAV, 'utf8');
const routes = [...source.matchAll(/to:\s*'([^']+)'/g)]
  .map((m) => m[1])
  .filter((to) => !to.includes(':'));
const unique = [...new Set(['/dashboard/operations', ...routes])];

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

let current = { pageErrors: [], consoleErrors: [], failedRequests: [] };
page.on('pageerror', (e) => current.pageErrors.push(e.message.slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error') current.consoleErrors.push(m.text().slice(0, 160));
});
page.on('requestfailed', (r) => {
  // net::ERR_ABORTED is what a poll in flight looks like when the sweep
  // navigates to the next route. It is an artefact of the sweep, not a defect,
  // and counting it made every single route look broken on the first run.
  const reason = r.failure()?.errorText ?? '';
  if (reason.includes('ERR_ABORTED')) return;
  current.failedRequests.push(`${r.method()} ${r.url().slice(-56)} ${reason}`);
});
page.on('response', (r) => {
  // 4xx/5xx on our own API is the interesting case. A 404 on a favicon is not.
  // 401 is excluded: the console refreshes an expired token and retries, so a
  // single 401 mid-sweep is the auth flow working rather than a failure.
  if (r.status() >= 400 && r.status() !== 401 && r.url().includes('/api/')) {
    current.failedRequests.push(`${r.status()} ${r.url().split('/api/')[1]?.slice(0, 56)}`);
  }
});

const results = [];
for (const route of unique) {
  current = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);

  const probe = await page.evaluate(() => {
    const main = document.querySelector('main');
    const text = (main?.innerText ?? '').trim();
    return {
      chars: text.length,
      panels: main ? main.querySelectorAll('.panel, article.panel, section.panel').length : 0,
      /*
       * The console's own honest-failure states, read from `DataState`'s
       * `data-state` attribute rather than from prose.
       *
       * Prose-matching was wrong in a way that matters: `/is unavailable/`
       * matched Nodes, which renders a LIST of what this deployment cannot
       * measure. The screen was working perfectly and reporting its limits, and
       * the sweep called it data-unavailable — a screen explaining what is
       * unavailable is not a screen that failed. `data-state` is set by the
       * component, so it says what the view concluded rather than what it
       * happened to say.
       *
       * `partial` is deliberately NOT a failure: several screens are honestly
       * partial by design (Nodes measures one node of an unknown number), and
       * flagging that trains people to ignore the report.
       */
      errorState: [...(main?.querySelectorAll('[data-state]') ?? [])].some((el) =>
        ['error', 'unavailable'].includes(el.getAttribute('data-state') ?? ''),
      ),
      partial: [...(main?.querySelectorAll('[data-state]') ?? [])].some(
        (el) => el.getAttribute('data-state') === 'partial',
      ),
      // Anchored to the console's actual denial copy. A bare /permission/ also
      // matched every screen that merely NAMES a permission — the API reference
      // lists one per endpoint — and flagged eight healthy routes as denied.
      denied: /you do not have permission|permission denied|not authorised to/i.test(text),
      // A route that fell through to the shell with no view mounted.
      empty: text.length < 40,
    };
  });

  results.push({ route, ...probe, ...current });
}
await browser.close();

const bad = results.filter(
  (r) => r.pageErrors.length || r.empty || r.failedRequests.length || r.consoleErrors.length,
);

console.log(`${results.length} routes swept\n`);
console.log('route                          chars panels  state');
console.log('-'.repeat(78));
for (const r of results) {
  const flags = [
    r.pageErrors.length ? `CRASH(${r.pageErrors.length})` : '',
    r.empty ? 'EMPTY' : '',
    r.failedRequests.length ? `HTTP(${r.failedRequests.length})` : '',
    r.consoleErrors.length ? `CONSOLE(${r.consoleErrors.length})` : '',
    r.denied ? 'denied' : '',
    r.errorState ? 'data-unavailable' : '',
    // Reported, not counted as a fault: an honestly partial screen is working.
    r.partial ? 'partial' : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(
    `${r.route.padEnd(30)}${String(r.chars).padStart(5)}${String(r.panels).padStart(7)}  ${flags || 'ok'}`,
  );
}

if (bad.length) {
  console.log(`\n${'='.repeat(78)}\nDETAIL\n${'='.repeat(78)}`);
  for (const r of bad) {
    console.log(`\n${r.route}`);
    for (const e of r.pageErrors) console.log(`   CRASH   ${e}`);
    for (const e of r.consoleErrors.slice(0, 3)) console.log(`   CONSOLE ${e}`);
    for (const e of [...new Set(r.failedRequests)].slice(0, 5)) console.log(`   HTTP    ${e}`);
    if (r.empty) console.log('   EMPTY   the view rendered no content');
  }
}

const crashed = results.filter((r) => r.pageErrors.length || r.empty).length;
console.log(
  `\n${crashed} routes crashed or rendered nothing | ${results.length - crashed} rendered content`,
);
fs.writeFileSync(
  path.join('d:/JKANNEL/docs', 'route-smoke.json'),
  JSON.stringify(results, null, 2),
);
