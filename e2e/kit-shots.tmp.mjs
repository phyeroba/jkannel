// Photographs every screen of the handed-over UI kit, and the matching screen
// of our running console, into one folder for side-by-side comparison.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `design-diff.mjs` compares CSS declarations and `screen-diff.mjs` compares
// panel titles and column headers. Both passed at 620/620 and 0 missing
// selectors while the console still did not look like the package, because
// neither of them can see a panel that was never built. The kit ships a
// self-contained `index.html` that transpiles in-browser — it can simply be
// opened and photographed, and that should have been the first thing done.
//
// Usage:  node scripts/kit-shots.mjs [outputDir]
//         BASE=http://127.0.0.1:15173 U=operator P=... node scripts/kit-shots.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const KIT = 'd:/JKANNEL/design/JKANNEL design system/ui_kits/console/index.html';
const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const OUT = process.argv[2] ?? 'd:/JKANNEL/docs/design-comparison';

/**
 * Kit nav label -> our route. The kit's own sidebar labels are the left column,
 * so a screen the kit has and we do not shows up as a missing route rather than
 * being silently skipped.
 */
const SCREENS = [
  ['Dashboard', '/dashboard/operations'],
  ['Alerts', '/alerts'],
  ['Carriers', '/carriers'],
  ['SMSCs', '/smsc'],
  ['SMPP Sessions', '/smpp-sessions'],
  ['Live Traffic', '/live-traffic'],
  ['Queues', '/queues'],
  ['DLR Performance', '/dlr-performance'],
  ['Carrier Routes', '/routing'],
  ['Failover', '/failover'],
  ['Route Simulator', '/route-simulator'],
  ['Message Trace', '/message-trace'],
  ['SMPP Errors', '/smpp-errors'],
  ['Events', '/events'],
  ['Logs', '/logs-audit'],
  ['Test Tools', '/test-tools'],
  ['Engine Configuration', '/configuration'],
  ['Services', '/services'],
  ['Nodes', '/nodes'],
  ['Performance', '/reports'],
  ['Audit Trail', '/logs-audit'],
  ['Users & Roles', '/users'],
];

const VIEWPORT = { width: 1600, height: 1100 };
fs.mkdirSync(OUT, { recursive: true });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const browser = await chromium.launch();

// --- The kit ---------------------------------------------------------------
const kitCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const kit = await kitCtx.newPage();
await kit.goto(pathToFileURL(KIT).href, { waitUntil: 'load' });
await kit.waitForTimeout(8000);
// The kit boots on its login screen.
const signIn = kit.locator('button', { hasText: /^Sign in$/i }).first();
if (await signIn.count()) {
  await signIn.click();
  await kit.waitForTimeout(2500);
}

const kitCaptured = [];
for (const [label] of SCREENS) {
  // Open the owning section first: the kit's sidebar is an accordion.
  const groups = kit.locator('.nav-label');
  for (let i = 0; i < (await groups.count()); i += 1) {
    const link = kit.locator('.sidebar a', { hasText: new RegExp(`^${label}$`, 'i') }).first();
    if (await link.count()) break;
    await groups.nth(i).click();
    await kit.waitForTimeout(250);
  }
  const link = kit.locator('.sidebar a', { hasText: new RegExp(`^${label}$`, 'i') }).first();
  if (!(await link.count())) {
    console.log(`kit: NO SUCH SCREEN  ${label}`);
    continue;
  }
  await link.click();
  await kit.waitForTimeout(1200);
  await kit.screenshot({ path: path.join(OUT, `kit--${slug(label)}.png`), fullPage: true });
  kitCaptured.push(label);
  console.log(`kit: ${label}`);
}
await kitCtx.close();

// --- Ours ------------------------------------------------------------------
const ourCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const ours = await ourCtx.newPage();
ours.on('pageerror', (e) => console.log('OURS PAGE ERROR:', e.message));
await ours.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await ours.fill('[data-testid="username"]', process.env.U ?? 'operator');
await ours.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  ours.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  ours.click('[data-testid="login-submit"]'),
]);

for (const [label, route] of SCREENS) {
  if (!kitCaptured.includes(label)) continue;
  await ours.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await ours.waitForTimeout(4500);
  await ours.screenshot({ path: path.join(OUT, `ours--${slug(label)}.png`), fullPage: true });
  console.log(`ours: ${label}`);
}
await ourCtx.close();
await browser.close();
console.log(`\n${kitCaptured.length} screens captured to ${OUT}`);
