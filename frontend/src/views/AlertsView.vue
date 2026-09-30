<script setup lang="ts">
/**
 * ALERTS — the triage screen, rebuilt to the design Peter supplied.
 *
 * See `docs/REDESIGN-ALERTS-ESCALATION-NOTIFICATIONS.md` §1 and the capture in
 * `design/redesign-2026-09/alerts-AFTER.png`. That document is the authority
 * here, not the generic workspace this route used to render.
 *
 * WHY THIS IS NOT `ModuleWorkspace` ANY MORE
 * ---------------------------------------------------------------------------
 * The workspace is a good register: a search box, some filters, a sorted table
 * and a pager, driven from a column list. Alerts is not a register, it is a
 * queue being worked. The things the design asks for — a summary strip, tabs
 * that carry counts, a live line, bulk acknowledge, a side panel holding the
 * fields that are empty on most rows — are not columns, and bolting each of
 * them onto the shared workspace would have made every other screen carry the
 * weight of one screen's job.
 *
 * WHAT THE OPERATOR IS DOING HERE
 * ---------------------------------------------------------------------------
 * Arriving at an alert list, they want three things in this order: how bad is
 * it, what needs me, and what can I do about it. So the strip answers the
 * first before any row is read, the Open tab is where the page opens, and the
 * two actions that resolve most rows sit on the row itself.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';
import DetailDrawer from '../components/DetailDrawer.vue';
import EventTimeline from '../components/EventTimeline.vue';
import TablePager from '../components/TablePager.vue';
import DataState from '../components/DataState.vue';
import AppIcon from '../components/AppIcon.vue';
import { agoWhen, shortWhen, spanOf } from '../utils/when';

type RecordValue = Record<string, unknown>;
// Mirrors the `DataState` union the shared component accepts; 'live' is its
// word for loaded-and-current.
type LoadState = 'loading' | 'live' | 'error' | 'empty' | 'permission-denied';

/** The tabs, in the order the design shows them. `open` is where we land. */
const TABS: ReadonlyArray<{
  id: 'open' | 'acknowledged' | 'resolved' | 'all';
  label: string;
  statuses: string[];
}> = [
  { id: 'open', label: 'Open', statuses: ['open'] },
  { id: 'acknowledged', label: 'Acknowledged', statuses: ['acknowledged'] },
  // Closed alerts are resolved alerts that have also been filed. An operator
  // looking for "the ones that are done" means both.
  { id: 'resolved', label: 'Resolved', statuses: ['resolved', 'closed'] },
  { id: 'all', label: 'All', statuses: [] },
];
type TabId = (typeof TABS)[number]['id'];

interface AlertSummary {
  total: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  openBySeverity: Record<string, number>;
  unacknowledged: number;
  oldestOpenedAt: string | null;
  resolved30d: number;
  medianResolveSeconds: number | null;
}

const PAGE_SIZE = 50;

const rows = ref<RecordValue[]>([]);
const total = ref(0);
const offset = ref(0);
const state = ref<LoadState>('loading');
const error = ref('');
/**
 * An action that failed, reported beside the action.
 *
 * Never through the load-failure path: acknowledging one alert and getting a
 * 409 must not replace a register the operator is working from.
 */
const actionError = ref('');
const notice = ref('');

const summary = ref<AlertSummary | null>(null);
const activeTab = ref<TabId>('open');
const search = ref('');
const severity = ref<'' | 'critical' | 'warning' | 'info'>('');
const newestFirst = ref(true);

const selected = ref<Set<string>>(new Set());
const openAlert = ref<RecordValue | null>(null);
const busyId = ref('');
const bulkBusy = ref(false);

const canAcknowledge = computed(() => canAccess(session.value, 'alerts.acknowledge'));

