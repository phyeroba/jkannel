// Captures console screenshots for the repository README.
//
// Run against a LOCAL stack only. The shots are of a development instance with
// fake binds and no real traffic, which is deliberate: publishing screenshots of
// production would put real subscriber numbers, real carrier names and real
// volumes into a public repository. Masking protects the numbers, but the
// carrier and SMSC identifiers are not masked and should not be advertised.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const API = process.env.API ?? 'http://127.0.0.1:13200/api/v1';
const OUT = process.env.OUT ?? 'd:/JKANNEL/docs/screenshots';

/** The pages worth showing someone deciding whether to read further. */
const SHOTS = [
  { file: 'services.png', route: '/services', title: 'Services board' },
  { file: 'nodes.png', route: '/nodes', title: 'Nodes' },
  { file: 'dashboard.png', route: '/dashboard/operations', title: 'Operations dashboard' },
  { file: 'analytics.png', route: '/reports', title: 'Reports and analytics' },
  { file: 'messages.png', route: '/messages', title: 'Messages (masked)' },
  { file: 'carriers.png', route: '/carriers', title: 'Carriers' },
  { file: 'smsc.png', route: '/smsc', title: 'SMSC connections' },
  { file: 'routing.png', route: '/routing', title: 'Routing' },
  { file: 'live-traffic.png', route: '/live-traffic', title: 'Live traffic' },
  { file: 'queues.png', route: '/queues', title: 'Queues' },
  { file: 'message-trace.png', route: '/message-trace', title: 'Message trace' },
  { file: 'test-tools.png', route: '/test-tools', title: 'Test tools' },
  { file: 'api-reference.png', route: '/api-reference', title: 'API reference' },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  // 1440x900 at 2x: sharp on a retina display and still legible inlined in a
  // README at half width.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

// Sign in through the actual form rather than seeding a token. The session
// store populates from the login response, so a bare localStorage token leaves
// `identity` null and the route guard bounces every page back to /login — which
// is exactly what the first run captured, twelve times.
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);
console.log('signed in as', process.env.U ?? 'operator');
for (const shot of SHOTS) {
  await page.goto(BASE + shot.route, { waitUntil: 'domcontentloaded' });
  // Wait for the skeleton to clear rather than guessing a delay. /services runs
  // eight probes with 3s timeouts, so a fixed 1.8s wait captured it mid-load —
  // a screenshot of a loading state advertises the wrong thing entirely.
  // Wait for DataState's skeleton to be gone. Testing the text was too loose —
  // the skeleton carries no words, so the condition passed while the page was
  // still grey bars. The element itself is the honest signal.
  // A flat wait, deliberately. Two cleverer conditions failed: the text test
  // passed while the page was still grey bars (a skeleton carries no words),
  // and `main .skeleton` never matched because DataState renders its skeleton
  // outside <main>. /services is the slow one at ~4s (eight probes, 3s
  // timeouts), so 6s clears it with room to spare.
  await page.waitForTimeout(6000);
  const target = path.join(OUT, shot.file);
  await page.screenshot({ path: target, fullPage: false });
  const kb = Math.round(fs.statSync(target).size / 1024);
  console.log(`${shot.file.padEnd(22)} ${String(kb).padStart(4)} KB  ${shot.title}`);
}

await browser.close();
