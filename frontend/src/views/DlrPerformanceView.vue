<script setup lang="ts">
/**
 * DLR PERFORMANCE (PLAN.md 3.3, spec §8).
 *
 * THE MATURITY WARNING IS THE POINT OF THIS SCREEN
 * ---------------------------------------------------------------------------
 * §8's UI requirement is one sentence: *"Make DLR maturity/window warnings
 * prominent to avoid false incident conclusions."*
 *
 * A receipt lands some time after the message is submitted. Any window that
 * reaches up to now therefore contains messages whose receipts have not arrived
 * yet, and a delivery rate computed over it is mechanically too low — lower the
 * fresher the window. An operator watching that number fall reads a carrier
 * outage. There is no outage. They are watching messages age into their own
 * receipts.
 *
 * So the warning is a `role="alert"` banner ABOVE every figure on the page, not
 * a footnote under them and not a tooltip. It is rendered verbatim: the backend
 * computes which of the two signals fired (window overlap, pending share) and
 * puts the percentages in the sentence, and paraphrasing it would drop the
 * numbers that make it actionable.
 *
 * AND BOTH RATES, ALWAYS TOGETHER
 * ---------------------------------------------------------------------------
 * `deliveryRate` excludes pending from the denominator; `deliveryRateIncluding-
 * Pending` counts every pending message as a failure. Either one alone misleads
 * — the first hides a window where nothing has come back, the second reads as a
 * collapse on any fresh window. Side by side, the gap between them IS the
 * pending backlog, and that is a thing an operator can act on.
 *
 * The window comes from the SHARED time range (spec §6: "preserve selected time
 * range when navigating between Traffic, SMSC and Diagnostics"), so a window
 * picked on one screen is the window this one answers for.
 *
 * Backend contract:
 *   GET /reports/dlr-performance?from=<ISO>&to=<ISO>   (perm reports.view)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import MiniChart, { type ChartSeries } from '../components/MiniChart.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import { resolveWindow, selectedRange } from '../stores/time-range';
import {
  DELIVERY_RATE_VIEWS,
  formatShare,
  formatLatency,
  readDeliveryAs,
  type BindQuality,
  type DeliveryQuality,
  type DlrPerformanceReport,
} from '../utils/traffic';

const report = ref<DlrPerformanceReport | null>(null);
const state = ref<State>('loading');
const error = ref('');
const sortBy = ref<'submitted' | 'worst'>('submitted');

const overall = computed<DeliveryQuality | null>(() => report.value?.overall ?? null);
const funnel = computed(() => overall.value?.funnel ?? null);
const maturity = computed(() => overall.value?.maturity ?? null);

/**
 * When the banner shows.
 *
 * Guarded on `available`, because when the message store could not be read at
 * all there are no figures on the page to misread — the unavailability notice
 * is the message that matters, and stacking a maturity warning on top of it
 * would bury it.
 */
const showMaturityWarning = computed(
  () => Boolean(report.value?.available) && Boolean(maturity.value?.immature),
);

/** Submitted → accepted → receipts → delivered, the four stages §8 names. */
const funnelStages = computed(() => {
  const data = funnel.value;
  if (!data) return [];
  return [
    {
      key: 'submitted',
      label: 'Submitted to the engine',
      value: data.submitted,
      detail: 'Messages JKANNEL handed to the gateway in this window.',
    },
    {
      key: 'accepted',
      label: 'Accepted by the engine',
      value: data.accepted,
      detail:
        'A submission the engine refused never reaches the message store, so this equals submitted.',
    },
    {
      key: 'receipts',
      label: 'Produced a receipt',
      value: data.receiptsReceived,
      detail: 'Any delivery receipt at all, whatever it said.',
    },
    {
      key: 'delivered',
      label: 'Delivered',
      value: data.delivered,
      detail: 'A receipt reporting successful delivery to the handset.',
    },
  ];
});

function shareOfSubmitted(value: number): number {
  const submitted = funnel.value?.submitted ?? 0;
  return submitted > 0 ? value / submitted : 0;
}

/**
 * A share of ONE carrier's own submissions, not of the estate's.
 *
 * Using the overall denominator here would make a small carrier's 100% reject
 * rate render as a fraction of a percent, which is the reading that lets a
 * completely broken connection hide behind a busy healthy one.
 */
