#!/usr/bin/env node
/**
 * MEASURE THE THINGS AN OPERATOR CALLS "CRAMPED".
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The complaints arrive as taste ("this looks bad", "why are these on the same
 * row") and taste is not actionable at 1700 lines of template. Underneath each
 * one is a geometric fact that can be measured and then regressed:
 *
 *  - TWO LABELLED CONTROLS SHARING A HORIZONTAL BAND. A filter bar may do this;
 *    a form must not, because the eye pairs a label with the control to its
 *    right and gets the wrong one.
 *  - A BUTTON CLUSTER THAT WRAPS. Buttons that mean one thing belong on one
 *    line. Two rows reads as two groups.
 *  - A TABLE WHOSE ROWS ARE TALLER THAN THEY NEED TO BE, which is what "make
 *    the rows smaller" means: fewer records visible per screen than the data
 *    warrants.
 *  - A LIST WITH NO PAGER. Fine at 20 rows, a different screen at 20,000.
 *
 * It reports geometry. Whether a screen is *pleasant* is still a person's call;
 * this exists so that the part which is not a matter of opinion stops coming
 * back.
 *
 *   node scripts/layout-audit.mjs
 *   ROUTES=/live-queue,/events node scripts/layout-audit.mjs
 */
import { createRequire } from 'node:module';

/*
 * Playwright is a devDependency of the FRONTEND workspace, not of the repo
 * root — there is no root `node_modules` at all. A bare `import` here resolves
 * from this file's own directory, so it fails no matter which directory the
 * script is run from, which is a confusing way for an audit to not-run.
 */
const { chromium } = createRequire(new URL('../frontend/package.json', import.meta.url))(
  '@playwright/test',
);

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
/*
 * Rows taller than this waste a screen.
 *
 * One line of content in this design costs about 50px: 22.4px of line-height
 * inside 28px of cell padding. 56 was therefore below TWO lines, so a cell
 * whose message legitimately wrapped once was reported as a fault. The bar is
 * now a little over two lines — enough to leave honest wrapping alone and to
 * catch the Operational events row, which was 169px for one line in every
 * cell.
 */
const MAX_ROW_HEIGHT = Number(process.env.MAX_ROW ?? 92);
/** Below this many rows a register does not yet need a pager. */
const PAGER_NEEDED_FROM = Number(process.env.PAGER_FROM ?? 25);

const ROUTES = (
  process.env.ROUTES ?? '/live-queue,/live-traffic,/events,/log-explorer,/test-tools,/performance'
).split(',');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);

