<script setup lang="ts">
/**
 * EVENTS (PLAN.md 4.4 + 4.5, spec §12).
 *
 * §12.1 is the structured stream of what the SYSTEM observed — binds lost and
 * restored, sessions flapping, queue thresholds crossed, DLR quality degrading,
 * services restarting. It is deliberately NOT the audit trail, which records
 * what a PERSON did and lives in Logs & Audit; conflating the two is how "the
 * bind dropped" and "someone disabled the bind" end up looking alike.
 *
 * §12.2 is the payoff: one correlation id threads an incident across events,
 * alerts, audit entries and logs. `GET /diagnostics/correlations/:id` returns
 * the first three together, and its `note` names the fourth.
 *
 * THE LOG CAVEAT IS NOT OPTIONAL. Structured logs come from an in-memory ring
 * buffer local to one API process: they do not survive a restart and are not
 * shared between replicas. An older incident will routinely have events and
 * audit entries with no log lines at all. A silently empty log section would be
 * read as "nothing was logged", so the API's own `note` is rendered verbatim
 * above the section and the empty case says why it is empty — every time,
 * including when the operator simply lacks the permission to read logs.
 *
 * Backend contract:
 *   GET /diagnostics/events?limit&kind&severity&subjectType&subjectId
 *                          &correlationId&since            (monitoring.view)
 *   GET /diagnostics/correlations/:correlationId           (monitoring.view)
 *   GET /observability/logs?correlationId=…                (system.view)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import { canAccess, session } from '../stores/session';
import { resolveWindow, selectedRange } from '../stores/time-range';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import {
  EVENT_KIND_SUGGESTIONS,
  EVENT_SEVERITIES,
  EVENT_SUBJECT_TYPES,
  isCorrelationId,
  severityTone,
  severityWord,
  subjectLabel,
  type CorrelationBundle,
  type OperationalEvent,
} from '../utils/diagnostics';

/** Exactly what the service clamps to: 1..500, defaulting to 100. */
const LIMIT_CHOICES = [50, 100, 250, 500];

const kind = ref('');
const severity = ref('');
const subjectType = ref('');
const subjectId = ref('');
const correlationFilter = ref('');
const limit = ref(100);
/** Rows skipped. The stream is newest-first, so 0 is the newest page. */
const offset = ref(0);
/** How many events match the filters, not how many are on this page. */
const total = ref(0);

const events = ref<OperationalEvent[]>([]);
const state = ref<State>('loading');
const error = ref('');
const expanded = ref<string | null>(null);

// --- The correlation drill-down ---------------------------------------------

const bundle = ref<CorrelationBundle | null>(null);
const bundleState = ref<State>('empty');
const bundleError = ref('');
const bundleId = ref('');

interface LogLine {
  timestamp?: string;
  level?: string;
  message?: string;
  route?: string;
  method?: string;
}
const logs = ref<LogLine[]>([]);
const logState = ref<State>('empty');
const logError = ref('');

/** `/observability/logs` enforces system.view, which a monitoring.view operator may not hold. */
const canReadLogs = computed(() => canAccess(session.value, 'system.view'));

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
function failureState(reason: unknown): State {
  return reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
}

/**
 * The shared time range supplies `since`.
 *
 * §6 requires the range to survive the walk from Traffic to SMSC to
 * Diagnostics, so this screen reads it rather than owning a window of its own.
 * The API takes no upper bound, which is stated on screen rather than papered
 * over — a range whose end is in the past would still return events after it.
 */
function buildParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set('limit', String(limit.value));
  params.set('offset', String(offset.value));
  if (kind.value.trim()) params.set('kind', kind.value.trim());
  if (severity.value) params.set('severity', severity.value);
  if (subjectType.value) params.set('subjectType', subjectType.value);
  if (subjectId.value.trim()) params.set('subjectId', subjectId.value.trim());
  if (correlationFilter.value.trim()) params.set('correlationId', correlationFilter.value.trim());
  params.set('since', resolveWindow().from.toISOString());
  return params;
}

