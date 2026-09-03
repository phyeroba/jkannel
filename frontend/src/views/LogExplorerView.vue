<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DetailDrawer from '../components/DetailDrawer.vue';
import { useLiveResource } from '../composables/useLiveResource';

type LoadState = 'loading' | 'ok' | 'error';

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  context?: string;
  correlationId?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  username?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  clientIp?: string;
  trace?: string;
}

interface LogQueryResult {
  items?: LogEntry[];
  matched?: number;
  stored?: number;
  capacity?: number;
  dropped?: number;
  oldest?: string | null;
  newest?: string | null;
  durable?: boolean;
  scope?: string;
  notice?: string;
}

/** Mirrors LOG_LEVELS in platform/log-buffer.ts, weakest first. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LIMIT_CHOICES = [50, 100, 250, 500, 1000];

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}
function levelTone(level: unknown) {
  const value = String(level ?? '').toLowerCase();
  if (value === 'error' || value === 'fatal') return 'bad';
  if (value === 'warn') return 'warn';
  if (value === 'info') return 'good';
  return '';
}
/**
 * Buffer health, without re-running the query.
 *
 * `GET /observability/logs/stats` returns the search envelope minus the lines.
 * Merging it into `result` rather than holding it separately keeps ONE set of
 * numbers on the screen: two independently-refreshed copies of "how full is the
 * buffer" would eventually disagree, and the operator would have no way to tell
 * which was current.
 *
 * `matched` is deliberately not overwritten — it belongs to the last query and
 * means "matching this filter", which a filterless stats call cannot answer.
 */
const statsBusy = ref(false);

async function refreshStats() {
  statsBusy.value = true;
  try {
    const stats = await apiRequest<LogQueryResult>('/observability/logs/stats');
    const { matched, items, ...health } = stats ?? {};
    void matched;
    void items;
    result.value = { ...(result.value ?? {}), ...health };
  } catch {
    // The figures on screen stay as they were rather than being blanked: the
    // last successful read is still the truest thing available.
  } finally {
    statsBusy.value = false;
  }
}

/**
 * The thing a log line is about.
 *
 * A request line names a route; anything else names whoever it was acting for.
 * Falling through to "not attributed" rather than an em dash keeps the two
 * apart: the dash on this console means we looked and found nothing, whereas
 * here the emitter simply did not record a subject.
 */
function logObject(entry: LogEntry): string {
  return entry.route ?? entry.username ?? entry.userId ?? entry.tenantId ?? 'not attributed';
}

/** `datetime-local` (browser zone) -> the ISO instant the API expects. */
function fromLocalInput(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

// --- Filters ------------------------------------------------------------------
// correlationId is first and is the primary control: "show me everything for
// this incident" is the workflow this view exists for.
const correlationId = ref('');
const requestId = ref('');
const minLevel = ref('');
const level = ref('');
const routeFilter = ref('');
const contains = ref('');
const tenantId = ref('');
const userId = ref('');
const since = ref('');
const until = ref('');
/*
 * Fifty, not a hundred.
 *
 * The buffer holds thousands of lines and the grid renders a whole page of
 * them, so the default decides how much of the screen the first result fills.
 * A hundred rows is several screens of scrolling before you reach the pager,
 * which is the wrong first impression of a search you have not narrowed yet.
 */
const limit = ref(50);

const entries = ref<LogEntry[]>([]);
/*
 * Paging state for the Entries grid.
 *
 * It reported "100 shown of 4,312 matching" and offered no way to reach line
 * 101 — the only control was Rows, and raising a limit is not paging. The panel
 * even had a standing notice telling the operator to raise the row count or
 * narrow the filters, which was honest about the limitation and no help at all.
 */
const offset = ref(0);
/*
 * Sorting, sent to the SERVER rather than applied here.
 *
 * Sorting the rows the browser is holding orders one page against itself, so
 * "slowest first" would show the slowest request on the page you happen to be
 * on rather than the slowest there is. That is worse than no sorting, because
 * it looks like an answer. The buffer orders the whole match set and then
 * pages it.
 */
const SORTABLE: { key: string; label: string }[] = [
  { key: 'time', label: 'Time' },
  { key: 'level', label: 'Level' },
  { key: 'component', label: 'Component' },
  { key: 'route', label: 'Route' },
  { key: 'status', label: 'Status' },
  { key: 'duration', label: 'Duration' },
];
const sortField = ref('time');
const sortDirection = ref<'asc' | 'desc'>('desc');
function toggleSort(field: string) {
  if (sortField.value === field) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    // Time reads newest-first and everything else reads largest-first, which is
    // what somebody sorting by duration or status is looking for.
    sortDirection.value = 'desc';
  }
  // Back to page one: page 4 of the old order is not page 4 of the new one.
  offset.value = 0;
  void search();
}
const sortIndicator = (field: string) =>
  sortField.value === field ? (sortDirection.value === 'asc' ? ' ↑' : ' ↓') : '';
