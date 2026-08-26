#!/usr/bin/env node
/**
 * OPEN EVERY DIALOG AND LOOK AT WHAT IS ACTUALLY RENDERED.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * "The popup is squashed" was reported for three separate screens, and reading
 * the CSS said everything was correct: the field grid is
 * `repeat(auto-fit, minmax(…, 1fr))`, ported from the kit's own Add SMSC
 * dialog, byte for byte.
 *
 * It was correct and the result was wrong, because the kit's card is 620px wide
 * and ours is 900px for a create form. The same `minmax(200px, 1fr)` yields two
 * tracks of 283px there and four tracks of 205px here. A rule copied faithfully
 * from a design system can still render nothing like the design system, and the
 * only way to know is to open the thing and measure it.
 *
 * WHAT IT FLAGS
 * ---------------------------------------------------------------------------
 *  - A FIELD TRACK NARROWER THAN `MIN_TRACK`. A label, a control and a hint
 *    need room; below this they stack into unreadability.
 *  - A DIALOG WIDER THAN THE VIEWPORT, or a body that scrolls HORIZONTALLY.
 *    Vertical scrolling in a long form is correct and is not flagged.
 *  - A CONTROL OVERFLOWING ITS FIELD, which is how a too-narrow track shows up
 *    even when the track itself passes.
 *
 * It does not judge whether a dialog is beautiful. It reports the geometry that
 * makes one unusable, and leaves taste to a person.
 *
 *   node scripts/dialog-audit.mjs
 */
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
/** The kit renders its dialog fields at about 283px. Anything much under that
 *  is narrower than the design it is meant to reproduce. */
const MIN_TRACK = Number(process.env.MIN_TRACK ?? 260);

/**
 * The openers, by the button an operator clicks.
 *
 * Listed rather than discovered: clicking every button on every screen would
 * also click Delete, Reconnect and Deploy, and this must be safe to run against
 * a live console.
 */
const CASES = [
  { route: '/carriers', button: 'New carrier' },
  { route: '/smsc', button: 'Add SMSC' },
  { route: '/customers', button: 'Add customer' },
  { route: '/routing-advanced', button: 'New route' },
  { route: '/recipient-policy', button: 'New entry' },
  { route: '/roles', button: 'New role' },
  { route: '/messages', button: 'Send message' },
  { route: '/api-gateway', button: 'Create API client' },
  { route: '/reports', button: 'New definition' },
];

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
const opened = [];
const notFound = [];

for (const testCase of CASES) {
  await page.goto(BASE + testCase.route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // Buttons and links both open dialogs in this console.
  const opener = page
    .locator('main button, main a', { hasText: new RegExp(`^\\s*${testCase.button}\\s*$`, 'i') })
    .first();
  if (!(await opener.count())) {
    notFound.push(`${testCase.route} → "${testCase.button}"`);
    continue;
  }
  await opener.click();
  await page.waitForTimeout(1200);

  const measured = await page.evaluate(() => {
    const card = document.querySelector('.command-dialog, [role="dialog"]');
    if (!card) return null;
    const cardBox = card.getBoundingClientRect();
    const body = card.querySelector('.dialog-body');
    // An EMPTY grid is skipped. A collapsed fieldset in the SMSC form renders
    // its container with no children, and `auto-fit` collapses every track to
    // 0px — which the first version of this reported as a 0px field, i.e. as
    // the very worst possible result, for a group that is not on screen. A
    // measurement that fires hardest on something invisible trains people to
    // ignore it.
    const grids = [...card.querySelectorAll('.dialog-grid')]
      .filter((grid) =>
        [...grid.children].some((child) => child.getBoundingClientRect().width > 0),
      )
      .map((grid) => {
        const tracks = getComputedStyle(grid)
          .gridTemplateColumns.split(' ')
          .map((t) => Number.parseFloat(t))
          .filter((n) => Number.isFinite(n) && n > 0);
        return { tracks: tracks.length, narrowest: tracks.length ? Math.min(...tracks) : null };
      });
    // A control wider than the field that holds it. 2px of slack, because
    // sub-pixel layout is not an overflow.
    let overflowing = 0;
    for (const field of card.querySelectorAll('.field, label')) {
      const fieldWidth = field.getBoundingClientRect().width;
      for (const control of field.querySelectorAll('input, select, textarea'))
        if (control.getBoundingClientRect().width > fieldWidth + 2) overflowing += 1;
    }
    return {
      title: (card.querySelector('h2, h3, header')?.textContent ?? '').trim().slice(0, 40),
      width: Math.round(cardBox.width),
      height: Math.round(cardBox.height),
      viewportWidth: window.innerWidth,
      bodyScrollWidth: body?.scrollWidth ?? null,
      bodyClientWidth: body?.clientWidth ?? null,
      grids,
      overflowing,
    };
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  if (!measured) {
    findings.push({ ...testCase, problem: 'the button did not open a dialog' });
    continue;
  }
  opened.push({ ...testCase, ...measured });

  const narrowest = measured.grids
    .map((g) => g.narrowest)
    .filter((n) => n !== null)
    .reduce((a, b) => (a === null || b < a ? b : a), null);
  if (narrowest !== null && narrowest < MIN_TRACK)
    findings.push({
      ...testCase,
      problem: `field track ${Math.round(narrowest)}px, under the ${MIN_TRACK}px a label, control and hint need (${measured.grids.map((g) => `${g.tracks} cols`).join(', ')})`,
    });
  if (measured.width > measured.viewportWidth)
    findings.push({ ...testCase, problem: `${measured.width}px wide in a ${measured.viewportWidth}px viewport` });
  if (measured.bodyScrollWidth && measured.bodyScrollWidth > (measured.bodyClientWidth ?? 0) + 2)
    findings.push({
      ...testCase,
      problem: `body scrolls horizontally (${measured.bodyScrollWidth}px of content in ${measured.bodyClientWidth}px)`,
    });
  if (measured.overflowing)
    findings.push({ ...testCase, problem: `${measured.overflowing} control(s) wider than the field holding them` });
}

await browser.close();

console.log('='.repeat(92));
console.log(`DIALOG AUDIT — ${opened.length} dialog(s) opened and measured`);
console.log('='.repeat(92));

for (const dialog of opened)
  console.log(
    `\n  ${dialog.route} → ${dialog.button}\n      ${dialog.width}×${dialog.height}px · ` +
      (dialog.grids.length
        ? dialog.grids
            .map((g) => `${g.tracks} track(s) at ${Math.round(g.narrowest ?? 0)}px`)
            .join(', ')
        : 'no field grid'),
  );

if (notFound.length) {
  console.log('\nOPENER NOT FOUND (the screen or its button may have been renamed):\n');
  for (const entry of notFound) console.log(`  ${entry}`);
}

if (findings.length) {
  console.log('\nPROBLEMS:\n');
  for (const f of findings) console.log(`  ${f.route} → ${f.button}\n      ${f.problem}`);
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  findings.length
    ? `${findings.length} problem(s) across ${opened.length} dialog(s).`
    : `All ${opened.length} dialogs give their fields room and fit their viewport.`,
);
process.exitCode = findings.length ? 1 : 0;
