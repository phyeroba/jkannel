<script setup lang="ts">
/**
 * MESSAGE TRACE (PLAN.md 4.2, spec §10 / UC-MSG-01).
 *
 * §10 asks for "a chronological trace, not a raw log dump", with per-stage
 * timestamps, calculated latency, and **the first abnormal or missing stage
 * highlighted**. The backend (4.1) already assembles the stages, computes the
 * latencies and names the first problem; this screen's whole job is to render
 * that without quietly undoing any of it.
 *
 * Three things it must not do, each of which is easy to do by accident:
 *
 * 1. **Bury `firstProblem`.** It is the first thing under the search box, above
 *    the timeline, in a `role="alert"` region. An operator who has to scan a
 *    twelve-stage timeline for the amber one has been given a log dump with
 *    extra styling.
 * 2. **Paint a pending receipt as a failure.** `pending` means no receipt has
 *    arrived YET, and the backend's own detail sentence says "that is not a
 *    failure". So the badge is muted, the word is "still waiting", and the
 *    sentence is repeated in the operator's own words underneath.
 * 3. **Render `latencyMs: null` as `0ms`.** Null is the normal case on the first
 *    stage and on either side of a stage with no timestamp. Everything numeric
 *    on this screen goes through `displayValue` (§17).
 *
 * The raw engine rows stay on the page, collapsed, because §10's "not a log
 * dump" is about the DEFAULT view, not about hiding evidence: an interpretation
 * an operator cannot check is worse than the rows it was built from.
 *
 * Backend contract:
 *   GET /diagnostics/messages/:id/lifecycle   (perm messages.view)
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import PrivacyReveal from '../components/PrivacyReveal.vue';
import { canAccess, session } from '../stores/session';
import { privacyOf, type PrivacyState } from '../utils/privacy';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import {
  bindFactTarget,
  buildDiagnosticSummary,
  deliveryTone,
  factLabel,
  formatFinal,
  formatLatency,
  formatMilliseconds,
  formatStageMoment,
  stageTone,
  stageWord,
  TRACE_STATUS_FILTERS,
  type MessageTrace,
  type TraceSearchRow,
} from '../utils/diagnostics';

const route = useRoute();
const router = useRouter();

const canReveal = computed(() => canAccess(session.value, 'messages.reveal'));
const privacy = ref<PrivacyState | null>(null);
const revealing = ref(false);

/**
 * A trace is one message, so the reveal window is asked for against that
 * message id. The grant then unmasks this message and nothing else — the
 * narrowest authority that answers the question the operator is asking.
 */
function onRevealChanged(value: boolean) {
  if (revealing.value === value) return;
  revealing.value = value;
  if (searched.value) void load(searched.value);
  // The grid carries the same subscriber numbers, so it must honour the same
  // grant — leaving it masked behind a revealed trace would look like a bug and
  // send someone back to the Messages workspace to see the number.
  if (matches.value.length) void loadMatches();
}

const query = ref(String(route.query.id ?? ''));
const searched = ref('');
const trace = ref<MessageTrace | null>(null);
const state = ref<State>('empty');
const error = ref('');
const copied = ref(false);

/* --- FINDING THE MESSAGE -----------------------------------------------------
 *
 * The lifecycle endpoint needs an exact id. Every operator who arrives here
 * from a complaint has an MSISDN or a carrier reference instead, and until now
 * the only route from one to the other was to open the Messages workspace,
 * search there, copy the id back. So the same box now also runs the message
 * search — `GET /messages`, the same endpoint and the same filters the Messages
 * grid uses — and a row click traces it.
 *
 * The two reads stay separate calls on purpose. Searching is a page of an
 * indexed table; tracing assembles per-stage evidence for one message. Making
 * the search return lifecycles would charge every scrolled-past row the price
 * of the one the operator actually wanted.
 */
const statusFilter = ref('');
const matches = ref<TraceSearchRow[]>([]);
const matchState = ref<State>('empty');
const matchError = ref('');
const matchTotal = ref<number | null>(null);
/** Engine SMSC id → carrier name, so a row can say "MTN" and not only `mtn-p1`. */
const carrierBySmsc = ref<Record<string, string>>({});
let carrierLookupTried = false;

const MATCH_LIMIT = 25;

/** The `/messages` envelope, coerced. A page shape must never crash the screen. */
function asRows(payload: unknown): TraceSearchRow[] {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is TraceSearchRow => Boolean(item) && typeof item === 'object');
}