/* --- identity helpers ---------------------------------------------------- */
function id(row: RecordValue): string {
  return String(row.id ?? '');
}
function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}
function severityOf(row: RecordValue): string {
  return String(row.severity ?? row.rule_severity ?? row.ruleSeverity ?? 'unknown').toLowerCase();
}
function statusOf(row: RecordValue): string {
  return String(row.status ?? 'unknown').toLowerCase();
}
function openedAt(row: RecordValue): string {
  return String(row.opened_at ?? row.openedAt ?? '');
}
function resolvedAt(row: RecordValue): string {
  return String(row.resolved_at ?? row.resolvedAt ?? '');
}
function acknowledgedAt(row: RecordValue): string {
  return String(row.acknowledged_at ?? row.acknowledgedAt ?? '');
}
function assigneeOf(row: RecordValue): string {
  return text(
    row.assigned_to_username ?? row.assignedToUsername ?? row.assigned_to ?? row.assignedTo,
    'Unassigned',
  );
}
function sourceOf(row: RecordValue): string {
  return text(row.source, '');
}
/** The first segment of the id, which is what a human quotes in a ticket. */
function shortId(row: RecordValue): string {
  return id(row).split('-')[0] ?? '';
}

/**
 * How long this alert has run: to now while open, to resolution once closed.
 *
 * A settled incident must stop ageing, or yesterday's resolved alert climbs
 * the "longest running" order forever.
 */
function durationOf(row: RecordValue): string {
  const from = Date.parse(openedAt(row));
  if (Number.isNaN(from)) return '';
  const to = Date.parse(resolvedAt(row));
  const end = Number.isNaN(to) ? Date.now() : to;
  return spanOf((end - from) / 1000);
}

const severityTone: Record<string, string> = {
  critical: 'bad',
  warning: 'warn',
  info: 'good',
};
function toneOf(value: string): string {
  return severityTone[value] ?? '';
}

/* --- the summary strip --------------------------------------------------- */
/**
 * Every figure here is a whole-table measurement from `GET /alerts/summary`.
 *
 * Deriving them from `rows` would be one line and would count the PAGE: on a
 * register paginated at fifty, the Open tab would read 50 while three hundred
 * were open. A wrong count is worse than none because it looks like an answer.
 */
const openCount = computed(() => summary.value?.byStatus.open ?? 0);
const openSplit = computed(() => {
  const by = summary.value?.openBySeverity ?? {};
  return Object.entries(by)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
});
const medianResolve = computed(() => {
  const value = summary.value?.medianResolveSeconds;
  return value === null || value === undefined ? null : spanOf(value);
});

function tabCount(tab: TabId): number | null {
  const by = summary.value?.byStatus;
  if (!by) return null;
  if (tab === 'all') return summary.value?.total ?? 0;
  const definition = TABS.find((t) => t.id === tab);
  return (definition?.statuses ?? []).reduce((sum, status) => sum + (by[status] ?? 0), 0);
}

/* --- loading ------------------------------------------------------------- */
function queryFor(): string {
  const params = new URLSearchParams();
  params.set('sort', newestFirst.value ? '-openedAt' : 'openedAt');
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset.value));
  const statuses = TABS.find((t) => t.id === activeTab.value)?.statuses ?? [];
  // The API filters one status at a time. The Resolved tab covers two, so it
  // asks for nothing and narrows in the browser — over a page it has already
  // been given, never over a count it reports.
  if (statuses.length === 1) params.set('filter.status', statuses[0]);
  if (severity.value) params.set('filter.severity', severity.value);
  if (search.value.trim()) params.set('search', search.value.trim());
  return `/alerts?${params.toString()}`;
}

async function loadSummary() {
  try {
    summary.value = (await apiRequest<AlertSummary>('/alerts/summary')) ?? null;
  } catch {
    // Decoration over a register that loaded. A failed tally must not raise a
    // banner, and must not be filled in with zeros — zeros would report an
    // empty system.
    summary.value = null;
  }
}

