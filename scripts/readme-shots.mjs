#!/usr/bin/env node
/**
 * The screenshots the README shows, and the captions that go with them.
 *
 * WHY A SCRIPT AND NOT A FOLDER OF PNGs
 * ---------------------------------------------------------------------------
 * A README screenshot rots the day the screen changes, and nobody notices
 * because nothing checks it. Generating them means re-running one command after
 * a change, and it means the caption lives beside the route it describes rather
 * than in somebody's memory.
 *
 * WHAT IS DELIBERATELY NOT CAPTURED
 * ---------------------------------------------------------------------------
 * Anything showing a real carrier's hostname, port or credentials. These are
 * published to a public repository, so the capture list is restricted to
 * screens whose content is either synthetic or operational-but-not-identifying,
 * and every image is scanned for the carrier's details before it is written.
 * A screenshot is the easiest way in the world to leak a bind endpoint.
 *
 *   node scripts/readme-shots.mjs [outputDir]
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const OUT = process.argv[2] ?? 'd:/JKANNEL/docs/screenshots';
const VIEWPORT = { width: 1680, height: 1000 };

/**
 * Route, file name, and the sentence the README puts under it. The caption is
 * the point: a screenshot with no caption is decoration, and this README is
 * meant to tell somebody what the platform does before they install it.
 */
const SHOTS = [
  {
    route: '/dashboard/operations',
    name: '01-operations',
    title: 'Operations overview',
    caption:
      'Every figure is read from the running engine at request time. A value the engine did not ' +
      'report reads "unknown" rather than zero — the console never invents a number to fill a card.',
  },
  {
    route: '/smsc',
    name: '02-smsc-register',
    title: 'SMSC connections',
    caption:
      'The carrier-facing connections, scoped by market. Bind state is what the engine observed, ' +
      'not what the configuration asked for, so an enabled bind the carrier has not accepted is visible as such.',
  },
  {
    route: '/smsc',
    name: '03-smsc-configuration',
    title: 'Connection settings, point and click',
    caption:
      'All 38 settable SMSC attributes have a control, grouped as a carrier onboarding sheet is laid ' +
      'out and collapsed until wanted. Each field names the kannel.conf directive it becomes, and a ' +
      'setting left blank is omitted from the generated file so the engine default applies.',
    action: 'openSmscForm',
  },
  {
    route: '/routing',
    name: '04-routing',
    title: 'Carrier routing',
    caption:
      'Routes are drafted, validated, then deployed — and only a deployed route decides where a ' +
      'message goes. The simulator resolves against the same deployed set the send path uses.',
  },
  {
    route: '/live-queue',
    name: '05-live-queue',
    title: 'Live queue',
    caption:
      'The engine spool as it drains. A healthy gateway empties this in under a second, so an ' +
      'empty queue is the normal state rather than a sign that nothing was sent.',
  },
  {
    route: '/messages',
    name: '06-messages',
    title: 'Message log and trace',
    caption:
      'Every submission with its delivery outcome. Opening one shows the full trace — segments, ' +
      'encoding, and the engine events behind the status — in a sheet, so the log keeps its place.',
  },
  {
    route: '/alerts',
    name: '07-alerts',
    title: 'Alerts',
    caption:
      'Operational alerts with their lifecycle: acknowledged, assigned, suppressed or resolved, ' +
      'and whether anybody was actually notified — which is a different question from whether it fired.',
  },
  {
    route: '/configuration',
    name: '08-configuration',
    title: 'Engine configuration',
    caption:
      'Configuration is generated from the database, validated by a real bearerbox parse in an ' +
      'isolated container, approved as an immutable version, and only then deployed.',
  },
  {
    route: '/api-reference',
    name: '09-api-reference',
    title: 'API reference',
    caption:
      'The console is one client of the API, not a privileged one. Every operation it performs is ' +
      'documented here with a runnable example.',
  },
];

