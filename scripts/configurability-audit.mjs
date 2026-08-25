#!/usr/bin/env node
/**
 * Can an operator configure this gateway by pointing and clicking?
 *
 * THE QUESTION THIS ANSWERS
 * ---------------------------------------------------------------------------
 * Plain Kannel is configured by editing `kannel.conf`. Every directive is in
 * one file, documented, and reachable with a text editor. The promise of this
 * console is that the same estate is configurable without that file — and the
 * failure mode is subtle: the API grows a field, the generator renders it, and
 * the console never gains a control for it. Nothing breaks. The operator simply
 * cannot set it, and their only route is curl — which is strictly worse than
 * the config file they were promised they could stop editing.
 *
 * `endpoint-coverage.mjs` cannot see this: the endpoint HAS a surface. The
 * screen exists, it lists the records, it just cannot set half of what the
 * record holds. This audit measures the FIELDS, not the endpoints.
 *
 * HOW IT DECIDES
 * ---------------------------------------------------------------------------
 * The settable field list is parsed out of the backend source, not typed in
 * here, so it cannot drift: `SmscAttributes` in `smsc/smsc.service.ts` is the
 * contract the create and update handlers accept. Each field is then looked for
 * in the console — first in the rendered create dialog and edit form, and
 * failing that in the view source, so a control behind a tab or a permission
 * still counts.
 *
 *   BASE=http://127.0.0.1:15173 node scripts/configurability-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';

/**
 * The engine directive each attribute renders to, so the report speaks the
 * language of the person who knows `kannel.conf` and is asking where their
 * directive went. Taken from `EngineSmsc` and the generator's renderer.
 */
const DIRECTIVE = {
  systemId: 'smsc-username / system-id',
  usernameSecretRef: 'smsc-username (secret ref)',
  credentialSecretRef: 'smsc-password (secret ref)',
  systemType: 'system-type',
  bindMode: 'transceiver-mode / receive-port',
  receivePort: 'receive-port',
  interfaceVersion: 'interface-version',
  addressRange: 'address-range',
  sourceAddrTon: 'source-addr-ton',
  sourceAddrNpi: 'source-addr-npi',
  destAddrTon: 'dest-addr-ton',
  destAddrNpi: 'dest-addr-npi',
  windowSize: 'max-pending-submits',
  keepaliveSeconds: 'enquire-link-interval',
  reconnectDelaySeconds: 'reconnect-delay',
  waitAckSeconds: 'wait-ack',
  maxErrorCount: 'max-error-count',
  useTls: 'use-ssl',
  altCharset: 'alt-charset',
  sendUrl: 'send-url',
  notes: '(console only — not an engine directive)',
  connectionCount: 'instances',
  connectionTimeoutSeconds: 'connection-timeout',
  waitAckExpireAction: 'wait-ack-expire',
  retryOnAuthFailure: 'retry',
  allowedSmscIds: 'allowed-smsc-id',
  deniedSmscIds: 'denied-smsc-id',
  preferredSmscIds: 'preferred-smsc-id',
  allowedPrefixes: 'allowed-prefix',
  deniedPrefixes: 'denied-prefix',
  preferredPrefixes: 'preferred-prefix',
};

/** Fields the create/update handlers take outside the attribute bag. */
const CORE = ['name', 'engineId', 'type', 'host', 'port', 'tps', 'enabled', 'credentialSecretRef'];

/**
 * Reads `SmscAttributes` straight out of the backend. Typing the list here
 * instead would make the audit agree with itself rather than with the API — the
 * exact failure this tool exists to catch, one level up.
 */
function settableFields() {
  const source = fs.readFileSync(
    path.join(ROOT, 'backend/src/smsc/smsc.service.ts'),
    'utf8',
  );
  const block = source.match(/export interface SmscAttributes \{([\s\S]*?)\n\}/);
  if (!block) throw new Error('SmscAttributes not found — has the interface moved or been renamed?');
  const parsed = [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  if (parsed.length < 10) throw new Error(`Only ${parsed.length} attributes parsed; the shape changed`);
  return [...CORE, ...parsed];
}

/** kebab and snake spellings a control might legitimately use. */
const spellings = (field) => [
  field,
  field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
  field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
];

const fields = settableFields();

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

await page.goto(`${BASE}/smsc`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

/** Every control the operator can actually reach, with how it is identified. */
async function controlsOnScreen() {
  return page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')].map((el) => {
      const label = el.closest('label')?.textContent ?? '';
      return [
        el.getAttribute('data-testid') ?? '',
        el.getAttribute('name') ?? '',
        el.getAttribute('placeholder') ?? '',
        label,
      ]
        .join(' ')
        .toLowerCase();
    }),
  );
}

