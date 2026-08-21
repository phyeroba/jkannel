#!/usr/bin/env node
/**
 * Measures the real gap between stacked panels on every screen.
 *
 * A CSS rule that looks right is not the same as spacing that IS right: a view
 * can override it, a grid can swallow it, and a margin can collapse. This reads
 * the rendered geometry instead — for each pair of vertically adjacent panels
 * it computes the actual pixel gap, and reports anything that is not the
 * expected one.
 *
 * Two failures are called out separately because they look different to a user:
 *
 *   OVERLAP    a negative gap — the panels are on top of each other
 *   TOUCHING   a gap of 0-3px, which reads as one panel with a line through it
 *
 * Panels side by side in a grid are skipped: their spacing is the grid's `gap`
 * and is measured horizontally, not here.
 *
 *   BASE=http://127.0.0.1:15173 node scripts/spacing-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';
const NAV = path.join(ROOT, 'frontend/src/navigation.ts');
/** `--gap-panel`. Read from the token file so this cannot drift from the CSS. */
const EXPECTED = Number(
  /--gap-panel:\s*(\d+)px/.exec(
    fs.readFileSync(path.join(ROOT, 'frontend/src/design-system/spacing.css'), 'utf8'),
  )?.[1] ?? 16,
);
const TOLERANCE = 2;

const source = fs.readFileSync(NAV, 'utf8');
const routes = [
  ...new Set([
    '/dashboard/operations',
    ...[...source.matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1]).filter((to) => !to.includes(':')),
  ]),
];

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

const problems = [];
let measured = 0;

for (const route of routes) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const gaps = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return [];

    /*
     * ADJACENT SIBLINGS ONLY.
     *
     * The first version of this compared every panel to the next one in
     * document order, which reported a 207px "gap" wherever a note, a banner
     * or a chart sat between two panels. Nothing is wrong there — the space is
     * that content. Margin only governs the distance between two elements that
     * are actually next to each other, so that is the only distance worth
     * judging.
     */
    const BLOCKS = '.panel, .dashboard-grid, .split-grid, .metrics-grid';
    const label = (el) =>
      el.getAttribute('data-testid') ??
      el.className?.split?.(' ')?.find?.((c) => c.endsWith('-grid')) ??
      el.querySelector('h2, h3')?.textContent?.trim().slice(0, 40) ??
      '(unlabelled)';
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      return box.height > 0 && box.width > 0;
    };

    const out = [];
    for (const parent of [main, ...main.querySelectorAll('div, section, form')]) {
      const children = [...parent.children].filter(
        (el) => el.matches(BLOCKS) && visible(el),
      );
      for (let i = 0; i < children.length - 1; i += 1) {
        const a = children[i];
        const b = children[i + 1];
        // Skip nodes with anything visible between them — that content, not a
        // margin, is what sets the distance.
        let between = a.nextElementSibling;
        let interrupted = false;
        while (between && between !== b) {
          if (visible(between)) {
            interrupted = true;
            break;
          }
          between = between.nextElementSibling;
        }
        if (interrupted) continue;

        const boxA = a.getBoundingClientRect();
        const boxB = b.getBoundingClientRect();
        // Side by side in a grid: their spacing is the grid's horizontal gap.
        if (boxB.top < boxA.bottom - 4) continue;
        out.push({ from: label(a), to: label(b), gap: Math.round(boxB.top - boxA.bottom) });
      }
    }
    return out;
  });

  for (const gap of gaps) {
    measured += 1;
    if (gap.gap < 0) problems.push({ route, ...gap, kind: 'OVERLAP' });
    else if (gap.gap <= 3) problems.push({ route, ...gap, kind: 'TOUCHING' });
    else if (Math.abs(gap.gap - EXPECTED) > TOLERANCE)
      problems.push({ route, ...gap, kind: `${gap.gap}px, expected ${EXPECTED}px` });
  }
}
await browser.close();

console.log('='.repeat(92));
console.log(`SPACING AUDIT — measured gap between stacked panels (expected ${EXPECTED}px)`);
console.log('='.repeat(92));
console.log(`${routes.length} routes · ${measured} panel pairs measured\n`);

if (!problems.length) {
  console.log('Every stacked panel pair sits at the expected gap.');
} else {
  for (const p of problems)
    console.log(
      `  ${p.kind.padEnd(22)} ${p.route.padEnd(22)} ${p.from.slice(0, 26).padEnd(28)} -> ${p.to.slice(0, 26)}`,
    );
  console.log(`\n${problems.length} pair(s) off.`);
}
fs.writeFileSync(path.join(ROOT, 'docs/spacing-audit.json'), JSON.stringify(problems, null, 2));
process.exitCode = problems.length ? 1 : 0;