const activeFilters = computed(() => {
  const parts = [`since=${selectedRange.value.label.toLowerCase()}`, `limit=${limit.value}`];
  if (kind.value.trim()) parts.push(`kind=${kind.value.trim()}*`);
  if (severity.value) parts.push(`severity=${severity.value}`);
  if (subjectType.value) parts.push(`subjectType=${subjectType.value}`);
  if (subjectId.value.trim()) parts.push(`subjectId=${subjectId.value.trim()}`);
  if (correlationFilter.value.trim()) parts.push(`correlationId=${correlationFilter.value.trim()}`);
  return parts;
});

/**
 * A correlation id the API will reject, caught before the request.
 *
 * The controller answers 400 on anything that is not 36 characters of hex and
 * hyphens, and "Request failed (400)" beside a search box tells the operator
 * nothing about what they pasted.
 */
const correlationFilterInvalid = computed(
  () => Boolean(correlationFilter.value.trim()) && !isCorrelationId(correlationFilter.value),
);

async function load() {
  if (correlationFilterInvalid.value) {
    events.value = [];
    error.value =
      'A correlation id is 36 characters of hexadecimal and hyphens. The stream was not re-read, because the API would reject that value rather than search for it.';
    state.value = 'error';
    return;
  }
  state.value = 'loading';
  try {
    const page = await apiRequest<{
      items?: OperationalEvent[];
      limit?: number;
      total?: number;
    }>(`/diagnostics/events?${buildParams().toString()}`);
    events.value = Array.isArray(page?.items) ? page.items : [];
    total.value = Number.isFinite(page?.total) ? Number(page?.total) : events.value.length;
    error.value = '';
    state.value = events.value.length ? 'live' : 'empty';
  } catch (reason) {
    events.value = [];
    error.value = messageFrom(reason, 'The event stream could not be read.');
    state.value = failureState(reason);
  }
}

/*
 * PAGING.
 *
 * The stream used to be capped at `limit` with a notice explaining that what
 * you could see was the newest slice and not the whole of it. Honest, and no
 * use: the advice it gave — raise the row count — runs out at the 500-row
 * ceiling, on the screen you visit precisely when a great deal has happened.
 */
const pageLabel = computed(() => {
  if (!total.value) return 'No matching events';
  const first = offset.value + 1;
  const last = offset.value + events.value.length;
  return `${first}–${last} of ${total.value}`;
});
const canGoBack = computed(() => offset.value > 0);
const canGoForward = computed(() => offset.value + limit.value < total.value);

function turnPage(direction: number) {
  const next = offset.value + direction * limit.value;
  offset.value = Math.max(0, Math.min(next, Math.max(0, total.value - 1)));
  void load();
}

const criticalCount = computed(
  () => events.value.filter((event) => event.severity === 'critical').length,
);
const warningCount = computed(
  () => events.value.filter((event) => event.severity === 'warning').length,
);
const threaded = computed(() => events.value.filter((event) => event.correlation_id).length);

function applyFilters() {
  offset.value = 0;
  void load();
}

function resetFilters() {
  kind.value = '';
  severity.value = '';
  subjectType.value = '';
  subjectId.value = '';
  correlationFilter.value = '';
  offset.value = 0;
  void load();
}

async function loadLogs(id: string) {
  if (!canReadLogs.value) {
    logs.value = [];
    logState.value = 'permission-denied';
    return;
  }
  logState.value = 'loading';
  try {
    const result = await apiRequest<{ items?: LogLine[] }>(
      `/observability/logs?correlationId=${encodeURIComponent(id)}&limit=250`,
    );
    logs.value = Array.isArray(result?.items) ? result.items : [];
    logError.value = '';
    logState.value = logs.value.length ? 'live' : 'empty';
  } catch (reason) {
    logs.value = [];
    logError.value = messageFrom(reason, 'The log buffer could not be queried.');
    logState.value = failureState(reason);
  }
}

async function openCorrelation(id: string | null | undefined) {
  const clean = String(id ?? '').trim();
  if (!clean) return;
  bundleId.value = clean;
  if (!isCorrelationId(clean)) {
    bundle.value = null;
    bundleError.value =
      'That correlation id is not the 36-character form the API accepts, so no incident was requested.';
    bundleState.value = 'error';
    return;
  }
  bundleState.value = 'loading';
  logState.value = 'loading';
  try {
    bundle.value = await apiRequest<CorrelationBundle>(
      `/diagnostics/correlations/${encodeURIComponent(clean)}`,
    );
    bundleError.value = '';
    bundleState.value = 'live';
  } catch (reason) {
    bundle.value = null;
    bundleError.value = messageFrom(reason, 'That incident could not be read.');
    bundleState.value = failureState(reason);
  }
  await loadLogs(clean);
}