/** Any filter change starts again at page one; page 4 of a new query is a lie. */
function searchFromStart() {
  offset.value = 0;
  return search();
}
function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * limit.value);
  if (direction > 0 && offset.value + limit.value >= num(result.value?.matched)) return;
  if (next === offset.value) return;
  offset.value = next;
  void search();
}
const pageLabel = computed(() => {
  const matched = num(result.value?.matched);
  if (!matched || !entries.value.length) return 'Showing 0 of 0';
  return `Showing ${offset.value + 1}–${offset.value + entries.value.length} of ${matched}`;
});
const result = ref<LogQueryResult | null>(null);
const state = ref<LoadState>('loading');
const error = ref('');
const missing = ref(false);
const selected = ref<LogEntry | null>(null);

const activeFilters = computed(() => {
  const parts: string[] = [];
  if (correlationId.value.trim()) parts.push(`correlationId=${correlationId.value.trim()}`);
  if (requestId.value.trim()) parts.push(`requestId=${requestId.value.trim()}`);
  if (level.value) parts.push(`level=${level.value}`);
  if (minLevel.value) parts.push(`minLevel=${minLevel.value}`);
  if (routeFilter.value.trim()) parts.push(`route=${routeFilter.value.trim()}`);
  if (contains.value.trim()) parts.push(`contains=${contains.value.trim()}`);
  if (tenantId.value.trim()) parts.push(`tenantId=${tenantId.value.trim()}`);
  if (userId.value.trim()) parts.push(`userId=${userId.value.trim()}`);
  if (since.value) parts.push(`since=${since.value}`);
  if (until.value) parts.push(`until=${until.value}`);
  return parts;
});

function buildParams() {
  const params = new URLSearchParams();
  if (correlationId.value.trim()) params.set('correlationId', correlationId.value.trim());
  if (requestId.value.trim()) params.set('requestId', requestId.value.trim());
  if (level.value) params.set('level', level.value);
  if (minLevel.value) params.set('minLevel', minLevel.value);
  if (routeFilter.value.trim()) params.set('route', routeFilter.value.trim());
  if (contains.value.trim()) params.set('contains', contains.value.trim());
  if (tenantId.value.trim()) params.set('tenantId', tenantId.value.trim());
  if (userId.value.trim()) params.set('userId', userId.value.trim());
  const sinceIso = since.value ? fromLocalInput(since.value) : '';
  const untilIso = until.value ? fromLocalInput(until.value) : '';
  if (sinceIso) params.set('since', sinceIso);
  if (untilIso) params.set('until', untilIso);
  params.set('limit', String(limit.value));
  // Always sent, including zero: this is what pages the buffer, and the server
  // treats a missing offset as "the newest slice" rather than "page one of a
  // pageable result".
  params.set('offset', String(offset.value));
  params.set('sort', sortField.value);
  params.set('direction', sortDirection.value);
  return params;
}

async function search() {
  state.value = state.value === 'ok' ? 'ok' : 'loading';
  missing.value = false;
  try {
    const payload = await apiRequest<LogQueryResult>(`/observability/logs?${buildParams()}`);
    result.value = payload ?? null;
    entries.value = Array.isArray(payload?.items) ? payload.items : [];
    error.value = '';
    state.value = 'ok';
  } catch (reason) {
    entries.value = [];
    result.value = null;
    missing.value = isMissing(reason);
    // A 400 from the controller names the exact parameter it rejected
    // (level, since, until, limit); show that instead of a generic failure.
    error.value = messageFrom(reason, 'The log buffer could not be queried.');
    state.value = 'error';
  }
}

