#!/usr/bin/env node
/**
 * ARE A ROW'S ACTION BUTTONS ON ONE LINE?
 *
 * WHY MEASURE INSTEAD OF READING THE CSS
 * ---------------------------------------------------------------------------
 * `design-system/index.css` already gives `.row-actions` `display: flex`, and
 * reading that rule says the buttons are in a row. They are — a flex row that
 * WRAPS. The same block also gives the cell `width: 1%`, which asks the table to
 * shrink the Actions column to its content, and a wrapping flex container's
 * minimum content width is its widest single item. So the browser is entitled
 * to shrink the column to one button and stack the rest, and on a busy grid
 * that is exactly what it does.
 *
 * Both rules are individually right and the pair is wrong, which is precisely
 * the kind of thing a CSS read-through does not catch. The only honest question
 * is what the rendered buttons' geometry actually is.
 *
 * WHAT COUNTS AS STACKED
 * ---------------------------------------------------------------------------
 * Two buttons in the same cell whose bounding boxes do not overlap vertically.
 * Not "different y" — a 1px baseline difference between a button and an icon
 * button is not a stack, and would make this report noise. Genuine wrapping puts
 * them in disjoint horizontal bands.
 *
 * Single-button cells are skipped: one button cannot be stacked, and counting
 * them as passes would flatter the result.
 *
 *   node scripts/row-actions-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';

const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/route-smoke.json'), 'utf8'))
  .map((entry) => entry.route ?? entry.path)
  .filter(Boolean);

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 } })
).newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);

const stacked = [];
let cellsWithSeveral = 0;

for (const route of routes) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll('.row-actions')].flatMap((cell) => {
      const buttons = [...cell.querySelectorAll('button, a')]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (buttons.length < 2) return [];
      // Disjoint vertical bands, not merely a different top edge.
      let rows = 1;
      const sorted = [...buttons].sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i += 1)
        if (sorted[i].top >= sorted[i - 1].bottom) rows += 1;
      return [
        {
          buttons: buttons.length,
          rows,
          width: Math.round(cell.getBoundingClientRect().width),
          // The container's own wrap setting, so the report names the cause
          // rather than only the symptom.
          wrap: getComputedStyle(cell).flexWrap,
          display: getComputedStyle(cell).display,
        },
      ];
    }),
  );
  cellsWithSeveral += cells.length;
  for (const cell of cells) if (cell.rows > 1) stacked.push({ route, ...cell });
}

await browser.close();

console.log('='.repeat(92));
console.log(`ROW ACTIONS — ${cellsWithSeveral} cell(s) with more than one button, across ${routes.length} routes`);
console.log('='.repeat(92));

if (stacked.length) {
  const byRoute = new Map();
  for (const s of stacked) {
    const seen = byRoute.get(s.route) ?? [];
    seen.push(s);
    byRoute.set(s.route, seen);
  }
  console.log('\nSTACKED — buttons on more than one line:\n');
  for (const [route, cells] of byRoute) {
    const worst = cells.reduce((a, b) => (b.rows > a.rows ? b : a));
    console.log(
      `  ${route}\n      ${cells.length} cell(s); worst: ${worst.buttons} buttons on ${worst.rows} lines ` +
        `in a ${worst.width}px cell (display:${worst.display} flex-wrap:${worst.wrap})`,
    );
  }
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  stacked.length
    ? `${stacked.length} of ${cellsWithSeveral} multi-button cells stack their actions vertically.`
    : `All ${cellsWithSeveral} multi-button cells keep their actions on one line.`,
);
process.exitCode = stacked.length ? 1 : 0;