function shareOfCarrier(row: BindQuality, value: number): number | null {
  const submitted = row.quality.funnel.submitted;
  return submitted > 0 ? value / submitted : null;
}

/** The outcome breakdown. `expired` is deliberately not a number — see below. */
const outcomes = computed(() => {
  const data = funnel.value;
  if (!data) return [];
  return [
    { key: 'delivered', label: 'delivered', value: data.delivered, tone: 'good' },
    { key: 'failed', label: 'failed', value: data.failed, tone: 'bad' },
    { key: 'rejected', label: 'rejected', value: data.rejected, tone: 'bad' },
    { key: 'pending', label: 'pending — no receipt yet', value: data.pending, tone: 'warn' },
    { key: 'unknown', label: 'unknown', value: data.unknown, tone: 'muted' },
  ];
});

const bindRows = computed<BindQuality[]>(() => {
  const rows = [...(report.value?.byBind ?? [])];
  if (sortBy.value === 'submitted') return rows;
  // Worst settled rate first, with "no settled outcome" pushed to the end
  // rather than sorted as if it were 0% — an unmeasured bind is not the worst
  // bind, and putting it at the top of a "worst first" list says it is.
  return rows.sort((a, b) => {
    const left = a.quality.deliveryRate;
    const right = b.quality.deliveryRate;
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  });
});

const immatureBinds = computed(() => bindRows.value.filter((row) => row.quality.maturity.immature));

/** Already ordered worst-delivery-first by the API, as the design orders it. */
const carrierRows = computed<BindQuality[]>(() => report.value?.byCarrier ?? []);

/**
 * MT submitted against receipts, over the same buckets.
 *
 * §8's point is that quality must be trended SEPARATELY from raw traffic, so a
 * busy hour is not read as a better hour. That needs both lines on one axis:
 * receipts tracking submissions is health, receipts flattening while
 * submissions climb is the picture worth catching.
 */
const volumeSeries = computed<ChartSeries[]>(() => {
  const points = report.value?.volume ?? [];
  return [
    { label: 'MT submitted', values: points.map((point) => point.submitted) },
    { label: 'Receipts received', values: points.map((point) => point.receipts) },
  ];
});

const volumeLabels = computed(() =>
  (report.value?.volume ?? []).map((point) => {
    const at = new Date(point.at);
    return Number.isNaN(at.getTime())
      ? point.at
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }),
);

const hasVolume = computed(() => (report.value?.volume ?? []).length > 0);

/**
 * The status breakdown as shares of the whole, for the design's bar rendering.
 *
 * A bar needs a denominator, and `submitted` is the only one that makes the
 * five bars add up to the window. Guarded against zero so an empty window
 * renders bars of nothing rather than NaN width.
 */
const statusBreakdown = computed(() =>
  outcomes.value.map((outcome) => ({
    ...outcome,
    share: shareOfSubmitted(outcome.value),
  })),
);

function bindLabel(row: BindQuality): string {
  return row.smscName ?? row.engineId;
}

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