async function load() {
  state.value = 'loading';
  error.value = '';
  try {
    const payload = await apiRequest<{ items?: RecordValue[]; total?: number } | RecordValue[]>(
      queryFor(),
    );
    const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
    const count = Array.isArray(payload) ? payload.length : (payload?.total ?? items.length);
    const statuses = TABS.find((t) => t.id === activeTab.value)?.statuses ?? [];
    rows.value =
      statuses.length > 1 ? items.filter((row) => statuses.includes(statusOf(row))) : items;
    total.value = count;
    state.value = rows.value.length ? 'live' : 'empty';
  } catch (reason) {
    rows.value = [];
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
    error.value = reason instanceof Error ? reason.message : 'Alerts could not be loaded.';
  }
}

async function reload() {
  selected.value = new Set();
  await Promise.all([load(), loadSummary()]);
}

function chooseTab(tab: TabId) {
  if (tab === activeTab.value) return;
  activeTab.value = tab;
  offset.value = 0;
  void reload();
}

function applyFilters() {
  offset.value = 0;
  void reload();
}

/* Debounced, so typing does not fire a request per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 350);
});

function turnPage(direction: number) {
  const next = offset.value + direction * PAGE_SIZE;
  if (next < 0 || next >= total.value) return;
  offset.value = next;
  void load();
}

/* --- live refresh -------------------------------------------------------- */
/**
 * One line, not a panel.
 *
 * The screen carried `Auto refresh [On] Every [30s] (Refresh now)` as three
 * separate labelled controls occupying their own band. They are one idea —
 * whether this page keeps itself current — and the design states it as a
 * sentence with a Pause beside it.
 */
const REFRESH_SECONDS = 30;
const paused = ref(false);
const lastRefreshed = ref<Date | null>(null);
const sinceRefresh = ref(0);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const refreshedLabel = computed(() =>
  lastRefreshed.value ? `updated ${sinceRefresh.value}s ago` : 'not yet updated',
);

function startTimers() {
  tickTimer = setInterval(() => {
    if (!lastRefreshed.value) return;
    sinceRefresh.value = Math.floor((Date.now() - lastRefreshed.value.getTime()) / 1000);
  }, 1000);
  refreshTimer = setInterval(() => {
    if (paused.value) return;
    void refreshNow();
  }, REFRESH_SECONDS * 1000);
}

async function refreshNow() {
  await reload();
  lastRefreshed.value = new Date();
  sinceRefresh.value = 0;
}

/* --- actions ------------------------------------------------------------- */
async function acknowledge(row: RecordValue) {
  if (!canAcknowledge.value) return;
  busyId.value = id(row);
  actionError.value = '';
  try {
    await apiRequest(`/alerts/${id(row)}/acknowledgements`, { method: 'POST', body: '{}' });
    notice.value = 'Alert acknowledged.';
    await reload();
  } catch (reason) {
    actionError.value =
      reason instanceof Error ? reason.message : 'The alert could not be acknowledged.';
  } finally {
    busyId.value = '';
  }
}

async function reNotify(row: RecordValue) {
  if (!canAcknowledge.value) return;
  busyId.value = id(row);
  actionError.value = '';
  try {
    await apiRequest(`/alerts/${id(row)}/notifications`, { method: 'POST', body: '{}' });
    notice.value = 'Notification resent.';
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : 'The alert could not be resent.';
  } finally {
    busyId.value = '';
  }
}

/* --- bulk selection ------------------------------------------------------ */
const selectableRows = computed(() => rows.value.filter((row) => statusOf(row) === 'open'));
const allSelected = computed(
  () => selectableRows.value.length > 0 && selected.value.size === selectableRows.value.length,
);

function toggleRow(row: RecordValue) {
  const next = new Set(selected.value);
  const key = id(row);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}
function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(selectableRows.value.map((row) => id(row)));
}

/**
 * Bulk actions run in SEQUENCE and report how far they got.
 *
 * Firing twenty POSTs at once would be faster and would leave the operator
 * unable to say which ones landed when the eleventh 409s. The count in the
 * message is the number that actually succeeded, not the number attempted.
 */
