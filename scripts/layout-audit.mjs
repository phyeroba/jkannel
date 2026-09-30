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
import fs from 'node:fs';
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
 *
 * RAISED 92 -> 104 on 2026-09-30. The house identity cell is a name with its
 * id beneath it (`<strong>` over `small.row-id`, which is `display: block`),
 * and that is two lines plus 28px of padding — about 98px. At 92 the audit was
 * asking a deliberate, consistent pattern to be flattened, which is the
 * failure mode this file's own header warns about: a tool that talks the next
 * person out of a layout that was already right. Every genuine finding this
 * sweep produced was 109px or more (configuration 109, mo-routing 128, smsc
 * 129, backup 163, alerts 243, roles 336), so 104 still catches all of them.
 */
const MAX_ROW_HEIGHT = Number(process.env.MAX_ROW ?? 104);
/** Below this many rows a register does not yet need a pager. */
const PAGER_NEEDED_FROM = Number(process.env.PAGER_FROM ?? 25);

/*
 * EVERY SCREEN, NOT THE SIX THAT WERE COMPLAINED ABOUT.
 *
 * This defaulted to the six routes from the original report, so the rules below
 * were correct and simply never looked anywhere else. `/alerts` was rendering
 * 31 rows at an average of 243px each — 7,579px of table, on a screen an
 * operator opens during an incident — and this script had no opinion about it,
 * because `/alerts` was not in the list.
 *
 * Read from `navigation.ts` the way `route-smoke.mjs` already does, so a screen
 * added later is swept automatically rather than missed because nobody updated
 * a list here. `ROUTES=` still narrows it while working on one screen.
 */
const NAV = new URL('../frontend/src/navigation.ts', import.meta.url);
const ROUTES = process.env.ROUTES
  ? process.env.ROUTES.split(',')
  : [
      ...new Set([
        '/dashboard/operations',
        ...[...fs.readFileSync(NAV, 'utf8').matchAll(/to:\s*'([^']+)'/g)]
          .map((match) => match[1])
          .filter((to) => !to.includes(':')),
      ]),
    ];

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
      /** Deliberate exemptions, reported separately so they stay visible. */
      const notes = [];
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
        /*
         * A TOOLBAR IS NOT A FORM.
         *
         * A refresh bar ("Live updates [On] Every [5s] Rank by [depth]") or a
         * filter bar is SUPPOSED to run its labels inline. Those controls are
         * independent switches over the view, not fields of one record, and
         * each caption names the control immediately to its right — there is
         * no second field for the eye to pair it with by mistake.
         *
         * Without this the audit reported three correct toolbars as defects,
         * which is the failure the header warns about: a tool that talks the
         * next person out of a layout that was already right. The rule below
         * is about FORMS.
         */
        if (control.closest('.toolbar, .grid-toolbar, .filters, .log-refresh')) continue;
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
      const CLUSTERS =
        '.row-actions, .panel-actions, .actions, .toolbar, .button-row, .dialog-footer, .filters';
      for (const group of document.querySelectorAll(CLUSTERS)) {
        /*
         * A DECLARED SUB-GROUP IS ITS OWN CLUSTER.
         *
         * The rule is "buttons that mean one thing belong on one line", and
         * `.button-row` is how a screen declares which buttons those are. A
         * toolbar holding a primary action AND a `.button-row` of secondary
         * ones is two clusters, not one badly-wrapped cluster — measuring it
         * flat reported nine workspace screens the moment the group was given
         * room to wrap as a unit, which is the behaviour the rule wants.
         *
         * So a container measures only the buttons it owns directly; the ones
         * inside a nested cluster are measured with that cluster instead.
         */
        const buttons = [...group.querySelectorAll('button, a.button, .btn')]
          .filter(seen)
          .filter((button) => button.closest(CLUSTERS) === group);
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
          /*
           * A BOUNDED TABLE MAY DECLINE, IN WRITING.
           *
           * "Fine at 20 rows, a different screen at 20,000" assumes the list
           * grows. A permission catalogue and the API's own endpoint list do
           * not: they are as long as the product is, they are read by scanning
           * rather than by paging, and both already have a search box. A pager
           * there is a control that never helps anybody.
           *
           * So a table may opt out with `data-bounded="why"` — and the reason
           * is REPORTED rather than swallowed, so an exemption stays visible
           * and can be argued with. An empty or missing reason is not an
           * exemption.
           */
          const bounded = (table.getAttribute('data-bounded') ?? '').trim();
          if (!pager && bounded)
            notes.push({ kind: 'bounded, no pager by design', where: caption, detail: bounded });
          else if (!pager)
            problems.push({
              kind: 'no pager',
              where: caption,
              detail: `${rows.length} rows rendered at once`,
            });
        }
      }
      // Exemptions ride along tagged, so the reporter can list them apart from
      // the findings rather than either hiding them or crying wolf.
      return [...problems, ...notes.map((note) => ({ ...note, exempt: true }))];
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

/*
 * Exemptions are printed, not swallowed. A table that declared itself bounded
 * is a decision somebody made and should be able to argue with later; an
 * exemption nobody can see is indistinguishable from a rule that stopped
 * working.
 */
const exempt = findings.filter((f) => f.exempt);
const problems = findings.filter((f) => !f.exempt);
if (exempt.length) {
  console.log('\nDECLARED EXEMPT — reported so they stay arguable:\n');
  const seen = new Set();
  for (const f of exempt) {
    const id = `${f.route} ${f.where} ${f.detail}`;
    if (seen.has(id)) continue;
    seen.add(id);
    console.log(`  ${f.route} — ${f.where}\n      ${f.detail}`);
  }
}

if (!problems.length) console.log('\n  Nothing measurable is wrong on these screens.\n');
const byRoute = new Map();
for (const f of problems) {
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
console.log(
  `\n${bar}\n${problems.length} finding(s)` +
    (exempt.length ? `, plus ${exempt.length} declared exempt.` : '.'),
);
process.exitCode = problems.length ? 1 : 0;
