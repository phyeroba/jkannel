#!/usr/bin/env node
/**
 * DOES IT LOOK LIKE THE KIT — measured on the rendered page, not in the CSS.
 *
 * WHY `design-diff` IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * `design-diff.mjs` compares stylesheets and now reports 622 declarations
 * matching and none diverging. That is necessary and it is not sufficient: it
 * proves the RULES agree, not that the PIXELS do. A rule can match perfectly
 * and still lose at runtime — outranked by `style.css`, by a scoped component
 * style, by an inline style, or by a selector that never matches the markup we
 * actually render. Every one of those produces a screen that looks wrong while
 * the CSS audit stays green.
 *
 * So this opens the kit and the console side by side in one browser, finds the
 * same component in each, and compares `getComputedStyle` — the value the
 * browser resolved after the whole cascade, which is the only thing an operator
 * ever sees.
 *
 * WHAT IT COMPARES, AND WHY THOSE
 * ---------------------------------------------------------------------------
 * The properties that carry a design's identity: type size and weight, colour,
 * background, radius, border and padding. Not layout geometry — width and
 * position legitimately differ between a click-through with three fake rows and
 * a console with a real register, and comparing them would bury the signal.
 *
 *   node scripts/rendered-diff.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KIT = 'd:/JKANNEL/design/JKANNEL design system/ui_kits/console/index.html';
const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';

/**
 * A component, the selector that finds it in each place, and the route to be on
 * when looking. Selectors are the design system's own class names, which is the
 * point: if our markup does not carry them, the component is not the kit's
 * component however similar it looks.
 */
const COMPONENTS = [
  { name: 'panel', selector: '.panel', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'panel heading', selector: '.panel h2', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'primary button', selector: '.primary-button', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'secondary button', selector: '.secondary-button', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'table header cell', selector: 'table th', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'table body cell', selector: 'table td', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'status badge', selector: '.status-badge', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'sidebar link', selector: '.sidebar nav a', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'filter select', selector: '.filter-select select', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'chip', selector: '.chip', kitScreen: 'SMSCs', route: '/smsc' },
  { name: 'metric card', selector: '.metric-card', kitScreen: 'Dashboard', route: '/dashboard/operations' },
  { name: 'source note', selector: '.source-note', kitScreen: 'Dashboard', route: '/dashboard/operations' },
];

/** The properties that carry identity. Geometry is deliberately excluded. */
const PROPS = [
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textTransform',
  'color',
  'backgroundColor',
  'borderRadius',
  'borderTopWidth',
  'borderTopColor',
  'paddingTop',
  'paddingLeft',
];

/**
 * The most REPRESENTATIVE element for a selector, not the first one in the DOM.
 *
 * `querySelector` returns the first match, and the first match is routinely a
 * variant: our first `.panel` on the SMSC screen is `toolbar panel
 * grid-toolbar`, and the first `select` on any screen is the topbar's time
 * range. Comparing a toolbar against the kit's plain panel produced four
 * "rendered differences" that were really the tool comparing two different
 * components — the same class of false reading as everywhere else in this
 * tooling.
 *
 * So: prefer an element inside `main`, which excludes the topbar and sidebar
 * chrome, and among those take the one carrying the FEWEST classes — the
 * plainest instance, which is what the design system's base rule describes.
 * The chosen instance is reported alongside any difference, so a comparison
 * between two differently-modified elements stays visible instead of being
 * quietly counted as a divergence in the design.
 */
const read = (page, selector) =>
  page.evaluate(
    ({ selector, props }) => {
      const all = [...document.querySelectorAll(selector)];
      if (!all.length) return null;
      const scoped = all.filter((el) => el.closest('main'));
      const pool = scoped.length ? scoped : all;
      const el = pool.reduce((best, candidate) =>
        candidate.classList.length < best.classList.length ? candidate : best,
      );
      const style = getComputedStyle(el);
      return {
        ...Object.fromEntries(props.map((p) => [p, style[p]])),
        __classes: el.className || '(none)',
      };
    },
    { selector, props: PROPS },
  );

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

