<script setup lang="ts">
import { computed } from 'vue';

export interface ChartSeries {
  label: string;
  color?: string;
  values: number[];
}

const props = withDefaults(
  defineProps<{
    type?: 'line' | 'area' | 'bar';
    series: ChartSeries[];
    labels?: string[];
    title: string;
    height?: number;
    /** Show horizontal gridlines. */
    grid?: boolean;
  }>(),
  {
    type: 'line',
    labels: () => [],
    height: 160,
    grid: true,
  },
);

// A fixed viewBox keeps the SVG crisp while the element scales to its container.
const width = 640;
const padding = { top: 12, right: 12, bottom: 22, left: 34 };

const palette = ['var(--brand)', 'var(--info)', 'var(--good)', 'var(--warn)'];

const seriesColors = computed(() =>
  props.series.map((entry, index) => entry.color ?? palette[index % palette.length]),
);

const pointCount = computed(() => Math.max(0, ...props.series.map((entry) => entry.values.length)));

const maxValue = computed(() => {
  const all = props.series.flatMap((entry) => entry.values);
  const peak = all.length ? Math.max(...all) : 0;
  return peak <= 0 ? 1 : peak;
});

const plot = computed(() => ({
  x: padding.left,
  y: padding.top,
  w: width - padding.left - padding.right,
  h: props.height - padding.top - padding.bottom,
}));

function xFor(index: number): number {
  const count = pointCount.value;
  if (count <= 1) return plot.value.x + plot.value.w / 2;
  return plot.value.x + (plot.value.w * index) / (count - 1);
}

function yFor(value: number): number {
  const { y, h } = plot.value;
  return y + h - (value / maxValue.value) * h;
}

/**
 * An axis label with enough precision to be a different number from the one
 * above it.
 *
 * `Math.round` was doing this, and on a rate series it produced an axis reading
 * 0, 0, 0, 0, 0 — five gridlines, all zero, under a curve with a clear spike in
 * it. Gateway throughput averaged over six-hour buckets is a fraction of a
 * message per second, so every tick rounded to nothing, and the chart said "no
 * traffic" while drawing traffic. The screen next door plotted the same window
 * against a 40/s ceiling and labelled itself 0/10/20/30/40 perfectly, which is
 * how the fault stayed invisible: only the small-numbered chart was wrong.
 *
 * The precision comes from the STEP rather than the maximum, because the job of
 * the label is to distinguish one gridline from the next. Capped at three
 * decimals: below that the number is noise and the shape of the curve is the
 * real information.
 */
function tickLabel(value: number, step: number): string {
  if (!Number.isFinite(value)) return '0';
  if (step >= 1) return String(Math.round(value));
  if (step >= 0.1) return value.toFixed(1);
  if (step >= 0.01) return value.toFixed(2);
  // A step of zero means every value is the same — a flat series, usually all
  // zero. `toFixed(3)` on that gives "0.000", which reads like a measurement
  // rather than an absence, so a genuinely flat axis stays plain.
  return step > 0 ? value.toFixed(3) : String(Math.round(value));
}

const gridLines = computed(() => {
  if (!props.grid) return [];
  const lines = [];
  const step = maxValue.value / 4;
  for (let index = 0; index <= 4; index += 1) {
    const value = step * index;
    lines.push({ y: yFor(value), value: tickLabel(value, step) });
  }
  return lines;
});

const linePaths = computed(() =>
  props.series.map((entry) => {
    if (!entry.values.length) return '';
    return entry.values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(value)}`)
      .join(' ');
  }),
);

const areaPaths = computed(() =>
  props.series.map((entry) => {
    if (!entry.values.length) return '';
    const baseline = plot.value.y + plot.value.h;
    const top = entry.values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(value)}`)
      .join(' ');
    const first = xFor(0);
    const last = xFor(entry.values.length - 1);
    return `${top} L ${last} ${baseline} L ${first} ${baseline} Z`;
  }),
);

// Grouped bars: each label slot is shared between the series.
const barGroups = computed(() => {
  const count = pointCount.value;
  if (!count) return [];
  const slot = plot.value.w / count;
  const barCount = props.series.length || 1;
  const groupWidth = slot * 0.7;
  const barWidth = groupWidth / barCount;
  const groups = [];
  for (let index = 0; index < count; index += 1) {
    const slotStart = plot.value.x + slot * index + (slot - groupWidth) / 2;
    const bars = props.series.map((entry, sIndex) => {
      const value = entry.values[index] ?? 0;
      const barHeight = Math.max(0, (value / maxValue.value) * plot.value.h);
      return {
        x: slotStart + barWidth * sIndex,
        y: plot.value.y + plot.value.h - barHeight,
        width: Math.max(1, barWidth - 1),
        height: barHeight,
        color: seriesColors.value[sIndex],
        value,
        label: entry.label,
      };
    });
    groups.push({ bars });
  }
  return groups;
});

