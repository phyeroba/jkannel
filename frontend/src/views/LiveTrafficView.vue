<script setup lang="ts">
/**
 * LIVE TRAFFIC (PLAN.md 3.2, spec §6).
 *
 * §6 asks for three things this console did not have: the MT / MO / DLR split
 * rather than one aggregate outbound number, current-average-peak for each, and
 * a table that is *calm* — "values update in place; rows do not reorder unless
 * ranking is enabled". The last one is not a nicety. A NOC screen that
 * reshuffles every five seconds cannot be read at all: the operator's eye is
 * tracking a row, the row moves, and they read someone else's figures.
 *
 * So: rows are keyed on engine id, ordered on engine id, and the order does not
 * change when the numbers do. Ranking by depth is a control the operator turns
 * on deliberately, and it starts off.
 *
 * WHAT THE ENGINE ACTUALLY GIVES US
 * ---------------------------------------------------------------------------
 * `GET /queue-console/live` returns, per bind, `outboundRate` and `inboundRate`
 * as three-element arrays — bearerbox's own rolling means over 1, 5 and 15
 * minutes. They are not samples JKANNEL took, so "now" here is a one-minute
 * mean and the screen says so rather than implying an instantaneous reading.
 *
 * There is NO per-bind DLR rate. bearerbox reports a single engine-wide
 * `dlrQueued` depth, which is a queue length and not a throughput, so the DLR
 * column that §6 asks for does not exist and no column is drawn for it. The
 * peak is tracked in the browser across this visit and labelled as such,
 * because nothing server-side retains one.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import MiniChart from '../components/MiniChart.vue';
import { useLiveResource } from '../composables/useLiveResource';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment, formatRate, formatUtilisation } from '../utils/connectivity';
import { smscOptionsFrom, type SmscOption } from '../utils/safe-control';
import {
  RATE_WINDOWS,
  engineStatusTone,
  engineStatusWord,
  formatAge,
  formatDuration,
  rateAt,
  type LiveBind,
  type LiveSnapshot,
} from '../utils/traffic';

const snapshot = ref<LiveSnapshot | null>(null);
const state = ref<State>('loading');
const error = ref('');
/** Highest 1-minute MT mean seen per bind since this screen opened. */
const peaks = ref<Record<string, number>>({});
/** Off by default — see the header comment. */
const rankByDepth = ref(false);

const engine = computed(() => snapshot.value?.engine ?? {});
const source = computed(() => snapshot.value?.source ?? null);
const sourceDegraded = computed(() => {
  const status = String(source.value?.status ?? 'ok').toLowerCase();
  return Boolean(status) && status !== 'ok';
});

/** Stable order by engine id; ranking is opt-in and re-sorts by queue depth. */
const binds = computed<LiveBind[]>(() => {
  const rows = (snapshot.value?.binds ?? []).filter((bind) => bind && bind.engineId);
  const ordered = [...rows];
  return rankByDepth.value
    ? ordered.sort((a, b) => (b.queued ?? -1) - (a.queued ?? -1))
    : ordered.sort((a, b) => String(a.engineId).localeCompare(String(b.engineId)));
});

/* --- THE REGISTER SIDE OF THE MATRIX -----------------------------------------
 *
 * The live snapshot is the ENGINE's view: it knows rates and queues but nothing
 * about carriers or configured ceilings, which live in the SMSC register. One
 * read of `/smscs` on mount supplies both, keyed by engine id.
 *
 * Read once rather than on every poll: a carrier assignment and a throughput
 * ceiling are configuration, and re-fetching them every five seconds alongside
 * a live snapshot would triple this screen's request rate to watch values that
 * change when somebody edits them.
 */
const register = ref<SmscOption[]>([]);

async function loadRegister() {
  try {
    const page = await apiRequest<{ items?: Record<string, unknown>[] }>(
      '/smscs?limit=500&offset=0',
    );
    register.value = smscOptionsFrom(Array.isArray(page?.items) ? page.items : []);
  } catch {
    // The matrix degrades to engine-only columns; the rates are the point of
    // the screen and must not be lost to a failed lookup.
    register.value = [];
  }
}

const registerByEngineId = computed(() => {
  const map = new Map<string, SmscOption>();
  for (const option of register.value) if (option.engineId) map.set(option.engineId, option);
  return map;
});