function closeCorrelation() {
  bundle.value = null;
  bundleId.value = '';
  bundleState.value = 'empty';
  logs.value = [];
  logState.value = 'empty';
}

/** Narrow the stream itself to one incident, as well as opening the thread. */
function filterToCorrelation(id: string | null | undefined) {
  const clean = String(id ?? '').trim();
  if (!clean) return;
  correlationFilter.value = clean;
  void load();
}

function toggleDetail(id: string) {
  expanded.value = expanded.value === id ? null : id;
}

function detailText(event: OperationalEvent): string {
  return JSON.stringify(event.detail ?? {}, null, 2);
}
function hasDetail(event: OperationalEvent): boolean {
  return Boolean(event.detail && Object.keys(event.detail).length);
}

/** Two minutes either side — wide enough to catch the cause, narrow enough to read. */
const EVIDENCE_WINDOW_MS = 120_000;

/**
 * Where the Evidence button goes.
 *
 * A correlation id is the precise question and is used whenever the emitter set
 * one. Most operational events carry none — they are written by the poller,
 * outside any request — so the fallback is a time window around the event.
 * That is looser, and the title attribute says so rather than letting an
 * operator read a window of unrelated lines as "the evidence for this event".
 */
function evidenceLink(event: OperationalEvent) {
  if (event.correlation_id)
    return { path: '/log-explorer', query: { correlationId: event.correlation_id } };
  const at = Date.parse(event.observed_at);
  if (!Number.isFinite(at)) return { path: '/log-explorer' };
  return {
    path: '/log-explorer',
    query: {
      since: new Date(at - EVIDENCE_WINDOW_MS).toISOString(),
      until: new Date(at + EVIDENCE_WINDOW_MS).toISOString(),
    },
  };
}

// One range, shared. Changing it anywhere re-asks this question.
watch(selectedRange, () => void load());

onMounted(load);
</script>

