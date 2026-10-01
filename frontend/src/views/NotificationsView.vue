<script setup lang="ts">
/**
 * NOTIFICATIONS — an inbox, not a register.
 *
 * See `docs/REDESIGN-ALERTS-ESCALATION-NOTIFICATIONS.md` §3 and the capture in
 * `design/redesign-2026-09/notifications-AFTER.png`.
 *
 * The screen was a five-column table — Received / Category / Title / Body /
 * Status — which is the shape of the database row and not the shape of the
 * task. Nobody scans a column of message bodies: they read a subject line,
 * glance at a preview, and check whether it is new. Printing the full body on
 * every row also put the table 327px past its panel, because one long
 * sentence sets the width for all fifty.
 *
 * FIGURES COME FROM `data`, NOT FROM THE PROSE
 * ---------------------------------------------------------------------------
 * Each report notification carries a `data` object — `periodStart`,
 * `periodEnd`, `messages`, `dlrs` — written by `report-jobs.service.ts`
 * alongside the sentence. The compact line and the reading pane read that.
 * Regexing "0 messages and 0 delivery reports between …" out of the body
 * would work until someone rewords the sentence, and then it would quietly
 * show zeros for real traffic.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import { agoWhen } from '../utils/when';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'live' | 'error' | 'empty' | 'permission-denied';

interface NotificationData {
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  messages?: number;
  dlrs?: number;
}
interface NotificationRow {
  id: string;
  category: string;
  title: string;
  body: string;
  data: NotificationData;
  readAt: string | null;
  createdAt: string;
}

const PAGE_SIZE = 100;

const rows = ref<NotificationRow[]>([]);
const state = ref<LoadState>('loading');
const error = ref('');
const actionError = ref('');
const selectedId = ref('');

const tab = ref<'unread' | 'all'>('unread');
const kind = ref<'' | 'daily' | 'weekly'>('');
const search = ref('');
const newestFirst = ref(true);
const warningDismissed = ref(false);

/* --- loading ------------------------------------------------------------- */
function normalise(raw: RecordValue): NotificationRow {
  const data = (raw.data ?? {}) as NotificationData;
  return {
    id: String(raw.id ?? ''),
    category: String(raw.category ?? ''),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    // `data` is jsonb and arrives parsed, but a row written before the column
    // existed has `{}` — every reader below treats a missing figure as absent
    // rather than as zero.
    data: data && typeof data === 'object' ? data : {},
    readAt: (raw.read_at ?? raw.readAt ?? null) as string | null,
    createdAt: String(raw.created_at ?? raw.createdAt ?? ''),
  };
}

async function load() {
  state.value = 'loading';
  error.value = '';
  try {
    const payload = await apiRequest<{ items?: RecordValue[] } | RecordValue[]>(
      `/notifications?sort=-createdAt&limit=${PAGE_SIZE}&offset=0`,
    );
    const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
    rows.value = items.map(normalise);
    state.value = rows.value.length ? 'live' : 'empty';
    // The design opens on the first notification, and opening one marks it
    // read — so the page lands with that row already read, exactly as if the
    // operator had clicked it.
    const first = visible.value[0];
    if (first && !selectedId.value) void open(first);
  } catch (reason) {
    rows.value = [];
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
    error.value = reason instanceof Error ? reason.message : 'Notifications could not be loaded.';
  }
}

/* --- derived lists ------------------------------------------------------- */
const unreadCount = computed(() => rows.value.filter((row) => !row.readAt).length);

function kindOf(row: NotificationRow): string {
  return String(row.data.periodType ?? '').toLowerCase();
}

