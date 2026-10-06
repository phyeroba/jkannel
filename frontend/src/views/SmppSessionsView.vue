<script setup lang="ts">
/**
 * SMPP SESSIONS (PLAN.md 2.5, spec §5; rebuilt to CONSOLE_DESIGN_SPEC §1).
 *
 * THIS SCREEN IS NAMED FOR SOMETHING IT CANNOT SHOW, AND SAYS SO.
 *
 * §5 asks for a session register: per-session identity, bind state in SMPP
 * vocabulary (BOUND_TX/RX/TRX), endpoint, uptime, last protocol activity,
 * enquire_link round-trip time and missed responses, submit_sm /
 * submit_sm_resp / deliver_sm / generic_nack counters, and protocol latency
 * percentiles.
 *
 * bearerbox emits none of it. `/status.json` gives one entry per `smsc-id` with
 * a status token and coarse counters, and `instances = N` forks N real SMPP
 * sessions that all share that one `smsc-id` — so there is no per-session
 * identity to key a row on, even in principle.
 *
 * What is built instead is a register of BINDS across the estate, from the two
 * sources that do exist: the bind state the poller writes, and the transition
 * history JKANNEL keeps forever. There are no columns for the unavailable
 * fields — an empty column invites the reader to conclude "zero" — and the
 * `limits` block the API returns is rendered in full, grouped by reason so an
 * `instances = 3` connection's sentence is never read as covering the rest.
 *
 * WHAT THE 2026-10 REBUILD CHANGED
 * ---------------------------------------------------------------------------
 * The screen had the right content in the wrong shape. Peter's report was that
 * the bind timeline "is too long"; measuring found two faults with one cause —
 * nothing on the page was bounded.
 *
 *   - The timeline grew one row per transition with no cap, so a week of
 *     flapping pushed the page to several screens of rail. It is now a capped
 *     scroll region that says how much it is showing, with a filter for the
 *     transitions that are actually problems.
 *   - Thirteen columns ran 588px past the panel. Three separate timestamp
 *     columns (Since, Last observed, Last transition) answer one question —
 *     how long has it been like this — so they are now one cell, and the four
 *     throughput columns are another. Seven columns, nothing dropped.
 *   - The five bands of §1 are now in order: verdict, figures, tabs + live,
 *     filters, rows. Before this the first thing on the screen after the scope
 *     note was a row of seven dropdowns.
 *
 * Backend contract:
 *   GET /smscs?search=&filter.type=&filter.enabled=&filter.lifecycleState=
 *              &sort=&limit=&offset=      (server-side grid, console.repository.ts)
 *   GET /smscs/:engineId/detail           (bind state, capacity, limits, history)
 *
 * `/sessions` is user login sessions and stays that way; this is a distinct
 * path with a distinct label.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import EventTimeline from '../components/EventTimeline.vue';
import ObservabilityLimits from '../components/ObservabilityLimits.vue';
import TablePager from '../components/TablePager.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import { agoWhen } from '../utils/when';
import {
  bindTone,
  bindWord,
  formatCeiling,
  formatMoment,
  formatRate,
  formatUtilisation,
  mapWithConcurrency,
  utilisationTone,
  type ObservabilityLimits as Limits,
  type SmscDetail,
  type SmscRow,
} from '../utils/connectivity';

/** Exactly CONSOLE_GRIDS.smscs.sortColumns — no option the API would ignore. */
const SORT_FIELDS = [
  { value: 'name', label: 'name' },
  { value: 'priority', label: 'priority' },
  { value: 'type', label: 'type' },
  { value: 'enabled', label: 'enabled' },
  { value: 'lifecycleState', label: 'lifecycle state' },
  { value: 'updatedAt', label: 'last updated' },
];
const PAGE_SIZES = [10, 25, 50];
/** Matches the alerts register, so "Live" means the same thing on both. */
const REFRESH_SECONDS = 30;

const rows = ref<SmscDetail[]>([]);

/**
 * How many times a bind has come up.
 *
 * Counted from the transition history the detail read already returns, not from
 * a counter the engine keeps — bearerbox keeps none. Every transition INTO a
 * bound state is one reconnect, and the first observation counts too: a bind
 * that has come up once has reconnected once as far as this register is
 * concerned.
 *
 * This is the honest half of what the design system's Sessions screen asks for.
 * Its Timeouts, Enquire RTT, P95 latency and Top error columns are not here
 * because /status.json carries none of them and only bearerbox's own log does.
 */
function reconnectCount(detail: SmscDetail): number {
  return (detail.transitions ?? []).filter((entry) => entry.toState === 'bound').length;
}