/** Run once per route, and again per tab on a tabbed screen. */
const measure = () =>
  page.evaluate(
    ({ MAX_ROW_HEIGHT, PAGER_NEEDED_FROM }) => {
      const problems = [];
      const seen = (el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };

      // --- controls sharing a horizontal band -------------------------------
      /*
       * Each control is attributed to its NEAREST enclosing panel. Walking
       * panels outward instead reports the same pair once per ancestor, and a
       * page nested four sections deep drowns its own findings.
       */
      const labelText = (field) => {
        if (!field) return '';
        // `textContent` on a field wrapping a <select> concatenates every
        // option, so "Auto refresh" reads as "Auto refreshOnOff". Only the text
        // an operator actually sees as the label counts.
        const clone = field.cloneNode(true);
        for (const noisy of clone.querySelectorAll('select, option, datalist')) noisy.remove();
        return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 28);
      };
      /*
       * A LABEL BESIDE ITS CONTROL, NOT ABOVE IT.
       *
       * The first version of this flagged any two labelled controls sharing a
       * horizontal band. That is the wrong condition: a proper field grid puts
       * three fields side by side, each with its label ABOVE its control, and
       * that is the fix — so the audit fired hardest on the screens that had
       * just been corrected, and would have talked the next person out of the
       * correct layout.
       *
       * What actually goes wrong is the INLINE label. In a flex toolbar the
       * label sits to the left of its control, so a run of "Status [select]
       * Search [input] Bind [select]" gives the eye no way to tell which label
       * owns which control except proximity — and in Live Queue's spool row
       * the control to the right of "Set priority" was a button that cancelled
       * messages.
       *
       * So: measure where the label is. Above the control is a field. Beside
       * it, with another field on the same band, is the thing that was
       * reported.
       */
      const byPanel = new Map();
      for (const control of document.querySelectorAll('input, select, textarea')) {
        if (!seen(control)) continue;
        if (['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(control.type)) continue;
        const field = control.closest('label, .field');
        if (!field || !labelText(field)) continue;
        const panel = control.closest('fieldset, form, section, .panel, .card') ?? document.body;
        if (!byPanel.has(panel)) byPanel.set(panel, []);
        byPanel.get(panel).push({ control, field });
      }
      /** True when the label text sits to the SIDE of the control. */
      const labelIsInline = (field, control) => {
        // The label text is whatever the field holds that is not the control.
        const caption = field.querySelector('span, .label') ?? field;
        const captionBox = caption.getBoundingClientRect();
        const controlBox = control.getBoundingClientRect();
        if (!captionBox.width || !controlBox.width) return false;
        // Above means the caption ends at or before the control begins,
        // vertically. 2px of slack for sub-pixel layout.
        return captionBox.bottom > controlBox.top + 2;
      };
      for (const [panel, entries] of byPanel) {
        if (entries.length < 2) continue;
        const bands = new Map();
        for (const { control, field } of entries) {
          const band = Math.round(control.getBoundingClientRect().top / 12);
          if (!bands.has(band)) bands.set(band, []);
          bands.get(band).push({
            name: labelText(field),
            inline: labelIsInline(field, control),
          });
        }
        for (const [, found] of bands) {
          if (found.length < 2) continue;
          const inline = found.filter((f) => f.inline);
          if (!inline.length) continue;
          problems.push({
            kind: 'inline labels share a row',
            where: (panel.querySelector('h1,h2,h3,legend')?.textContent ?? '').trim().slice(0, 40),
            detail: found
              .map((f) => (f.inline ? `${f.name} (inline)` : f.name))
              .join(' + '),
          });
        }
      }

      // --- a button cluster that wraps --------------------------------------
      for (const group of document.querySelectorAll(
        '.row-actions, .panel-actions, .actions, .toolbar, .button-row, .dialog-footer, .filters',
      )) {
        const buttons = [...group.querySelectorAll('button, a.button, .btn')].filter(seen);
        if (buttons.length < 2) continue;
        const tops = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top / 8)));
        if (tops.size > 1)
          problems.push({
            kind: `button cluster on ${tops.size} rows`,
            where: (group.closest('section,.panel,.card')?.querySelector('h1,h2,h3')?.textContent ?? '')
              .trim()
              .slice(0, 40),
            detail: buttons.map((b) => b.textContent.trim().slice(0, 18)).join(' / '),
          });
      }

      // --- registers: row height and paging ---------------------------------
      for (const table of document.querySelectorAll('table')) {
        const rows = [...table.querySelectorAll('tbody tr')].filter(seen);
        // One row is usually the empty state, whose height is not the row height.
        if (rows.length < 3) continue;
        const heights = rows.map((r) => r.getBoundingClientRect().height);
        const median = heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)];
        const caption = (
          table.closest('section,.panel,.card')?.querySelector('h1,h2,h3')?.textContent ?? ''
        )
          .trim()
          .slice(0, 40);
        if (median > MAX_ROW_HEIGHT)
          problems.push({
            kind: 'tall rows',
            where: caption,
            detail: `${Math.round(median)}px per row over ${rows.length} rows`,
          });
        if (rows.length >= PAGER_NEEDED_FROM) {
          const scope = table.closest('section,.panel,.card') ?? document.body;
          const pager = [...scope.querySelectorAll('button, select, [class*=pag]')].some((el) =>
            /next|previous|prev\b|per page|page size|rows per/i.test(el.textContent ?? ''),
          );
          if (!pager)
            problems.push({
              kind: 'no pager',
              where: caption,
              detail: `${rows.length} rows rendered at once`,
            });
        }
      }
      return problems;
    },
    { MAX_ROW_HEIGHT, PAGER_NEEDED_FROM },
  );

const findings = [];
for (const route of ROUTES) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // A tabbed screen hides most of itself, so each tab is measured in turn.
  const tabs = await page.locator('[role="tab"], .tab, nav.tabs a, .tabs button').all();
  const labels = [];
  for (const tab of tabs) {
    const text = (await tab.textContent().catch(() => ''))?.trim() ?? '';
    if (text) labels.push(text);
  }

  const record = (tab, list) => {
    for (const problem of list) findings.push({ route, tab, ...problem });
  };
  record(null, await measure());

  for (let index = 0; index < tabs.length; index += 1) {
    await tabs[index].click().catch(() => undefined);
    await page.waitForTimeout(900);
    record(labels[index] ?? `tab ${index + 1}`, await measure());
  }
  if (labels.length) console.log(`  ${route}: ${labels.length} tab(s) — ${labels.join(', ')}`);
}

await browser.close();

const bar = '='.repeat(94);
console.log(`\n${bar}\nLAYOUT AUDIT — ${ROUTES.length} route(s)\n${bar}`);
if (!findings.length) console.log('\n  Nothing measurable is wrong on these screens.\n');
const byRoute = new Map();
for (const f of findings) {
  const key = f.tab ? `${f.route}  [${f.tab}]` : f.route;
  if (!byRoute.has(key)) byRoute.set(key, []);
  byRoute.get(key).push(f);
}
for (const [key, list] of byRoute) {
  console.log(`\n${key}`);
  // The same structural problem repeats per row of a table; say so once.
  const unique = new Map();
  for (const f of list) {
    const id = `${f.kind} ${f.where} ${f.detail}`;
    unique.set(id, (unique.get(id) ?? 0) + 1);
  }
  for (const [id, count] of unique) {
    const [kind, where, detail] = id.split(' ');
    console.log(`   ${kind}${count > 1 ? ` (x${count})` : ''}  ${where ? `— ${where}` : ''}`);
    console.log(`      ${detail}`);
  }
}
console.log(`\n${bar}\n${findings.length} finding(s).`);
process.exitCode = findings.length ? 1 : 0;
