#!/usr/bin/env node
/**
 * PADDING INSIDE panels, on every route.
 *
 * `spacing-audit.mjs` measures the gap BETWEEN adjacent panels and reports every
 * pair at 16px. That is a different question from the one an operator notices:
 * a panel whose content is jammed against its own edge, or floating in twice the
 * room it should have, looks wrong even when the gaps around it are perfect.
 *
 * The design system fixes panel padding at `--pad-card` (20px) and toolbar
 * padding at 14px. Anything else is either a deliberate exception that should be
 * stated, or a leftover from before the package was being followed.
 *
 * WHAT IT DOES NOT FLAG, AND WHY
 * ---------------------------------------------------------------------------
 * A panel with a `.table-wrap` as its last child legitimately has its bottom
 * padding cancelled — `components.css` pulls the table out to the panel edge
 * with `margin: 16px -20px -20px`, so the table's own cell padding becomes the
 * edge. Flagging that would be flagging the design.
 *
 *   node scripts/padding-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';
/** From `spacing.css`. Read here rather than assumed, so a retune is picked up. */
const EXPECTED_PANEL = Number(process.env.PAD_CARD ?? 20);
const EXPECTED_TOOLBAR = 14;

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

const findings = [];
let measured = 0;

for (const route of routes) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const panels = await page.evaluate(
    ({ expectedPanel, expectedToolbar }) =>
      [...document.querySelectorAll('main .panel')].map((el) => {
        const style = getComputedStyle(el);
        const pad = {
          top: parseFloat(style.paddingTop),
          right: parseFloat(style.paddingRight),
          bottom: parseFloat(style.paddingBottom),
          left: parseFloat(style.paddingLeft),
        };
        const isToolbar = el.classList.contains('toolbar');
        const want = isToolbar ? expectedToolbar : expectedPanel;
        // A table pulled to the panel edge cancels the bottom padding by design.
        const lastChild = el.lastElementChild;
        const edgeTable =
          lastChild &&
          (lastChild.classList.contains('table-wrap') ||
            lastChild.querySelector?.(':scope > .table-wrap'));
        const wrong = ['top', 'right', 'left']
          .filter((side) => Math.abs(pad[side] - want) > 0.5)
          .concat(!edgeTable && Math.abs(pad.bottom - want) > 0.5 ? ['bottom'] : []);
        return {
          testid: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '(unnamed)',
          classes: el.className,
          pad,
          want,
          wrong,
          edgeTable: Boolean(edgeTable),
        };
      }),
    { expectedPanel: EXPECTED_PANEL, expectedToolbar: EXPECTED_TOOLBAR },
  );
  measured += panels.length;
  for (const panel of panels)
    if (panel.wrong.length) findings.push({ route, ...panel });
}
await browser.close();

console.log('='.repeat(96));
console.log(`PADDING AUDIT — panel interiors (expected ${EXPECTED_PANEL}px, toolbars ${EXPECTED_TOOLBAR}px)`);
console.log('='.repeat(96));
console.log(`${routes.length} routes · ${measured} panels measured`);

let lastRoute = '';
for (const finding of findings) {
  if (finding.route !== lastRoute) {
    console.log(`\n  ${finding.route}`);
    lastRoute = finding.route;
  }
  const shown = finding.wrong.map((side) => `${side} ${finding.pad[side]}px`).join(', ');
  console.log(`      ${String(finding.testid).padEnd(34)} want ${finding.want}px · got ${shown}`);
}

console.log(`\n${'='.repeat(96)}`);
console.log(
  findings.length
    ? `${findings.length} panel(s) do not use the design system's padding.`
    : 'Every panel uses the padding the design system specifies.',
);
fs.writeFileSync(path.join(ROOT, 'docs/padding-audit.json'), JSON.stringify(findings, null, 2));