/**
 * A bind is flapping when it has come up repeatedly rather than once and
 * stayed. Three is the threshold the alerting side already uses for "this is a
 * pattern, not an incident".
 */
const FLAP_THRESHOLD = 3;
const flapping = computed(() =>
  rows.value
    .map((row) => ({ row, reconnects: reconnectCount(row) }))
    .filter((entry) => entry.reconnects >= FLAP_THRESHOLD)
    .sort((a, b) => b.reconnects - a.reconnects),
);

/** The tone a transition's destination state deserves on the rail. */
function transitionTone(toState: string | null | undefined): 'ok' | 'error' | 'missing' | 'warn' {
  if (toState === 'bound') return 'ok';
  if (toState === 'failed' || toState === 'disconnected') return 'error';
  if (toState === null || toState === undefined) return 'missing';
  return 'warn';
}

/**
 * Every bind's history on one rail, newest first — the design system's "Bind
 * timeline". Reading one bind's page tells you what happened to that bind;
 * this answers the different question of what happened to the estate, which is
 * how a correlated outage across several carriers becomes visible at all.
 *
 * Built in full first so the count beside the heading is the real number of
 * transitions, then capped for rendering. A panel that shows fifty of three
 * hundred and says "fifty" is not showing the estate's history, it is showing
 * a window onto it, and the difference matters when you are asking whether
 * four carriers dropped at the same moment.
 */
const TIMELINE_CAP = 40;
const timelineFilter = ref<'all' | 'problems'>('all');
const allTransitions = computed(() =>
  rows.value
    .flatMap((row) => (row.transitions ?? []).map((entry) => ({ row, entry })))
    .sort((a, b) => String(b.entry.observedAt).localeCompare(String(a.entry.observedAt))),
);
/** Problems only: anything that is not a transition INTO a bound state. */
const filteredTransitions = computed(() =>
  timelineFilter.value === 'problems'
    ? allTransitions.value.filter(({ entry }) => transitionTone(entry.toState) !== 'ok')
    : allTransitions.value,
);
const bindTimeline = computed(() =>
  filteredTransitions.value.slice(0, TIMELINE_CAP).map(({ row, entry }) => ({
    // Relative in the rail, exact in the title — a rail of ISO strings is the
    // same wall of text the register was.
    at: agoWhen(entry.observedAt),
    label: `${row.name}: ${entry.fromState ?? 'no recorded state'} → ${entry.toState ?? 'no recorded state'}`,
    detail: `${entry.kind} · ${formatMoment(entry.observedAt)}`,
    state: transitionTone(entry.toState),
  })),
);
const timelineCountLabel = computed(() => {
  const total = allTransitions.value.length;
  const matching = filteredTransitions.value.length;
  const shown = Math.min(matching, TIMELINE_CAP);
  if (!total) return 'none recorded';
  if (timelineFilter.value === 'problems')
    return shown < matching
      ? `${shown} of ${matching} problem transitions · ${total} in all`
      : `${matching} problem transitions · ${total} in all`;
  return shown < total ? `${shown} most recent of ${total}` : `${total} transitions`;
});

const state = ref<State>('loading');
const error = ref('');
/** Connections whose detail read failed; named so `partial` means something. */
const missed = ref<string[]>([]);

/* --- the verdict ---------------------------------------------------------
   §1 puts the verdict first. On a register of forty binds the question an
   operator arrives with is "is anything down", and the answer was previously
   only derivable by reading the State column of every row. */
const notBound = computed(() =>
  rows.value.filter((row) => row.bindState && row.bindState !== 'bound'),
);
const neverObserved = computed(() => rows.value.filter((row) => !row.bindState));
/**
 * Never green on an absence of evidence. A page where nothing has been
 * observed is not a page where everything is fine, and the dashboard already
 * made that mistake once.
 */
const verdictTone = computed(() => {
  if (state.value !== 'live' && state.value !== 'partial') return 'unknown';
  if (!rows.value.length) return 'unknown';
  if (notBound.value.length) return 'bad';
  if (neverObserved.value.length) return 'unknown';
  if (flapping.value.length) return 'warn';
  return 'good';
});
const verdictWord = computed(
  () =>
    ({
      good: 'All bound',
      warn: 'Flapping',
      bad: 'Not bound',
      unknown: 'Unverified',
    })[verdictTone.value],
);
const verdictSentence = computed(() => {
  if (state.value === 'loading') return 'Reading bind state for each connection…';
  if (!rows.value.length) return 'No bind matched these filters, so there is nothing to assess.';
  const parts: string[] = [];
  if (notBound.value.length)
    parts.push(
      `${notBound.value.length} bind(s) observed in a state other than bound: ${notBound.value
        .map((row) => row.name)
        .join(', ')}`,
    );
  if (neverObserved.value.length)
    parts.push(
      `${neverObserved.value.length} have never been observed at all: ${neverObserved.value
        .map((row) => row.name)
        .join(', ')}`,
    );
  if (flapping.value.length)
    parts.push(
      `${flapping.value.length} have come up ${FLAP_THRESHOLD} or more times rather than coming up and staying`,
    );
  if (!parts.length)
    return `All ${rows.value.length} bind(s) on this page are bound, and none has flapped.`;
  return `${parts.join('. ')}.`;
});
/** The one to open first: a bind that is down beats one nobody has watched. */
const worstBind = computed(
  () => notBound.value[0] ?? flapping.value[0]?.row ?? neverObserved.value[0] ?? null,
);

