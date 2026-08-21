<script setup lang="ts">
/**
 * SMPP ERRORS (PLAN.md 4.3, spec §11 / UC-ERR-01).
 *
 * §11 asks for two things. The first — "decode SMPP command status into
 * symbolic name and human explanation" with "recommended diagnostic checks,
 * clearly labeled as guidance rather than automated root-cause certainty" — is
 * exactly what `GET /diagnostics/smpp-statuses` serves, and it is what this
 * screen is.
 *
 * The second is an occurrence table: count, rate, first seen, last seen and
 * trend per SMSC and session. **No endpoint in this build aggregates command
 * statuses over time.** The decoder was promoted out of the bind prober, but
 * nothing records a status per submission, so there is no source for a count.
 * A table of codes with an empty "occurrences" column would be read as "this
 * has never happened", which is a much worse answer than saying so — see the
 * scope note, which is the first thing on the screen.
 *
 * The `note` field is rendered verbatim and given its own heading. It is the
 * sentence that stops the guidance column being read as a diagnosis, and
 * paraphrasing it would soften exactly the part that matters.
 *
 * Backend contract:
 *   GET /diagnostics/smpp-statuses         -> { statuses[], note }   (smsc.view)
 *   GET /diagnostics/smpp-statuses/:code   -> one SmppStatus; decimal or 0x hex
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import MiniChart from '../components/MiniChart.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  formatSmppCode,
  formatSmppCodeBoth,
  isUndecodedStatus,
  isVendorSpecific,
  matchesStatusQuery,
  parseSmppCodeInput,
  retryTone,
  retryWord,
  type SmppStatus,
  type SmppStatusTable,
} from '../utils/diagnostics';

const table = ref<SmppStatusTable | null>(null);
const state = ref<State>('loading');
const error = ref('');

const search = ref('');

const lookupInput = ref('');
const lookupResult = ref<SmppStatus | null>(null);
const lookupState = ref<State>('empty');
const lookupError = ref('');

const statuses = computed(() => table.value?.statuses ?? []);
const rows = computed(() => statuses.value.filter((row) => matchesStatusQuery(row, search.value)));
const retryableCount = computed(() => statuses.value.filter((row) => row.retryable).length);

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
function failureState(reason: unknown): State {
  return reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
}

async function load() {
  state.value = 'loading';
  try {
    const data = await apiRequest<SmppStatusTable>('/diagnostics/smpp-statuses');
    table.value = data;
    error.value = '';
    state.value = data?.statuses?.length ? 'live' : 'empty';
  } catch (reason) {
    table.value = null;
    error.value = messageFrom(reason, 'The status decoder could not be read.');
    state.value = failureState(reason);
  }
}

async function lookup() {
  const parsed = parseSmppCodeInput(lookupInput.value);
  if (parsed.code === null) {
    lookupResult.value = null;
    lookupError.value = parsed.error;
    lookupState.value = 'error';
    return;
  }
  lookupState.value = 'loading';
  try {
    // The raw input is sent, not the parsed number: the API accepts both
    // notations and echoing what was typed keeps its answer checkable.
    lookupResult.value = await apiRequest<SmppStatus>(
      `/diagnostics/smpp-statuses/${encodeURIComponent(lookupInput.value.trim())}`,
    );
    lookupError.value = '';
    lookupState.value = 'live';
  } catch (reason) {
    lookupResult.value = null;
    lookupError.value = messageFrom(reason, 'That command status could not be decoded.');
    lookupState.value = failureState(reason);
  }
}

/** True when the API had nothing to say about the code and said so in hex. */
const lookupUndecoded = computed(() =>
  lookupResult.value ? isUndecodedStatus(lookupResult.value) : false,
);

function clearLookup() {
  lookupInput.value = '';
  lookupResult.value = null;
  lookupError.value = '';
  lookupState.value = 'empty';
}