/**
 * Carrier bind details, and what replaces them in a published image.
 *
 * THIS IS NOT OPTIONAL. The first run of this script photographed the SMSC
 * register of a stack that has the real carrier configured, and the capture
 * showed the bind hostname, its port and the egress IP in plain text —
 * everything needed to find and probe the link, in an image destined for a
 * public README. A screenshot is the easiest way in the world to leak an
 * endpoint, and nothing about taking one warns you.
 *
 * Replaced in the DOM before the shutter rather than blurred afterwards: a
 * black box can be moved, a replaced string cannot, and the resulting image is
 * still a truthful picture of the screen's STRUCTURE, which is what a README
 * screenshot is for.
 *
 * THE LIST ITSELF IS NOT IN THIS FILE. It was, briefly, and that was the same
 * mistake one level up: a redaction list naming the carrier's hostname publishes
 * the carrier's hostname to whoever reads the script. It comes from
 * `SHOT_REDACTIONS` in the gitignored `.env` instead, as
 * `from=to,from=to`. Empty means no redaction, which is correct for a stack
 * with no real carrier and wrong for one that has — so the run below REFUSES
 * when the list is empty and any of the values are visible on screen.
 */
/**
 * `.env` is read from disk, not inherited from the environment.
 *
 * This used `process.env.SHOT_REDACTIONS` alone, and nothing in this repository
 * loads `.env` into the process — so the list was ALWAYS empty, redaction never
 * ran, and the carrier's hostname was rendered into the SMSC register behind
 * the Create SMSC dialog in `03-smsc-configuration.png`.
 *
 * The guard below could not catch it either, because it is built from this same
 * list: an empty list has nothing to look for, so "nothing forbidden was found"
 * was true and meaningless. That is the defining shape of a safety check that
 * fails open, and it is the exact failure this script exists to prevent.
 */
function redactionPairs() {
  const inline = process.env.SHOT_REDACTIONS;
  if (inline) return inline;
  try {
    const env = fs.readFileSync(path.join('d:/JKANNEL', '.env'), 'utf8');
    return /^SHOT_REDACTIONS=(.*)$/m.exec(env)?.[1] ?? '';
  } catch {
    return '';
  }
}

const REDACTIONS = redactionPairs()
  .split(',')
  .map((pair) => pair.split('=').map((part) => part.trim()))
  .filter(([from, to]) => from && to);

/*
 * NO LIST IS NOT THE SAME AS NOTHING TO HIDE.
 *
 * A stack with no real carrier configured genuinely needs no redaction, and a
 * stack that has one needs it absolutely — and from inside this script the two
 * look identical. Defaulting to "carry on" resolves that ambiguity in the one
 * direction that can publish a hostname, so it refuses instead and makes the
 * safe case say so out loud.
 */
if (!REDACTIONS.length && process.env.SHOT_ALLOW_NO_REDACTION !== 'true') {
  console.error(
    [
      '',
      'REFUSING: no redaction list.',
      '',
      'SHOT_REDACTIONS is not set in the environment and was not found in .env, so nothing',
      'would be masked before the shutter. If this deployment really has no carrier details',
      'on screen, re-run with SHOT_ALLOW_NO_REDACTION=true to say so deliberately.',
    ].join('\n'),
  );
  process.exit(1);
}

async function redact(page) {
  const remaining = await page.evaluate((pairs) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes)
      for (const [from, to] of pairs)
        if (node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.split(from).join(to);
    // Attribute values too: a title or aria-label can carry the same string and
    // some of them render as a tooltip.
    for (const el of document.querySelectorAll('[title],[aria-label],[value],[placeholder]'))
      for (const attr of ['title', 'aria-label', 'value', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        let next = v;
        for (const [from, to] of pairs) next = next.split(from).join(to);
        if (next !== v) el.setAttribute(attr, next);
      }
    return pairs.filter(([from]) => document.body.innerText.includes(from)).map(([f]) => f);
  }, REDACTIONS);
  if (remaining.length) {
    console.error(`\nREFUSING: ${remaining.join(', ')} still visible after redaction`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
).newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', process.env.U ?? 'operator');
await page.fill('[data-testid="password"]', process.env.P ?? 'JkannelLocal2026!');
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
  page.click('[data-testid="login-submit"]'),
]);