// --- the kit ----------------------------------------------------------------
const kitPage = await context.newPage();
await kitPage.goto(pathToFileURL(KIT).href, { waitUntil: 'load' });
await kitPage.waitForTimeout(8000);
// The kit boots on its own login screen and its sidebar is an accordion, so a
// component has to be navigated to before it exists in the DOM. Reading the
// landing page and calling everything "not present in the kit" is how this
// silently compared one button and declared the rest unavailable.
const signIn = kitPage.locator('button', { hasText: /^Sign in$/i }).first();
if (await signIn.count()) {
  await signIn.click();
  await kitPage.waitForTimeout(2500);
}
async function kitGoto(label) {
  const groups = kitPage.locator('.nav-label');
  for (let i = 0; i < (await groups.count()); i += 1) {
    if (await kitPage.locator('.sidebar a', { hasText: new RegExp(`^${label}$`, 'i') }).count())
      break;
    await groups.nth(i).click();
    await kitPage.waitForTimeout(200);
  }
  const link = kitPage.locator('.sidebar a', { hasText: new RegExp(`^${label}$`, 'i') }).first();
  if (!(await link.count())) return false;
  await link.click();
  await kitPage.waitForTimeout(1200);
  return true;
}

// --- ours -------------------------------------------------------------------
const appPage = await context.newPage();
await appPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await appPage.fill('[data-testid="username"]', process.env.U ?? 'operator');
await appPage.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  appPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  appPage.click('[data-testid="login-submit"]'),
]);

const rows = [];
let currentRoute = '';
let currentKitScreen = '';
for (const component of COMPONENTS) {
  if (component.kitScreen !== currentKitScreen) {
    await kitGoto(component.kitScreen);
    currentKitScreen = component.kitScreen;
  }
  if (component.route !== currentRoute) {
    await appPage.goto(BASE + component.route, { waitUntil: 'domcontentloaded' });
    await appPage.waitForTimeout(3000);
    currentRoute = component.route;
  }
  const [want, got] = await Promise.all([
    read(kitPage, component.selector),
    read(appPage, component.selector),
  ]);
  rows.push({ ...component, want, got });
}
await browser.close();

// --- report -----------------------------------------------------------------
console.log('='.repeat(92));
console.log('RENDERED DIFF — computed styles, kit vs console');
console.log('='.repeat(92));

let diffCount = 0;
let absent = 0;
let compared = 0;
for (const row of rows) {
  if (!row.want) {
    console.log(`\n  ${row.name}  — not present in the kit at this screen, skipped`);
    continue;
  }
  if (!row.got) {
    absent += 1;
    console.log(`\n  ${row.name}  — MISSING from the console (${row.selector})`);
    continue;
  }
  const differences = PROPS.filter((p) => row.want[p] !== row.got[p]);
  compared += PROPS.length;
  if (!differences.length) continue;
  diffCount += differences.length;
  console.log(`\n  ${row.name}   (${row.selector})`);
  // Which instance each side measured. A difference caused by comparing two
  // variants of a component must be visible, not counted as a design divergence.
  if (row.want.__classes !== row.got.__classes)
    console.log(`      instance          kit "${row.want.__classes}"  ours "${row.got.__classes}"`);
  for (const prop of differences)
    console.log(`      ${prop.padEnd(18)} kit ${String(row.want[prop]).padEnd(26)} ours ${row.got[prop]}`);
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  diffCount === 0 && absent === 0
    ? `Every component renders identically to the kit across ${compared} computed properties.`
    : `${diffCount} rendered difference(s) across ${compared} properties · ${absent} component(s) missing.`,
);
fs.writeFileSync(path.join(ROOT, 'docs/rendered-diff.json'), JSON.stringify(rows, null, 2));