function resetFilters() {
  correlationId.value = '';
  requestId.value = '';
  minLevel.value = '';
  level.value = '';
  routeFilter.value = '';
  contains.value = '';
  tenantId.value = '';
  userId.value = '';
  since.value = '';
  until.value = '';
  selected.value = null;
  void search();
}

/** One click from any line to "everything else in this request's trace". */
function traceCorrelation(entry: LogEntry) {
  const id = text(entry.correlationId, '');
  if (!id || id === '—') return;
  correlationId.value = id;
  requestId.value = '';
  selected.value = null;
  void search();
}

const truncated = computed(() => num(result.value?.matched) > entries.value.length);
const bufferFull = computed(
  () => num(result.value?.capacity) > 0 && num(result.value?.stored) >= num(result.value?.capacity),
);
const notice = computed(() => text(result.value?.notice, ''));
const isDurable = computed(() => result.value?.durable === true);

const refreshChoices = [5, 10, 30, 60];
const { autoRefresh, intervalSeconds, refreshing, lastRefreshedAt, refreshNow } = useLiveResource(
  () => search(),
  { intervalSeconds: 10, enabled: false, immediate: false },
);

/**
 * Deep links, so another screen can hand this one an incident.
 *
 * Events, Message Trace and Alerts all have a "show me the log lines behind
 * this" affordance in the design, and without query support the best any of
 * them could do was drop the operator on an unfiltered buffer and let them
 * retype a correlation id from memory. Every parameter here is one the filter
 * bar already exposes — this adds no new query power, only the ability to
 * arrive with it already set.
 *
 * `since`/`until` are bound to `datetime-local` inputs, which will not accept
 * an ISO instant with its zone suffix, so an incoming instant is converted to
 * the browser's local wall-clock form. Passing it through raw silently leaves
 * the field blank and quietly widens the search to everything.
 */
