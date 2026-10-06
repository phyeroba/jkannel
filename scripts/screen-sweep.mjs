/**
 * Screenshot every screen a console operator can actually reach.
 *
 * WHY THIS EXISTS, AND WHY v1 WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The layout and overflow audits measure two numbers. Neither can see that a
 * dialog is a flat list of eleven fields, that a drawer buries its own
 * controls, or that a screen is simply ugly. The redesign kept missing
 * drill-downs because a page top was rebuilt and the sheet behind its own
 * button was never opened.
 *
 * The first version of this script walked `navigation.ts` and clicked ONE
 * opener per page. That still left three whole classes of screen unseen:
 *
 *   1. Every dialog after the first. A register with New / Edit / Import has
 *      three, and only one was ever captured.
 *   2. Every page reached by a LINK rather than by the nav — the carrier,
 *      SMSC, message and customer detail pages are reached by clicking a row,
 *      and none of them is in `navigation.ts`.
 *   3. Every drawer that opens from a row click rather than from a button.
 *
 * So this walks in two phases. Phase one takes the nav routes, captures each,
 * opens EVERY non-destructive opener on it one at a time, and captures what
 * each one opened — then clicks the first register row, for the drawer. While
 * it does that it collects the in-app links it saw. Phase two visits the
 * routes those links point at which the nav never mentions, and does the same
 * to them.
 *
 * Output is a folder of PNGs plus `index.json` describing each one: what it
 * is, how tall, and how far any register on it runs past its panel.
 *
 *   BASE=https://gw1.speedamobile.com U=operator P=... node scripts/screen-sweep.mjs
 *   ONLY=/alerts,/carriers node scripts/screen-sweep.mjs      (a subset)
 *   PHASE1=1 node scripts/screen-sweep.mjs                    (skip discovery)
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
/** Phase two costs another pass; `PHASE1=1` stops after the nav routes. */
const WITH_DISCOVERY = process.env.PHASE1 !== '1';
/** A register with nine row-action buttons would otherwise take nine shots. */
const MAX_OPENERS = Number(process.env.MAX_OPENERS ?? 4);

const navigation = readFileSync(new URL('../frontend/src/navigation.ts', import.meta.url), 'utf8');
const navRoutes = [
  ...new Set([...navigation.matchAll(/to:\s*'(\/[^']*)'/g)].map((m) => m[1])),
].sort();
const only = (process.env.ONLY ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const phaseOne = only.length ? navRoutes.filter((route) => only.includes(route)) : navRoutes;

mkdirSync(OUT, { recursive: true });
const slug = (route) =>
  route.replace(/^\//, '').replace(/[/?#=&]/g, '-').replace(/-+/g, '-').slice(0, 70) || 'root';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await page.click('[data-testid="login-submit"]');
await page.waitForURL(/dashboard|operations/, { timeout: 30000 });

const index = [];
const taken = new Set();
/** Route patterns already visited in phase two, so `/smsc/a` covers `/smsc/b`. */
const discoveredPatterns = new Set();
const discovered = [];

/**
 * A control worth clicking is one that OPENS something. Save, Delete, Export
 * and Run change state or leave the page; this sweep is read-only, so they
 * are excluded BY NAME rather than by hoping they are disabled.
 */
const OPENERS =
  /^(new|add|create|edit|open|configure|view|details?|manage|inspect|test|import|assign|invite|attach|filter|advanced|customi[sz]e|settings?)\b/i;
const DESTRUCTIVE =
  /\b(save|delete|remove|disable|enable|suspend|retire|purge|run|send|apply|rotate|revoke|restart|stop|start|deploy|reset|clear|acknowledge|resolve|close|retry|requeue|cancel|sign out|logout)\b/i;
const DIALOG = '[role="dialog"], .modal, .drawer, .detail-drawer, .dialog, .drawer-body';

async function capture(name, note, extra = {}) {
  let file = `${name}.png`;
  let n = 2;
  while (taken.has(file)) file = `${name}-${n++}.png`;
  taken.add(file);
  await page.screenshot({ path: join(OUT, file), fullPage: true });
  const measured = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    // Named, not just counted. "/smsc/kololo overflow 917" sent one fix at
    // the wrong table on that page; "Operation history +917" does not.
    overflow: [...document.querySelectorAll('.table-wrap')]
      .map((wrap) => ({
        px: wrap.scrollWidth - wrap.clientWidth,
        panel: (
          wrap.closest('section,article')?.querySelector('h2,h3')?.textContent ?? 'unnamed'
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 38),
        cols: wrap.querySelectorAll('thead th').length,
      }))
      .filter((row) => row.px > 4)
      .map((row) => `${row.panel} +${row.px}/${row.cols}col`),
    /*
     * Is the dialog's commit button reachable without scrolling?
     *
     * The first version measured the dialog's HEIGHT, which is the wrong
     * question: a long form is fine, a long form whose Save you cannot see
     * is not. It also scored the SMSC editor as *worse* after the fix that
     * made Save permanently visible, because a sticky footer adds height.
     *
     * So this asks what an operator asks: is the primary action on screen?
     * A sticky or fixed footer is reachable by definition, whatever the form
     * above it measures.
     */
    buriedAction: [...document.querySelectorAll('[role="dialog"], .drawer-body')]
      .flatMap((node) => [
        ...node.querySelectorAll('.primary-button, button[type="submit"]'),
      ])
      .filter((button) => {
        for (let el = button; el && el !== document.body; el = el.parentElement) {
          const position = getComputedStyle(el).position;
          if (position === 'sticky' || position === 'fixed') return false;
        }
        return button.getBoundingClientRect().bottom > window.innerHeight + 4;
      })
      .map(
        (button) =>
          `${(button.textContent ?? '').trim().slice(0, 24)} +${Math.round(
            button.getBoundingClientRect().bottom - window.innerHeight,
          )}`,
      ),
  }));
  index.push({ file, note, ...measured, ...extra });
  return file;
}