<template>
  <div data-testid="events-view">
    <!-- THE STREAM ---------------------------------------------------------- -->
    <section class="panel" data-testid="events-panel" aria-labelledby="events-heading">
      <header class="panel-header">
        <div>
          <h2 id="events-heading">Operational events</h2>
          <p aria-live="polite" data-testid="events-summary">
            {{
              state === 'loading'
                ? 'Reading the event stream…'
                : `${total} event(s) since the start of ${selectedRange.label.toLowerCase()}, newest first — showing ${pageLabel.toLowerCase()}.`
            }}
          </p>
        </div>
        <button class="secondary-button" data-testid="events-refresh" @click="load">Refresh</button>
      </header>

      <p class="source-note" data-testid="events-scope-note">
        These are events the <strong>system</strong> observed. What a <strong>person</strong> did is
        the audit trail, in Logs &amp; Audit — the two are kept apart because “the bind dropped” and
        “an operator disabled the bind” have different fixes and must never look alike. The window
        comes from the console's shared time range and is sent as <span class="mono">since</span>;
        the API takes no upper bound, so an event newer than the end of the range still appears.
      </p>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="events-metric-total">{{
            displayValue(events.length, state)
          }}</strong>
          <small>events in this window</small>
        </div>
        <div class="metric">
          <strong data-testid="events-metric-critical">{{
            displayValue(criticalCount, state)
          }}</strong>
          <small>critical</small>
        </div>
        <div class="metric">
          <strong data-testid="events-metric-warning">{{
            displayValue(warningCount, state)
          }}</strong>
          <small>warning</small>
        </div>
        <div class="metric">
          <strong data-testid="events-metric-threaded">{{ displayValue(threaded, state) }}</strong>
          <small>carry a correlation id</small>
        </div>
      </div>

      <!--
        SIX FILTERS, AS A FORM.

        This was a `.grid-toolbar`: six `label · control` pairs and two buttons
        packed into one flex run, labels INLINE, no two fields the same width.
        With six of them the eye has to guess which label owns which control,
        and the pair at the end of the run is a row count next to an Apply
        button that looks like it belongs to it.

        The same `.panel-form` the Live Queue panels use — label above control,
        equal columns, buttons on their own line.
      -->
      <fieldset class="panel-form" data-testid="events-filter-group">
        <legend>Narrow the stream</legend>
        <div class="dialog-grid">
          <label class="field">
            <span>Kind starts with</span>
            <input
              v-model="kind"
              data-testid="events-filter-kind"
              type="search"
              list="event-kind-suggestions"
              placeholder="smsc. — the API matches a prefix"
              @keyup.enter="applyFilters"
            />
            <datalist id="event-kind-suggestions">
              <option v-for="suggestion in EVENT_KIND_SUGGESTIONS" :key="suggestion">
                {{ suggestion }}
              </option>
            </datalist>
          </label>
          <label class="field">
            <span>Severity</span>
            <select v-model="severity" data-testid="events-filter-severity" @change="applyFilters">
              <option value="">Any</option>
              <option v-for="value in EVENT_SEVERITIES" :key="value" :value="value">
                {{ value }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>Subject type</span>
            <select
              v-model="subjectType"
              data-testid="events-filter-subject-type"
              @change="applyFilters"
            >
              <option value="">Any</option>
              <option v-for="value in EVENT_SUBJECT_TYPES" :key="value" :value="value">
                {{ value }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>Subject id</span>
            <input
              v-model="subjectId"
              data-testid="events-filter-subject-id"
              type="search"
              placeholder="mtn-p1"
              @keyup.enter="applyFilters"
            />
          </label>
          <label class="field">
            <span>Correlation id</span>
            <input
              v-model="correlationFilter"
              data-testid="events-filter-correlation"
              type="search"
              placeholder="0e3b1f2a-… (36 characters)"
              @keyup.enter="applyFilters"
            />
          </label>
          <label class="field">
            <span>Rows per page</span>
            <select v-model.number="limit" data-testid="events-limit" @change="applyFilters">
              <option v-for="choice in LIMIT_CHOICES" :key="choice" :value="choice">
                {{ choice }}
              </option>
            </select>
          </label>
        </div>
        <div class="panel-form-actions">
          <button class="primary-button" data-testid="events-apply" @click="applyFilters">
            Apply
          </button>
          <button class="secondary-button" data-testid="events-reset" @click="resetFilters">
            Clear filters
          </button>
        </div>
      </fieldset>

      <p
        v-if="correlationFilterInvalid"
        class="form-error"
        role="alert"
        data-testid="events-correlation-invalid"
      >
        A correlation id is 36 characters of hexadecimal and hyphens. Paste the whole id, not a
        prefix — the API matches it exactly and would reject anything shorter.
      </p>

      <p class="source-note" data-testid="events-active-filters">
        Applied by the API: <span class="mono">{{ activeFilters.join(' · ') }}</span>
      </p>

      <DataState
        :state="state"
        subject="operational events"
        skeleton="table"
        :skeleton-rows="6"
        :detail="
          state === 'empty'
            ? 'No event was recorded in this window with these filters. Events are written when the system observes something worth recording — a quiet window is a normal reading, not a gap in monitoring.'
            : state === 'error'
              ? error
              : undefined
        "
        permission="monitoring.view"
        testid="events-state"
        :on-retry="load"
      >
        <div class="table-wrap">
          <table data-testid="events-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Kind</th>
                <th scope="col">Severity</th>
                <th scope="col">Subject</th>
                <th scope="col">Summary</th>
                <th scope="col">Correlation</th>
                <th scope="col">Evidence</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="event in events" :key="event.id">
                <tr :data-testid="`event-${event.id}`">
                  <td class="mono">{{ formatMoment(event.observed_at) }}</td>
                  <td class="mono">{{ event.kind }}</td>
                  <td>
                    <!-- Word first; the tone only repeats it (§17.1). -->
                    <span
                      class="status-badge"
                      :class="severityTone(event.severity)"
                      :data-testid="`event-severity-${event.id}`"
                      >{{ severityWord(event.severity) }}</span
                    >
                  </td>
                  <td class="mono">{{ subjectLabel(event) }}</td>
                  <td>{{ event.summary }}</td>
                  <td class="row-actions">
                    <template v-if="event.correlation_id">
                      <button
                        class="secondary-button"
                        :data-testid="`event-thread-${event.id}`"
                        :title="`Open everything recorded under ${event.correlation_id}`"
                        @click="openCorrelation(event.correlation_id)"
                      >
                        Open incident
                      </button>
                      <button
                        class="secondary-button"
                        :data-testid="`event-filter-${event.id}`"
                        @click="filterToCorrelation(event.correlation_id)"
                      >
                        Filter to it
                      </button>
                    </template>
                    <span v-else class="cell-health" :data-testid="`event-nothread-${event.id}`"
                      >not correlated</span
                    >
                  </td>
                  <!--
                    §12's evidence: the log lines around the moment the event
                    was recorded. Scoped by correlation id when the emitter set
                    one, and otherwise by a window either side of the event —
                    the log buffer has no notion of an event id, so a time
                    window is the only honest way to ask "what else was
                    happening then".
                  -->
                  <td class="row-actions">
                    <RouterLink
                      class="secondary-button"
                      :data-testid="`event-evidence-${event.id}`"
                      :to="evidenceLink(event)"
                      :title="
                        event.correlation_id
                          ? 'Log lines recorded under this correlation id'
                          : 'Log lines from the two minutes around this event'
                      "
                    >
                      Logs
                    </RouterLink>
                  </td>
                  <td class="row-actions">
                    <button
                      v-if="hasDetail(event)"
                      class="secondary-button"
                      :data-testid="`event-detail-toggle-${event.id}`"
                      @click="toggleDetail(event.id)"
                    >
                      {{ expanded === event.id ? 'Hide' : 'Show' }}
                    </button>
                    <span v-else class="cell-health">none recorded</span>
                  </td>
                </tr>
                <tr v-if="expanded === event.id" :data-testid="`event-detail-${event.id}`">
                  <td colspan="8">
                    <pre class="json-block">{{ detailText(event) }}</pre>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <footer class="pager" data-testid="events-pager">
          <span data-testid="events-range">{{ pageLabel }}</span>
          <div class="pager-buttons">
            <button
              class="secondary-button"
              data-testid="events-prev"
              :disabled="state === 'loading' || !canGoBack"
              @click="turnPage(-1)"
            >
              Previous
            </button>
            <button
              class="secondary-button"
              data-testid="events-next"
              :disabled="state === 'loading' || !canGoForward"
              @click="turnPage(1)"
            >
              Next
            </button>
          </div>
        </footer>
      </DataState>
    </section>

    <!-- ONE INCIDENT, THREADED ----------------------------------------------
         In a sheet: the event stream this was opened from is the context for
         reading it, and a panel below the stream scrolls that context away. -->
    <DetailDrawer
      :open="Boolean(bundleId)"
      title="Incident thread"
      eyebrow="Correlation"
      :subtitle="bundleId"
      wide
      @close="closeCorrelation"
    >
      <div data-testid="correlation-panel">
        <p class="mono" data-testid="correlation-id">{{ bundleId }}</p>
        <DataState
          :state="bundleState"
          subject="this incident"
          skeleton="table"
          :skeleton-rows="4"
          :detail="bundleState === 'error' ? bundleError : undefined"
          permission="monitoring.view"
          testid="correlation-state"
          :on-retry="() => openCorrelation(bundleId)"
        >
          <div class="summary-strip">
            <div class="metric">
              <strong data-testid="correlation-metric-events">{{
                displayValue(bundle?.events?.length, bundleState)
              }}</strong>
              <small>events</small>
            </div>
            <div class="metric">
              <strong data-testid="correlation-metric-alerts">{{
                displayValue(bundle?.alerts?.length, bundleState)
              }}</strong>
              <small>alerts</small>
            </div>
            <div class="metric">
              <strong data-testid="correlation-metric-audit">{{
                displayValue(bundle?.audit?.length, bundleState)
              }}</strong>
              <small>audit entries</small>
            </div>
          </div>

          <!-- Events ---------------------------------------------------------- -->
          <h3>Events</h3>
          <ul v-if="bundle?.events?.length" class="sample-list" data-testid="correlation-events">
            <li v-for="event in bundle.events" :key="event.id">
              <span class="status-badge" :class="severityTone(event.severity)">{{
                severityWord(event.severity)
              }}</span>
              <span class="mono">{{ event.kind }}</span>
              <span>{{ event.summary }}</span>
              <small>{{ formatMoment(event.observed_at) }}</small>
            </li>
          </ul>
          <p v-else class="source-note" data-testid="correlation-events-empty">
            No operational event carries this correlation id.
          </p>

          <!-- Alerts ---------------------------------------------------------- -->
          <h3>Alerts</h3>
          <ul v-if="bundle?.alerts?.length" class="sample-list" data-testid="correlation-alerts">
            <li v-for="alert in bundle.alerts" :key="alert.id">
              <span class="status-badge" :class="severityTone(alert.severity)">{{
                severityWord(alert.severity)
              }}</span>
              <span>{{ alert.summary }}</span>
              <small
                >opened {{ formatMoment(alert.opened_at) }} ·
                {{
                  alert.resolved_at ? `resolved ${formatMoment(alert.resolved_at)}` : 'still open'
                }}
              </small>
            </li>
          </ul>
          <p v-else class="source-note" data-testid="correlation-alerts-empty">
            No alert was raised under this correlation id.
          </p>

          <!-- Audit ----------------------------------------------------------- -->
          <h3>Audit entries</h3>
          <ul v-if="bundle?.audit?.length" class="sample-list" data-testid="correlation-audit">
            <li v-for="entry in bundle.audit" :key="entry.id">
              <span class="mono">{{ entry.action }}</span>
              <span class="mono">{{
                [entry.entity_type, entry.entity_id].filter(Boolean).join(' ')
              }}</span>
              <small>{{ formatMoment(entry.created_at) }}</small>
            </li>
          </ul>
          <p v-else class="source-note" data-testid="correlation-audit-empty">
            No operator action was recorded under this correlation id.
          </p>

          <!--
          THE LOG CAVEAT. Rendered from the API's own `note`, above the log
          section rather than below it, because it is the thing that makes an
          empty log section readable.
        -->
          <h3>Structured logs</h3>
          <p class="warn-notice" role="note" data-testid="correlation-log-caveat">
            <strong>Logs are process-local and do not survive a restart.</strong> An older incident
            will often have events and audit entries here with no log lines at all — that is the
            buffer having wrapped or the process having restarted, not proof that nothing was
            logged.
            <span class="mono" data-testid="correlation-note">{{ bundle?.note }}</span>
          </p>

          <ul v-if="logs.length" class="sample-list" data-testid="correlation-logs">
            <li v-for="(line, index) in logs" :key="index">
              <span class="status-badge muted">{{ line.level ?? 'unknown' }}</span>
              <span>{{ line.message }}</span>
              <small>{{ formatMoment(line.timestamp) }}</small>
            </li>
          </ul>
          <p
            v-else-if="logState === 'permission-denied'"
            class="source-note"
            data-testid="correlation-logs-forbidden"
          >
            Log lines were not requested: reading them needs the
            <span class="mono">system.view</span> permission, which this account does not hold. The
            events, alerts and audit entries above are complete regardless — this section being
            empty says nothing about whether lines exist.
          </p>
          <p
            v-else-if="logState === 'error'"
            class="source-note"
            data-testid="correlation-logs-error"
          >
            The log buffer could not be queried: {{ logError }}. Treat this section as unread rather
            than empty.
          </p>
          <p
            v-else-if="logState === 'loading'"
            class="source-note"
            data-testid="correlation-logs-loading"
          >
            Reading the log buffer…
          </p>
          <p v-else class="source-note" data-testid="correlation-logs-empty">
            This API process holds no log line for this correlation id. Read that as “not retained
            here”, not as “nothing happened” — see the caveat above. The Log Explorer shows how much
            of the buffer has already been evicted.
          </p>
        </DataState>
      </div>
    </DetailDrawer>
  </div>
</template>

<style scoped>
.detail-panel h3 {
  margin: 16px 0 4px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.detail-panel > header {
  align-items: flex-start;
}
.sample-list span:nth-child(2) {
  color: var(--text-strong);
}
</style>
<style src="./workspace-extras.css"></style>
