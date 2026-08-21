<script setup lang="ts">
/**
 * PERFORMANCE (spec §14, §18 — the kit's `/performance`).
 *
 * The design's screen has two panels: **Gateway latency** and **Capacity**.
 * Only one of them can be built honestly, and the difference is worth stating
 * because it is the whole reason this screen looks the way it does.
 *
 * CAPACITY IS REAL. `smsc_bind_snapshots` holds one row per bind per poll with
 * the engine's own outbound and inbound rate, and it has since the status
 * poller was written. `GET /performance/throughput` sums each poll across the
 * estate, buckets the result, and compares it to the sum of configured
 * ceilings. Nothing here is collected specially for this screen.
 *
 * GATEWAY LATENCY IS NOT. The kit charts "submit latency P95" and "internal
 * queue wait". Kannel's status interface reports counters and rate averages and
 * never a per-message timing, so neither figure exists to be read. Rather than
 * draw an empty axis, the panel is replaced by a statement of what cannot be
 * measured and a pointer to the latency that CAN — submit-to-receipt, from the
 * DLR correlation, on DLR Performance. An operator who sees "no latency here"
 * with no pointer concludes the platform measures none.
 *
 * The sampling card is the other deliberate difference. The kit prints the
 * configured scrape interval; this prints the MEASURED median gap between
 * polls, because the two diverge exactly when something is wrong — a wedged
 * engine, a cycle overrunning its own interval — and on a performance screen
 * the measurement is the useful one.
 *
 * Backend contract:
 *   GET /performance/throughput?minutes=   (perm smsc.view)
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import MetricCard from '../components/MetricCard.vue';
import MiniChart, { type ChartSeries } from '../components/MiniChart.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatRate, formatUtilisation, utilisationTone } from '../utils/connectivity';
import { formatDuration } from '../utils/traffic';

interface ThroughputPoint {
  at: string;
  outbound: number;
  inbound: number;
  peakOutbound: number;
  samples: number;
}

interface ThroughputSeries {
  points: ThroughputPoint[];
  bucketSeconds: number;
  windowMinutes: number;
  ceiling: {
    effectiveTps: number | null;
    contributingSmscs: number;
    smscsWithoutCeiling: number;
    connections: number;
  };
  peakOutbound: number | null;
  latestOutbound: number | null;
  sampling: {
    intervalSeconds: number | null;
    lastObservedAt: string | null;
    ageSeconds: number | null;
    polls: number;
  };
  limits: { unavailable: string[]; reason: string };
}

/** Windows the poller can actually fill. Retention defaults to 72 hours. */
const RANGES = [
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 4320, label: '3 days' },
];

const minutes = ref(360);
const series = ref<ThroughputSeries | null>(null);
const state = ref<State>('loading');
const error = ref('');

/**
 * Stale when the last poll is older than three intervals.
 *
 * Three rather than one: a single missed cycle is scheduler jitter and marking
 * it stale would leave the banner permanently on, which trains people to ignore
 * it. Three consecutive misses is the engine or the poller actually stopping.
 */
const STALE_INTERVALS = 3;

const sampling = computed(() => series.value?.sampling ?? null);
const ceiling = computed(() => series.value?.ceiling ?? null);
const points = computed(() => series.value?.points ?? []);

const stale = computed(() => {
  const age = sampling.value?.ageSeconds;
  const interval = sampling.value?.intervalSeconds;
  if (age === null || age === undefined || !interval) return false;
  return age > interval * STALE_INTERVALS;
});

const chartSeries = computed<ChartSeries[]>(() => [
  { label: 'MT submitted (/s)', values: points.value.map((point) => point.outbound) },
  { label: 'MO received (/s)', values: points.value.map((point) => point.inbound) },
]);