const visible = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const list = rows.value.filter((row) => {
    // The row being READ stays in the list, even on the Unread tab.
    //
    // Opening a notification marks it read, so without this the row vanishes
    // from under the cursor the instant it is clicked — and on load, where
    // the first notification opens itself, the reading pane showed a record
    // that was nowhere in the list beside it. Every mail client keeps the
    // open message in place; the filter applies again as soon as the
    // operator moves on.
    if (row.id === selectedId.value) return true;
    if (tab.value === 'unread' && row.readAt) return false;
    if (kind.value && kindOf(row) !== kind.value) return false;
    if (needle && !`${row.title} ${row.body}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  return list.sort((a, b) => {
    const left = Date.parse(a.createdAt) || 0;
    const right = Date.parse(b.createdAt) || 0;
    return newestFirst.value ? right - left : left - right;
  });
});

/**
 * TODAY / YESTERDAY / THIS WEEK / LAST WEEK / EARLIER.
 *
 * Buckets by calendar day rather than by elapsed hours: something sent at
 * 23:50 last night is "Yesterday" at 00:10, not "2h ago · Today". That is how
 * a person reads a date, and an inbox that disagrees looks broken.
 */
const BUCKETS = ['Today', 'Yesterday', 'This week', 'Last week', 'Earlier'] as const;
function bucketOf(row: NotificationRow, now = new Date()): string {
  const at = new Date(row.createdAt);
  if (Number.isNaN(at.getTime())) return 'Earlier';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'This week';
  if (days <= 14) return 'Last week';
  return 'Earlier';
}

const grouped = computed(() => {
  const map = new Map<string, NotificationRow[]>();
  for (const row of visible.value) {
    const key = bucketOf(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  // Fixed order, and only the buckets that have something in them: an empty
  // "Last week" heading is a promise of content that is not there.
  return BUCKETS.filter((name) => map.has(name)).map((name) => ({
    name,
    items: map.get(name)!,
  }));
});

const selected = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null);

/**
 * "0 msgs · 0 DLRs · 09-29 → 09-30", or nothing.
 *
 * Returns an empty string when the figures are absent rather than printing
 * zeros: a notification from before the `data` column, or a platform notice
 * that is not a report, has no counts, and "0 msgs" would be a measurement we
 * never took.
 */
function compactLine(row: NotificationRow): string {
  const { messages, dlrs, periodStart, periodEnd } = row.data;
  if (messages === undefined && dlrs === undefined) return '';
  const short = (iso?: string) => (iso ? iso.slice(5) : '');
  const span = periodStart && periodEnd ? ` · ${short(periodStart)} → ${short(periodEnd)}` : '';
  return `${messages ?? '—'} msgs · ${dlrs ?? '—'} DLRs${span}`;
}

/**
 * The amber bar, and the run of empty reports behind it.
 *
 * Counted from the most recent report backwards, stopping at the first one
 * that carried traffic — so it says "44 consecutive", which is a fact about
 * now, rather than "44 of the last 50", which is a fact about nothing.
 */
const emptyRun = computed(() => {
  const reports = rows.value
    .filter((row) => row.data.messages !== undefined)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  let count = 0;
  for (const row of reports) {
    if ((row.data.messages ?? 0) > 0 || (row.data.dlrs ?? 0) > 0) break;
    count += 1;
  }
  const oldest = reports[count - 1];
  return { count, since: oldest?.data.periodStart ?? '' };
});
const showWarning = computed(() => !warningDismissed.value && emptyRun.value.count >= 3);

/* --- actions ------------------------------------------------------------- */
async function open(row: NotificationRow) {
  selectedId.value = row.id;
  if (row.readAt) return;
  await markRead(row);
}

async function markRead(row: NotificationRow) {
  actionError.value = '';
  // Optimistic: the unread badge and the tab count should move the moment the
  // row is clicked. Rolled back below if the write is refused.
  const previous = row.readAt;
  row.readAt = new Date().toISOString();
  try {
    await apiRequest(`/notifications/${row.id}/read`, { method: 'POST', body: '{}' });
  } catch (reason) {
    row.readAt = previous;
    actionError.value =
      reason instanceof Error ? reason.message : 'The notification could not be marked read.';
  }
}

async function markAllRead() {
  actionError.value = '';
  try {
    await apiRequest('/notifications/read-all', { method: 'POST', body: '{}' });
    await load();
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : 'Nothing could be marked read.';
  }
}

/* Switching to Unread can hide the open row; move to the first still shown. */
watch([tab, kind, search], () => {
  if (!visible.value.some((row) => row.id === selectedId.value)) {
    selectedId.value = visible.value[0]?.id ?? '';
  }
});

onMounted(load);
</script>

<template>
  <div data-testid="notifications-view">
    <header class="screen-head">
      <div class="screen-actions">
        <RouterLink class="secondary-button" to="/reports" data-testid="notif-schedule">
          Report schedule
        </RouterLink>
        <button
          class="primary-button"
          type="button"
          :disabled="!unreadCount"
          data-testid="notif-mark-all"
          @click="markAllRead"
        >
          Mark all read
        </button>
      </div>
    </header>

    <!--
      The run of empty reports, said once at the top.
      Fifty rows each reading "0 messages and 0 delivery reports" state the
      same fact fifty times and none of them say it is a RUN. This does, and
      links to the screen where the cause would be.
    -->
    <div v-if="showWarning" class="warn-bar" role="status" data-testid="notif-warning">
      <span class="warn-dot" aria-hidden="true"></span>
      <p>
        <strong>No traffic in {{ emptyRun.count }} consecutive reports.</strong>
        <template v-if="emptyRun.since">
          Every report since {{ emptyRun.since }} shows 0 messages and 0 delivery reports.
        </template>
      </p>
      <RouterLink class="text-link" to="/smsc">Check SMSC binds</RouterLink>
      <button
        class="warn-dismiss"
        type="button"
        aria-label="Dismiss"
        data-testid="notif-warning-dismiss"
        @click="warningDismissed = true"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>

    <p v-if="actionError" class="form-alert is-error" role="alert" data-testid="notif-error">
      {{ actionError }}
    </p>

    <div class="inbox">
      <!-- LIST ----------------------------------------------------------- -->
      <section class="panel inbox-list" aria-label="Notifications">
        <div class="tab-bar">
          <div class="tab-row" role="tablist" aria-label="Read state">
            <button
              type="button"
              role="tab"
              class="tab"
              :class="{ 'is-active': tab === 'unread' }"
              :aria-selected="tab === 'unread'"
              data-testid="notif-tab-unread"
              @click="tab = 'unread'"
            >
              Unread <span class="tab-count">{{ unreadCount }}</span>
            </button>
            <button
              type="button"
              role="tab"
              class="tab"
              :class="{ 'is-active': tab === 'all' }"
              :aria-selected="tab === 'all'"
              data-testid="notif-tab-all"
              @click="tab = 'all'"
            >
              All <span class="tab-count">{{ rows.length }}</span>
            </button>
          </div>
          <div class="segmented" role="group" aria-label="Report kind">
            <button
              type="button"
              :class="{ 'is-active': kind === '' }"
              data-testid="notif-kind-all"
              @click="kind = ''"
            >
              All reports
            </button>
            <button
              type="button"
              :class="{ 'is-active': kind === 'daily' }"
              data-testid="notif-kind-daily"
              @click="kind = 'daily'"
            >
              Daily
            </button>
            <button
              type="button"
              :class="{ 'is-active': kind === 'weekly' }"
              data-testid="notif-kind-weekly"
              @click="kind = 'weekly'"
            >
              Weekly
            </button>
          </div>
        </div>

        <div class="filter-row">
          <label class="filter-search">
            <span class="sr-only">Search notifications</span>
            <input
              v-model="search"
              type="search"
              placeholder="Search title or body"
              data-testid="notif-search"
            />
          </label>
          <button
            class="secondary-button"
            type="button"
            data-testid="notif-sort"
            @click="newestFirst = !newestFirst"
          >
            {{ newestFirst ? 'Newest first' : 'Oldest first' }}
          </button>
        </div>

        <DataState
          :state="state"
          subject="notifications"
          skeleton="text"
          :detail="state === 'error' ? error : undefined"
          testid="notif-state"
          :on-retry="load"
        >
          <div class="inbox-scroll">
            <template v-for="group in grouped" :key="group.name">
              <p class="group-head">
                <span>{{ group.name }}</span>
                <span class="group-count">{{ group.items.length }}</span>
              </p>
              <button
                v-for="row in group.items"
                :key="row.id"
                type="button"
                class="inbox-row"
                :class="{ 'is-selected': row.id === selectedId, 'is-unread': !row.readAt }"
                :data-testid="`notif-row-${row.id}`"
                @click="open(row)"
              >
                <span class="unread-dot" aria-hidden="true"></span>
                <span class="inbox-main">
                  <span class="inbox-title">
                    {{ row.title }}
                    <span v-if="kindOf(row) === 'weekly'" class="chip">Weekly</span>
                  </span>
                  <!--
                    One line, truncated. The full body is in the reading pane;
                    repeating it per row is what made this list a wall of the
                    same sentence.
                  -->
                  <span v-if="compactLine(row)" class="inbox-compact mono">{{
                    compactLine(row)
                  }}</span>
                </span>
                <span class="inbox-side">
                  <span class="inbox-when">{{ agoWhen(row.createdAt) }}</span>
                  <span
                    v-if="!row.readAt"
                    class="text-link"
                    role="button"
                    tabindex="0"
                    :data-testid="`notif-read-${row.id}`"
                    @click.stop="markRead(row)"
                    @keydown.enter.stop="markRead(row)"
                    >Mark read</span
                  >
                </span>
              </button>
            </template>
            <p v-if="!visible.length && state === 'live'" class="inbox-empty">
              Nothing matches this filter.
            </p>
          </div>
        </DataState>
      </section>

      <!-- READING PANE ---------------------------------------------------- -->
      <section class="panel inbox-read" aria-label="Notification" data-testid="notif-reader">
        <template v-if="selected">
          <p class="read-meta">
            <span class="chip">{{ selected.category }}</span>
            <span class="mono">{{ selected.createdAt }}</span>
          </p>
          <h2>{{ selected.title }}</h2>
          <p v-if="selected.data.periodStart" class="read-period">
            Period {{ selected.data.periodStart }} → {{ selected.data.periodEnd }}
          </p>

          <!-- The two figures the report is about, as figures. -->
          <div v-if="selected.data.messages !== undefined" class="read-figures">
            <div>
              <b>{{ selected.data.messages }}</b>
              <span>Messages</span>
            </div>
            <div>
              <b>{{ selected.data.dlrs ?? '—' }}</b>
              <span>Delivery reports</span>
            </div>
          </div>

          <p class="read-body">{{ selected.body }}</p>

          <div class="button-row">
            <RouterLink class="primary-button" to="/reports" data-testid="notif-open-reports">
              Open in Reports
            </RouterLink>
            <button
              v-if="!selected.readAt"
              class="secondary-button"
              type="button"
              data-testid="notif-reader-read"
              @click="markRead(selected)"
            >
              Mark read
            </button>
          </div>
        </template>
        <p v-else class="inbox-empty">Select a notification to read it.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.screen-head {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.screen-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.warn-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--warn, #9a6700);
  border-radius: var(--r-md, 8px);
  background: var(--warn-soft, #fbf0d8);
  font-size: 13px;
}
.warn-bar p {
  margin: 0;
  flex: 1 1 320px;
  min-width: 0;
}
.warn-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--warn, #9a6700);
  flex-shrink: 0;
}
.warn-dismiss {
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

/* Two panes. On a narrow screen the reader drops BELOW the list rather than
   squeezing it — a 200px-wide reading pane is not a reading pane. */
.inbox {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 1100px) {
  .inbox {
    grid-template-columns: 1fr;
  }
}

.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}
.tab-row {
  display: flex;
  gap: 2px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 13px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
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
/* The kind filter wraps UNDER the tabs when there is no room, rather than
   clipping "Weekly" off the right edge. */
.segmented {
  display: inline-flex;
  padding: 2px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface-2);
}
.segmented button {
  padding: 5px 11px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.segmented button.is-active {
  background: var(--surface);
  color: var(--text-strong);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.filter-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.filter-search {
  flex: 1 1 220px;
  min-width: 0;
}
.filter-search input {
  width: 100%;
}

/* The list scrolls inside its own pane, so the reading pane beside it stays
   where it is as the operator works down the list. */
.inbox-scroll {
  max-height: 620px;
  overflow-y: auto;
  margin: 0 -4px;
  padding: 0 4px;
}
.group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding: 6px 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.group-count {
  font-variant-numeric: tabular-nums;
}

.inbox-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid transparent;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.inbox-row:hover {
  background: var(--surface-2);
}
.inbox-row.is-selected {
  border-left-color: var(--brand);
  background: var(--brand-soft);
}
.unread-dot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}
.inbox-row.is-unread .unread-dot {
  background: var(--brand);
}
.inbox-main {
  flex: 1 1 auto;
  min-width: 0;
}
.inbox-title {
  display: block;
  color: var(--text-strong);
  font-size: 13.5px;
}
.inbox-row.is-unread .inbox-title {
  font-weight: 600;
}
.inbox-compact {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.inbox-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
  font-size: 12px;
}
.inbox-when {
  color: var(--muted);
  white-space: nowrap;
}
.inbox-empty {
  padding: 28px 8px;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
}

.inbox-read h2 {
  margin: 6px 0 2px;
}
.read-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.read-period {
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 13px;
}
.read-figures {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--border);
  overflow: hidden;
}
.read-figures div {
  background: var(--surface);
  padding: 14px 16px;
}
.read-figures b {
  display: block;
  font-size: 28px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.read-figures span {
  color: var(--muted);
  font-size: 12.5px;
}
.read-body {
  margin: 0 0 16px;
  font-size: 13.5px;
  max-width: 62ch;
}
</style>
<style src="./workspace-extras.css"></style>