async function bulkRun(kind: 'acknowledge' | 're-notify') {
  const targets = rows.value.filter((row) => selected.value.has(id(row)));
  if (!targets.length) return;
  bulkBusy.value = true;
  actionError.value = '';
  let done = 0;
  const failures: string[] = [];
  for (const row of targets) {
    try {
      const path =
        kind === 'acknowledge'
          ? `/alerts/${id(row)}/acknowledgements`
          : `/alerts/${id(row)}/notifications`;
      await apiRequest(path, { method: 'POST', body: '{}' });
      done += 1;
    } catch (reason) {
      failures.push(`${shortId(row)}: ${reason instanceof Error ? reason.message : 'failed'}`);
    }
  }
  bulkBusy.value = false;
  notice.value = `${done} of ${targets.length} alert(s) ${kind === 'acknowledge' ? 'acknowledged' : 'resent'}.`;
  if (failures.length) actionError.value = failures.join(' · ');
  await reload();
}

/* --- side panel ---------------------------------------------------------- */
/**
 * The columns that were `—` on almost every row live here instead.
 *
 * Rule, correlation group, suppression and notification state matter when you
 * are looking at ONE alert and are noise across fifty, which is exactly the
 * case for a panel rather than a column.
 */
function openPanel(row: RecordValue) {
  openAlert.value = row;
}

const panelTimeline = computed(() => {
  const row = openAlert.value;
  if (!row) return [];
  const steps: Array<{ label: string; at: string; detail?: string }> = [];
  const push = (label: string, at: string, detail?: string) => {
    if (at) steps.push({ label, at, detail });
  };
  push('Opened', openedAt(row));
  push(
    'Notified',
    String(row.notified_at ?? row.notifiedAt ?? ''),
    text(row.notification_state ?? row.notificationState, ''),
  );
  push('Acknowledged', acknowledgedAt(row), text(row.acknowledged_by ?? row.acknowledgedBy, ''));
  push('Resolved', resolvedAt(row));
  return steps;
});

/* --- export menu --------------------------------------------------------- */
const exportOpen = ref(false);
function exportAs(format: 'csv' | 'pdf') {
  exportOpen.value = false;
  const params = new URLSearchParams();
  if (severity.value) params.set('filter.severity', severity.value);
  if (search.value.trim()) params.set('search', search.value.trim());
  window.open(`/api/v1/alerts/export.${format}?${params.toString()}`, '_blank');
}
function closeExport(event: MouseEvent) {
  if (!(event.target as HTMLElement).closest('.export-menu')) exportOpen.value = false;
}

onMounted(async () => {
  await refreshNow();
  startTimers();
  document.addEventListener('click', closeExport);
});
onBeforeUnmount(() => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  clearTimeout(searchTimer);
  document.removeEventListener('click', closeExport);
});
</script>