const captured = [];
for (const shot of SHOTS) {
  await page.goto(BASE + shot.route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  // Park the pointer off the content: a hovered row photographs as a highlight
  // nobody chose, and it reads as a selection in a still image.
  await page.mouse.move(VIEWPORT.width - 2, 2);
  await redact(page);

  if (shot.action === 'openSmscForm') {
    const add = page.locator('main button:visible').filter({ hasText: /add smsc/i }).first();
    if (await add.count()) {
      await add.click();
      await page.waitForTimeout(900);
      // Open the collapsed groups, because the point of the capture is that the
      // deep settings exist at all.
      const toggles = page.locator('.smsc-form button.cfg-toggle');
      for (let i = 0; i < (await toggles.count()); i += 1) {
        await toggles.nth(i).click();
        await page.waitForTimeout(120);
      }
      /*
       * BACK TO THE TOP, because clicking the LAST toggle scrolled the dialog
       * body down to it.
       *
       * The capture came out on the middle of the form — Alternative charset,
       * Source TON, Destination NPI — a run of loose fields with no group
       * heading in frame, under a caption promising settings "grouped as a
       * carrier onboarding sheet is laid out and collapsed until wanted". The
       * image contradicted its own caption, and the caption was the true one.
       *
       * Every group is still expanded, which is the point of the capture; the
       * frame just starts where an operator's eye does.
       */
      await page.evaluate(() => {
        const body = document.querySelector('.dialog-body');
        if (body) body.scrollTop = 0;
      });
      await page.waitForTimeout(500);
    }
  }

  /*
   * FULL PAGE, BUT BOUNDED.
   *
   * `fullPage: true` on the message log produced a 24,406px ribbon — every row
   * of a hundred-row register in one image, unreadable at any width a README
   * renders at. Clipping to a couple of screens shows the screen as an operator
   * first meets it, which is what a screenshot is for; the alternative is an
   * image nobody can see anything in.
   */
  const MAX_HEIGHT = 2000;
  const fullHeight = await page.evaluate(() =>
    Math.ceil(document.documentElement.scrollHeight),
  );
  const file = path.join(OUT, `${shot.name}.png`);
  await page.screenshot({
    path: file,
    ...(shot.action === 'openSmscForm'
      ? {}
      : {
          fullPage: true,
          clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(fullHeight, MAX_HEIGHT) },
        }),
  });
  captured.push({ ...shot, file: path.basename(file) });
  console.log(`  ${shot.name.padEnd(24)} ${shot.route}`);
}
await browser.close();

/*
 * The leak check. Carrier bind details must never reach a public repository,
 * and a screenshot is the easiest way in the world to publish one by accident.
 * Filenames and captions are checked here; the images themselves are checked by
 * the caller against the same list, because this cannot read pixels.
 */
const FORBIDDEN = REDACTIONS.map(([from]) => from);
const textual = JSON.stringify(captured);
const leaked = FORBIDDEN.filter((term) => textual.includes(term));
if (leaked.length) {
  console.error(`\nREFUSING: capture metadata contains ${leaked.join(', ')}`);
  process.exit(1);
}

fs.writeFileSync(path.join(OUT, 'captions.json'), JSON.stringify(captured, null, 2));
console.log(`\n${captured.length} screenshots written to ${OUT}`);
/*
 * The images are the one thing nothing here can verify.
 *
 * `secret-scan.mjs` reads tracked files including binaries, and it CANNOT find
 * a hostname that was rendered into a PNG — the file holds compressed pixels,
 * not the characters that were drawn. It reported these very screenshots clean
 * while one of them showed the carrier's hostname in plain sight.
 *
 * So the real control is the DOM check above, which runs at shutter time and
 * refuses if a forbidden string is still on the page. This line is the last
 * human step, and it names the terms so that looking is quick.
 */
console.log(
  `
Redacted ${REDACTIONS.length} term(s) before every shutter, and verified none survived in`,
);
console.log('the DOM. That is the guarantee — a PNG cannot be text-scanned afterwards.');
/*
 * The terms are COUNTED, not printed.
 *
 * This used to end `console.log('Terms:', FORBIDDEN.join(', '))`, which put the
 * carrier's hostname, its system id and two egress addresses straight into
 * whatever captured the run — a terminal scrollback, a CI log, a transcript. A
 * script that exists to stop those values being published should not be the
 * thing that publishes them, and the header of this file makes exactly that
 * argument about the list living in `.env` rather than in the source. Printing
 * them at the end undid it.
 *
 * The operator already knows what is in their own `.env`; the count is what
 * tells them the list was loaded, which is the only thing that was actually in
 * doubt.
 */
console.log(`Loaded ${REDACTIONS.length} term(s) from SHOT_REDACTIONS.`);