/* --- THROTTLING IN CONTEXT ----------------------------------------------------
 *
 * The recorded throughput series, drawn against the configured ceiling. Same
 * endpoint as Performance and Live Traffic, so all three show one history of
 * one gateway rather than three readings that can disagree.
 *
 * The ceiling is a flat line repeated across the buckets rather than a chart
 * annotation, because MiniChart draws series and a constant series IS the
 * clearest way to show a threshold on one.
 */
const THROTTLE_WINDOW_MINUTES = 360;

const throttlePoints = ref<{ at: string; outbound: number; peakOutbound: number }[]>([]);
const throttleCeiling = ref<number | null>(null);
const throttleState = ref<State>('loading');

const throttleSeries = computed(() => {
  const series = [
    { label: 'Observed MT (/s)', values: throttlePoints.value.map((point) => point.outbound) },
    { label: 'Peak in bucket (/s)', values: throttlePoints.value.map((point) => point.peakOutbound) },
  ];
  if (throttleCeiling.value !== null)
    series.push({
      label: `Configured ceiling (${throttleCeiling.value}/s)`,
      values: throttlePoints.value.map(() => throttleCeiling.value as number),
    });
  return series;
});

const throttleLabels = computed(() =>
  throttlePoints.value.map((point) => {
    const at = new Date(point.at);
    return Number.isNaN(at.getTime())
      ? point.at
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }),
);

async function loadThrottling() {
  throttleState.value = 'loading';
  try {
    const result = await apiRequest<{
      points?: { at: string; outbound: number; peakOutbound: number }[];
      ceiling?: { effectiveTps: number | null };
    }>(`/performance/throughput?minutes=${THROTTLE_WINDOW_MINUTES}`);
    throttlePoints.value = Array.isArray(result?.points) ? result.points : [];
    throttleCeiling.value = result?.ceiling?.effectiveTps ?? null;
    throttleState.value = throttlePoints.value.length ? 'live' : 'empty';
  } catch {
    throttlePoints.value = [];
    throttleCeiling.value = null;
    throttleState.value = 'error';
  }
}

onMounted(() => {
  void load();
  void loadThrottling();
});
</script>

