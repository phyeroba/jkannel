/**
 * Screenshot every navigable route, and every dialog one click away from it.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The layout and overflow audits measure two numbers. Neither of them can see
 * that a dialog is a flat list of eleven fields, that a panel's heading says
 * one thing and its body another, or that a screen is simply ugly. The
 * redesign kept missing drill-downs because the top of a page was rebuilt and
 * the sheet behind its own button was never opened.
 *
 * So this walks the routes from `navigation.ts` — the same source the other
 * two audits read, so a screen cannot be added to the console and left out —
 * captures each one, then finds the controls that OPEN something (New, Add,
 * Create, Edit, Open, the first register row) and captures what they opened.
 *
 * Output is a folder of PNGs plus `index.json` describing each one, which is
 * what gets reviewed and what gets attached to the redesign ledger.
 *
 *   BASE=https://gw1.speedamobile.com U=operator P=... node scripts/screen-sweep.mjs
 *   ONLY=/alerts,/carriers   node scripts/screen-sweep.mjs     (a subset)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../frontend/package.json', import.meta.url))(
  '@playwright/test',
);

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const OUT = process.env.OUT ?? join(process.cwd(), '.screens');
const WIDTH = Number(process.env.W ?? 1600);
const HEIGHT = Number(process.env.H ?? 1000);
/** Dialogs are the point of this sweep; `SKIP_DIALOGS=1` turns them off. */
const WITH_DIALOGS = process.env.SKIP_DIALOGS !== '1';

const navigation = readFileSync(new URL('../frontend/src/navigation.ts', import.meta.url), 'utf8');
const all = [...new Set([...navigation.matchAll(/to:\s*'(\/[^']*)'/g)].map((m) => m[1]))].sort();
const only = (process.env.ONLY ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const routes = only.length ? all.filter((route) => only.includes(route)) : all;

mkdirSync(OUT, { recursive: true });
const slug = (route) => route.replace(/^\//, '').replace(/\//g, '-') || 'root';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await page.click('[data-testid="login-submit"]');
await page.waitForURL(/dashboard|operations/, { timeout: 30000 });

const index = [];

/**
 * A control worth clicking is one that OPENS something. "Save", "Delete" and
 * "Export" change state or leave the page; this sweep is read-only, so they
 * are excluded by name rather than by hoping they are disabled.
 */
const OPENERS = /^(new|add|create|edit|open|configure|view|details|manage|test)\b/i;
const DESTRUCTIVE = /\b(save|delete|remove|disable|suspend|retire|purge|run|send|apply|rotate)\b/i;

async function capture(name, note) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('.table-wrap')]
      .map((wrap) => wrap.scrollWidth - wrap.clientWidth)
      .filter((value) => value > 4),
  );
  index.push({ file, note, height, overflow });
  return file;
}

for (const route of routes) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await capture(slug(route), route);
    if (!WITH_DIALOGS) continue;

    // One opener per page. Opening several means deciding how to close each
    // one, and a dialog left open contaminates the next capture.
    const buttons = await page.$$('button:not([disabled])');
    for (const button of buttons) {
      const label = ((await button.textContent()) ?? '').trim();
      if (!label || !OPENERS.test(label) || DESTRUCTIVE.test(label)) continue;
      try {
        await button.click({ timeout: 2500 });
        await page.waitForTimeout(1200);
        const opened = await page.$('[role="dialog"], .modal, .drawer, .detail-drawer');
        if (!opened) {
          await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1200);
          continue;
        }
        await capture(`${slug(route)}--dialog`, `${route} → "${label}"`);
      } catch {
        /* a control that refuses to open is not this sweep's problem */
      }
      break;
    }
  } catch (reason) {
    index.push({ file: null, note: route, error: String(reason).slice(0, 120) });
  }
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n${index.length} capture(s) in ${OUT}`);
for (const entry of index)
  console.log(
    entry.error
      ? `  FAILED ${entry.note} — ${entry.error}`
      : `  ${String(entry.height).padStart(6)}px  ${
          entry.overflow.length ? `overflow ${entry.overflow.join(',')}` : '          '
        }  ${entry.note}`,
  );
await browser.close();