/** Clock labels at the bucket's own resolution — a 3-day chart needs the date. */
const chartLabels = computed(() => {
  const wide = (series.value?.windowMinutes ?? 0) > 1440;
  return points.value.map((point) => {
    const at = new Date(point.at);
    if (Number.isNaN(at.getTime())) return point.at;
    return wide
      ? at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
});

const utilisation = computed(() => {
  const observed = series.value?.latestOutbound;
  const capacity = ceiling.value?.effectiveTps;
  if (observed === null || observed === undefined || !capacity) return null;
  return observed / capacity;
});

/**
 * Headroom: what is left of the declared ceiling right now.
 *
 * Null rather than the full ceiling when throughput has not been observed. "All
 * of it is free" and "we have not looked" are different answers, and only one
 * of them is safe to plan a campaign against.
 */
const headroom = computed(() => {
  const observed = series.value?.latestOutbound;
  const capacity = ceiling.value?.effectiveTps;
  if (observed === null || observed === undefined || capacity === null || capacity === undefined)
    return null;
  return Math.max(0, capacity - observed);
});

/**
 * The headroom tile's tone, or none at all.
 *
 * `utilisationTone` answers `muted` when there is nothing to measure, and a
 * MetricCard has no muted tone — it has "no tone", which is the correct
 * rendering: an unmeasured tile must not be tinted as though it were a reading.
 */
const headroomTone = computed<'good' | 'warn' | 'bad' | undefined>(() => {
  if (utilisation.value === null) return undefined;
  const tone = utilisationTone(utilisation.value);
  return tone === 'muted' ? undefined : tone;
});

const bucketLabel = computed(() => {
  const seconds = series.value?.bucketSeconds;
  return seconds ? formatDuration(seconds) : '';
});

const samplingDetail = computed(() => {
  const value = sampling.value;
  if (!value || value.intervalSeconds === null) return 'no polls in this window';
  const age = value.ageSeconds;
  return age === null
    ? `${value.polls} polls, measured interval`
    : `measured interval, last success ${formatDuration(age)} ago`;
});

/**
 * The caveat the kit states as prose and we can state as fact: how much of the
 * estate contributes no known ceiling. While that count is non-zero the
 * headroom figure is a lower bound, and saying "850/s capacity" without it
 * would be the kind of confident number that gets planned against.
 */
const ceilingCaveat = computed(() => {
  const value = ceiling.value;
  if (!value) return '';
  if (value.effectiveTps === null)
    return `No connection in the estate declares a throughput ceiling, so there is nothing to measure utilisation against. That does not mean the gateway is unlimited — it means the limit is the carrier's and is not recorded here.`;
  if (value.smscsWithoutCeiling > 0)
    return `${value.smscsWithoutCeiling} enabled connection(s) declare no ceiling, so the total above is a lower bound and real headroom is higher by an unknown amount.`;
  return `Every enabled connection declares a ceiling, so this total is complete. Kannel enforces throughput per bind, so it is the sum over ${value.connections} connection(s), not over ${value.contributingSmscs} SMSC record(s).`;
});

async function load() {
  state.value = 'loading';
  try {
    const result = await apiRequest<ThroughputSeries>(`/performance/throughput?minutes=${minutes.value}`);
    series.value = result;
    error.value = '';
    // `partial` when the window holds no poll at all: the ceiling is still a
    // real reading of configuration, so blanking the screen would throw away
    // the half we do know.
    state.value = result?.points?.length ? (stale.value ? 'stale' : 'live') : 'partial';
  } catch (reason) {
    series.value = null;
    error.value = reason instanceof Error ? reason.message : 'Throughput could not be read.';
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

function setRange(value: number) {
  if (minutes.value === value) return;
  minutes.value = value;
  void load();
}

onMounted(load);
</script>

<template>
  <div data-testid="performance-view">
    <section class="metrics-grid" data-testid="performance-metrics">
      <MetricCard
        label="Throughput now"
        :value="formatRate(series?.latestOutbound, state)"
        detail="gateway-wide MT, most recent poll"
        icon="chart"
      />
      <MetricCard
        label="Peak in window"
        :value="formatRate(series?.peakOutbound, state)"
        detail="highest single poll, not a bucket average"
        icon="chart"
      />
      <MetricCard
        label="Headroom"
        :value="formatRate(headroom, state)"
        :detail="
          ceiling?.effectiveTps === null || ceiling?.effectiveTps === undefined
            ? 'no ceiling is declared'
            : `${ceiling.effectiveTps}/s declared across ${ceiling.connections} connection(s)`
        "
        icon="server"
        :tone="headroomTone"
      />
      <MetricCard
        label="Sampling"
        :value="
          displayValue(sampling?.intervalSeconds, state, (value) => formatDuration(Number(value)))
        "
        :detail="samplingDetail"
        icon="cog"
      />
    </section>

    <!-- GATEWAY LATENCY — stated, not drawn ------------------------------- -->
    <section class="panel" data-testid="performance-latency" aria-labelledby="perf-latency-heading">
      <header class="panel-header">
        <div>
          <h2 id="perf-latency-heading">Gateway latency</h2>
          <p>
            Submit path and internal queue wait, which this engine does not report at any sampling
            interval.
          </p>
        </div>
      </header>
      <!--
        Rendered inline rather than through `ObservabilityLimits`: that
        component speaks about one SMSC connection and its `instances` collapse,
        which is a different claim from "the engine reports no timings at all".
      -->
      <div v-if="series?.limits" class="panel limits-panel" data-testid="performance-latency-limits">
        <h3>What this engine cannot report about gateway latency</h3>
        <p class="limits-reason" data-testid="performance-latency-reason">
          {{ series.limits.reason }}
        </p>
        <ul class="limits-list" data-testid="performance-latency-unavailable">
          <li v-for="field in series.limits.unavailable" :key="field">{{ field }}</li>
        </ul>
        <p class="source-note">
          Nothing on this screen substitutes for these. An absent chart means
          <strong>not observable</strong>, never zero milliseconds.
        </p>
      </div>
      <p class="source-note">
        The latency that <em>is</em> measured is the carrier's: submission to delivery receipt,
        correlated per message, with P50, P95 and P99. It lives on
        <RouterLink class="text-link" to="/dlr-performance">DLR Performance</RouterLink>. A rise
        there is the carrier slowing down — which is the reading this panel would have muddled had
        it drawn a gateway line beside it.
      </p>
    </section>

    <!-- CAPACITY ----------------------------------------------------------- -->
    <section class="panel" data-testid="performance-capacity" aria-labelledby="perf-capacity-heading">
      <header class="panel-header">
        <div>
          <h2 id="perf-capacity-heading">Capacity</h2>
          <p>
            Throughput against the sum of known carrier ceilings, from the status poller's own
            per-bind samples<span v-if="bucketLabel">, averaged into {{ bucketLabel }} buckets</span
            >.
          </p>
        </div>
        <div class="range-picker" role="group" aria-label="Time range">
          <button
            v-for="range in RANGES"
            :key="range.minutes"
            type="button"
            class="secondary-button"
            :class="{ 'is-active': minutes === range.minutes }"
            :data-testid="`performance-range-${range.minutes}`"
            @click="setRange(range.minutes)"
          >
            {{ range.label }}
          </button>
        </div>
      </header>

      <p v-if="stale" class="warn-notice" role="status" data-testid="performance-stale">
        <strong>These samples are not current.</strong> The last poll landed
        {{ formatDuration(sampling?.ageSeconds ?? 0) }} ago against a measured interval of
        {{ formatDuration(sampling?.intervalSeconds ?? 0) }}. The chart below is the last thing
        observed, not the traffic flowing now.
      </p>

      <DataState
        :state="state"
        subject="gateway throughput"
        skeleton="text"
        :detail="
          state === 'error'
            ? error
            : state === 'partial'
              ? 'No poll landed inside this window, so there is no throughput to plot. The declared ceiling below is configuration and is still accurate; widen the range, or check that the status poller is running.'
              : undefined
        "
        permission="smsc.view"
        testid="performance-state"
        :on-retry="load"
      >
        <MiniChart
          type="area"
          :series="chartSeries"
          :labels="chartLabels"
          title="Gateway throughput"
          :height="180"
          data-testid="performance-chart"
        />
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="performance-utilisation">{{
              formatUtilisation(utilisation, state)
            }}</strong>
            <small>of declared ceiling, at the most recent poll</small>
          </div>
          <div class="metric">
            <strong data-testid="performance-polls">{{
              displayValue(sampling?.polls, state)
            }}</strong>
            <small>polls in this window</small>
          </div>
          <div class="metric">
            <strong data-testid="performance-connections">{{
              displayValue(ceiling?.connections, state)
            }}</strong>
            <small>enabled connections</small>
          </div>
        </div>
      </DataState>

      <p class="source-note" data-testid="performance-ceiling-note">{{ ceilingCaveat }}</p>
      <p class="source-note">
        Each poll is summed across the estate <em>before</em> it is averaged into a bucket.
        Averaging each bind separately and adding the averages would smooth away the moment two
        binds peaked together, which is the moment this panel exists to show.
      </p>
    </section>
  </div>
</template>

<style scoped>
.range-picker {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.range-picker .is-active {
  border-color: var(--brand);
  color: var(--text-strong);
  background: color-mix(in srgb, var(--brand) 12%, transparent);
}

/* Same treatment the SMSC-scoped limits panel gets, because it is making the
   same kind of statement — this one just speaks for the gateway. */
.limits-panel {
  border-left: 3px solid var(--warn);
  margin: 0 0 4px;
}
.limits-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.limits-reason {
  margin: 0 0 10px;
  color: var(--text-strong);
}
.limits-list {
  margin: 8px 0 10px;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: 13px;
}
</style>
<style src="./workspace-extras.css"></style>