/** Carrier name for a reported bind, from `/smscs` — never from the engine. */
function carrierFor(engineId: string): string {
  const option = registerByEngineId.value.get(engineId);
  if (!option) return 'not in the register';
  return option.carrierName ?? 'unassigned';
}

/**
 * Observed MT against the ceiling the engine will enforce.
 *
 * Null — rendered "unknown" — when the connection declares no ceiling or has
 * reported no rate. A percentage of an unknown denominator is not 0%, and 0%
 * on this column would read as an idle bind.
 */
function utilisationFor(bind: LiveBind): number | null {
  const option = registerByEngineId.value.get(String(bind.engineId));
  const ceiling = option?.tps;
  if (ceiling === null || ceiling === undefined || ceiling <= 0) return null;
  const observed = rateAt(bind.outboundRate, 0);
  if (observed === null || observed === undefined) return null;
  return observed / (ceiling * (option?.connections ?? 1));
}

/* --- THE RECORDED SERIES -----------------------------------------------------
 *
 * The live snapshot is one instant, and until now the only history this screen
 * had was peaks tracked in the browser since it opened — lost on reload and
 * different for every operator watching. The poller has been recording per-poll
 * rates all along; `/performance/throughput` reads them, and the Performance
 * screen draws the same series, so two screens cannot show different histories
 * of the same gateway.
 */
const TREND_WINDOW_MINUTES = 360;

const trendPoints = ref<{ at: string; outbound: number; inbound: number }[]>([]);
const trendState = ref<State>('loading');

const trendSeries = computed(() => [
  { label: 'MT out (/s)', values: trendPoints.value.map((point) => point.outbound) },
  { label: 'MO in (/s)', values: trendPoints.value.map((point) => point.inbound) },
]);

const trendLabels = computed(() =>
  trendPoints.value.map((point) => {
    const at = new Date(point.at);
    return Number.isNaN(at.getTime())
      ? point.at
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }),
);

async function loadTrend() {
  trendState.value = 'loading';
  try {
    const result = await apiRequest<{
      points?: { at: string; outbound: number; inbound: number }[];
    }>(`/performance/throughput?minutes=${TREND_WINDOW_MINUTES}`);
    trendPoints.value = Array.isArray(result?.points) ? result.points : [];
    trendState.value = trendPoints.value.length ? 'live' : 'empty';
  } catch {
    trendPoints.value = [];
    trendState.value = 'error';
  }
}

/**
 * Age of the oldest message still spooled for a bind.
 *
 * From SQLBox, not from the engine: bearerbox reports a queue depth per bind
 * and no ages at all, while `send_sms` carries a timestamp on every waiting
 * message. That distinction matters on this row — the Queued column is the
 * engine's number and this one is the spool's, and they can legitimately
 * disagree while a message is in flight between them.
 *
 * "nothing waiting" and "unknown" are held apart: no spool group means the
 * queue is empty, while a group with no readable timestamp means we cannot say
 * how old its oldest message is.
 */
function oldestFor(bind: LiveBind): string {
  const groups = snapshot.value?.spool?.bySmsc;
  if (!Array.isArray(groups)) return 'unknown';
  const entry = groups.find((group) => group.smscId === String(bind.engineId));
  if (!entry || !entry.count) return 'nothing waiting';
  if (!entry.oldestEpoch || entry.oldestEpoch <= 0) return 'unknown';
  return formatDuration(Math.max(0, Math.round(Date.now() / 1000 - entry.oldestEpoch)));
}

/** Sum of a rate window across every bind, or null when nothing reported one. */
function totalRate(field: 'outboundRate' | 'inboundRate', index: number): number | null {
  let total = 0;
  let measured = false;
  for (const bind of binds.value) {
    const value = rateAt(bind[field], index);
    if (value === null) continue;
    measured = true;
    total += value;
  }
  return measured ? total : null;
}

const mtNow = computed(() => totalRate('outboundRate', 0));
const mtAverage = computed(() => totalRate('outboundRate', 2));
const moNow = computed(() => totalRate('inboundRate', 0));
const moAverage = computed(() => totalRate('inboundRate', 2));
/** Estate peak is the sum of the per-bind peaks actually observed this visit. */
const mtPeak = computed(() => {
  const values = binds.value
    .map((bind) => peaks.value[String(bind.engineId)])
    .filter((value): value is number => typeof value === 'number');
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
});

function peakFor(bind: LiveBind): number | null {
  const value = peaks.value[String(bind.engineId)];
  return typeof value === 'number' ? value : null;
}