function toLocalInput(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  const local = new Date(parsed - new Date(parsed).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function applyDeepLink(query: Record<string, unknown>) {
  const read = (key: string): string => {
    const value = query[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  correlationId.value = read('correlationId') || correlationId.value;
  requestId.value = read('requestId') || requestId.value;
  contains.value = read('contains') || contains.value;
  routeFilter.value = read('route') || routeFilter.value;
  minLevel.value = read('minLevel') || minLevel.value;
  level.value = read('level') || level.value;
  const from = read('since');
  const to = read('until');
  if (from) since.value = toLocalInput(from) || from;
  if (to) until.value = toLocalInput(to) || to;
}

// `useRoute()` is undefined when this view is mounted outside a router, which
// is how several of its unit tests exercise it. Deep-linking is a convenience
// laid over filters the operator can set by hand, so its absence must not stop
// the screen loading.
const route = useRoute();

onMounted(() => {
  applyDeepLink((route?.query ?? {}) as Record<string, unknown>);
  void search();
});
</script>

<template>
  <div data-testid="log-explorer-view">
    <!--
      The honesty banner is not decoration. This endpoint reads a bounded ring
      buffer inside ONE API process: it is lost on restart, it does not see the
      other replicas, and it evicts its oldest lines once it wraps. Anybody
      reading this screen as "the logs" would draw wrong conclusions from an
      absence of evidence, so the limits are stated before the results.
    -->
    <p class="warn-notice" role="status" data-testid="log-buffer-warning">
      This is <strong>not durable log storage</strong>. It is an in-memory ring buffer local to a
      single API process: entries are lost on restart, are not shared between replicas, and the
      oldest lines are evicted once the buffer wraps. A line missing here does not mean it never
      happened — only that this process no longer holds it. Ship stdout to a real log store for
      retention.
      <span v-if="notice" class="mono" data-testid="log-buffer-notice">{{ notice }}</span>
    </p>
    <p v-if="isDurable" class="notice" role="status" data-testid="log-buffer-durable">
      This deployment reports the log source as durable, so the caveat above does not apply to it.
    </p>

    <!-- Buffer health --------------------------------------------------------- -->
    <section class="panel" data-testid="log-buffer-panel" aria-label="Log buffer health">
      <header class="panel-header">
        <div>
          <h2>Buffer</h2>
          <p aria-live="polite">
            {{
              state === 'loading'
                ? 'Querying the buffer…'
                : `Scope: ${text(result?.scope, 'process')} · durable: ${isDurable ? 'yes' : 'no'}`
            }}
          </p>
        </div>
        <!--
          Buffer health without re-running the query. `GET stats` returns the
          same envelope minus the lines, so watching for eviction costs nothing
          and does not disturb the results an operator is reading.
        -->
        <button
          class="secondary-button"
          type="button"
          :disabled="statsBusy"
          data-testid="log-stats-refresh"
          @click="refreshStats"
        >
          {{ statsBusy ? 'Reading…' : 'Refresh buffer health' }}
        </button>
      </header>
      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="log-stored">{{ num(result?.stored) }}</strong>
          <small>Held in buffer</small>
        </div>
        <div class="metric">
          <strong data-testid="log-capacity">{{ num(result?.capacity) }}</strong>
          <small>Capacity</small>
        </div>
        <div class="metric">
          <strong data-testid="log-dropped">{{ num(result?.dropped) }}</strong>
          <small>Evicted since boot</small>
        </div>
        <div class="metric">
          <strong data-testid="log-matched">{{ num(result?.matched) }}</strong>
          <small>Matching this filter</small>
        </div>
        <div class="metric">
          <strong>{{ text(result?.oldest) }}</strong>
          <small>Oldest held</small>
        </div>
        <div class="metric">
          <strong>{{ text(result?.newest) }}</strong>
          <small>Newest held</small>
        </div>
      </div>
      <p v-if="num(result?.dropped) > 0" class="warn-notice" data-testid="log-dropped-warning">
        {{ num(result?.dropped) }} line(s) have already been evicted since this process started.
        Anything older than {{ text(result?.oldest) }} is gone from here permanently.
      </p>
      <p v-else-if="bufferFull" class="source-note" data-testid="log-buffer-full">
        The buffer is at capacity, so the next line written evicts the oldest one.
      </p>
    </section>

    <!-- Search ----------------------------------------------------------------- -->
    <section class="panel" data-testid="log-search-panel" aria-label="Log search">
      <header class="panel-header">
        <div>
          <h2>Trace an incident</h2>
          <p>
            A correlation id ties every line one request produced together. It is the fastest way
            from "a customer reported an error at 14:02" to the lines that caused it.
          </p>
        </div>
      </header>

      <!--
        The primary field, in the same shape as the narrowing fields below it.

        It was a `.grid-toolbar`: label inline, then the input, then two buttons,
        all on one line. That put the correlation search in a different visual
        language from the nine fields immediately under it, which are the same
        kind of thing — and made the panel read as a toolbar with a form stuck
        underneath rather than as one form with a headline field.
      -->
      <div class="dialog-grid">
        <label class="field">
          <span>Correlation ID</span>
          <input
            v-model="correlationId"
            data-testid="log-correlation-id"
            type="search"
            placeholder="Paste the correlation id from an error response or a header"
            @keyup.enter="searchFromStart"
          />
        </label>
      </div>
      <div class="log-filter-actions">
        <button class="primary-button" data-testid="log-search-submit" @click="searchFromStart">
          {{ state === 'loading' ? 'Searching…' : 'Search' }}
        </button>
        <button class="secondary-button" data-testid="log-reset" @click="resetFilters">
          Clear filters
        </button>
      </div>

      <!--
        NARROWING, AS A LABELLED GROUP OF EQUAL FIELDS.

        This was three `.grid-toolbar` rows holding eleven controls: a flex row
        that packs `label · control` pairs left to right at whatever width each
        happens to want. Nine fields on two lines, no two the same width, the
        labels sitting inline so the eye cannot find the start of a field, and
        the auto-refresh controls in the same visual run as the filters despite
        having nothing to do with narrowing a search.

        A toolbar is the right component for three or four controls above a
        grid. It is the wrong one for a form, and this is a form.

        So: a `.field` grid, which is the design system's form pattern — label
        ABOVE control, every column the same width, and the fields in the order
        somebody actually narrows a search. The identifiers come first because
        they answer the question outright; the coarse filters follow; the time
        window is last because it is a qualifier on the rest. Refresh moves to
        its own footer, since it governs the RESULT and not the QUERY.
      -->
      <fieldset class="log-filters" data-testid="log-filter-group">
        <legend>Or narrow it down</legend>
        <div class="dialog-grid">
          <label class="field">
            <span>Request ID</span>
            <input
              v-model="requestId"
              data-testid="log-request-id"
              type="search"
              @keyup.enter="searchFromStart"
            />
          </label>
          <label class="field">
            <span>Tenant ID</span>
            <input
              v-model="tenantId"
              data-testid="log-tenant"
              type="search"
              @keyup.enter="searchFromStart"
            />
          </label>
          <label class="field">
            <span>User ID</span>
            <input v-model="userId" data-testid="log-user" type="search" @keyup.enter="searchFromStart" />
          </label>
          <label class="field">
            <span>Minimum level</span>
            <select v-model="minLevel" data-testid="log-min-level" @change="searchFromStart">
              <option value="">Any</option>
              <option v-for="choice in LEVELS" :key="choice" :value="choice">{{ choice }}</option>
            </select>
          </label>
          <label class="field">
            <span>Exact level</span>
            <select v-model="level" data-testid="log-level" @change="searchFromStart">
              <option value="">Any</option>
              <option v-for="choice in LEVELS" :key="choice" :value="choice">{{ choice }}</option>
            </select>
          </label>
          <label class="field">
            <span>Rows</span>
            <select v-model.number="limit" data-testid="log-limit" @change="searchFromStart">
              <option v-for="choice in LIMIT_CHOICES" :key="choice" :value="choice">
                {{ choice }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>Route contains</span>
            <input
              v-model="routeFilter"
              data-testid="log-route"
              type="search"
              placeholder="/api/v1/messages"
              @keyup.enter="searchFromStart"
            />
          </label>
          <label class="field">
            <span>Message contains</span>
            <input
              v-model="contains"
              data-testid="log-contains"
              type="search"
              placeholder="timeout, refused, …"
              @keyup.enter="searchFromStart"
            />
          </label>
          <label class="field">
            <span>Since</span>
            <input v-model="since" data-testid="log-since" type="datetime-local" />
          </label>
          <label class="field">
            <span>Until</span>
            <input v-model="until" data-testid="log-until" type="datetime-local" />
          </label>
        </div>
        <div class="log-filter-actions">
          <button class="secondary-button" data-testid="log-apply" @click="searchFromStart">
            Apply filters
          </button>
          <span v-if="activeFilters.length" class="source-note">
            {{ activeFilters.length }} filter{{ activeFilters.length === 1 ? '' : 's' }} applied
          </span>
        </div>
      </fieldset>

      <!-- Refresh governs the RESULT, not the query, so it sits apart from the
           filters and reads as a footer to the panel. -->
      <div class="log-refresh" data-testid="log-refresh-bar">
        <label class="filter-select">
          <span>Auto refresh</span>
          <select v-model="autoRefresh" data-testid="log-auto-toggle">
            <option :value="true">On</option>
            <option :value="false">Off</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Every</span>
          <select v-model.number="intervalSeconds" data-testid="log-interval">
            <option v-for="choice in refreshChoices" :key="choice" :value="choice">
              {{ choice }}s
            </option>
          </select>
        </label>
        <button
          class="secondary-button"
          data-testid="log-refresh"
          :disabled="refreshing"
          @click="refreshNow(true)"
        >
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
        <span class="source-note" data-testid="log-last-refreshed">
          {{ lastRefreshedAt ? `Last updated ${lastRefreshedAt}` : 'Not refreshed yet' }}
        </span>
      </div>

      <p v-if="activeFilters.length" class="source-note" data-testid="log-active-filters">
        Applied: <span class="mono">{{ activeFilters.join(' · ') }}</span>
      </p>
    </section>

    <!-- Results ----------------------------------------------------------------- -->
    <section class="panel" data-testid="log-results-panel" aria-label="Log entries">
      <header class="panel-header">
        <div>
          <h2>Entries</h2>
          <p aria-live="polite">
            {{
              state === 'loading'
                ? 'Loading log entries…'
                : `${entries.length} shown of ${num(result?.matched)} matching, newest first`
            }}
          </p>
        </div>
      </header>

      <p v-if="state === 'error'" class="chart-empty" role="alert" data-testid="log-error">
        {{ missing ? 'The log query API is not available in this deployment.' : error }}
      </p>
      <template v-else>
        <!-- The notice that used to live here told the operator to raise the
             row count or narrow the filters, because there was no other way
             past the newest slice. There is now: the pager below reaches every
             matching line. What remains worth saying is the thing paging does
             NOT fix — the buffer is one process's memory and evicts. -->
        <p v-if="truncated" class="source-note" data-testid="log-truncated">
          Paging through {{ num(result?.matched) }} matching lines held by THIS process. The buffer
          keeps {{ num(result?.capacity) }} and has already evicted {{ num(result?.dropped) }}, so
          an absence here is not proof the event did not happen.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <!--
                Only the columns the SERVER can order by are buttons. A header
                that looks sortable and is not is a worse lie than one that
                plainly is not: Object is derived from three different fields
                depending on the line, Message is free text nobody sorts, and
                Correlation is an opaque id.
              -->
              <tr>
                <th scope="col" :aria-sort="sortField === 'time' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-time" @click="toggleSort('time')">
                    Time{{ sortIndicator('time') }}
                  </button>
                </th>
                <th scope="col" :aria-sort="sortField === 'level' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-level" @click="toggleSort('level')">
                    Level{{ sortIndicator('level') }}
                  </button>
                </th>
                <th scope="col" :aria-sort="sortField === 'component' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-component" @click="toggleSort('component')">
                    Component{{ sortIndicator('component') }}
                  </button>
                </th>
                <th scope="col">Object</th>
                <th scope="col">Message</th>
                <th scope="col" :aria-sort="sortField === 'route' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-route" @click="toggleSort('route')">
                    Route{{ sortIndicator('route') }}
                  </button>
                </th>
                <th scope="col" :aria-sort="sortField === 'status' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-status" @click="toggleSort('status')">
                    Status{{ sortIndicator('status') }}
                  </button>
                </th>
                <th scope="col" :aria-sort="sortField === 'duration' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'">
                  <button type="button" class="th-sort" data-testid="log-sort-duration" @click="toggleSort('duration')">
                    Duration{{ sortIndicator('duration') }}
                  </button>
                </th>
                <th scope="col">Correlation</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in entries"
                :key="`${entry.timestamp}-${index}`"
                :data-testid="`log-row-${index}`"
                @click="selected = entry"
              >
                <!--
                  A timestamp is one value and must not be broken across two
                  lines. `2026-09-03T08:49:24.452Z` was wrapping after the
                  month, so the column read "2026-09-" above "03T08:49:24.452Z"
                  and every row in the buffer was two lines tall for it. It also
                  makes the column impossible to scan: the eye follows the left
                  edge, and the left edge alternates between a date and a time.
                -->
                <td class="mono log-time">{{ text(entry.timestamp) }}</td>
                <td>
                  <span class="status-badge" :class="levelTone(entry.level)">
                    {{ text(entry.level) }}
                  </span>
                </td>
                <!--
                  `context` is the logger context the emitter set — "HTTP",
                  a service name — which is precisely the design's "Component".
                  It was previously a subscript under the message; as its own
                  column it becomes something you can scan a page by.
                -->
                <td class="mono cell-tight" :data-testid="`log-component-${index}`">
                  {{ text(entry.context, 'unattributed') }}
                </td>
                <!--
                  What the line is ABOUT. The route for a request line, the
                  subject for anything else. "not attributed" rather than a dash:
                  a line with no object is a line whose emitter did not say what
                  it concerned, which is a fact about the log, not about us.
                -->
                <td class="mono cell-tight" :data-testid="`log-object-${index}`">
                  {{ logObject(entry) }}
                </td>
                <td>{{ text(entry.message) }}</td>
                <td class="mono">
                  {{ entry.method ? `${entry.method} ` : '' }}{{ text(entry.route) }}
                </td>
                <td class="mono">{{ text(entry.status) }}</td>
                <td class="mono">
                  {{ entry.durationMs === undefined ? '—' : `${num(entry.durationMs)} ms` }}
                </td>
                <td class="row-actions" @click.stop>
                  <button
                    v-if="entry.correlationId"
                    class="secondary-button"
                    :data-testid="`log-trace-${index}`"
                    :title="`Show every line for ${entry.correlationId}`"
                    @click="traceCorrelation(entry)"
                  >
                    {{ String(entry.correlationId).slice(0, 8) }}…
                  </button>
                  <span v-else class="cell-health">none</span>
                </td>
              </tr>
              <tr v-if="state === 'ok' && !entries.length">
                <td colspan="9" class="empty-cell" data-testid="log-empty">
                  No entry in this process's buffer matches. That is not proof the event did not
                  happen — the buffer holds only {{ num(result?.capacity) }} lines from this one
                  process, and {{ num(result?.dropped) }} have already been evicted.
                </td>
              </tr>
              <tr v-if="state === 'loading'">
                <td colspan="9" class="empty-cell">Loading log entries…</td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer class="pager" data-testid="log-pager">
          <span data-testid="log-range">{{ pageLabel }}</span>
          <div class="pager-buttons">
            <button
              class="secondary-button"
              data-testid="log-prev"
              :disabled="state === 'loading' || offset === 0"
              @click="turnPage(-1)"
            >
              Previous
            </button>
            <button
              class="secondary-button"
              data-testid="log-next"
              :disabled="state === 'loading' || offset + limit >= num(result?.matched)"
              @click="turnPage(1)"
            >
              Next
            </button>
          </div>
        </footer>
      </template>
    </section>

    <!-- Single entry ------------------------------------------------------------
         A sheet. Reading one line means comparing it with the lines around it,
         which a panel below the buffer scrolls out of view. -->
    <DetailDrawer
      :open="Boolean(selected)"
      title="Log entry"
      eyebrow="Log"
      wide
      @close="selected = null"
    >
      <dl v-if="selected" class="detail-grid" data-testid="log-entry-panel">
        <dt>Timestamp</dt>
        <dd class="mono">{{ text(selected.timestamp) }}</dd>
        <dt>Level</dt>
        <dd>
          <span class="status-badge" :class="levelTone(selected.level)">
            {{ text(selected.level) }}
          </span>
        </dd>
        <dt>Message</dt>
        <dd>{{ text(selected.message) }}</dd>
        <dt>Context</dt>
        <dd class="mono">{{ text(selected.context) }}</dd>
        <dt>Correlation ID</dt>
        <dd class="mono">{{ text(selected.correlationId) }}</dd>
        <dt>Request ID</dt>
        <dd class="mono">{{ text(selected.requestId) }}</dd>
        <dt>Route</dt>
        <dd class="mono">
          {{ selected.method ? `${selected.method} ` : '' }}{{ text(selected.route) }}
        </dd>
        <dt>Status</dt>
        <dd class="mono">{{ text(selected.status) }}</dd>
        <dt>Duration</dt>
        <dd class="mono">
          {{ selected.durationMs === undefined ? '—' : `${num(selected.durationMs)} ms` }}
        </dd>
        <dt>Tenant</dt>
        <dd class="mono">{{ text(selected.tenantId) }}</dd>
        <dt>User</dt>
        <dd class="mono">{{ text(selected.username ?? selected.userId) }}</dd>
        <dt>Client IP</dt>
        <dd class="mono">{{ text(selected.clientIp) }}</dd>
      </dl>
      <template v-if="selected?.trace">
        <h3>Trace</h3>
        <pre class="json-block" data-testid="log-entry-trace">{{ selected.trace }}</pre>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* A sortable header is a button so it is reachable by keyboard and announced as
   one, but it must not LOOK like a button — the kit's table head is a quiet
   band and a row of controls in it would shout. So it inherits the `th`'s own
   type entirely and only gains a pointer and a hover tint. */
.th-sort {
  all: unset;
  cursor: pointer;
  white-space: nowrap;
}
.th-sort:hover {
  color: var(--text-strong);
}
.th-sort:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
  border-radius: var(--r-xs);
}

/* The filter group. A `fieldset` rather than a `div` because it IS one — the
   legend names what the controls do collectively, which is the thing three
   unlabelled toolbar rows could not say. Its own border is removed and the rule
   above the legend does the separating, so the panel keeps one visual language
   rather than gaining a box inside a box. */
.log-filters {
  margin: 4px 0 0;
  padding: 16px 0 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.log-filters > legend {
  padding: 0;
  color: var(--muted);
  font-size: var(--fs-body-sm);
  font-weight: var(--fw-medium);
}
/* `.dialog-grid` is the design system's equal-column field grid and is already
   sized so a label, a control and a hint fit in one track. Reused here rather
   than reinvented: the same form pattern should look the same in a panel as it
   does in a dialog. */
.log-filters .dialog-grid {
  margin-top: 12px;
}
.log-time {
  white-space: nowrap;
}
.log-filter-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin-top: 16px;
}
/* Refresh is a footer to the panel, not another filter row, so it is separated
   by a rule and its controls stay compact. */
.log-refresh {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-4);
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
</style>
<style src="./workspace-extras.css"></style>