async function load() {
  state.value = 'loading';
  const { from, to } = resolveWindow();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  try {
    const data = await apiRequest<DlrPerformanceReport>(
      `/reports/dlr-performance?${params.toString()}`,
    );
    report.value = data;
    error.value = '';
    if (data.available === false) {
      // Not "empty": empty would mean we looked and there was no traffic.
      error.value = data.detail;
      state.value = 'error';
    } else if (!data.overall?.funnel?.submitted) {
      state.value = 'empty';
    } else {
      state.value = 'live';
    }
  } catch (reason) {
    report.value = null;
    error.value = messageFrom(reason, 'The delivery-receipt report could not be loaded.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

// The shared range is the window. Changing it anywhere re-asks this question.
watch(selectedRange, () => void load());

onMounted(load);
</script>

<template>
  <div data-testid="dlr-performance-view">
    <!--
      THE MATURITY BANNER. First element in the document, before any figure, and
      `role="alert"` so a screen reader announces it rather than leaving it to be
      discovered after the number it is about.
    -->
    <!--
      `stale-banner` is the design system's own class for "what is below is not
      to be trusted as current", and an immature window is exactly that case —
      the receipts have not arrived yet, so the rate underneath reads low. Using
      the shared class rather than a local one keeps this banner identical to
      the staleness banners on Carriers, Dashboard and SMSC Detail; `maturity-alert`
      stays alongside it for the left-hand rule that marks this one as a warning
      about the reading rather than about the connection.
    -->
    <p
      v-if="showMaturityWarning"
      class="stale-banner maturity-alert"
      role="alert"
      data-testid="dlr-maturity-warning"
    >
      <strong>This window is too recent to draw a conclusion from.</strong>
      <span data-testid="dlr-maturity-text">{{ maturity?.warning }}</span>
    </p>

    <section class="panel" data-testid="dlr-window-panel" aria-labelledby="dlr-window-heading">
      <header class="panel-header">
        <div>
          <h2 id="dlr-window-heading">Delivery performance</h2>
          <p aria-live="polite" data-testid="dlr-window">
            {{
              state === 'loading'
                ? 'Reading receipts for the selected window…'
                : report
                  ? `${selectedRange.label}: ${formatMoment(report.from)} → ${formatMoment(report.to)}`
                  : selectedRange.label
            }}
          </p>
        </div>
        <button class="secondary-button" data-testid="dlr-refresh" @click="load">Refresh</button>
      </header>
      <p class="source-note" data-testid="dlr-window-note">
        The window is the console's shared time range, chosen in the top bar, so it is the same
        window the Traffic and SMSC screens are answering for. Every bind in the comparison below is
        measured over this identical window — which is what makes carriers comparable at all.
      </p>

      <!--
        BOTH RATES, SIDE BY SIDE. Neither is "the" delivery rate; the pair is.
      -->
      <div class="rate-pair" data-testid="dlr-rate-pair">
        <article class="rate-card">
          <h3>{{ DELIVERY_RATE_VIEWS[0].label }}</h3>
          <strong data-testid="dlr-rate-settled">{{
            formatShare(overall?.deliveryRate, state)
          }}</strong>
          <p>{{ DELIVERY_RATE_VIEWS[0].caption }}</p>
          <small
            >Optimistic while receipts are still arriving: a message with no receipt yet is not
            counted against this figure at all.</small
          >
        </article>
        <article class="rate-card">
          <h3>{{ DELIVERY_RATE_VIEWS[1].label }}</h3>
          <strong data-testid="dlr-rate-worst-case">{{
            formatShare(overall?.deliveryRateIncludingPending, state)
          }}</strong>
          <p>{{ DELIVERY_RATE_VIEWS[1].caption }}</p>
          <small
            >Pessimistic on a fresh window: it treats “no receipt yet” as “did not arrive”. The gap
            between the two figures is the pending backlog.</small
          >
        </article>
        <article class="rate-card">
          <h3>Accepted with no receipt</h3>
          <strong data-testid="dlr-rate-no-receipt">{{
            formatShare(overall?.noReceiptRate, state)
          }}</strong>
          <p>pending ÷ accepted — the size of the gap between the two rates above</p>
          <small
            >A high figure on a settled window means receipts are missing, not that handsets failed
            to receive the message. The two get different escalations.</small
          >
        </article>
      </div>

      <p v-if="error" class="form-error" role="alert" data-testid="dlr-error">{{ error }}</p>
    </section>

    <DataState
      :state="state"
      subject="delivery receipts"
      skeleton="cards"
      :skeleton-rows="4"
      :detail="
        state === 'empty'
          ? 'No message was submitted in this window, so there is no delivery rate to report. Widen the time range in the top bar, or check Live Traffic to confirm traffic is flowing.'
          : state === 'error'
            ? error
            : undefined
      "
      permission="reports.view"
      testid="dlr-state"
      :on-retry="load"
    >
      <section class="panel" data-testid="dlr-funnel-panel" aria-labelledby="dlr-funnel-heading">
        <header class="panel-header">
          <div>
            <h2 id="dlr-funnel-heading">Delivery funnel</h2>
            <p>Submitted → accepted → receipt received → delivered, over the window above.</p>
          </div>
        </header>
        <div class="funnel">
          <div
            v-for="(stage, index) in funnelStages"
            :key="stage.key"
            class="funnel-stage"
            :data-testid="`dlr-stage-${stage.key}`"
          >
            <div class="breakdown-label">
              <span>{{ stage.label }}</span>
              <span>
                <strong>{{ displayValue(stage.value, state) }}</strong>
                <span class="funnel-share">{{
                  formatShare(shareOfSubmitted(stage.value), state)
                }}</span>
                <span v-if="index > 0" class="funnel-drop"
                  >−{{ displayValue(funnelStages[index - 1].value - stage.value, state) }}</span
                >
              </span>
            </div>
            <span class="breakdown-track"
              ><span
                class="breakdown-fill"
                :style="{ width: `${Math.max(1, shareOfSubmitted(stage.value) * 100)}%` }"
              ></span
            ></span>
            <small class="row-id">{{ stage.detail }}</small>
          </div>
        </div>
      </section>

      <section
        class="panel"
        data-testid="dlr-outcomes-panel"
        aria-labelledby="dlr-outcomes-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="dlr-outcomes-heading">Status breakdown</h2>
            <p>
              Normalised status with the count behind it. Every accepted message in the window, by
              what happened to it.
            </p>
          </div>
        </header>
        <ul class="outcome-list">
          <li
            v-for="outcome in statusBreakdown"
            :key="outcome.key"
            :data-testid="`dlr-outcome-${outcome.key}`"
          >
            <span class="status-badge" :class="outcome.tone">{{ outcome.label }}</span>
            <strong>{{ displayValue(outcome.value, state) }}</strong>
            <!--
              The bar is the design's, and it carries no information the number
              beside it does not — which is the point: a share is compared by
              eye far faster than it is read, and this panel exists to be
              scanned.
            -->
            <span class="breakdown-track" aria-hidden="true">
              <span
                class="breakdown-fill"
                :class="`fill-${outcome.tone}`"
                :style="{ width: `${Math.max(outcome.share > 0 ? 1 : 0, outcome.share * 100)}%` }"
              ></span>
            </span>
            <small>{{ formatShare(outcome.share, state) }}</small>
          </li>
          <!--
            `expired` is in the contract and is always zero, because Kannel's DLR
            mask has five values and none of them is expiry. Printing that zero
            would say we looked and found none.
          -->
          <li data-testid="dlr-outcome-expired">
            <span class="status-badge muted">expired</span>
            <strong>not distinguishable</strong>
            <small
              >the engine's receipt mask has no expiry value, so an expired message is reported as
              failed or never reported at all</small
            >
          </li>
        </ul>
      </section>

      <!-- DELIVERY RATE AGAINST VOLUME ----------------------------------- -->
      <section class="panel" data-testid="dlr-volume-panel" aria-labelledby="dlr-volume-heading">
        <header class="panel-header">
          <div>
            <h2 id="dlr-volume-heading">Delivery rate against volume</h2>
            <p>
              Quality is trended separately from raw traffic, so a busy hour is not read as a better
              hour. Bucketed on the message's own submission time, so a late receipt still counts
              against the minute the message was sent.
            </p>
          </div>
        </header>
        <MiniChart
          v-if="hasVolume"
          type="line"
          :series="volumeSeries"
          :labels="volumeLabels"
          title="MT submitted against receipts received"
          :height="170"
          data-testid="dlr-volume-chart"
        />
        <p v-else class="chart-empty" data-testid="dlr-volume-empty">
          No message was submitted in this window, so there is no trend to draw. That is an absence
          of traffic, not an absence of measurement.
        </p>
        <p class="source-note">
          Receipts tracking submissions is health. Receipts flattening while submissions climb is
          the picture this panel exists to catch — and it is invisible on a delivery percentage,
          which stays flat while the backlog grows.
        </p>
      </section>

      <!-- CARRIER COMPARISON ---------------------------------------------- -->
      <section class="panel" data-testid="dlr-carrier-panel" aria-labelledby="dlr-carrier-heading">
        <header class="panel-header">
          <div>
            <h2 id="dlr-carrier-heading">Carrier comparison</h2>
            <p>
              An identical window for every carrier, worst delivery first. Rolled up in the database
              per carrier rather than averaged from the binds below — a mean of two binds' P95s
              describes no message that was ever sent.
            </p>
          </div>
        </header>
        <div v-if="carrierRows.length" class="table-wrap">
          <table data-testid="dlr-carrier-table">
            <thead>
              <tr>
                <th scope="col">Carrier</th>
                <th scope="col">Delivery</th>
                <th scope="col">P50</th>
                <th scope="col">P95</th>
                <th scope="col">P99</th>
                <th scope="col">No-DLR</th>
                <th scope="col">Reject</th>
                <th scope="col">Read as</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in carrierRows"
                :key="row.carrierId ?? 'unassigned'"
                :data-testid="`dlr-carrier-${row.carrierId ?? 'unassigned'}`"
              >
                <td>
                  <strong>{{ row.carrierName ?? 'No carrier record' }}</strong>
                  <small v-if="!row.carrierName" class="row-id">
                    traffic on connections that belong to no carrier
                  </small>
                </td>
                <td>{{ formatShare(row.quality.deliveryRate, state) }}</td>
                <td class="mono">{{ formatLatency(row.quality.latency?.p50) }}</td>
                <td class="mono">{{ formatLatency(row.quality.latency?.p95) }}</td>
                <td class="mono">{{ formatLatency(row.quality.latency?.p99) }}</td>
                <td>{{ formatShare(row.quality.noReceiptRate, state) }}</td>
                <td>{{ formatShare(shareOfCarrier(row, row.quality.funnel.rejected), state) }}</td>
                <td>
                  <span class="status-badge" :class="readDeliveryAs(row.quality).tone">{{
                    readDeliveryAs(row.quality).word
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="chart-empty" data-testid="dlr-carrier-empty">
          No carrier carried traffic in this window.
        </p>
        <!--
          The sentence the whole column exists for. Kept verbatim from the
          design, because the two conditions it separates get different
          escalations and the distinction is the point of the panel.
        -->
        <p class="source-note">
          A high no-DLR rate with a normal reject rate means receipts are missing, not that handsets
          failed to receive the message. The two get different escalations.
        </p>
        <!--
          Throttling is in the design's table and is NOT here. Kannel's status
          interface exposes no per-message command_status, so ESME_RTHROTTLED
          cannot be counted from the message store — only bearerbox's own log
          carries it. An empty column would have implied nobody was throttled.
        -->
        <p class="source-note" data-testid="dlr-carrier-throttle-note">
          There is no throttle column. A throttled submission is reported by the carrier as an SMPP
          <span class="mono">command_status</span>, which this engine does not record against the
          message — so the rate cannot be counted here at all. SMPP Errors is where throttling
          shows up.
        </p>
      </section>

      <section class="panel" data-testid="dlr-bind-panel" aria-labelledby="dlr-bind-heading">
        <header class="panel-header">
          <div>
            <h2 id="dlr-bind-heading">Per-bind comparison</h2>
            <p data-testid="dlr-bind-summary">
              {{ bindRows.length }} bind(s), all measured over the identical window above.
            </p>
          </div>
          <label class="filter-select">
            <span>Order</span>
            <select v-model="sortBy" data-testid="dlr-bind-sort">
              <option value="submitted">most traffic first</option>
              <option value="worst">worst settled rate first</option>
            </select>
          </label>
        </header>

        <p
          v-if="immatureBinds.length"
          class="warn-notice"
          role="note"
          data-testid="dlr-bind-maturity-note"
        >
          {{ immatureBinds.length }} of these binds has a window too recent for its receipts to have
          settled, marked below. Comparing a settled bind against an unsettled one will always make
          the unsettled one look worse.
        </p>

        <div class="table-wrap">
          <table data-testid="dlr-bind-table">
            <thead>
              <tr>
                <th scope="col">Bind</th>
                <th scope="col">Carrier</th>
                <th scope="col">Submitted</th>
                <th scope="col">Delivered</th>
                <th scope="col">Failed</th>
                <th scope="col">Rejected</th>
                <th scope="col">Pending</th>
                <th scope="col">Settled rate</th>
                <th scope="col">Worst-case rate</th>
                <th scope="col">No receipt</th>
                <th scope="col">P50</th>
                <th scope="col">P95</th>
                <th scope="col">P99</th>
                <th scope="col">Window</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in bindRows"
                :key="row.engineId"
                :data-testid="`dlr-bind-${row.engineId}`"
              >
                <td>
                  <router-link class="text-link" :to="`/smsc/${row.engineId}`">{{
                    bindLabel(row)
                  }}</router-link>
                  <small class="row-id mono">{{ row.engineId }}</small>
                </td>
                <td>
                  <router-link
                    v-if="row.carrierId"
                    class="text-link"
                    :to="`/carriers/${row.carrierId}`"
                    >{{ row.carrierName }}</router-link
                  >
                  <span v-else class="row-id">unassigned</span>
                </td>
                <td class="mono">{{ displayValue(row.quality.funnel.submitted, state) }}</td>
                <td class="mono">{{ displayValue(row.quality.funnel.delivered, state) }}</td>
                <td class="mono">{{ displayValue(row.quality.funnel.failed, state) }}</td>
                <td class="mono">{{ displayValue(row.quality.funnel.rejected, state) }}</td>
                <td class="mono">{{ displayValue(row.quality.funnel.pending, state) }}</td>
                <td class="mono" :data-testid="`dlr-bind-settled-${row.engineId}`">
                  {{ formatShare(row.quality.deliveryRate, state) }}
                </td>
                <td class="mono" :data-testid="`dlr-bind-worst-${row.engineId}`">
                  {{ formatShare(row.quality.deliveryRateIncludingPending, state) }}
                </td>
                <td class="mono">{{ formatShare(row.quality.noReceiptRate, state) }}</td>
                <!-- Round-trip receipt latency over DELIVERED receipts only, so
                     a carrier that rejects instantly cannot flatter its own
                     percentile. `unknown` when nothing was delivered: a
                     percentile over an empty set is not zero. -->
                <td class="mono" :data-testid="`dlr-bind-p50-${row.engineId}`">
                  {{ formatLatency(row.quality.latency?.p50) }}
                </td>
                <td class="mono">{{ formatLatency(row.quality.latency?.p95) }}</td>
                <td class="mono">{{ formatLatency(row.quality.latency?.p99) }}</td>
                <td :data-testid="`dlr-bind-maturity-${row.engineId}`">
                  <span
                    v-if="row.quality.maturity.immature"
                    class="status-badge warn"
                    :title="row.quality.maturity.warning ?? ''"
                    >too recent to judge</span
                  >
                  <span v-else class="status-badge good">settled</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="source-note" data-testid="dlr-bind-note">
          Two rates per bind, for the same reason as the pair at the top: a bind whose settled rate
          is high and whose worst-case rate is low is not failing, it is waiting. A bind where both
          are low is failing.
        </p>
      </section>
    </DataState>
  </div>
</template>

<style scoped>
/*
  The maturity banner is styled as the loudest thing on the page on purpose.
  Tone is carried by the word "too recent" as well as the colour (§17.1).
*/
.maturity-alert {
  display: grid;
  gap: 6px;
  margin: 0 0 14px;
  padding: 14px 16px;
  border: 1px solid var(--warn);
  border-left-width: 4px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--warn) 12%, var(--surface));
  color: var(--warn);
  line-height: 1.6;
}
.maturity-alert strong {
  color: var(--warn);
  font-size: 14px;
}
.maturity-alert span {
  color: var(--text);
  font-size: 13px;
}

.rate-pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.rate-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--surface-2);
  display: grid;
  gap: 4px;
  align-content: start;
}
.rate-card h3 {
  margin: 0;
  font-size: 13px;
  color: var(--text-strong);
}
.rate-card strong {
  font-size: 28px;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.rate-card p {
  margin: 0;
  font-size: 12px;
  color: var(--text);
}
.rate-card small {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.funnel {
  display: grid;
  gap: 14px;
  margin-top: 12px;
}
.funnel-stage {
  display: grid;
  gap: 5px;
}
.funnel-share {
  margin-left: 8px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.funnel-drop {
  margin-left: 8px;
  color: var(--bad);
  font-variant-numeric: tabular-nums;
}

.outcome-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.outcome-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.outcome-list strong {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.outcome-list small {
  color: var(--muted);
  font-size: 11.5px;
  margin-left: auto;
  text-align: right;
  max-width: 46ch;
  line-height: 1.5;
}
</style>
<style src="./workspace-extras.css"></style>