/*
 * Roughly how wide one axis-label character is, in viewBox units.
 *
 * `.mini-chart-tick` is 10px with tabular numerals, so every digit is the same
 * width and about 6 units of it. The viewBox is a fixed 640 and the SVG scales
 * to its container, so measuring in viewBox units holds at any rendered size —
 * a narrower container shrinks the text by exactly the same factor as the
 * spacing between labels.
 */
const AXIS_CHAR_WIDTH = 6;
/** Clear space demanded between two neighbouring labels. */
const AXIS_LABEL_GAP = 10;

const axisLabels = computed(() => {
  const count = pointCount.value;
  if (!count || !props.labels.length) return [];
  if (count === 1) return [{ x: xFor(0), text: props.labels[0] ?? '' }];

  /*
   * TWO CONSTRAINTS, AND THE TIGHTER ONE WINS.
   *
   * A fixed target of six labels was the only rule here, which is a rule about
   * COUNT on an axis whose problem is WIDTH. It holds for "07:43" and fails for
   * "Sep 3, 07 AM" — the wide-window form of the same axis, four times longer,
   * thinned exactly as much.
   */
  const widest = props.labels
    .slice(0, count)
    .reduce((wide, label) => Math.max(wide, String(label ?? '').length), 0);
  const needed = widest * AXIS_CHAR_WIDTH + AXIS_LABEL_GAP;
  const fits = Math.max(2, Math.floor(plot.value.w / needed) + 1);
  const stride = Math.max(1, Math.ceil(count / 6), Math.ceil((count - 1) / (fits - 1)));

  const out = [];
  for (let index = 0; index < count; index += 1)
    if (index % stride === 0) out.push({ x: xFor(index), text: props.labels[index] ?? '' });

  /*
   * THE LAST LABEL, BUT ONLY IF THERE IS ROOM FOR IT.
   *
   * This condition used to be `index % stride === 0 || index === count - 1`,
   * which forces the final label unconditionally. Whenever the point count is
   * not a multiple of the stride — which is most of the time — the last two
   * labels land a fraction of a stride apart and collide, so the axis reads
   * evenly spaced all the way across and then bunches up at the right edge.
   *
   * Reported on three separate charts: the SMPP throttling pane, Live Traffic's
   * throughput and the Performance capacity graph. One component, one cause.
   *
   * Where the series ENDS is still worth labelling, so it is kept when it has
   * half a stride of clearance and dropped when it does not. Dropping it costs
   * nothing: the final point is still plotted, and a `clearance` of zero means
   * the stride already emitted that label.
   */
  const last = count - 1;
  const clearance = last % stride;
  if (clearance >= stride / 2) out.push({ x: xFor(last), text: props.labels[last] ?? '' });
  return out;
});

const hasData = computed(() => pointCount.value > 0);
</script>

<template>
  <figure class="mini-chart">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      preserveAspectRatio="none"
      :aria-label="title"
      class="mini-chart-svg"
    >
      <title>{{ title }}</title>
      <g v-if="grid" class="mini-chart-grid">
        <line
          v-for="line in gridLines"
          :key="`grid-${line.y}`"
          :x1="plot.x"
          :x2="plot.x + plot.w"
          :y1="line.y"
          :y2="line.y"
        />
        <text
          v-for="line in gridLines"
          :key="`tick-${line.y}`"
          :x="plot.x - 6"
          :y="line.y + 3"
          class="mini-chart-tick"
        >
          {{ line.value }}
        </text>
      </g>

      <template v-if="hasData && type === 'bar'">
        <g v-for="(group, gIndex) in barGroups" :key="`bg-${gIndex}`">
          <rect
            v-for="(bar, bIndex) in group.bars"
            :key="`b-${gIndex}-${bIndex}`"
            :x="bar.x"
            :y="bar.y"
            :width="bar.width"
            :height="bar.height"
            :fill="bar.color"
            rx="2"
          >
            <title>{{ bar.label }}: {{ bar.value }}</title>
          </rect>
        </g>
      </template>

      <template v-else-if="hasData">
        <path
          v-for="(entry, index) in series"
          v-show="type === 'area'"
          :key="`area-${index}`"
          :d="areaPaths[index]"
          :fill="seriesColors[index]"
          fill-opacity="0.14"
          stroke="none"
        />
        <path
          v-for="(entry, index) in series"
          :key="`line-${index}`"
          :d="linePaths[index]"
          fill="none"
          :stroke="seriesColors[index]"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      </template>

      <g class="mini-chart-axis">
        <text
          v-for="(mark, index) in axisLabels"
          :key="`x-${index}`"
          :x="mark.x"
          :y="height - 6"
          text-anchor="middle"
          class="mini-chart-tick"
        >
          {{ mark.text }}
        </text>
      </g>
    </svg>
    <figcaption v-if="series.length" class="mini-chart-legend">
      <span v-for="(entry, index) in series" :key="`lg-${index}`" class="mini-chart-legend-item">
        <span class="mini-chart-swatch" :style="{ background: seriesColors[index] }"></span>
        {{ entry.label }}
      </span>
    </figcaption>
  </figure>
</template>
