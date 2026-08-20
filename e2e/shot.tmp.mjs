import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:15173';
const OUT =
  'C:/Users/PETERH~1/AppData/Local/Temp/claude/d--JKANNEL/405235fa-7822-4231-8e2e-3b9df11f5d1c/scratchpad/cmp';
fs.mkdirSync(OUT, { recursive: true });
const routes = process.argv.slice(2);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', 'operator');
await page.fill('[data-testid="password"]', 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);
for (const route of routes) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const name = 'ours--' + (route.replace(/^\//, '').replace(/\//g, '-') || 'root') + '.png';
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('captured', route);
}
await browser.close();