function carrierFor(smscId: string | null | undefined): string | null {
  const id = (smscId ?? '').trim();
  return id ? (carrierBySmsc.value[id] ?? null) : null;
}

/**
 * Resolves carrier names once per visit, and never fails the search.
 *
 * The SMSC id is already in every row, so the carrier name is a convenience
 * label on top of data the operator can read regardless. An error here is
 * swallowed rather than surfaced: a failed lookup must not make it look as
 * though the search itself went wrong.
 */
async function loadCarrierNames() {
  if (carrierLookupTried) return;
  carrierLookupTried = true;
  try {
    const page = await apiRequest<unknown>('/smscs?limit=200');
    const items = (page as { items?: unknown })?.items;
    const map: Record<string, string> = {};
    for (const row of Array.isArray(items) ? items : []) {
      const record = row as Record<string, unknown>;
      const engineId = record.engine_id ?? record.engineId;
      const carrier = record.carrier_name ?? record.carrierName;
      if (typeof engineId === 'string' && typeof carrier === 'string' && carrier.trim())
        map[engineId] = carrier;
    }
    carrierBySmsc.value = map;
  } catch {
    carrierBySmsc.value = {};
  }
}

async function loadMatches() {
  const clean = query.value.trim();
  if (!clean && !statusFilter.value) {
    matchState.value = 'empty';
    matches.value = [];
    matchTotal.value = null;
    return;
  }
  matchState.value = 'loading';
  const params = new URLSearchParams();
  if (clean) params.set('query', clean);
  if (statusFilter.value) params.set('deliveryStatus', statusFilter.value);
  params.set('limit', String(MATCH_LIMIT));
  if (revealing.value) params.set('reveal', 'true');
  try {
    const payload = await apiRequest<unknown>(`/messages?${params.toString()}`);
    const rows = asRows(payload);
    matches.value = rows;
    matchTotal.value = (payload as { total?: number | null })?.total ?? null;
    // An unreadable engine store is a different answer from "nothing matched",
    // and showing it as an empty result would tell an operator their message
    // does not exist when in fact nobody looked.
    const source = (payload as { source?: { status?: string; message?: string } })?.source;
    if (source?.status === 'unavailable') {
      matchError.value =
        source.message ??
        'The engine message store could not be read, so nothing was searched. This is not evidence that no message matches.';
      matchState.value = 'error';
      return;
    }
    matchError.value = '';
    matchState.value = rows.length ? 'live' : 'empty';
    if (rows.length) void loadCarrierNames();
  } catch (reason) {
    matches.value = [];
    matchTotal.value = null;
    matchError.value = messageFrom(reason, 'The message search could not be run.');
    matchState.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

/** The row currently being traced, so the summary can quote its facts. */
const tracedRow = computed(
  () => matches.value.find((row) => String(row.id) === searched.value) ?? null,
);

const summaryOpen = ref(false);
const summaryCopied = ref(false);
const summaryText = computed(() =>
  trace.value
    ? buildDiagnosticSummary(trace.value, tracedRow.value, carrierFor(tracedRow.value?.smscId))
    : '',
);

async function copySummary() {
  try {
    await navigator.clipboard?.writeText(summaryText.value);
    summaryCopied.value = true;
  } catch {
    summaryCopied.value = false;
  }
}

/** A row click is a drill-down: it traces that message without retyping its id. */
function traceRow(row: TraceSearchRow) {
  const id = String(row.id ?? '').trim();
  if (!id) return;
  void router.replace({ path: route.path, query: { id } });
  void load(id);
}

const lifecycle = computed(() => trace.value?.lifecycle ?? null);
const stages = computed(() => lifecycle.value?.stages ?? []);
const firstProblem = computed(() => lifecycle.value?.firstProblem ?? null);
/** Stages still waiting. Counted separately from problems, on purpose. */
const pendingStages = computed(() => stages.value.filter((stage) => stage.status === 'pending'));

/**
 * Whether the engine store answered. `available: false` means the whole engine
 * half of the lifecycle is missing — so an absent `submitted` stage says
 * nothing about whether the message was submitted, and the screen must not let
 * that absence be read as evidence.
 */
const engineUnavailable = computed(() => Boolean(trace.value) && trace.value?.available === false);

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

async function load(id: string) {
  const clean = id.trim();
  if (!clean) {
    state.value = 'empty';
    trace.value = null;
    searched.value = '';
    return;
  }
  state.value = 'loading';
  searched.value = clean;
  copied.value = false;
  try {
    const result = await apiRequest<MessageTrace>(
      `/diagnostics/messages/${encodeURIComponent(clean)}/lifecycle${revealing.value ? '?reveal=true' : ''}`,
    );
    trace.value = result;
    privacy.value = privacyOf(result);
    error.value = '';
    const hasEvidence = Boolean(result?.lifecycle?.stages?.length || result?.events?.length);
    // `partial` rather than `live` when the engine store is down: the routing
    // decision on its own IS a real measurement, and blanking it would be the
    // worse failure — but it is half the story and says so.
    state.value = !hasEvidence ? 'empty' : result.available === false ? 'partial' : 'live';
    setBreadcrumbTrail(route.path, [
      { label: 'Message Trace', to: '/message-trace' },
      { label: clean },
    ]);
  } catch (reason) {
    trace.value = null;
    error.value = messageFrom(reason, 'The message lifecycle could not be read.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

function search() {
  const clean = query.value.trim();
  // The id lives in the URL so a trace can be pasted into a ticket and reopened.
  void router.replace({ path: route.path, query: clean ? { id: clean } : {} });
  // Lifecycle first, then the search. An exact id answers in one request and is
  // what most searches are; the grid is the fallback for everyone who arrived
  // with an MSISDN instead.
  void load(clean);
  void loadMatches();
}

async function copyId() {
  const id = trace.value?.id ?? searched.value;
  if (!id) return;
  try {
    await navigator.clipboard?.writeText(id);
    copied.value = true;
  } catch {
    // Clipboard access is permission-gated and absent over plain HTTP. The id
    // is on screen and selectable either way, so this is not worth an error.
    copied.value = false;
  }
}

onMounted(() => {
  if (!query.value.trim()) return;
  void load(query.value);
  void loadMatches();
});
</script>

<template>
  <div data-testid="message-trace-view">
    <!-- SEARCH ------------------------------------------------------------- -->
    <section class="panel" data-testid="trace-search" aria-labelledby="trace-search-heading">
      <header class="panel-header">
        <div>
          <h2 id="trace-search-heading">Message Trace</h2>
          <p>
            One message, from the routing decision to the delivery receipt, with the time each stage
            took. Search by the id JKANNEL issued, the id the engine recorded, a sender, or a
            destination number — an exact id traces straight through, anything else lists what
            matched so you can pick the right one.
          </p>
        </div>
        <label class="filter-select" data-testid="trace-status-filter">
          <span>Status</span>
          <select v-model="statusFilter" @change="loadMatches">
            <option value="">any</option>
            <option v-for="status in TRACE_STATUS_FILTERS" :key="status" :value="status">
              {{ status }}
            </option>
          </select>
        </label>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Message id, reference or number</span>
          <input
            v-model="query"
            data-testid="trace-input"
            type="search"
            placeholder="A message id, a carrier reference, or the destination number"
            @keyup.enter="search"
          />
        </label>
        <button class="primary-button" data-testid="trace-search-submit" @click="search">
          {{ state === 'loading' ? 'Reading…' : 'Trace' }}
        </button>
      </div>

      <p v-if="searched" class="source-note" data-testid="trace-searched">
        Tracing <span class="mono">{{ searched }}</span>
        <button class="secondary-button" data-testid="trace-copy-id" @click="copyId">
          {{ copied ? 'Copied' : 'Copy id' }}
        </button>
      </p>
    </section>

    <!-- WHAT MATCHED ------------------------------------------------------- -->
    <section
      v-if="matchState !== 'empty' || matches.length"
      class="panel"
      data-testid="trace-matches"
      aria-labelledby="trace-matches-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="trace-matches-heading">Matching messages</h2>
          <p>
            From the engine message store, newest first. Select a row to trace it — the id does not
            need to be copied anywhere.
          </p>
        </div>
        <span v-if="matchState === 'live'" class="status-badge muted" data-testid="trace-match-count">
          {{ matches.length }}{{ matchTotal !== null && matchTotal > matches.length ? ` of ${matchTotal}` : '' }}
        </span>
      </header>

      <DataState
        :state="matchState"
        subject="matching messages"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          matchState === 'error'
            ? matchError
            : matchState === 'empty'
              ? 'Nothing in the retained window matches that search. Retention prunes older messages, so an absence here is not proof the message never existed.'
              : undefined
        "
        permission="messages.view"
        testid="trace-match-state"
        :on-retry="loadMatches"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Message ID</th>
                <th scope="col">Carrier ID</th>
                <th scope="col">Destination</th>
                <th scope="col">Sender</th>
                <th scope="col">Carrier</th>
                <th scope="col">SMSC</th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
                <th scope="col">Final</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in matches"
                :key="row.id"
                class="selectable"
                :class="{ 'is-traced': String(row.id) === searched }"
                :data-testid="`trace-match-${row.id}`"
                tabindex="0"
                @click="traceRow(row)"
                @keyup.enter="traceRow(row)"
              >
                <td class="mono">{{ row.id }}</td>
                <!--
                  A message the engine has not yet given a reference has no
                  carrier id — not an unknown one. `not issued` says which.
                -->
                <td class="mono cell-tight">{{ row.externalRef || 'not issued' }}</td>
                <td class="mono">{{ displayValue(row.receiver, matchState) }}</td>
                <td>{{ displayValue(row.sender, matchState) }}</td>
                <td>{{ carrierFor(row.smscId) ?? 'unassigned' }}</td>
                <td class="mono cell-tight">{{ displayValue(row.smscId, matchState) }}</td>
                <td>
                  <span class="status-badge" :class="deliveryTone(row.deliveryStatus)">{{
                    row.deliveryStatus ?? 'unknown'
                  }}</span>
                </td>
                <td class="mono cell-tight">{{ formatMoment(row.timestamp) }}</td>
                <td class="mono cell-tight">{{ formatFinal(row.dlrAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="source-note">
          “Carrier” is resolved from the SMSC the message went out on. A connection that belongs to
          no carrier record reads <span class="mono">unassigned</span> — the SMSC id beside it is
          still the authoritative one.
        </p>
      </DataState>
    </section>

    <DataState
      :state="state"
      subject="this message's lifecycle"
      skeleton="table"
      :skeleton-rows="5"
      :detail="
        state === 'empty' && searched && matches.length
          ? 'What you typed is not itself a message id, but it matched the messages listed above. Select one to trace it.'
          : state === 'empty' && searched
            ? 'Nothing is recorded under that identifier — no routing decision in JKANNEL and no row in the engine store. That is not proof the message never existed: retention prunes old messages, and an id from a different environment will not be found here either.'
          : state === 'empty'
            ? 'Search above by message id, carrier reference, sender or destination number. An exact id traces straight through; anything else lists what matched.'
            : state === 'error'
              ? error
              : state === 'partial'
                ? (trace?.detail ?? undefined)
                : undefined
      "
      permission="messages.view"
      testid="trace-state"
      :on-retry="() => load(searched)"
    >
      <!-- THE FIRST PROBLEM, ABOVE THE TIMELINE ---------------------------- -->
      <section
        v-if="firstProblem"
        class="panel problem-panel"
        role="alert"
        data-testid="trace-first-problem"
        aria-labelledby="trace-problem-heading"
      >
        <h2 id="trace-problem-heading">First abnormal stage: {{ firstProblem.label }}</h2>
        <p data-testid="trace-first-problem-detail">{{ firstProblem.detail }}</p>
        <p class="source-note">
          Everything before this stage completed. This is where the lifecycle stopped behaving, so
          it is where to look first — not necessarily where the cause is.
        </p>
      </section>
      <p v-else class="notice" role="status" data-testid="trace-no-problem">
        No stage went wrong.
        <template v-if="lifecycle?.inFlight">
          This message is still in flight, so stages that have not happened yet cannot have failed
          yet either.
        </template>
        <template v-else> Every recorded stage completed normally. </template>
      </p>

      <!-- ENGINE AVAILABILITY --------------------------------------------- -->
      <p
        v-if="engineUnavailable"
        class="warn-notice"
        role="alert"
        data-testid="trace-engine-unavailable"
      >
        <strong>The engine message store could not be read.</strong> Only JKANNEL's own record — the
        routing decision and the retry chain — is below. A missing spool, submit or receipt stage
        here means <em>not readable</em>, not <em>did not happen</em>.
        <span class="mono">{{ trace?.detail }}</span>
      </p>

      <!-- SUMMARY ----------------------------------------------------------- -->
      <section class="panel" data-testid="trace-summary" aria-labelledby="trace-summary-heading">
        <header class="panel-header">
          <div>
            <h2 id="trace-summary-heading">Lifecycle</h2>
            <p>{{ stages.length }} recorded stage(s).</p>
          </div>
          <div class="head-actions">
            <span
              class="status-badge"
              :class="lifecycle?.inFlight ? 'warn' : 'good'"
              data-testid="trace-inflight"
              >{{ lifecycle?.inFlight ? 'in flight' : 'settled' }}</span
            >
            <button
              class="secondary-button"
              type="button"
              data-testid="trace-summary-open"
              @click="
                summaryCopied = false;
                summaryOpen = true;
              "
            >
              Diagnostic summary
            </button>
          </div>
        </header>

        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="trace-total">{{
              displayValue(lifecycle?.totalMs, state, formatMilliseconds)
            }}</strong>
            <small>first stage to last</small>
          </div>
          <div class="metric">
            <strong data-testid="trace-stage-count">{{
              displayValue(stages.length, state)
            }}</strong>
            <small>stages recorded</small>
          </div>
          <div class="metric">
            <strong data-testid="trace-pending-count">{{
              displayValue(pendingStages.length, state)
            }}</strong>
            <small>stages still waiting</small>
          </div>
          <div class="metric">
            <strong data-testid="trace-event-count">{{
              displayValue(trace?.events?.length, state)
            }}</strong>
            <small>raw engine rows</small>
          </div>
        </div>
        <p class="source-note" data-testid="trace-total-note">
          Total elapsed spans only the stages that carry a timestamp. It is not a delivery time: a
          message whose receipt has not arrived has no last stage to measure to, and the figure
          above stops at whatever did happen.
        </p>

        <!-- THE TIMELINE ---------------------------------------------------- -->
        <ol class="timeline" data-testid="trace-timeline">
          <li
            v-for="(stage, index) in stages"
            :key="`${stage.kind}-${index}`"
            class="timeline-item"
            :class="`tone-${stageTone(stage.status)}`"
            :data-testid="`trace-stage-${stage.kind}`"
            :data-status="stage.status"
          >
            <span class="timeline-marker" aria-hidden="true"></span>
            <div class="timeline-body">
              <header class="timeline-head">
                <strong>{{ stage.label }}</strong>
                <!-- Word first; the tone only repeats what it already says (§17.1). -->
                <span
                  class="status-badge"
                  :class="stageTone(stage.status)"
                  :data-testid="`trace-status-${stage.kind}`"
                  >{{ stageWord(stage.status) }}</span
                >
              </header>
              <p class="timeline-detail">{{ stage.detail }}</p>

              <!--
                The pending receipt, spelled out a second time. The backend
                sentence above already says it; this one says what it means for
                the person reading, because "no receipt" is the single most
                misread state on this screen.
              -->
              <p
                v-if="stage.status === 'pending'"
                class="pending-note"
                :data-testid="`trace-pending-note-${stage.kind}`"
              >
                Still waiting is not the same as failed. Nothing here says this message was lost —
                only that no receipt has arrived yet, and some carriers never send one at all.
              </p>

              <dl class="timeline-facts">
                <dt>When</dt>
                <dd class="mono" :data-testid="`trace-at-${stage.kind}`">
                  {{ formatStageMoment(stage.at, stage.status) }}
                </dd>
                <dt>Since previous stage</dt>
                <dd class="mono" :data-testid="`trace-latency-${stage.kind}`">
                  {{ formatLatency(stage.latencyMs, state) }}
                </dd>
                <template v-for="(value, key) in stage.facts" :key="key">
                  <dt>{{ factLabel(String(key)) }}</dt>
                  <dd class="mono">
                    <router-link
                      v-if="bindFactTarget(String(key), value)"
                      class="text-link"
                      :to="bindFactTarget(String(key), value)"
                      >{{ value }}</router-link
                    >
                    <span v-else>{{ displayValue(value, state) }}</span>
                  </dd>
                </template>
              </dl>
            </div>
          </li>
        </ol>

        <p class="source-note" data-testid="trace-latency-note">
          “Since previous stage” is the gap between two stages that both carry a timestamp. It reads
          <span class="mono">—</span> on the first stage and on either side of a stage that has not
          happened, because there is nothing to measure — never <span class="mono">0ms</span>, which
          would claim the gateway did the work instantly.
        </p>
      </section>

      <!-- THE EVIDENCE, COLLAPSED ------------------------------------------ -->
      <section class="panel" data-testid="trace-raw" aria-labelledby="trace-raw-heading">
        <h2 id="trace-raw-heading">Raw engine rows</h2>
        <p>
          The rows the timeline above was assembled from, exactly as the engine store returned them.
          An interpretation you cannot check is worth less than the evidence behind it.
        </p>
        <!--
          Sits above the raw rows, because that dump is where the subscriber's
          number and the message body actually appear.
        -->
        <PrivacyReveal
          :privacy="privacy"
          :can-reveal="canReveal"
          :message-ref="searched || null"
          testid="trace-privacy"
          @changed="onRevealChanged"
        />
        <details data-testid="trace-raw-details">
          <summary>Show {{ trace?.events?.length ?? 0 }} raw row(s) — {{ trace?.detail }}</summary>
          <pre v-if="trace?.events?.length" class="json-block" data-testid="trace-raw-json">{{
            JSON.stringify(trace?.events, null, 2)
          }}</pre>
          <p v-else class="source-note" data-testid="trace-raw-empty">
            The engine store returned no rows for this id.
            <template v-if="engineUnavailable">
              It could not be read at all, so this is not evidence of absence.
            </template>
            <template v-else>
              It was readable and had nothing under this identifier — the stages above, if any, come
              from JKANNEL's own routing record.
            </template>
          </p>
        </details>
      </section>
    </DataState>

    <!-- DIAGNOSTIC SUMMARY -------------------------------------------------- -->
    <DetailDrawer
      :open="summaryOpen"
      eyebrow="Message trace"
      title="Diagnostic summary"
      :subtitle="searched"
      @close="summaryOpen = false"
    >
      <p>
        The trace as text, for a carrier ticket. Only facts that were actually recorded appear — a
        line that is missing means the value was never captured, which is itself worth saying to a
        carrier who claims a message was never received.
      </p>
      <pre class="json-block" data-testid="trace-summary-text">{{ summaryText }}</pre>
      <template v-if="tracedRow === null">
        <p class="source-note" data-testid="trace-summary-partial">
          This message was traced by id rather than selected from the search above, so the summary
          carries the lifecycle only. Search for it to include the destination, sender and carrier
          reference.
        </p>
      </template>
      <template #footer>
        <button class="primary-button" type="button" data-testid="trace-summary-copy" @click="copySummary">
          {{ summaryCopied ? 'Copied' : 'Copy summary' }}
        </button>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* The margin is the shared `.panel` rule's — this only adds the accent. */
.problem-panel {
  border-left: 3px solid var(--bad);
}
.problem-panel h2 {
  color: var(--bad);
}
.problem-panel p {
  margin: 6px 0 0;
  line-height: 1.6;
}

/* A vertical spine with one marker per stage. The marker carries the same tone
   as the badge beside the label, so the two never disagree. */
.timeline {
  list-style: none;
  margin: 16px 0 0;
  padding: 0 0 0 22px;
  display: grid;
  gap: 14px;
}
.timeline-item {
  position: relative;
  padding: 0 0 0 16px;
  border-left: 2px solid var(--border);
}
.timeline-item:last-child {
  border-left-color: transparent;
}
.timeline-marker {
  position: absolute;
  left: -7px;
  top: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--muted);
  border: 2px solid var(--surface);
}
.timeline-item.tone-good .timeline-marker {
  background: var(--good);
}
.timeline-item.tone-warn .timeline-marker {
  background: var(--warn);
}
.timeline-item.tone-bad .timeline-marker {
  background: var(--bad);
}
.timeline-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.timeline-head strong {
  color: var(--text-strong);
  font-size: 14px;
}
.timeline-detail {
  margin: 6px 0 0;
  line-height: 1.6;
}
.pending-note {
  margin: 8px 0 0;
  padding: 8px 11px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.timeline-facts {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 4px 16px;
  margin: 10px 0 0;
  font-size: 12.5px;
}
.timeline-facts dt {
  color: var(--muted);
}
.timeline-facts dd {
  margin: 0;
  color: var(--text-strong);
  word-break: break-word;
}
details summary {
  cursor: pointer;
  color: var(--brand);
  font-size: 13px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Timestamps and engine identifiers, which are long and never read word by
   word. One step down keeps the nine-column grid off a horizontal scrollbar. */
.cell-tight {
  font-size: 12.5px;
}

/* The row whose lifecycle is on screen below. Without it, clicking a row in a
   long result set scrolls the trace into view and leaves no trace of which row
   produced it. */
tbody tr.is-traced {
  background: color-mix(in srgb, var(--brand) 10%, transparent);
}
tbody tr.selectable:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}
</style>
<style src="./workspace-extras.css"></style>