function bindLabel(bind: LiveBind): string {
  return String(bind.smscName ?? bind.name ?? bind.engineId ?? 'unnamed');
}

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function recordPeaks(rows: LiveBind[]) {
  const next = { ...peaks.value };
  for (const bind of rows) {
    const engineId = String(bind.engineId ?? '');
    if (!engineId) continue;
    const observed = rateAt(bind.outboundRate, 0);
    if (observed === null) continue;
    next[engineId] = Math.max(next[engineId] ?? 0, observed);
  }
  peaks.value = next;
}

async function load() {
  try {
    const data = await apiRequest<LiveSnapshot>('/queue-console/live');
    snapshot.value = data && typeof data === 'object' ? data : {};
    recordPeaks(snapshot.value.binds ?? []);
    error.value = '';
    state.value = sourceDegraded.value
      ? // A real reading that is not current: `partial` keeps the rows on screen
        // and puts the engine's own sentence above them.
        'partial'
      : binds.value.length
        ? 'live'
        : 'empty';
  } catch (reason) {
    snapshot.value = null;
    error.value = messageFrom(reason, 'The live traffic snapshot could not be loaded.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

function resetPeaks() {
  peaks.value = {};
}

const refreshChoices = [2, 5, 10, 30, 60];
const { autoRefresh, intervalSeconds, refreshing, lastRefreshedAt, refreshNow } = useLiveResource(
  load,
  { intervalSeconds: 5, immediate: false },
);

onMounted(() => {
  void load();
  // Configuration, so it is read once rather than on every live poll.
  void loadRegister();
  // Six hours of recorded samples; refreshing this every five seconds alongside
  // the live snapshot would re-read the same history to move one bucket.
  void loadTrend();
});
</script>

<template>
  <div data-testid="live-traffic-view">
    <section class="toolbar panel grid-toolbar" aria-label="Live traffic refresh controls">
      <label class="filter-select">
        <span>Live updates</span>
        <select v-model="autoRefresh" data-testid="live-traffic-auto">
          <option :value="true">On</option>
          <option :value="false">Paused</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Every</span>
        <select v-model.number="intervalSeconds" data-testid="live-traffic-interval">
          <option v-for="choice in refreshChoices" :key="choice" :value="choice">
            {{ choice }}s
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Rank by queue depth</span>
        <select v-model="rankByDepth" data-testid="live-traffic-rank">
          <option :value="false">off — hold row order steady</option>
          <option :value="true">on — deepest queue first</option>
        </select>
      </label>
      <button
        class="primary-button"
        data-testid="live-traffic-refresh"
        :disabled="refreshing"
        @click="refreshNow(true)"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh' }}
      </button>
      <span class="source-note" data-testid="live-traffic-refreshed">
        {{
          lastRefreshedAt
            ? `Last updated ${lastRefreshedAt}${autoRefresh ? '' : ' — live updates are paused'}`
            : 'Waiting for the first snapshot…'
        }}
      </span>
    </section>

    <section class="panel" data-testid="live-traffic-engine" aria-labelledby="live-traffic-heading">
      <header class="panel-header">
        <div>
          <h2 id="live-traffic-heading">Live traffic</h2>
          <p aria-live="polite" data-testid="live-traffic-observed">
            {{
              state === 'loading'
                ? 'Reading the engine snapshot…'
                : `Engine observed ${formatMoment(snapshot?.observedAt)}`
            }}
          </p>
        </div>
        <span class="status-badge" :class="engineStatusTone(engine.status)">{{
          engineStatusWord(engine.status)
        }}</span>
      </header>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="live-traffic-mt-now">{{ formatRate(mtNow, state) }}</strong>
          <small>MT out, mean over the last minute</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-mt-average">{{ formatRate(mtAverage, state) }}</strong>
          <small>MT out, mean over the last 15 minutes</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-mt-peak">{{ formatRate(mtPeak, state) }}</strong>
          <small>highest MT reading since this screen opened</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-mo-now">{{ formatRate(moNow, state) }}</strong>
          <small>MO in, mean over the last minute</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-mo-average">{{ formatRate(moAverage, state) }}</strong>
          <small>MO in, mean over the last 15 minutes</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-dlr-queued">{{
            displayValue(engine.dlrQueued, state)
          }}</strong>
          <small>delivery receipts queued (a depth, not a rate)</small>
        </div>
      </div>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="live-traffic-queued-out">{{
            displayValue(engine.smsQueuedOut, state)
          }}</strong>
          <small>SMS queued outbound</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-queued-in">{{
            displayValue(engine.smsQueuedIn, state)
          }}</strong>
          <small>SMS queued inbound</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-store">{{
            displayValue(engine.storeSize, state)
          }}</strong>
          <small>messages in the engine store</small>
        </div>
        <div class="metric">
          <strong data-testid="live-traffic-uptime">{{
            formatAge(engine.uptimeSeconds, state)
          }}</strong>
          <small>engine uptime</small>
        </div>
        <div class="metric">
          <strong>{{ displayValue(engine.version, state) }}</strong>
          <small>engine version</small>
        </div>
      </div>

      <!--
        THE DLR STATEMENT. §6 asks for an MT / MO / DLR split and two thirds of
        it exist. Saying so here is cheaper than an empty column an operator
        would read as "no receipts are arriving".
      -->
      <p class="warn-notice" role="note" data-testid="live-traffic-dlr-note">
        There is no DLR throughput on this screen because the engine does not report one. Per bind
        it publishes exactly two rates — outbound (MT) and inbound — and estate-wide it publishes a
        single receipt <em>queue depth</em>, shown above. Inbound is not split into
        mobile-originated messages and delivery receipts either. For receipt volume and quality over
        a window, use
        <router-link class="text-link" to="/dlr-performance">DLR Performance</router-link>.
      </p>

      <p v-if="error" class="form-error" role="alert" data-testid="live-traffic-error">
        {{ error }}
      </p>
    </section>

    <!-- THROUGHPUT OVER TIME --------------------------------------------------
      The live figures above are one instant. This is the shape they have been
      making, from the poller's recorded samples rather than from anything this
      browser has watched — so it survives a page reload and is the same series
      the Performance screen draws.

      DLR is deliberately not a third line here, unlike the kit's mock. The
      engine reports no receipt rate at all, only a queue depth, so a DLR line
      would have to be invented. The note under the matrix already says so.
    -->
    <section class="panel" data-testid="traffic-trend" aria-labelledby="traffic-trend-heading">
      <header class="panel-header">
        <div>
          <h2 id="traffic-trend-heading">Throughput over time</h2>
          <p>
            Gateway-wide MT and MO, from the status poller's recorded samples over the last
            {{ Math.round(TREND_WINDOW_MINUTES / 60) }} hours.
          </p>
        </div>
      </header>
      <MiniChart
        v-if="trendPoints.length"
        type="area"
        :series="trendSeries"
        :labels="trendLabels"
        title="Gateway throughput"
        :height="200"
        data-testid="traffic-trend-chart"
      />
      <p v-else class="chart-empty" data-testid="traffic-trend-empty">
        {{
          trendState === 'error'
            ? 'The recorded throughput series could not be read.'
            : 'The poller has recorded no sample in this window, so there is no shape to draw yet.'
        }}
      </p>
    </section>

    <!-- TRAFFIC MATRIX --------------------------------------------------------
      Its own panel because it answers a different question from the totals
      above. The totals say how much the gateway is carrying; this says WHERE,
      and puts throughput beside queue and utilisation so that the dangerous
      combination — a healthy rate with a growing queue — is visible in one row
      rather than assembled across three screens.
    -->
    <section class="panel" data-testid="traffic-matrix" aria-labelledby="traffic-matrix-heading">
      <header class="panel-header">
        <div>
          <h2 id="traffic-matrix-heading">Traffic matrix</h2>
          <p>
            Throughput beside queue and capacity, per bind, so a healthy rate with a growing queue
            is visible.
          </p>
        </div>
      </header>

      <DataState
        :state="state"
        subject="live bind traffic"
        skeleton="table"
        :skeleton-rows="4"
        :missing="state === 'partial' ? ['engine runtime counters'] : []"
        :detail="
          state === 'partial'
            ? `The engine runtime is ${source?.status ?? 'degraded'}, so the per-bind counters below are not current and must not be read as real zeros. ${source?.detail ?? ''}`
            : state === 'empty'
              ? 'The engine reports no binds at all. Nothing can be sent until an SMSC connection is configured and enabled.'
              : state === 'error'
                ? error
                : undefined
        "
        permission="messages.view"
        testid="live-traffic-state"
        :on-retry="() => refreshNow(true)"
      >
        <div class="table-wrap">
          <table data-testid="live-traffic-table">
            <thead>
              <tr>
                <th scope="col">Bind</th>
                <th scope="col">Carrier</th>
                <th scope="col">State</th>
                <th v-for="window in RATE_WINDOWS" :key="window.short" scope="col">
                  MT {{ window.short }}
                </th>
                <th scope="col">MT peak</th>
                <th scope="col">MO 1m</th>
                <th scope="col">Utilisation</th>
                <th scope="col">Queued</th>
                <th scope="col">Oldest</th>
                <th scope="col">Failed</th>
                <th scope="col">Sent</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              <!--
                `:key` is the engine id and the sort is fixed, so Vue patches the
                cells of an existing row rather than replacing the row. That is
                what "updates in place" means in practice.
              -->
              <tr
                v-for="bind in binds"
                :key="String(bind.engineId)"
                :data-testid="`live-traffic-row-${bind.engineId}`"
              >
                <td>
                  <router-link class="text-link" :to="`/smsc/${bind.engineId}`">{{
                    bindLabel(bind)
                  }}</router-link>
                  <small class="row-id mono">{{ bind.engineId }}</small>
                  <small v-if="bind.known === false" class="row-id"
                    >not configured in this console</small
                  >
                </td>
                <!--
                  Resolved from the SMSC register by engine id. A bind the
                  engine reports but the console has no record of reads "not in
                  the register" rather than blank — that is a configuration gap
                  worth seeing, not a missing value.
                -->
                <td :data-testid="`live-traffic-carrier-${bind.engineId}`">
                  {{ carrierFor(String(bind.engineId)) }}
                </td>
                <td>
                  <span
                    class="status-badge"
                    :class="engineStatusTone(bind.status)"
                    :data-testid="`live-traffic-state-${bind.engineId}`"
                    >{{ engineStatusWord(bind.status) }}</span
                  >
                </td>
                <td
                  v-for="window in RATE_WINDOWS"
                  :key="window.short"
                  class="mono"
                  :data-testid="`live-traffic-mt-${window.short}-${bind.engineId}`"
                >
                  {{ formatRate(rateAt(bind.outboundRate, window.index), state) }}
                </td>
                <td class="mono" :data-testid="`live-traffic-peak-${bind.engineId}`">
                  {{ formatRate(peakFor(bind), state) }}
                </td>
                <td class="mono" :data-testid="`live-traffic-mo-${bind.engineId}`">
                  {{ formatRate(rateAt(bind.inboundRate, 0), state) }}
                </td>
                <!--
                  Against the ceiling the engine will actually enforce: the
                  per-bind tps multiplied by its instances. "unknown" where no
                  ceiling is declared, because a percentage of nothing is not 0%.
                -->
                <td class="mono" :data-testid="`live-traffic-utilisation-${bind.engineId}`">
                  {{ formatUtilisation(utilisationFor(bind), state) }}
                </td>
                <td class="mono" :data-testid="`live-traffic-queued-${bind.engineId}`">
                  {{ displayValue(bind.queued, state) }}
                </td>
                <td class="mono" :data-testid="`live-traffic-oldest-${bind.engineId}`">
                  {{ oldestFor(bind) }}
                </td>
                <td class="mono">{{ displayValue(bind.failed, state) }}</td>
                <td class="mono">{{ displayValue(bind.sent, state) }}</td>
                <td class="mono">{{ displayValue(bind.received, state) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="detail-actions">
          <button
            class="secondary-button"
            data-testid="live-traffic-reset-peaks"
            @click="resetPeaks"
          >
            Reset peaks
          </button>
        </div>
      </DataState>

      <p class="source-note" data-testid="live-traffic-rate-note">
        Every rate here is one of bearerbox's own rolling means over 1, 5 and 15 minutes — not an
        instantaneous reading and not something JKANNEL sampled. A bind the engine did not report a
        rate for is recorded as <span class="mono">0</span> by the status adapter before this screen
        sees it, so a <span class="mono">0/s</span> means either an idle bind or an unreported one;
        the two are indistinguishable in what the engine publishes. Peak is the highest one-minute
        mean seen while this screen has been open, and resets when you leave it — nothing
        server-side retains one.
      </p>
      <p class="source-note" data-testid="live-traffic-order-note">
        Rows are ordered on engine id and stay put while the figures update, so a value can be read
        without the row moving under the cursor. Ranking by depth re-sorts on every refresh and is
        off until you ask for it.
      </p>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
