/**
 * Horizontal overflow across every navigable route.
 *
 * A register that runs past its panel hides its own Actions column behind a
 * sideways scroll nobody discovers. The layout audit measures row HEIGHT and
 * button clusters; this measures the other axis.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/*
 * Playwright is a devDependency of the FRONTEND workspace; there is no root
 * `node_modules`, so a bare import resolves from this file's directory and
 * fails whichever directory the script is run from.
 */
const { chromium } = createRequire(new URL('../frontend/package.json', import.meta.url))(
  '@playwright/test',
);
const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
/*
 * Routes come from `navigation.ts`, not from a list kept here.
 *
 * The layout audit used to carry six hardcoded routes and so measured six of
 * fifty screens; the forty-four it never looked at were not passing, they were
 * unmeasured. Reading the nav means a screen cannot be added to the console
 * and left out of the audit.
 */
const navigation = readFileSync(new URL('../frontend/src/navigation.ts', import.meta.url), 'utf8');
const routes = [...new Set([...navigation.matchAll(/to:\s*'(\/[^']*)'/g)].map((m) => m[1]))].sort();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await page.click('[data-testid="login-submit"]');
await page.waitForURL(/dashboard|operations/, { timeout: 25000 });

const findings = [];
for (const route of routes) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.table-wrap')]
        .map((w) => ({
          panel: (w.closest('section,article')?.querySelector('h2')?.textContent ?? '').trim().slice(0, 44),
          overflow: w.scrollWidth - w.clientWidth,
          cols: w.querySelectorAll('thead th').length,
        }))
        .filter((r) => r.overflow > 4),
    );
    for (const r of rows) findings.push({ route, ...r });
  } catch (reason) {
    findings.push({ route, panel: 'ROUTE FAILED', overflow: -1, cols: 0, why: String(reason).slice(0, 80) });
  }
}
console.log(`\nHORIZONTAL OVERFLOW — ${routes.length} route(s)\n${'='.repeat(78)}`);
if (!findings.length) console.log('No register runs past its panel.');
else console.table(findings);
console.log(`\n${findings.length} finding(s).`);
await browser.close();