<template>
  <div data-testid="alerts-view">
    <!-- HEADER ------------------------------------------------------------ -->
    <!--
      No subtitle here: the shell already renders `route.meta.description`
      under the page title, and repeating it printed the same sentence twice.
      This row exists only for the two controls on the right.
    -->
    <header class="screen-head">
      <div class="screen-actions">
        <RouterLink class="secondary-button" to="/alert-response" data-testid="alerts-maintenance">
          Escalation &amp; maintenance
        </RouterLink>
        <!-- One Export control, not one button per format. -->
        <div class="export-menu">
          <button
            class="secondary-button"
            type="button"
            data-testid="alerts-export"
            :aria-expanded="exportOpen"
            aria-haspopup="menu"
            @click.stop="exportOpen = !exportOpen"
          >
            Export <span aria-hidden="true">▾</span>
          </button>
          <div v-if="exportOpen" class="export-items" role="menu">
            <button
              type="button"
              role="menuitem"
              data-testid="alerts-export-csv"
              @click="exportAs('csv')"
            >
              Export CSV
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="alerts-export-pdf"
              @click="exportAs('pdf')"
            >
              Export PDF
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- SUMMARY STRIP ----------------------------------------------------- -->
    <!--
      Four measured figures, before any row. This is the question the operator
      arrives with, and until now they had to read it off a table of fifty.
    -->
    <section v-if="summary" class="stat-strip" data-testid="alerts-summary">
      <article>
        <p class="stat-label">Open</p>
        <b class="stat-figure" data-testid="stat-open">{{ openCount }}</b>
        <p class="stat-caption">
          <template v-if="openSplit.length">
            <span
              v-for="([name, count], index) in openSplit"
              :key="name"
              :class="{ 'is-critical': name === 'critical' }"
              >{{ count }} {{ name
              }}<template v-if="index < openSplit.length - 1"> · </template></span
            >
          </template>
          <template v-else>nothing open</template>
        </p>
      </article>
      <article>
        <p class="stat-label">Unacknowledged</p>
        <b class="stat-figure" data-testid="stat-unacked">{{ summary.unacknowledged }}</b>
        <p class="stat-caption">
          <template v-if="summary.oldestOpenedAt">
            Oldest opened {{ agoWhen(summary.oldestOpenedAt) }}
          </template>
          <template v-else>nothing waiting</template>
        </p>
      </article>
      <article>
        <p class="stat-label">Resolved · 30 days</p>
        <b class="stat-figure" data-testid="stat-resolved">{{ summary.resolved30d }}</b>
        <p class="stat-caption">Closed in the last 30 days</p>
      </article>
      <article>
        <p class="stat-label">Median time to resolve</p>
        <!--
          `not measured`, never `0m`. A zero here would read as instant
          resolution rather than as an absence of resolved alerts to measure.
        -->
        <b class="stat-figure" data-testid="stat-median">{{ medianResolve ?? 'not measured' }}</b>
        <p class="stat-caption">Across resolved alerts</p>
      </article>
    </section>

    <section class="panel alerts-panel">
      <!-- TABS + LIVE LINE ------------------------------------------------ -->
      <div class="tab-bar">
        <div class="tab-row" role="tablist" aria-label="Alert status">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            role="tab"
            class="tab"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-selected="activeTab === tab.id"
            :data-testid="`alerts-tab-${tab.id}`"
            @click="chooseTab(tab.id)"
          >
            {{ tab.label }}
            <span v-if="tabCount(tab.id) !== null" class="tab-count">{{ tabCount(tab.id) }}</span>
          </button>
        </div>
        <div class="live-line" data-testid="alerts-live">
          <span class="live-dot" :class="{ 'is-paused': paused }" aria-hidden="true"></span>
          <span
            >{{ paused ? 'Paused' : 'Live' }} · {{ refreshedLabel }} · every
            {{ REFRESH_SECONDS }}s</span
          >
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="alerts-pause"
            @click="paused = !paused"
          >
            {{ paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="alerts-refresh"
            :disabled="state === 'loading'"
            @click="refreshNow"
          >
            <AppIcon name="refresh" :size="14" />Refresh
          </button>
        </div>
      </div>

      <!-- FILTER ROW ------------------------------------------------------ -->
      <div class="filter-row">
        <label class="filter-search">
          <span class="sr-only">Filter alerts</span>
          <input
            v-model="search"
            type="search"
            placeholder="Filter by condition, resource, rule or ID"
            data-testid="alerts-search"
          />
        </label>
        <div class="segmented" role="group" aria-label="Severity">
          <button
            type="button"
            :class="{ 'is-active': severity === '' }"
            data-testid="alerts-sev-all"
            @click="((severity = ''), applyFilters())"
          >
            All
          </button>
          <button
            type="button"
            :class="{ 'is-active': severity === 'critical' }"
            data-testid="alerts-sev-critical"
            @click="((severity = 'critical'), applyFilters())"
          >
            <span class="sev-dot bad" aria-hidden="true"></span>Critical
          </button>
          <button
            type="button"
            :class="{ 'is-active': severity === 'warning' }"
            data-testid="alerts-sev-warning"
            @click="((severity = 'warning'), applyFilters())"
          >
            <span class="sev-dot warn" aria-hidden="true"></span>Warning
          </button>
        </div>
        <button
          class="secondary-button"
          type="button"
          data-testid="alerts-sort"
          @click="((newestFirst = !newestFirst), applyFilters())"
        >
          {{ newestFirst ? 'Newest first' : 'Oldest first' }}
        </button>
      </div>

      <p v-if="notice" class="notice" role="status" data-testid="alerts-notice">{{ notice }}</p>
      <p
        v-if="actionError"
        class="form-alert is-error"
        role="alert"
        data-testid="alerts-action-error"
      >
        {{ actionError }}
      </p>

      <!-- BULK BAR -------------------------------------------------------- -->
      <div v-if="selected.size" class="bulk-bar" data-testid="alerts-bulk">
        <span>{{ selected.size }} selected</span>
        <button
          class="primary-button is-compact"
          type="button"
          :disabled="bulkBusy || !canAcknowledge"
          data-testid="alerts-bulk-ack"
          @click="bulkRun('acknowledge')"
        >
          Acknowledge
        </button>
        <button
          class="secondary-button is-compact"
          type="button"
          :disabled="bulkBusy || !canAcknowledge"
          data-testid="alerts-bulk-notify"
          @click="bulkRun('re-notify')"
        >
          Re-notify
        </button>
        <button class="secondary-button is-compact" type="button" @click="selected = new Set()">
          Clear
        </button>
      </div>

      <!-- TABLE ----------------------------------------------------------- -->
      <DataState
        :state="state"
        subject="alerts"
        skeleton="table"
        :skeleton-rows="5"
        :detail="state === 'error' ? error : undefined"
        permission="alerts.view"
        testid="alerts-state"
        :on-retry="reload"
      >
        <div class="table-wrap">
          <table data-testid="alerts-table">
            <thead>
              <tr>
                <th scope="col" class="col-check">
                  <input
                    type="checkbox"
                    :checked="allSelected"
                    :disabled="!selectableRows.length"
                    aria-label="Select all open alerts"
                    data-testid="alerts-select-all"
                    @change="toggleAll"
                  />
                </th>
                <th scope="col">Severity</th>
                <th scope="col">Condition</th>
                <th scope="col">Status</th>
                <th scope="col">Count</th>
                <th scope="col">Opened</th>
                <th scope="col">Duration</th>
                <th scope="col">Assignee</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="id(row)"
                class="selectable"
                :data-testid="`alert-row-${id(row)}`"
                tabindex="0"
                @click="openPanel(row)"
                @keydown.enter="openPanel(row)"
              >
                <td class="col-check" @click.stop>
                  <input
                    v-if="statusOf(row) === 'open'"
                    type="checkbox"
                    :checked="selected.has(id(row))"
                    :aria-label="`Select ${text(row.summary ?? row.rule_name)}`"
                    :data-testid="`alert-check-${id(row)}`"
                    @change="toggleRow(row)"
                  />
                </td>
                <td>
                  <!-- §17.1: the word carries the meaning, the colour repeats it. -->
                  <span class="sev-mark">
                    <span
                      class="sev-dot"
                      :class="toneOf(severityOf(row))"
                      aria-hidden="true"
                    ></span>
                    {{ severityOf(row) }}
                  </span>
                </td>
                <td class="cell-wrap">
                  <span class="clamp-2" :title="text(row.summary ?? row.rule_name)">{{
                    text(row.summary ?? row.rule_name)
                  }}</span>
                  <small class="row-id"
                    >{{ sourceOf(row) }}<template v-if="sourceOf(row)"> · </template
                    >{{ shortId(row) }}</small
                  >
                </td>
                <td>
                  <span class="status-badge" :class="statusOf(row) === 'open' ? 'bad' : ''">{{
                    statusOf(row)
                  }}</span>
                </td>
                <td class="num">{{ text(row.dedup_count ?? row.dedupCount, '1') }}</td>
                <!-- Relative, with the exact instant on hover. -->
                <td class="num" :title="openedAt(row)">{{ agoWhen(openedAt(row)) }}</td>
                <td class="num">{{ durationOf(row) }}</td>
                <td>{{ assigneeOf(row) }}</td>
                <td class="row-actions" @click.stop>
                  <!--
                    An inner flex row, not a flex cell.
                    `td.row-actions` resolves to `display: table-cell`
                    deliberately — flex on a `td` destroys its cell semantics
                    and the column stops aligning with its header. But inline
                    boxes align on their baselines, and a 17px chevron beside
                    two 12.5px buttons sat visibly lower and read as a second
                    row. One span inside the cell gives the three controls a
                    single flex line and one shared alignment, whatever the
                    row's height.
                  -->
                  <span class="action-cluster">
                    <template v-if="statusOf(row) === 'open' && canAcknowledge">
                      <button
                        class="primary-button is-compact"
                        type="button"
                        :disabled="busyId === id(row)"
                        :data-testid="`alert-ack-${id(row)}`"
                        @click="acknowledge(row)"
                      >
                        Acknowledge
                      </button>
                      <button
                        class="secondary-button is-compact"
                        type="button"
                        :disabled="busyId === id(row)"
                        :data-testid="`alert-notify-${id(row)}`"
                        @click="reNotify(row)"
                      >
                        Re-notify
                      </button>
                    </template>
                    <button
                      class="chevron-button"
                      type="button"
                      :aria-label="`Open ${text(row.summary ?? row.rule_name)}`"
                      :data-testid="`alert-open-${id(row)}`"
                      @click="openPanel(row)"
                    >
                      <span aria-hidden="true">›</span>
                    </button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <!-- FOOTER ---------------------------------------------------------- -->
      <!--
        The lifecycle explanation was four lines above the table. It is
        reference, not instruction — it belongs under the rows, in one line.
      -->
      <footer class="table-foot">
        <TablePager
          :shown="rows.length"
          :total="total"
          :offset="offset"
          :page-size="PAGE_SIZE"
          :busy="state === 'loading'"
          noun="alert"
          testid="alerts-pager"
          @turn="turnPage"
        />
        <p class="foot-help">
          Resolve, assign, suppress and comment from an alert's
          <RouterLink class="text-link" to="/alert-lifecycle">lifecycle</RouterLink>. For planned
          work, use a
          <RouterLink class="text-link" to="/alert-response">maintenance window</RouterLink>.
        </p>
      </footer>
    </section>

    <!-- SIDE PANEL -------------------------------------------------------- -->
    <DetailDrawer
      :open="Boolean(openAlert)"
      :title="text(openAlert?.summary ?? openAlert?.rule_name, 'Alert')"
      testid="alert-panel"
      @close="openAlert = null"
    >
      <template v-if="openAlert">
        <dl class="detail-grid">
          <dt>Severity</dt>
          <dd>{{ severityOf(openAlert) }}</dd>
          <dt>Status</dt>
          <dd>{{ statusOf(openAlert) }}</dd>
          <dt>Rule</dt>
          <dd>{{ text(openAlert.rule_name ?? openAlert.ruleName) }}</dd>
          <dt>Source</dt>
          <dd>{{ text(openAlert.source) }}</dd>
          <dt>Occurrences</dt>
          <dd>{{ text(openAlert.dedup_count ?? openAlert.dedupCount, '1') }}</dd>
          <dt>Correlation</dt>
          <dd class="mono">
            {{ text(openAlert.correlation_group ?? openAlert.correlationGroup) }}
          </dd>
          <dt>Notification</dt>
          <dd>
            {{ text(openAlert.notification_state ?? openAlert.notificationState, 'unknown') }}
          </dd>
          <dt>Suppressed until</dt>
          <dd>{{ shortWhen(openAlert.suppressed_until ?? openAlert.suppressedUntil) || '—' }}</dd>
          <dt>Assignee</dt>
          <dd>{{ assigneeOf(openAlert) }}</dd>
          <dt>Alert id</dt>
          <dd class="mono">{{ id(openAlert) }}</dd>
        </dl>

        <h3>Timeline</h3>
        <EventTimeline
          :items="
            panelTimeline.map((step) => ({
              label: step.label,
              at: shortWhen(step.at),
              detail: step.detail,
            }))
          "
        />
      </template>
      <template #footer>
        <div class="button-row">
          <button
            v-if="openAlert && statusOf(openAlert) === 'open' && canAcknowledge"
            class="primary-button"
            type="button"
            data-testid="alert-panel-ack"
            @click="acknowledge(openAlert)"
          >
            Acknowledge
          </button>
          <RouterLink
            v-if="openAlert"
            class="secondary-button"
            :to="`/alert-lifecycle?alert=${id(openAlert)}`"
            data-testid="alert-panel-lifecycle"
          >
            Open lifecycle
          </RouterLink>
        </div>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* The header's own row. The shell renders the page title; this carries the
   subtitle and the two controls that belong to the screen rather than to the
   table. */
.screen-head {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.screen-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.export-menu {
  position: relative;
}
.export-items {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
}
.export-items button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-strong);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.export-items button:hover {
  background: var(--surface-2);
}

/* Tabs and the live line share a row, divided from the filters below. */
.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.tab-row {
  display: flex;
  gap: 2px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}
.tab:hover {
  color: var(--text-strong);
}
.tab.is-active {
  color: var(--text-strong);
  border-bottom-color: var(--brand);
  font-weight: 500;
}
.tab-count {
  padding: 1px 7px;
  border-radius: 20px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.tab.is-active .tab-count {
  background: var(--brand-soft);
  color: var(--brand);
}

.live-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  color: var(--muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok, #1a7f37);
}
.live-dot.is-paused {
  background: var(--muted);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.filter-search {
  flex: 1 1 320px;
  min-width: 0;
}
.filter-search input {
  width: 100%;
}

/* A segmented control, not three checkboxes: the severities are mutually
   exclusive and the shape should say so. */
.segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface-2);
}
.segmented button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.segmented button.is-active {
  background: var(--surface);
  color: var(--text-strong);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.sev-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--muted);
  flex-shrink: 0;
}
.sev-dot.bad {
  background: var(--bad, #b42318);
}
.sev-dot.warn {
  background: var(--warn, #9a6700);
}
.sev-dot.good {
  background: var(--ok, #1a7f37);
}
.sev-mark {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  text-transform: capitalize;
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 9px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--brand);
  border-radius: var(--r-md, 8px);
  background: var(--brand-soft);
  font-size: 13px;
}

.col-check {
  width: 34px;
}
/* Acknowledge / Re-notify / chevron are one cluster and wrapped to two rows.
   `white-space: nowrap` does not stop that: `.row-actions` is a FLEX
   container with `flex-wrap: wrap`, so it is the flex line that breaks, not
   the text. The cluster means one thing — "act on this row" — so it states
   the width it needs and the columns that can wrap give it up. */
.alerts-panel td.row-actions {
  flex-wrap: nowrap;
  white-space: nowrap;
  min-width: max-content;
}
.action-cluster {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3, 8px);
  flex-wrap: nowrap;
}
.action-cluster > * {
  flex-shrink: 0;
  /* The cell resolves to `display: table-cell`, so these are inline boxes and
     each sits on its own baseline. The chevron is a 17px glyph beside two
     12.5px buttons, so it rode 6px lower than them — visibly out of line, and
     read by the layout audit as a cluster broken over two rows. Aligning the
     boxes rather than their baselines puts the three back on one line. */
  vertical-align: middle;
}
.chevron-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Stretched to the cluster's line rather than given a guessed height: a
     hard 29px against buttons that render at 31 left it 2px low, which is
     both visible and enough for the layout audit to read the cluster as two
     rows. `stretch` cannot drift when button padding changes. */
  align-self: stretch;
}
.num {
  font-variant-numeric: tabular-nums;
}
.chevron-button {
  padding: 2px 7px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}

.chevron-button:hover {
  color: var(--text-strong);
}

.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.foot-help {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  max-width: 62ch;
}
</style>
<style src="./workspace-extras.css"></style>