/**
 * Tabs over the LOADED PAGE, and the footer says so.
 *
 * The API can neither filter nor sort on bind state (it is written by the
 * poller into a side table the grid does not join), so these cannot be
 * server-side. A tab that silently counts one page of a paginated estate is
 * the "open 50 while three hundred are open" mistake — so the count is
 * labelled as the page's throughout, rather than presented as the estate's.
 */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'bound', label: 'Bound' },
  { id: 'notbound', label: 'Not bound' },
  { id: 'unobserved', label: 'Never observed' },
  { id: 'flapping', label: 'Flapping' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const activeTab = ref<TabId>('all');

function matchesTab(row: SmscDetail, tab: TabId): boolean {
  switch (tab) {
    case 'bound':
      return row.bindState === 'bound';
    case 'notbound':
      return Boolean(row.bindState) && row.bindState !== 'bound';
    case 'unobserved':
      return !row.bindState;
    case 'flapping':
      return reconnectCount(row) >= FLAP_THRESHOLD;
    default:
      return true;
  }
}
const tabCount = (tab: TabId) => rows.value.filter((row) => matchesTab(row, tab)).length;
const visibleRows = computed(() => rows.value.filter((row) => matchesTab(row, activeTab.value)));

/**
 * The bind opened in the detail sheet.
 *
 * Held by engine id rather than by object so the sheet keeps following the same
 * bind across a refresh — a poll that replaces `rows` would otherwise leave the
 * sheet showing a detached snapshot that quietly stops updating.
 *
 * No fetch: the register already holds each bind's full detail, so opening a
 * row is free. That is also why this is a sheet and not a navigation — the
 * estate list stays behind it, which is the whole point when you are working
 * down a list of forty binds looking for the one that is wrong.
 */
const openBindId = ref('');
const openBind = computed(
  () => rows.value.find((row) => row.engineId === openBindId.value) ?? null,
);

const total = ref(0);
const limit = ref(25);
const offset = ref(0);
const search = ref('');
const typeFilter = ref('smpp');
const enabledFilter = ref('');
const lifecycleFilter = ref('');
const sortField = ref('name');
const sortDirection = ref<'asc' | 'desc'>('asc');

const boundCount = computed(() => rows.value.filter((row) => row.bindState === 'bound').length);
const unobservedCount = computed(() => neverObserved.value.length);
const notBoundCount = computed(() => notBound.value.length);
/** Real SMPP sessions behind the rows on this page, from configuration. */
const configuredSessions = computed(() =>
  rows.value.reduce((sum, row) => sum + Math.max(1, row.limits?.configuredInstances ?? 1), 0),
);
const collapsedRows = computed(() => rows.value.filter((row) => row.limits?.sessionsCollapsed));

/**
 * One `limits` panel per distinct reason, with the connections it covers.
 *
 * The reason text changes with `instances`, so a single panel would either
 * repeat itself once per row or state one connection's situation as if it were
 * the estate's. Grouping is the only version of this that stays true.
 */
const limitGroups = computed(() => {
  const groups = new Map<string, { limits: Limits; engineIds: string[] }>();
  for (const row of rows.value) {
    if (!row.limits) continue;
    const existing = groups.get(row.limits.reason);
    if (existing) existing.engineIds.push(row.engineId);
    else groups.set(row.limits.reason, { limits: row.limits, engineIds: [row.engineId] });
  }
  return [...groups.values()];
});

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/* --- the live line -------------------------------------------------------
   One line stating one idea, per §3. The previous screen had no refresh at
   all: a register of bind state that never re-reads is a photograph, and an
   operator watching a carrier come back up had to reload the browser. */
const paused = ref(false);
const lastRead = ref<Date | null>(null);
const sinceRead = ref(0);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const refreshedLabel = computed(() =>
  lastRead.value ? `updated ${sinceRead.value}s ago` : 'not yet read',
);

async function load() {
  state.value = 'loading';
  missed.value = [];
  const params = new URLSearchParams();
  if (search.value.trim()) params.set('search', search.value.trim());
  if (typeFilter.value) params.set('filter.type', typeFilter.value);
  if (enabledFilter.value) params.set('filter.enabled', enabledFilter.value);
  if (lifecycleFilter.value) params.set('filter.lifecycleState', lifecycleFilter.value);
  params.set('sort', `${sortDirection.value === 'desc' ? '-' : ''}${sortField.value}`);
  params.set('limit', String(limit.value));
  params.set('offset', String(offset.value));
  try {
    const page = await apiRequest<{ items?: SmscRow[]; total?: number }>(
      `/smscs?${params.toString()}`,
    );
    const items = Array.isArray(page?.items) ? page.items : [];
    total.value = typeof page?.total === 'number' ? page.total : items.length;
    const details = await mapWithConcurrency(items, 6, async (row) => {
      try {
        return await apiRequest<SmscDetail>(`/smscs/${row.engine_id}/detail`);
      } catch {
        missed.value.push(row.engine_id);
        return null;
      }
    });
    rows.value = details.filter((detail): detail is SmscDetail => Boolean(detail));
    error.value = '';
    state.value = missed.value.length ? 'partial' : rows.value.length ? 'live' : 'empty';
  } catch (reason) {
    rows.value = [];
    total.value = 0;
    error.value = messageFrom(reason, 'The bind register could not be loaded.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
  lastRead.value = new Date();
  sinceRead.value = 0;
}

function applyFilters() {
  offset.value = 0;
  void load();
}
function turnPage(direction: number) {
  if (direction > 0 && offset.value + rows.value.length >= total.value) return;
  const next = Math.max(0, offset.value + direction * limit.value);
  if (next === offset.value) return;
  offset.value = next;
  void load();
}

/** The newest transition, as an age. `title` keeps the exact instant. */
function lastTransitionAge(row: SmscDetail): string {
  const entry = row.transitions?.[0];
  return entry ? agoWhen(entry.observedAt) : 'none recorded';
}
function lastTransitionKind(row: SmscDetail): string {
  const entry = row.transitions?.[0];
  return entry ? entry.kind : 'no transition recorded';
}
function lastTransitionMoment(row: SmscDetail): string {
  const entry = row.transitions?.[0];
  return entry ? formatMoment(entry.observedAt) : 'never';
}
/** Width of the utilisation bar, or null when the ratio is not measurable. */
function utilisationWidth(row: SmscDetail): string | null {
  const value = row.capacity?.utilisation;
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${Math.min(100, Math.max(2, Math.round(value * 100)))}%`;
}

onMounted(() => {
  void load();
  refreshTimer = setInterval(() => {
    if (!paused.value && state.value !== 'loading') void load();
  }, REFRESH_SECONDS * 1000);
  tickTimer = setInterval(() => {
    if (lastRead.value) sinceRead.value = Math.floor((Date.now() - lastRead.value.getTime()) / 1000);
  }, 1000);
});
onBeforeUnmount(() => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
});
</script>

<template>
  <div data-testid="smpp-sessions-view">
    <!-- HEADER BAND ------------------------------------------------------- -->
    <header class="screen-head">
      <div class="screen-actions">
        <RouterLink class="secondary-button" to="/smsc" data-testid="sessions-open-smsc">
          SMSC Connections
        </RouterLink>
        <RouterLink class="secondary-button" to="/carriers">Carriers</RouterLink>
      </div>
    </header>

    <!-- THE VERDICT -------------------------------------------------------
      §1 band one. Previously the first thing after the scope note was a row of
      seven dropdowns, and "is anything down" could only be answered by reading
      the State column of every row.
    -->
    <section class="status-line" :class="`is-${verdictTone}`" data-testid="sessions-status">
      <span class="status-chip">
        <span class="status-dot" aria-hidden="true"></span>{{ verdictWord }}
      </span>
      <p data-testid="sessions-summary" aria-live="polite">{{ verdictSentence }}</p>
      <RouterLink
        v-if="worstBind"
        class="secondary-button is-compact"
        :to="`/smsc/${worstBind.engineId}`"
        data-testid="sessions-open-worst"
      >
        Open {{ worstBind.name }}
      </RouterLink>
    </section>

    <!--
      THE HEADLINE STATEMENT. The gap between what this screen is called and
      what it can show is the most important thing an operator needs to know
      about it — but it is read once and then known, so it is a disclosure that
      opens to the full paragraph rather than four lines above every visit.
    -->
    <details class="panel scope-note" data-testid="sessions-scope">
      <summary>This is a register of binds, not of sessions</summary>
      <p>
        A “session” in SMPP is one bound TCP connection. This gateway's engine does not expose them
        individually: it reports one entry per <span class="mono">smsc-id</span>, and an SMSC
        configured with <span class="mono">instances = N</span> opens N real sessions that all share
        that single id. There is therefore no per-session row to show, and this screen does not
        invent one. Each row below is a <strong>configured bind</strong> and everything on it is the
        total across whatever sessions that bind is running.
      </p>
    </details>

    <!-- SUMMARY STRIP ----------------------------------------------------- -->
    <section class="stat-strip" data-testid="sessions-strip">
      <article>
        <p class="stat-label">Bound</p>
        <b class="stat-figure" data-testid="sessions-metric-bound">{{
          displayValue(boundCount, state)
        }}</b>
        <p class="stat-caption">Observed bound on this page</p>
      </article>
      <article>
        <p class="stat-label">Observed, not bound</p>
        <b class="stat-figure" data-testid="sessions-metric-notbound">{{
          displayValue(notBoundCount, state)
        }}</b>
        <p class="stat-caption">
          <template v-if="notBound.length">{{ notBound.map((row) => row.name).join(' · ') }}</template>
          <template v-else>nothing down</template>
        </p>
      </article>
      <article>
        <p class="stat-label">Never observed</p>
        <b class="stat-figure" data-testid="sessions-metric-unobserved">{{
          displayValue(unobservedCount, state)
        }}</b>
        <p class="stat-caption">No poll has ever recorded a state</p>
      </article>
      <article>
        <p class="stat-label">SMPP sessions configured</p>
        <b class="stat-figure" data-testid="sessions-metric-configured">{{
          displayValue(configuredSessions, state)
        }}</b>
        <!--
          Said on the figure itself, not only in a footnote: this is the one
          number on the strip that is not an observation.
        -->
        <p class="stat-caption" data-testid="sessions-configured-note">
          Behind these binds · <strong>configuration, not observation</strong>
        </p>
      </article>
    </section>

    <section class="panel">
      <!-- TABS + LIVE LINE ------------------------------------------------
        Buttons in a group, not a tablist: the rows below stay on screen and
        are filtered, so nothing is swapping panels.
      -->
      <div class="tab-bar">
        <div class="tab-row" role="group" aria-label="Filter binds by state, on this page">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="tab"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-pressed="activeTab === tab.id"
            :data-testid="`sessions-tab-${tab.id}`"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
            <span class="tab-count">{{ tabCount(tab.id) }}</span>
          </button>
        </div>
        <div class="live-line" data-testid="sessions-live">
          <span class="live-dot" :class="{ 'is-paused': paused }" aria-hidden="true"></span>
          <span
            >{{ paused ? 'Paused' : 'Live' }} · {{ refreshedLabel }} · every
            {{ REFRESH_SECONDS }}s</span
          >
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="sessions-pause"
            @click="paused = !paused"
          >
            {{ paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="sessions-refresh"
            :disabled="state === 'loading'"
            @click="load"
          >
            <AppIcon name="refresh" :size="14" />Refresh
          </button>
        </div>
      </div>

      <!-- FILTER ROW ------------------------------------------------------ -->
      <div class="filter-row">
        <label class="filter-select filter-search">
          <span class="sr-only">Search binds</span>
          <input
            v-model="search"
            data-testid="sessions-search"
            type="search"
            placeholder="Name, engine id, host or description"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select is-compact">
          <span>Protocol</span>
          <select v-model="typeFilter" data-testid="sessions-filter-type" @change="applyFilters">
            <option value="smpp">smpp</option>
            <option value="">Any type</option>
            <option value="http">http</option>
            <option value="at">at</option>
            <option value="fake">fake</option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Enabled</span>
          <select
            v-model="enabledFilter"
            data-testid="sessions-filter-enabled"
            @change="applyFilters"
          >
            <option value="">Any</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Lifecycle</span>
          <select
            v-model="lifecycleFilter"
            data-testid="sessions-filter-lifecycle"
            @change="applyFilters"
          >
            <option value="">Any</option>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="retired">retired</option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Sort</span>
          <select v-model="sortField" data-testid="sessions-sort" @change="applyFilters">
            <option v-for="field in SORT_FIELDS" :key="field.value" :value="field.value">
              {{ field.label }}
            </option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Direction</span>
          <select
            v-model="sortDirection"
            data-testid="sessions-sort-direction"
            @change="applyFilters"
          >
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Per page</span>
          <select v-model.number="limit" data-testid="sessions-limit" @change="applyFilters">
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>

      <p v-if="error" class="form-error" role="alert" data-testid="sessions-error">{{ error }}</p>

      <DataState
        :state="state"
        subject="binds"
        skeleton="table"
        :skeleton-rows="5"
        :missing="missed"
        :detail="
          state === 'empty'
            ? 'No SMSC connection matches these filters, so there is no bind to report on. Connections are created in the SMSC Connections workspace.'
            : state === 'error'
              ? error
              : undefined
        "
        permission="smsc.view"
        testid="sessions-state"
        :on-retry="load"
      >
        <div class="table-wrap">
          <!--
            SEVEN COLUMNS, FROM THIRTEEN. Nothing was dropped: Since, Last
            observed and Last transition are three readings of one question and
            share a cell; out rate, ceiling and utilisation are one answer about
            throughput; queued and failed are one answer about the spool.
          -->
          <table data-testid="sessions-table">
            <thead>
              <tr>
                <th scope="col">Bind</th>
                <th scope="col">Carrier</th>
                <th scope="col">State</th>
                <th scope="col">Sessions</th>
                <th scope="col">Throughput</th>
                <th scope="col">Spool</th>
                <!-- Counted from the transition history. The kit also asks for
                     Enquire RTT, Timeouts, P95 latency and Top error;
                     /status.json carries none of them and only bearerbox's own
                     log does, so they are absent rather than drawn as dashes. -->
                <th scope="col">Stability</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in visibleRows"
                :key="row.id"
                class="selectable"
                tabindex="0"
                :data-testid="`session-${row.engineId}`"
                @click="openBindId = row.engineId"
                @keydown.enter="openBindId = row.engineId"
              >
                <td>
                  <router-link class="text-link" :to="`/smsc/${row.engineId}`" @click.stop>{{
                    row.name
                  }}</router-link>
                  <small class="row-id mono clamp-1" :title="row.engineId">{{ row.engineId }}</small>
                </td>
                <td>
                  <router-link
                    v-if="row.carrierId"
                    class="text-link"
                    :to="`/carriers/${row.carrierId}`"
                    @click.stop
                    >{{ row.carrierName }}</router-link
                  >
                  <span v-else class="row-id">unassigned</span>
                </td>
                <!--
                  STATE, SINCE AND LAST OBSERVED IN ONE CELL. Word first; the
                  tone class only repeats what it says (§17.1). The two
                  timestamps are ages, with the instants in `title` — a register
                  is not the place to read a UTC offset.
                -->
                <td>
                  <span
                    class="status-badge"
                    :class="bindTone(row.bindState)"
                    :data-testid="`session-state-${row.engineId}`"
                    >{{ bindWord(row.bindState) }}</span
                  >
                  <small class="row-id" :title="formatMoment(row.bindStateSince)">
                    <template v-if="row.bindStateSince"
                      >since {{ agoWhen(row.bindStateSince) }}</template
                    >
                    <template v-else>no start recorded</template>
                  </small>
                  <small class="row-id" :title="formatMoment(row.bindObservedAt)">
                    <template v-if="row.bindObservedAt"
                      >seen {{ agoWhen(row.bindObservedAt) }}</template
                    >
                    <template v-else>never polled</template>
                  </small>
                </td>
                <td :data-testid="`session-collapsed-${row.engineId}`">
                  <template v-if="row.limits?.sessionsCollapsed">
                    <span class="status-badge warn"
                      >{{ row.limits.configuredInstances }} collapsed into 1</span
                    >
                    <small class="row-id"
                      >figures are the total across all
                      {{ row.limits.configuredInstances }}</small
                    >
                  </template>
                  <span v-else class="row-id">1 configured</span>
                </td>
                <!-- Out rate against its ceiling, with the ratio drawn rather
                     than left to be computed from two numbers in two columns. -->
                <td>
                  <span class="mono">{{ formatRate(row.outboundRate, state) }}</span>
                  <small class="row-id">of {{ formatCeiling(row.capacity) }}</small>
                  <span class="util-row">
                    <span
                      v-if="utilisationWidth(row)"
                      class="util-track"
                      aria-hidden="true"
                    >
                      <span
                        :class="utilisationTone(row.capacity?.utilisation)"
                        :style="{ width: utilisationWidth(row) ?? '0%' }"
                      ></span>
                    </span>
                    <small class="row-id" :data-testid="`session-utilisation-${row.engineId}`">{{
                      formatUtilisation(row.capacity?.utilisation, state)
                    }}</small>
                  </span>
                </td>
                <td>
                  <span class="mono">{{ displayValue(row.queued, state) }} queued</span>
                  <small class="row-id mono">{{ displayValue(row.failed, state) }} failed</small>
                </td>
                <td>
                  <span class="mono" :data-testid="`session-reconnects-${row.engineId}`">{{
                    reconnectCount(row)
                  }}</span>
                  <small class="row-id">bind(s) recorded</small>
                  <small class="row-id" :title="lastTransitionMoment(row)"
                    >{{ lastTransitionKind(row) }} · {{ lastTransitionAge(row) }}</small
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- FOOTER: the pager on one side, the reference on the other. -->
        <footer class="table-foot">
          <TablePager
            :shown="rows.length"
            :total="total"
            :offset="offset"
            :page-size="limit"
            :busy="state === 'loading'"
            noun="bind"
            testid="sessions-pager"
            @turn="turnPage"
          />
          <p class="foot-help" data-testid="sessions-grid-note">
            Search, protocol, enabled, lifecycle, sort and paging are applied by the API. Bind state
            is written by the poller into a table the grid does not join, so there is
            <strong>no filter or sort on bind state</strong> — the tabs above count and filter
            <em>this page only</em>, and say so rather than reporting a page as the estate.
          </p>
        </footer>
      </DataState>

      <p
        v-if="collapsedRows.length"
        class="warn-notice"
        role="note"
        data-testid="sessions-collapsed-summary"
      >
        {{ collapsedRows.length }} of the bind(s) on this page run more than one SMPP session behind
        a single reported entry:
        <span class="mono">{{
          collapsedRows
            .map((row) => `${row.engineId} (${row.limits.configuredInstances})`)
            .join(', ')
        }}</span
        >. If one of those sessions is failing while its siblings are healthy, nothing on this
        screen will show it — the counters are summed by the engine before JKANNEL ever sees them.
      </p>
    </section>

    <!-- THE LIMITS BLOCK, one per distinct reason, with its members named. -->
    <ObservabilityLimits
      v-for="group in limitGroups"
      :key="group.limits.reason"
      :limits="group.limits"
      scope="estate"
      :applies-to="group.engineIds"
      :testid="`sessions-limits-${group.engineIds[0]}`"
    />

    <!--
      Diagnostic summary and Bind timeline — two of the three panels the design
      system's SessionsScreen specifies. Both are derived from the transition
      history each detail read already returns.

      Its third, "Top command statuses", is absent: /status.json reports no
      submit_sm_resp status, and /diagnostics/smpp-statuses is a static
      dictionary of code meanings, not a count of what this gateway has seen.
    -->
    <section class="split-grid" data-testid="sessions-diagnostics">
      <article class="panel" data-testid="sessions-diagnostic-summary">
        <header class="panel-header">
          <div>
            <h2>Diagnostic summary</h2>
            <p>Binds that have come up more than once rather than come up and stayed</p>
          </div>
        </header>
        <ul v-if="flapping.length" class="health-list">
          <li
            v-for="entry in flapping"
            :key="entry.row.engineId"
            :data-testid="`sessions-flap-${entry.row.engineId}`"
          >
            <span class="status-dot warn"></span>
            <span>
              <strong>{{ entry.row.name }}</strong>
              <small
                >bound {{ entry.reconnects }} times · now
                {{ entry.row.bindState ?? 'never observed' }}</small
              >
            </span>
            <router-link class="secondary-button" :to="`/smsc/${entry.row.engineId}`"
              >Open</router-link
            >
          </li>
        </ul>
        <p v-else class="chart-empty" data-testid="sessions-no-flap">
          No bind has come up more than {{ FLAP_THRESHOLD - 1 }} times. That is not a claim that
          every bind is healthy — a bind that has never been observed at all has no transitions to
          count, and appears in the register above as “never observed”.
        </p>
      </article>

      <!--
        THE BIND TIMELINE, BOUNDED.

        This panel grew one row per transition with no cap, so a week of
        flapping made the page several screens tall and the panels below it
        unreachable. It is now a scroll region of about six rows that states
        how much of the history it is showing, with a filter for the
        transitions that are actually problems — which is the question this
        rail exists to answer.
      -->
      <article class="panel" data-testid="sessions-bind-timeline">
        <header class="panel-header">
          <div>
            <h2>Bind timeline</h2>
            <p>Every connection's transitions on one rail, newest first</p>
          </div>
          <div class="segmented" role="group" aria-label="Filter the timeline">
            <button
              type="button"
              class=""
              :class="{ 'is-active': timelineFilter === 'all' }"
              data-testid="sessions-timeline-all"
              @click="timelineFilter = 'all'"
            >
              All
            </button>
            <button
              type="button"
              :class="{ 'is-active': timelineFilter === 'problems' }"
              data-testid="sessions-timeline-problems"
              @click="timelineFilter = 'problems'"
            >
              Problems
            </button>
          </div>
        </header>
        <p class="list-count" data-testid="sessions-timeline-count">{{ timelineCountLabel }}</p>
        <div v-if="bindTimeline.length" class="capped-list">
          <EventTimeline dense :items="bindTimeline" />
        </div>
        <p v-else class="chart-empty" data-testid="sessions-timeline-empty">
          <template v-if="timelineFilter === 'problems' && allTransitions.length">
            No transition on this page was anything other than a bind coming up.
          </template>
          <template v-else>
            No bind transition has been recorded across the estate. The history is never pruned, so
            an empty rail means nothing has been observed to change.
          </template>
        </p>
      </article>
    </section>

    <!-- Row detail as a sheet: the register stays in place behind it. -->
    <DetailDrawer
      :open="Boolean(openBind)"
      eyebrow="Bind"
      :title="openBind?.name ?? ''"
      :subtitle="openBind ? `${openBind.engineId} · ${openBind.type}` : undefined"
      @close="openBindId = ''"
    >
      <template #actions>
        <router-link
          v-if="openBind"
          class="secondary-button"
          :to="`/smsc/${openBind.engineId}`"
          data-testid="session-drawer-open"
          >Open full page</router-link
        >
        <router-link
          v-if="openBind?.carrierId"
          class="secondary-button"
          :to="`/carriers/${openBind.carrierId}`"
          >Open carrier</router-link
        >
      </template>
      <template v-if="openBind">
        <dl class="detail-grid">
          <dt>Bind state</dt>
          <dd>
            <span class="status-badge" :class="bindTone(openBind.bindState)">{{
              bindWord(openBind.bindState)
            }}</span>
          </dd>
          <dt>Since</dt>
          <dd class="mono">{{ formatMoment(openBind.bindStateSince) }}</dd>
          <dt>Last observed</dt>
          <dd class="mono">{{ formatMoment(openBind.bindObservedAt) }}</dd>
          <dt>Reconnects</dt>
          <dd class="mono">{{ reconnectCount(openBind) }}</dd>
          <dt>Queued</dt>
          <dd class="mono">{{ displayValue(openBind.queued, state) }}</dd>
          <dt>Failed</dt>
          <dd class="mono">{{ displayValue(openBind.failed, state) }}</dd>
          <dt>Out rate</dt>
          <dd class="mono">{{ formatRate(openBind.outboundRate, state) }}</dd>
          <dt>Ceiling</dt>
          <dd class="mono">{{ formatCeiling(openBind.capacity) }}</dd>
          <dt>Utilisation</dt>
          <dd class="mono">{{ formatUtilisation(openBind.capacity?.utilisation, state) }}</dd>
        </dl>

        <h3>Transitions</h3>
        <!-- Capped here too: a bind sampled all week would otherwise push the
             rest of the record off the sheet. -->
        <div v-if="openBind.transitions?.length" class="capped-list">
          <EventTimeline
            dense
            :items="
              openBind.transitions.map((entry) => ({
                at: agoWhen(entry.observedAt),
                label: `${entry.fromState ?? 'no recorded state'} → ${entry.toState ?? 'no recorded state'}`,
                detail: `${entry.kind} · ${formatMoment(entry.observedAt)}`,
                state: transitionTone(entry.toState),
              }))
            "
          />
        </div>
        <p v-else class="chart-empty">No transition has been recorded for this bind.</p>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* The scope note as a disclosure: the statement stays on screen, the
   paragraph behind it is read once and then folded away. */
.scope-note {
  border-left: 3px solid var(--warn);
  margin-bottom: 14px;
}
.scope-note > summary {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-strong);
  cursor: pointer;
}
.scope-note > p {
  margin: 10px 0 0;
}

/* The utilisation ratio, drawn. A bar makes "83% of ceiling" readable at a
   glance; the figure beside it stays, because a bar cannot say `unknown`. */
.util-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 3px;
}
.util-track {
  flex: 0 0 56px;
  height: 4px;
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}
.util-track > span {
  display: block;
  height: 100%;
  background: var(--brand);
}
.util-track > span.warn {
  background: var(--warn, #9a6700);
}
.util-track > span.bad {
  background: var(--bad, #b42318);
}
.util-track > span.good {
  background: var(--ok, #1a7f37);
}
.util-row .row-id {
  margin: 0;
}

/* About six rows of rail, then a scroll. Nothing is hidden and nothing is
   truncated — the panel simply stops being able to push the page. */
.capped-list {
  max-height: 268px;
}
</style>
<style src="./workspace-extras.css"></style>