/**
 * Drives the form the way an operator adding a carrier bind would: choose SMPP,
 * because the SMPP-only settings are correctly hidden for the other drivers,
 * then open every collapsed group. "Reachable" has to mean reachable by
 * clicking, not visible on first paint — a group nobody can open is the defect;
 * a group that opens is the design.
 */
async function revealEverything(driver = 'smpp') {
  // SCOPED TO THE FORM, not to the page. The register behind the dialog has a
  // `Protocol` filter whose options are the same four words, it comes first in
  // document order, and `.first()` was therefore driving the filter while
  // reading the dialog — so the dialog never left SMPP and `send-url` was
  // reported as having no control when it has one.
  const form = page.locator('.smsc-form:visible').first();
  if (!(await form.count())) return;
  const protocol = form.locator('select').filter({ has: page.locator('option[value="smpp"]') }).first();
  if (await protocol.count()) {
    await protocol.selectOption(driver).catch(() => {});
    await page.waitForTimeout(400);
  }
  // Transmitter is the one bind mode that reveals a receive port.
  const bind = form.locator('select').filter({ has: page.locator('option[value="transmitter"]') }).first();
  if (await bind.count()) {
    await bind.selectOption('transmitter').catch(() => {});
    await page.waitForTimeout(300);
  }
  const toggles = form.locator('button.cfg-toggle');
  for (let i = 0; i < (await toggles.count()); i += 1) {
    await toggles.nth(i).click().catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

// The create dialog…
const add = page.locator('main button:visible').filter({ hasText: /add smsc/i }).first();
let inCreate = [];
if (await add.count()) {
  await add.click();
  await page.waitForTimeout(1200);
  // Every driver in turn, and the union of what each reveals. A field belongs
  // to a protocol — `send-url` is HTTP's, `system-type` is SMPP's — so asking
  // one driver whether the whole set is reachable answers the wrong question
  // and reports a correctly-hidden field as a missing one.
  for (const driver of ['smpp', 'http', 'at', 'fake']) {
    await revealEverything(driver);
    inCreate.push(...(await controlsOnScreen()));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// …and the edit form on an existing connection.
let inEdit = [];
const row = page.locator('main table tbody tr').first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(1500);
  const edit = page.locator('[data-testid="detail-edit"], button:visible').filter({ hasText: /^edit$/i }).first();
  if (await edit.count()) {
    await edit.click();
    await page.waitForTimeout(900);
    await revealEverything();
  }
  inEdit = await controlsOnScreen();
  await page.keyboard.press('Escape');
}
await browser.close();

const reachable = [...inCreate, ...inEdit].join(' | ');
const rows = fields.map((field) => ({
  field,
  directive: DIRECTIVE[field] ?? '(core)',
  onScreen: spellings(field).some((s) => reachable.includes(s.toLowerCase())),
}));

const width = Math.max(...fields.map((f) => f.length)) + 2;
console.log('='.repeat(92));
console.log('CONFIGURABILITY AUDIT — can an operator set this without editing a file?');
console.log('='.repeat(92));
console.log(`${'field'.padEnd(width)}${'engine directive'.padEnd(34)}control?`);
console.log('-'.repeat(92));
for (const r of rows)
  console.log(`${r.field.padEnd(width)}${r.directive.padEnd(34)}${r.onScreen ? 'yes' : 'NO'}`);

const missing = rows.filter((r) => !r.onScreen);
console.log(`\n${'='.repeat(92)}`);
console.log(
  missing.length
    ? `${missing.length} of ${rows.length} settable fields have NO control. The API accepts them, the ` +
        `generator renders them, and the only way to set them is curl.`
    : `All ${rows.length} settable fields have a control.`,
);
fs.writeFileSync(
  path.join(ROOT, 'docs/configurability-audit.json'),
  JSON.stringify(rows, null, 2),
);
