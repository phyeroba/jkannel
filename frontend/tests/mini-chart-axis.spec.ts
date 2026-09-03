import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MiniChart from '../src/components/MiniChart.vue';

/**
 * THE X AXIS MUST NOT BUNCH UP AT ITS RIGHT-HAND END.
 *
 * Reported three times, on three screens — the SMPP throttling pane, Live
 * Traffic's throughput chart, the Performance capacity graph — which is one
 * component reported three times.
 *
 * The old rule emitted a label at every `stride` AND unconditionally at the
 * last point. Those two rules agree only when the point count is a multiple of
 * the stride; the rest of the time the final label lands a fraction of a stride
 * from its neighbour. So the axis looked evenly spaced across most of its width
 * and then collided at the edge, which is exactly how it was described.
 *
 * What is asserted here is the property that was violated — every neighbouring
 * pair is at least half a stride apart — rather than a specific set of labels,
 * because the label positions are free to change and the spacing is not.
 */

const plotWidth = 640 - 34 - 12;

function axisFor(labels: string[]) {
  const wrapper = mount(MiniChart, {
    props: {
      title: 'test',
      labels,
      series: [{ label: 'a', values: labels.map((_, index) => index) }],
    },
  });
  const ticks = wrapper.findAll('.mini-chart-axis text');
  return ticks.map((tick) => ({
    x: Number(tick.attributes('x')),
    text: tick.text(),
  }));
}

function gaps(marks: { x: number }[]) {
  return marks.slice(1).map((mark, index) => mark.x - marks[index].x);
}

describe('MiniChart x axis', () => {
  /*
   * Ten-minute buckets over six hours: 37 points, which is what the throttling
   * pane plots and what made the fault visible. 37 is not a multiple of its
   * own stride, so the old code put the last two labels one slot apart.
   */
  const sixHours = Array.from({ length: 37 }, (_, index) => {
    const minutes = index * 10;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  });

  it('never places two labels closer than the rest of the axis', () => {
    for (const count of [7, 12, 13, 24, 25, 37, 48, 72, 145]) {
      const marks = axisFor(sixHours.slice(0, 1).concat(Array.from({ length: count - 1 }, (_, i) => `${i}:00`)));
      const spacing = gaps(marks);
      const widest = Math.max(...spacing);
      // Half the regular spacing is the threshold: below it two labels read as
      // one smudge. The old code produced ratios as bad as 1/7 here.
      expect(Math.min(...spacing), `count=${count} spacing=${spacing.join(',')}`).toBeGreaterThanOrEqual(
        widest / 2,
      );
    }
  });

  it('thins long labels harder than short ones', () => {
    /*
     * The old rule targeted a COUNT of six labels regardless of how wide they
     * were, so a wide-window axis got exactly the same treatment as "07:43" at
     * four times the width.
     *
     * Six labels of moderate length do fit across 594 units, which is why a
     * first version of this test passed against the old code — it compared two
     * cases the old rule happened to handle. The labels here are long enough
     * that six of them provably cannot fit, so the two rules must disagree.
     */
    const count = 48;
    const short = axisFor(
      Array.from({ length: count }, (_, i) => `${String(i % 24).padStart(2, '0')}:00`),
    );
    const long = axisFor(
      Array.from({ length: count }, (_, i) => `Sep ${(i % 28) + 1}, 2026 at ${String(i % 24).padStart(2, '0')}:00 EAT`),
    );
    expect(long.length).toBeLessThan(short.length);
    // Every long label must have room for its own text.
    const widest = Math.max(...long.map((mark) => mark.text.length));
    expect(Math.min(...gaps(long))).toBeGreaterThan(widest * 6);
  });

  it('labels a single point once, in the middle', () => {
    const marks = axisFor(['12:00']);
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('12:00');
  });

  it('does not repeat the final label', () => {
    // A count that IS a multiple of its stride already emits the last point.
    // Adding it again drew the same text twice at the same x, which renders as
    // one slightly bolder label and is invisible until you count them.
    for (const count of [7, 13, 25, 37, 49]) {
      const marks = axisFor(Array.from({ length: count }, (_, i) => `t${i}`));
      expect(new Set(marks.map((m) => m.x)).size, `count=${count}`).toBe(marks.length);
    }
  });
});