<template>
  <div data-testid="smpp-errors-view">
    <!--
      WHAT THIS SCREEN IS NOT. First, before the reference table, because §11
      asks for occurrence counts and trends and an operator arriving here from
      the specification will look for them.
    -->
    <section class="panel scope-note" data-testid="smpp-scope" aria-labelledby="smpp-scope-heading">
      <h2 id="smpp-scope-heading">A decoder, not an error report</h2>
      <p>
        This is the reference: what a command status means and what to check next. It has
        <strong>no counts, no rates, no first-seen or last-seen and no trend</strong>, because
        nothing in this build records a command status per submission — there is no source to
        aggregate. An occurrence column here would be empty, and an empty count reads as “this has
        never happened”, which is a claim nobody measured.
      </p>
    </section>

    <!-- LOOK UP ONE CODE --------------------------------------------------- -->
    <section class="panel" data-testid="smpp-lookup" aria-labelledby="smpp-lookup-heading">
      <header class="panel-header">
        <div>
          <h2 id="smpp-lookup-heading">Look up a command status</h2>
          <p>
            Decimal or hex, whichever the carrier's documentation used:
            <span class="mono">88</span> and <span class="mono">0x58</span> are the same status.
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Command status</span>
          <input
            v-model="lookupInput"
            data-testid="smpp-lookup-input"
            type="search"
            placeholder="88, 0x58, 0x00000058"
            @keyup.enter="lookup"
          />
        </label>
        <button class="primary-button" data-testid="smpp-lookup-submit" @click="lookup">
          {{ lookupState === 'loading' ? 'Decoding…' : 'Decode' }}
        </button>
        <button class="secondary-button" data-testid="smpp-lookup-clear" @click="clearLookup">
          Clear
        </button>
      </div>

      <p
        v-if="lookupState === 'error'"
        class="form-error"
        role="alert"
        data-testid="smpp-lookup-error"
      >
        {{ lookupError }}
      </p>

      <article v-if="lookupResult" class="panel detail-panel" data-testid="smpp-lookup-result">
        <header>
          <div>
            <h3 data-testid="smpp-lookup-name">{{ lookupResult.name }}</h3>
            <p class="mono" data-testid="smpp-lookup-code">
              {{ formatSmppCodeBoth(lookupResult.code) }}
            </p>
          </div>
          <span class="status-badge" :class="retryTone(lookupResult.retryable)">{{
            retryWord(lookupResult.retryable)
          }}</span>
        </header>

        <!--
          THE UNDECODED CASE. The API returns the hex value as the name when it
          has no description, and this screen keeps it that way: no invented
          name, no nearest-standard-code guess, no reassuring wording.
        -->
        <p v-if="lookupUndecoded" class="warn-notice" role="note" data-testid="smpp-lookup-unknown">
          <strong>JKANNEL has no description for this status.</strong> It is shown by its hex value,
          <span class="mono">{{ formatSmppCode(lookupResult.code) }}</span
          >, and nothing here has been inferred from codes that look similar.
          <template v-if="isVendorSpecific(lookupResult.code)">
            The SMPP specification reserves this range for the carrier to define, so
            <strong>only the carrier can say what this means</strong> — check their integration
            documentation for {{ formatSmppCode(lookupResult.code) }}.
          </template>
          <template v-else>
            It is not in the standard set this build describes, so
            <strong>only the carrier can say what this means</strong> — look it up in their
            documentation rather than assuming it matches a nearby standard code.
          </template>
        </p>

        <dl class="detail-grid">
          <dt>What it means</dt>
          <dd data-testid="smpp-lookup-meaning">{{ lookupResult.meaning }}</dd>
          <dt>Suggested check</dt>
          <dd data-testid="smpp-lookup-guidance">{{ lookupResult.guidance }}</dd>
          <dt>Retrying</dt>
          <dd>{{ retryWord(lookupResult.retryable) }}</dd>
        </dl>
        <p class="source-note">
          A suggested check is a place to look, not a cause. See the note below the table.
        </p>
      </article>
    </section>

    <!-- THE REFERENCE TABLE ------------------------------------------------- -->
    <section class="panel" data-testid="smpp-table-panel" aria-labelledby="smpp-table-heading">
      <header class="panel-header">
        <div>
          <h2 id="smpp-table-heading">Command status reference</h2>
          <p aria-live="polite" data-testid="smpp-summary">
            {{
              state === 'loading'
                ? 'Reading the decoder…'
                : `${rows.length} of ${statuses.length} status(es) shown.`
            }}
          </p>
        </div>
        <button class="secondary-button" data-testid="smpp-refresh" @click="load">Refresh</button>
      </header>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="smpp-metric-total">{{
            displayValue(statuses.length, state)
          }}</strong>
          <small>statuses this build can describe</small>
        </div>
        <div class="metric">
          <strong data-testid="smpp-metric-retryable">{{
            displayValue(retryableCount, state)
          }}</strong>
          <small>where a retry could plausibly succeed</small>
        </div>
      </div>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="smpp-search"
            type="search"
            placeholder="ESME_RTHROTTLED, throttl, 0x58 or 88"
          />
        </label>
      </div>

      <DataState
        :state="state"
        subject="SMPP command statuses"
        skeleton="table"
        :skeleton-rows="6"
        :detail="state === 'error' ? error : undefined"
        permission="smsc.view"
        testid="smpp-state"
        :on-retry="load"
      >
        <div class="table-wrap">
          <table data-testid="smpp-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">What it means</th>
                <th scope="col">Suggested check (guidance)</th>
                <th scope="col">Retrying</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.code" :data-testid="`smpp-row-${row.code}`">
                <td class="mono">{{ formatSmppCodeBoth(row.code) }}</td>
                <td class="mono">{{ row.name }}</td>
                <td>{{ row.meaning }}</td>
                <td class="guidance-cell">{{ row.guidance }}</td>
                <td>
                  <span class="status-badge" :class="retryTone(row.retryable)">{{
                    retryWord(row.retryable)
                  }}</span>
                </td>
              </tr>
              <tr v-if="!rows.length && statuses.length">
                <td colspan="5" class="empty-cell" data-testid="smpp-no-match">
                  No status in the reference matches “{{ search }}”. Every status this build
                  describes is listed when the box is empty — if a carrier quoted you a code that is
                  not here, decode it with the lookup above; it will tell you plainly that only the
                  carrier can define it.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <!-- THE NOTE, VERBATIM. -->
      <section class="panel guidance-note" data-testid="smpp-note-panel" aria-label="Guidance note">
        <h3>Guidance, not a diagnosis</h3>
        <p data-testid="smpp-note">{{ table?.note }}</p>
      </section>

      <p class="source-note" data-testid="smpp-search-note">
        The search box filters in the browser. That is honest here and nowhere else on this console:
        the endpoint returns the complete decoder in one response — every status this build knows,
        with no paging — so filtering the list cannot hide a row that exists on a page you are not
        looking at.
      </p>
    </section>

    <!-- THROTTLING IN CONTEXT ---------------------------------------------------
      The design charts submitted against ACCEPTED, so the gap is what the
      carrier refused. This engine cannot draw that line: a refusal arrives as
      an SMPP command_status on a submit_sm_resp, and bearerbox records neither
      the status nor a count of them anywhere this console can read.

      What it does report is the rate that got through, and we know the ceiling
      that was configured. That is a genuinely useful pairing — a rate pinned at
      the ceiling is throughput being shaped, and a rate well under it with a
      growing queue is something else entirely — so the panel draws that and
      says which of the two questions it is answering.
    -->
    <section
      class="panel"
      data-testid="smpp-throttling"
      aria-labelledby="smpp-throttling-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="smpp-throttling-heading">Throttling in context</h2>
          <p>
            Observed throughput against the ceiling configured across the estate, over the last
            {{ Math.round(THROTTLE_WINDOW_MINUTES / 60) }} hours.
          </p>
        </div>
        <RouterLink class="text-button" to="/performance">Open Performance</RouterLink>
      </header>

      <MiniChart
        v-if="throttlePoints.length"
        type="line"
        :series="throttleSeries"
        :labels="throttleLabels"
        title="Throughput against configured ceiling"
        :height="170"
        data-testid="smpp-throttle-chart"
      />
      <p v-else class="chart-empty" data-testid="smpp-throttle-empty">
        {{
          throttleState === 'error'
            ? 'The recorded throughput series could not be read.'
            : 'The poller has recorded no sample in this window, so there is nothing to plot against the ceiling.'
        }}
      </p>

      <p v-if="throttleCeiling === null" class="warn-notice" role="note" data-testid="smpp-throttle-noceiling">
        <strong>No connection declares a throughput ceiling</strong>, so there is no line to compare
        against and the chart above is throughput alone. The ceiling is set per SMSC as its TPS.
      </p>

      <!--
        The refusal, stated where it will be looked for. Without it, a flat
        throughput line under a ceiling reads as "nothing is being throttled",
        which is a conclusion this data cannot support.
      -->
      <p class="source-note" data-testid="smpp-throttle-note">
        This is the gateway's side only. A carrier refusing a submission answers
        <span class="mono">ESME_RTHROTTLED</span> on the submit response, and this engine records
        neither that status nor a count of it — so a carrier actively refusing traffic looks
        identical here to a quiet hour. Throughput sitting exactly on the ceiling is the engine
        shaping its own rate, which is a different thing and the one this chart can show.
      </p>
    </section>
  </div>
</template>

<style scoped>
/* The margin is the shared `.panel` rule's — this only adds the accent. */
.scope-note {
  border-left: 3px solid var(--warn);
}
.scope-note h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.scope-note p {
  margin: 0;
  line-height: 1.6;
}
.guidance-note {
  margin-top: 16px;
  border-left: 3px solid var(--info);
}
.guidance-note h3 {
  margin: 0 0 6px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.guidance-note p {
  margin: 0;
  line-height: 1.6;
}
.guidance-cell {
  color: var(--muted);
  max-width: 360px;
}
.detail-panel h3 {
  margin: 0 0 2px;
  font-size: 15px;
}
</style>
<style src="./workspace-extras.css"></style>
