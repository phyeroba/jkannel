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
import PrivacyReveal from '../components/PrivacyReveal.vue';
import { canAccess, session } from '../stores/session';
import { privacyOf, type PrivacyState } from '../utils/privacy';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  bindFactTarget,
  factLabel,
  formatLatency,
  formatMilliseconds,
  formatStageMoment,
  stageTone,
  stageWord,
  type MessageTrace,
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
}

const query = ref(String(route.query.id ?? ''));
const searched = ref('');
const trace = ref<MessageTrace | null>(null);
const state = ref<State>('empty');
const error = ref('');
const copied = ref(false);

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
  void load(clean);
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
  if (query.value.trim()) void load(query.value);
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
            took. Search by the id JKANNEL issued or the id the engine recorded — the lookup matches
            either.
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Message id</span>
          <input
            v-model="query"
            data-testid="trace-input"
            type="search"
            placeholder="The message id from a ticket, an export or the Messages grid"
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

    <DataState
      :state="state"
      subject="this message's lifecycle"
      skeleton="table"
      :skeleton-rows="5"
      :detail="
        state === 'empty' && searched
          ? 'Nothing is recorded under that identifier — no routing decision in JKANNEL and no row in the engine store. That is not proof the message never existed: retention prunes old messages, and an id from a different environment will not be found here either.'
          : state === 'empty'
            ? 'Enter a message id above. This screen reads one message at a time; the Messages workspace is where you find the id.'
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
          <span
            class="status-badge"
            :class="lifecycle?.inFlight ? 'warn' : 'good'"
            data-testid="trace-inflight"
            >{{ lifecycle?.inFlight ? 'in flight' : 'settled' }}</span
          >
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
  </div>
</template>

<style scoped>
.problem-panel {
  border-left: 3px solid var(--bad);
  margin-bottom: 14px;
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
</style>
<style src="./workspace-extras.css"></style>
