#!/usr/bin/env node
/**
 * WHAT IS BEING CUT OFF, ON EVERY ROUTE.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * Reported from the running console, on four different screens in one pass:
 * "the throughput over times output does not fit horizontally, the end is
 * squashed", "the throttling in context pane seems like it needs to be
 * scrollable, the end is squashed", "the capacity pane needs scrolling ability".
 *
 * The common shape is content wider than the box holding it, in a box that does
 * not scroll. That is invisible to every other measurement in this repository —
 * `padding-audit` measures the panel's interior, `rendered-diff` compares
 * computed style against the kit, and both are perfectly happy with a panel
 * whose contents are sliced off at the right edge. Nothing was asking the one
 * question an operator asks immediately: can I see all of it?
 *
 * WHAT COUNTS AS CUT OFF
 * ---------------------------------------------------------------------------
 * `scrollWidth > clientWidth` on an element whose computed `overflow-x` is
 * neither `auto` nor `scroll`, AND whose content actually reaches past the
 * nearest ancestor that would clip it. Content that overflows a SCROLLING
 * container is fine — that is the fix, not the fault — and content that spills
 * a box while nothing cuts it off is fine too: the design system's
 * `.table-wrap` does exactly that on purpose, with negative margins that bleed
 * a table to the panel edge.
 *
 * Tolerance of 2px, because sub-pixel layout routinely puts scrollWidth a
 * fraction over clientWidth on an element that is not actually clipped, and a
 * report full of 0.5px findings is a report nobody reads.
 *
 * It also flags the whole PAGE scrolling horizontally, which is the same fault
 * one level up and always wrong.
 *
 *   node scripts/overflow-audit.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:15173';
const ROOT = 'd:/JKANNEL';
const SLACK = 2;

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

for (const route of routes) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const clipped = await page.evaluate((slack) => {
    const out = [];
    // The page itself.
    if (document.documentElement.scrollWidth > window.innerWidth + slack)
      out.push({
        what: 'the page',
        label: '',
        over: Math.round(document.documentElement.scrollWidth - window.innerWidth),
      });

    /** A short, human name for the box, so a finding can be found. */
    const nameOf = (el) => {
      const panel = el.closest('.panel');
      const heading = panel?.querySelector('h2, h3');
      const own = el.querySelector(':scope > h2, :scope > h3');
      return (own?.textContent ?? heading?.textContent ?? el.className ?? 'unnamed')
        .toString()
        .trim()
        .slice(0, 48);
    };

    for (const el of document.querySelectorAll('main *')) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      /*
       * Visually-hidden text is clipped ON PURPOSE. The standard `.sr-only`
       * recipe is a 1px box with `overflow: hidden`, so every screen-reader
       * label in the console looked like 150px of lost content — six routes'
       * worth of findings that were all the accessibility layer working
       * correctly. Detected by geometry rather than by class name, so a
       * differently-named implementation of the same trick is also skipped.
       */
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
      // `hidden` clips without scrolling, which is the worst of the three: the
      // content is gone and nothing says so. Flagged, not skipped.
      if (el.scrollWidth <= el.clientWidth + slack) continue;
      if (!el.clientWidth) continue;
      // Only the innermost offender. A clipped table reports its own overflow
      // and so does every ancestor, and one finding per screen is the useful
      // number.
      if ([...el.children].some((child) => child.scrollWidth > child.clientWidth + slack)) continue;

      /*
       * SPILLING IS NOT CLIPPING, and only clipping loses content.
       *
       * `overflow-x: visible` means the content paints outside the box. That is
       * a defect when something cuts it off and a non-event when nothing does —
       * and the design system relies on the second case deliberately:
       * `.table-wrap` carries `margin: 16px -20px -20px` so a table bleeds to
       * the panel edge, which makes it 20px wider than its parent BY DESIGN.
       *
       * The first version of this reported 47 of those on the API reference
       * page alone, all of them the design working correctly, and they buried
       * the real findings underneath. So the question is not "is this element
       * wider than its box" but "does its content reach past the nearest thing
       * that would cut it off".
       */
      let clipper = el.parentElement;
      let reachable = false;
      while (clipper) {
        const parentOverflow = getComputedStyle(clipper).overflowX;
        // A SCROLLING ancestor is the remedy, not the fault: whatever spills is
        // still reachable. Stopping the walk at one and measuring against its
        // right edge is what made the code console on the API reference page
        // look like 182px of lost output, when `.console-body` scrolls
        // horizontally exactly as a terminal should.
        if (parentOverflow === 'auto' || parentOverflow === 'scroll') {
          reachable = true;
          break;
        }
        // `hidden` and `clip` genuinely cut content off with no way to see it.
        if (parentOverflow !== 'visible') break;
        clipper = clipper.parentElement;
      }
      if (reachable) continue;
      const limit = clipper
        ? clipper.getBoundingClientRect().right
        : document.documentElement.clientWidth;
      const contentRight = el.getBoundingClientRect().left + el.scrollWidth;
      if (contentRight <= limit + slack) continue;
      out.push({
        what: el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : ''),
        label: nameOf(el),
        over: Math.round(el.scrollWidth - el.clientWidth),
        overflowX: style.overflowX,
      });
    }
    return out;
  }, SLACK);

  for (const entry of clipped) findings.push({ route, ...entry });
}

await browser.close();

console.log('='.repeat(92));
console.log(`OVERFLOW AUDIT — ${routes.length} routes at 1600px`);
console.log('='.repeat(92));

/*
 * Collapsed per route and per kind, because the raw list is unusable. One grid
 * with forty rows produced forty identical findings — the same cell, the same
 * 44px, forty times — and buried the genuinely different screens under them. A
 * report that has to be read to the end is a report that gets skimmed, and a
 * skimmed report is the same as no report.
 */
if (findings.length) {
  const byRoute = new Map();
  for (const f of findings) byRoute.set(f.route, [...(byRoute.get(f.route) ?? []), f]);
  for (const [route, entries] of byRoute) {
    const kinds = new Map();
    for (const entry of entries) {
      const key = `${entry.label || entry.what}|${entry.what}`;
      const seen = kinds.get(key) ?? { ...entry, count: 0, worst: 0 };
      seen.count += 1;
      seen.worst = Math.max(seen.worst, entry.over);
      kinds.set(key, seen);
    }
    console.log(`\n  ${route}`);
    for (const e of [...kinds.values()].sort((a, b) => b.worst - a.worst))
      console.log(
        `      ${e.worst}px cut off — ${e.label || e.what}` +
          (e.count > 1 ? ` (x${e.count} rows)` : '') +
          (e.overflowX ? `  [${e.what}, overflow-x: ${e.overflowX}]` : ''),
      );
  }
}

console.log(`\n${'='.repeat(92)}`);
console.log(
  findings.length
    ? `${findings.length} element(s) hold content wider than themselves and do not scroll.`
    : 'Nothing on any route is cut off horizontally.',
);
process.exitCode = findings.length ? 1 : 0;