/** Shut whatever is open, without pressing anything that commits. */
async function dismiss(route) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(350);
  if (await page.$(DIALOG)) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1300);
  }
}

/** Collect in-app links, reduced to one example per route shape. */
async function collectLinks() {
  if (!WITH_DISCOVERY) return;
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href') ?? ''),
  );
  for (const href of hrefs) {
    const path = href.split('?')[0].split('#')[0];
    if (!path || path === '/' || navRoutes.includes(path)) continue;
    // `/smsc/kamdixy` and `/smsc/kololo` are the same screen. One is enough.
    const pattern = path.replace(/\/[0-9a-f-]{8,}$/i, '/:id').replace(/\/[^/]+$/, (m) =>
      /^\/[a-z-]+$/i.test(m) ? m : '/:id',
    );
    if (discoveredPatterns.has(pattern)) continue;
    discoveredPatterns.add(pattern);
    discovered.push({ path, pattern });
  }
}

async function sweepRoute(route, label) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await capture(slug(route), label ?? route);
  await collectLinks();
  if (!WITH_DIALOGS) return;

  // EVERY opener, not the first one. Re-queried each time, because opening
  // and closing a dialog replaces the nodes the previous query returned.
  const labels = await page.evaluate(
    ([openers, destructive]) =>
      [...document.querySelectorAll('button:not([disabled])')]
        .map((button) => (button.textContent ?? '').trim().replace(/\s+/g, ' '))
        .filter(
          (text) =>
            text &&
            text.length < 40 &&
            new RegExp(openers, 'i').test(text) &&
            !new RegExp(destructive, 'i').test(text),
        ),
    [OPENERS.source, DESTRUCTIVE.source],
  );

  let opened = 0;
  for (const text of [...new Set(labels)].slice(0, MAX_OPENERS)) {
    try {
      const button = page.locator(`button:not([disabled])`, { hasText: text }).first();
      await button.click({ timeout: 2500 });
      await page.waitForTimeout(1200);
      if (await page.$(DIALOG)) {
        await capture(`${slug(route)}--${slug(text)}`, `${route} → "${text}"`, { opener: text });
        opened += 1;
      }
      await dismiss(route);
    } catch {
      await dismiss(route);
    }
  }

  // The drawer behind a row click, which no button names.
  try {
    const row = page.locator('tbody tr.selectable, tbody tr[tabindex="0"]').first();
    if (await row.count()) {
      await row.click({ timeout: 2500 });
      await page.waitForTimeout(1300);
      if (await page.$(DIALOG)) {
        await capture(`${slug(route)}--row`, `${route} → first row`, { opener: 'row click' });
        opened += 1;
      }
      await dismiss(route);
    }
  } catch {
    /* a register with no selectable row simply has no drawer */
  }
  return opened;
}

for (const route of phaseOne) {
  try {
    await sweepRoute(route);
  } catch (reason) {
    index.push({ file: null, note: route, error: String(reason).slice(0, 110) });
  }
}

// PHASE TWO — the screens the navigation never mentions.
if (WITH_DISCOVERY && !only.length) {
  for (const { path, pattern } of discovered) {
    try {
      await sweepRoute(path, `${path}   [via link · ${pattern}]`);
    } catch (reason) {
      index.push({ file: null, note: path, error: String(reason).slice(0, 110) });
    }
  }
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n${index.length} capture(s) in ${OUT}`);
for (const entry of index)
  console.log(
    entry.error
      ? `  FAILED ${entry.note} — ${entry.error}`
      : `  ${String(entry.height).padStart(6)}px ${
          entry.overflow.length ? `overflow ${entry.overflow.join(',')}`.padEnd(22) : ''.padEnd(22)
        }${entry.buriedAction?.length ? `BURIED[${entry.buriedAction.join('; ')}] ` : ''}${entry.note}`,
  );
console.log(`\n${discovered.length} screen(s) found by link that the navigation does not list.`);
await browser.close();
