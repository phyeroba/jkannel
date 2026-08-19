import { test, expect } from '@playwright/test';
import { navigation } from '../../frontend/src/navigation';

/**
 * LAYOUT AUDIT — finds panes that visually overlap, and panels flush against
 * each other or the viewport edge.
 *
 * WHY THIS IS MEASURED, NOT EYEBALLED
 * ---------------------------------------------------------------------------
 * "The panes overlap on most pages" is a real report, but screenshots only prove
 * it one page at a time and a human has to keep looking. Overlap is a geometric
 * property: two sibling boxes whose rectangles intersect. So this walks every
 * route in the navigation, reads the real client rectangles the browser
 * computed, and reports the intersections.
 *
 * It is a DIAGNOSTIC first and a regression test second. Run it with
 * `--grep @layout` after a styling change; a page that starts overlapping will
 * fail here rather than in someone's browser.
 */

/** Rect of an element as the browser laid it out. */
interface Box {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlapArea = (a: Box, b: Box) => {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > 0 && dy > 0 ? dx * dy : 0;
};

// Routes that need no data and no params — every top-level nav destination.
const ROUTES = navigation
  .map((item) => item.to)
  .filter((to) => !to.includes(':'))
  .sort();

test.describe('@layout console layout audit', () => {
  /**
   * Each test walks every top-level route and waits 1.2s for the view to settle,
   * so the floor is already ROUTES.length × 1.2s before a single measurement —
   * past the 45s project default at the current route count. A sweep is
   * inherently long; the alternative is dropping routes from the sweep, which
   * would trade a slow test for a blind one.
   */
  test.setTimeout(Math.max(120_000, ROUTES.length * 4_000));

  test('no page lays sibling panels on top of each other', async ({ page }) => {
    const problems: string[] = [];

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      // Let the SPA settle: most views fetch on mount and grow the page.
      await page.waitForTimeout(1200);

      const boxes: Box[] = await page.evaluate(() => {
        const main = document.querySelector('main, #workspace, .workspace') ?? document.body;
        // Panel-ish nodes at the top two levels. The selector deliberately reaches
        // through a wrapper (`:scope > section > .panel`), because several views
        // group their panels inside an unclassed <section>.
        const nodes = Array.from(
          main.querySelectorAll<HTMLElement>(
            ':scope > section, :scope > article, :scope > .panel, :scope > div > .panel, :scope > section > .panel',
          ),
        );
        // CONTAINMENT IS NOT OVERLAP. Reaching through wrappers means the wrapper
        // and its own children both land in this list, and a parent's box always
        // covers its child's — so every grouped view reported a six-figure
        // "overlap" that was simply a panel sitting inside the section that holds
        // it. Dropping any node that contains another collected node leaves the
        // leaves, which are the boxes that genuinely must not intersect.
        const leaves = nodes.filter(
          (node) => !nodes.some((other) => other !== node && node.contains(other)),
        );
        return leaves
          .filter((n) => {
            const s = getComputedStyle(n);
            return s.display !== 'none' && s.visibility !== 'hidden' && n.offsetHeight > 4;
          })
          .map((n) => {
            const r = n.getBoundingClientRect();
            return {
              label: `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`,
              x: r.x,
              y: r.y + window.scrollY,
              w: r.width,
              h: r.height,
            };
          });
      });

      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const area = overlapArea(boxes[i], boxes[j]);
          // A few px of overlap is rounding; anything substantial is a bug.
          if (area > 400) {
            problems.push(
              `${route}: "${boxes[i].label}" overlaps "${boxes[j].label}" by ${Math.round(area)}px²`,
            );
          }
        }
      }
    }

    if (problems.length) console.log('\nOVERLAPS:\n' + problems.join('\n'));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('panels are separated from each other and from the viewport edge', async ({ page }) => {
    const problems: string[] = [];

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      const report = await page.evaluate(() => {
        const main = document.querySelector('main, #workspace, .workspace') ?? document.body;
        const panels = Array.from(main.querySelectorAll<HTMLElement>('.panel')).filter(
          (n) => n.offsetHeight > 4 && getComputedStyle(n).display !== 'none',
        );
        const out: { flushLeft: number; touching: number; noPadding: number } = {
          flushLeft: 0,
          touching: 0,
          noPadding: 0,
        };
        let prevBottom: number | null = null;
        for (const p of panels) {
          const r = p.getBoundingClientRect();
          const s = getComputedStyle(p);
          if (parseFloat(s.paddingTop) < 4) out.noPadding += 1;
          if (r.x < 4) out.flushLeft += 1;
          const top = r.y + window.scrollY;
          if (prevBottom !== null && top - prevBottom < 4 && top - prevBottom > -4) out.touching += 1;
          prevBottom = top + r.height;
        }
        return { count: panels.length, ...out };
      });

      if (report.noPadding) problems.push(`${route}: ${report.noPadding} panel(s) with no top padding`);
      if (report.touching) problems.push(`${route}: ${report.touching} panel pair(s) with no gap between them`);
      if (report.flushLeft) problems.push(`${route}: ${report.flushLeft} panel(s) flush against the viewport edge`);
    }

    if (problems.length) console.log('\nSPACING:\n' + problems.join('\n'));
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
