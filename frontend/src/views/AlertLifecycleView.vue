<script setup lang="ts">
/**
 * ALERT LIFECYCLE — the incident desk.
 *
 * Rebuilt 2026-10-06 to CONSOLE_DESIGN_SPEC §1. The columns had already been
 * grouped (13 → 7) but the screen had never been given the house shape: it
 * opened on a seven-control toolbar, its status filter was a dropdown with no
 * counts, and its detail sheet put five badges and nine fields above the
 * actions an operator came to use.
 *
 * What changed, and why:
 *
 *   - **Tabs carrying whole-table counts.** `GET /alerts/summary` tallies the
 *     table through the same tenant-scoped connection as the list, so "Open
 *     42" is 42 open alerts and not 42 rows on this page. The tab sets the
 *     server-side status filter, so the count and the filter agree. If the
 *     tally fails the tabs still work and simply carry no number — a wrong
 *     count is worse than none.
 *   - **A verdict before the register**, naming the oldest unacknowledged
 *     alert, because that is the question an operator opens this screen with.
 *   - **The live line** replaces `Auto refresh [On] Every [30s] (Refresh)`
 *     plus a "Last updated" caption — four controls stating one idea.
 *   - **The sheet leads with the actions.** Acknowledge / Resolve / Reopen /
 *     Close were below five badges, nine fields and two banners.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import { canAccess, session } from '../stores/session';
import AppIcon from '../components/AppIcon.vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import EventTimeline from '../components/EventTimeline.vue';
import TablePager from '../components/TablePager.vue';
import {
  alertAcknowledgement,
  alertCategory,
  alertDuration,
  alertObject,
  alertOccurrences,
  alertStarted,
} from '../utils/alerts';
import { agoWhen, shortWhen, spanOf } from '../utils/when';

type RecordValue = Record<string, unknown>;
type LoadState = 'idle' | 'loading' | 'ok' | 'error';
type Transition = 'acknowledge' | 'resolve' | 'assign' | 'suppress' | 'reopen' | 'close';

interface AlertRecord {
  id?: string;
  status?: string;
  severity?: string;
  summary?: string;
  assignedTo?: string | null;
  assignedToUsername?: string | null;
  assignedAt?: string | null;
  suppressedUntil?: string | null;
  suppressedReason?: string | null;
  notificationState?: string;
  notificationDetail?: RecordValue;
  openedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  reopenCount?: number;
  escalatedAt?: string | null;
  previousSeverity?: string | null;
  dedupCount?: number;
  correlationGroup?: string | null;
  details?: RecordValue;
}

interface AlertComment {
  id?: string;
  authorUsername?: string | null;
  body?: string;
  kind?: 'comment' | 'transition';
  createdAt?: string;
}

/**
 * Mirrors ALERT_TRANSITIONS in alert-lifecycle.repository.ts. Kept as data for
 * the same reason the backend does: a button offered for a transition the API
 * would refuse is a 409 the operator did not need to see.
 */
const ALERT_TRANSITIONS: Record<Transition, readonly string[]> = {
  acknowledge: ['open', 'suppressed'],
  resolve: ['open', 'acknowledged', 'suppressed'],
  assign: ['open', 'acknowledged', 'suppressed'],
  suppress: ['open', 'acknowledged', 'suppressed'],
  reopen: ['acknowledged', 'suppressed', 'resolved', 'closed'],
  close: ['open', 'acknowledged', 'suppressed', 'resolved'],
};
const SUPPRESS_CHOICES = [15, 30, 60, 120, 240, 480, 1440];

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}
function severityTone(value: unknown) {
  const severity = String(value ?? '').toLowerCase();
  if (severity === 'critical') return 'bad';
  if (severity === 'warning') return 'warn';
  return 'good';
}
function statusTone(value: unknown) {
  const status = String(value ?? '').toLowerCase();
  if (status === 'open') return 'bad';
  if (status === 'acknowledged' || status === 'suppressed') return 'warn';
  if (status === 'resolved' || status === 'closed') return 'good';
  return '';
}
/**
 * `notification_state` is the difference between "an alert fired" and "somebody
 * was told". `undeliverable` and `pending` are the states that mean nobody has
 * heard about it yet.
 */
function notificationTone(value: unknown) {
  const state = String(value ?? '').toLowerCase();
  if (state === 'delivered' || state === 'sent') return 'good';
  if (state === 'undeliverable' || state === 'failed') return 'bad';
  if (state === 'pending') return 'warn';
  return '';
}

// Reads are alerts.view (the route guard). Operator actions need
// alerts.acknowledge; suppression — which stops anyone being paged — needs
// system.manage, exactly as AlertLifecycleController declares.
const canAct = computed(() => canAccess(session.value, 'alerts.acknowledge'));
const canSuppress = computed(() => canAccess(session.value, 'system.manage'));
const canListUsers = computed(() => canAccess(session.value, 'users.view'));

// --- Alert index --------------------------------------------------------------
const alerts = ref<RecordValue[]>([]);
const listState = ref<LoadState>('loading');
const listError = ref('');
const listMissing = ref(false);
const listTotal = ref(0);
/** Opens on Open, matching the tab that is active on arrival. */
const statusFilter = ref('open');
const severityFilter = ref('');
const searchQuery = ref('');
const listLimit = ref(50);
/**
 * The offset was hard-coded to 0, so the screen fetched the newest 50 alerts
 * and there was no way to reach the 51st. `GET /alerts` reports a `total` and
 * accepts an offset — both were already read and sent, one of them frozen.
 */
const listOffset = ref(0);

const SEVERITY_CHOICES = ['info', 'warning', 'critical'] as const;

/* --- the whole-table tally -----------------------------------------------
 *
 * The same endpoint the Alerts register uses. Every figure here is measured
 * across the table, never derived from `alerts` — a count taken from the
 * loaded page says "open 50" on a register paginated at fifty while three
 * hundred are open, and a wrong count is worse than no count because it looks
 * like an answer.
 */
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
const summary = ref<AlertSummary | null>(null);

/**
 * A deployment without the tally endpoint answers 404, and an older one
 * answers 200 with something that is not a tally. Both have to end up as
 * `null` rather than as an object whose `byStatus` is undefined — the figures
 * are read in six places and a half-populated summary would throw in the
 * middle of a render.
 */
function asSummary(payload: unknown): AlertSummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Partial<AlertSummary>;
  if (typeof value.total !== 'number' || !value.byStatus || typeof value.byStatus !== 'object')
    return null;
  return {
    total: value.total,
    byStatus: value.byStatus,
    bySeverity: value.bySeverity ?? {},
    openBySeverity: value.openBySeverity ?? {},
    unacknowledged: value.unacknowledged ?? 0,
    oldestOpenedAt: value.oldestOpenedAt ?? null,
    resolved30d: value.resolved30d ?? 0,
    medianResolveSeconds: value.medianResolveSeconds ?? null,
  };
}

async function loadSummary() {
  try {
    summary.value = asSummary(await apiRequest<unknown>('/alerts/summary'));
  } catch {
    // Decoration over a register that loaded. A failed tally must not raise a
    // banner and must not be filled in with zeros, which would report an
    // empty system.
    summary.value = null;
  }
}

/**
 * The status filter as tabs rather than a dropdown.
 *
 * Each tab sets the SERVER-SIDE filter, so the number on the tab and the rows
 * below it are measuring the same thing. A client-side tab over a paginated
 * register would not be.
 */
const TABS = [
  { id: 'open', label: 'Open', statuses: ['open'] },
  { id: 'acknowledged', label: 'Acknowledged', statuses: ['acknowledged'] },
  { id: 'suppressed', label: 'Suppressed', statuses: ['suppressed'] },
  { id: 'resolved', label: 'Resolved', statuses: ['resolved'] },
  { id: 'closed', label: 'Closed', statuses: ['closed'] },
  { id: 'all', label: 'All', statuses: [] },
] as const;
type TabId = (typeof TABS)[number]['id'];
/** Opens on Open: the tab that matters, not the one that is widest. */
const activeTab = ref<TabId>('open');

function tabCount(tab: TabId): number | null {
  const by = summary.value?.byStatus;
  if (!by) return null;
  if (tab === 'all') return summary.value?.total ?? 0;
  const definition = TABS.find((entry) => entry.id === tab);
  return (definition?.statuses ?? []).reduce((sum, status) => sum + (by[status] ?? 0), 0);
}
function chooseTab(tab: TabId) {
  activeTab.value = tab;
  statusFilter.value = TABS.find((entry) => entry.id === tab)?.statuses[0] ?? '';
  applyAlertFilters();
}

/* --- the verdict ---------------------------------------------------------
 * §1 band one: the question an operator arrives with, answered before the
 * rows. Unacknowledged beats open — an open alert somebody has taken is being
 * worked, and an open alert nobody has taken is the one that gets missed. */
const verdictTone = computed(() => {
  if (!summary.value) return 'unknown';
  if (summary.value.unacknowledged > 0) return 'bad';
  if ((summary.value.byStatus.open ?? 0) > 0) return 'warn';
  return 'good';
});
const verdictWord = computed(
  () =>
    ({ good: 'Clear', warn: 'In hand', bad: 'Unclaimed', unknown: 'Not counted' })[
      verdictTone.value
    ],
);
const verdictSentence = computed(() => {
  const tally = summary.value;
  if (!tally)
    return 'The whole-table tally could not be read, so the counts below are this page only.';
  if (tally.unacknowledged > 0)
    return tally.oldestOpenedAt
      ? `${tally.unacknowledged} alert(s) have been raised and nobody has taken them. The oldest opened ${agoWhen(tally.oldestOpenedAt)}.`
      : `${tally.unacknowledged} alert(s) have been raised and nobody has taken them.`;
  if ((tally.byStatus.open ?? 0) > 0)
    return `${tally.byStatus.open} alert(s) are open and every one of them has been acknowledged.`;
  return 'Nothing is open. Every alert raised has been acknowledged and closed out.';
});
const medianResolve = computed(() => {
  const value = summary.value?.medianResolveSeconds;
  return value === null || value === undefined ? null : spanOf(value);
});
/** Open counts by severity, biggest first, for the caption under the figure. */
const openSplit = computed(() =>
  Object.entries(summary.value?.openBySeverity ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]),
);

/** Any filter change restarts paging: page 3 of the previous filter is meaningless. */
function applyAlertFilters() {
  listOffset.value = 0;
  void loadAlerts();
}
function turnAlertPage(direction: number) {
  const next = listOffset.value + direction * listLimit.value;
  if (next < 0 || next >= listTotal.value) return;
  listOffset.value = next;
  void loadAlerts();
}

async function loadAlerts() {
  listState.value = listState.value === 'ok' ? 'ok' : 'loading';
  listMissing.value = false;
  const params = new URLSearchParams();
  params.set('limit', String(listLimit.value));
  params.set('offset', String(listOffset.value));
  params.set('sort', '-openedAt');
  if (statusFilter.value) params.set('filter.status', statusFilter.value);
  if (severityFilter.value) params.set('filter.severity', severityFilter.value);
  if (searchQuery.value.trim()) params.set('search', searchQuery.value.trim());
  try {
    const payload = await apiRequest<unknown>(`/alerts?${params.toString()}`);
    alerts.value = asItems(payload);
    listTotal.value =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Number((payload as RecordValue).total ?? alerts.value.length)
        : alerts.value.length;
    listError.value = '';
    listState.value = 'ok';
  } catch (reason) {
    alerts.value = [];
    listTotal.value = 0;
    listMissing.value = isMissing(reason);
    listError.value = messageFrom(reason, 'Alerts could not be loaded.');
    listState.value = 'error';
  }
  // The tally rides with the list so the tabs and the rows are never a poll
  // apart — a tab reading 41 above a register that has just dropped to 40 is
  // the kind of disagreement an operator spends ten minutes on.
  await loadSummary();
  lastReadStamp.value = new Date();
  sinceRead.value = 0;
}

/* --- the live line -------------------------------------------------------
   "● Live · updated 3s ago · every 30s [Pause] [Refresh]" in place of four
   labelled controls stating the same idea. */
const lastReadStamp = ref<Date | null>(null);
const sinceRead = ref(0);
let tickTimer: ReturnType<typeof setInterval> | undefined;
const refreshedLabel = computed(() =>
  lastReadStamp.value ? `updated ${sinceRead.value}s ago` : 'not yet read',
);

/**
 * The alerts index selects `a.*`, so the lifecycle columns arrive in their
 * snake_case database form while `GET /alerts/:id/lifecycle` publishes camelCase.
 * Both are read rather than guessing which endpoint a row came from.
 */
function rowAssignee(row: RecordValue): string {
  return text(row.assigned_to_username ?? row.assignedToUsername ?? row.assigned_to, '');
}
function rowSuppressedUntil(row: RecordValue): string {
  return text(row.suppressed_until ?? row.suppressedUntil, '');
}
function rowNotificationState(row: RecordValue): string {
  return text(row.notification_state ?? row.notificationState, 'unknown');
}
function rowId(row: RecordValue): string {
  return text(row.id, '');
}

// --- Selected alert -----------------------------------------------------------
const selectedId = ref('');
const record = ref<AlertRecord | null>(null);
const detailState = ref<LoadState>('idle');
const detailError = ref('');
const comments = ref<AlertComment[]>([]);
const commentsState = ref<LoadState>('idle');
const commentsError = ref('');
const actionError = ref('');
const actionNotice = ref('');
const actionBusy = ref(false);

const assignee = ref('');
const suppressMinutes = ref(60);
const actionReason = ref('');
const commentDraft = ref('');
const userOptions = ref<string[]>([]);

const status = computed(() => String(record.value?.status ?? '').toLowerCase());
function allowed(transition: Transition): boolean {
  return ALERT_TRANSITIONS[transition].includes(status.value);
}
/** Explains a disabled button rather than leaving it inert and unexplained. */
function blockedReason(transition: Transition): string {
  if (!record.value) return '';
  if (allowed(transition)) return '';
  return `Cannot ${transition} an alert that is ${status.value || 'in an unknown state'} (allowed from: ${ALERT_TRANSITIONS[
    transition
  ].join(', ')}).`;
}

const suppressionActive = computed(() => {
  const until = Date.parse(String(record.value?.suppressedUntil ?? ''));
  return Number.isFinite(until) && until > Date.now();
});

/* --- ESCALATION STEPS ---------------------------------------------------------
 *
 * `GET /monitoring/escalation/alerts/:id` returns each escalation the policy
 * engine ran for this alert: which policy, which step, whether it succeeded.
 *
 * Folded into the incident timeline rather than given its own table, because it
 * is part of the same story. "Opened 09:00, escalated to on-call 09:05,
 * acknowledged 09:07" reads as a sequence; the same three facts in three panels
 * has to be reassembled by the reader every time.
 */
const escalations = ref<RecordValue[]>([]);

async function loadEscalations(id: string) {
  try {
    const rows = await apiRequest<unknown>(`/monitoring/escalation/alerts/${id}`);
    escalations.value = asItems(rows);
  } catch {
    // Needs alerts.view, which this screen already has — but a deployment
    // without the escalation module answers 404, and that is not an error
    // worth showing beside a lifecycle that loaded fine.
    escalations.value = [];
  }
}

async function loadDetail(id: string) {
  detailState.value = 'loading';
  detailError.value = '';
  try {
    record.value = await apiRequest<AlertRecord>(`/alerts/${id}/lifecycle`);
    detailState.value = 'ok';
  } catch (reason) {
    record.value = null;
    detailError.value = messageFrom(reason, 'The alert lifecycle record could not be loaded.');
    detailState.value = 'error';
  }
}

async function loadComments(id: string) {
  commentsState.value = 'loading';
  commentsError.value = '';
  try {
    comments.value = asItems(await apiRequest<unknown>(`/alerts/${id}/comments`));
    commentsState.value = 'ok';
  } catch (reason) {
    comments.value = [];
    commentsError.value = messageFrom(reason, 'The alert thread could not be loaded.');
    commentsState.value = 'error';
  }
}

async function selectAlert(id: string) {
  if (!id) return;
  selectedId.value = id;
  actionError.value = '';
  actionNotice.value = '';
  assignee.value = '';
  actionReason.value = '';
  commentDraft.value = '';
  await Promise.all([loadDetail(id), loadComments(id), loadEscalations(id)]);
  if (canListUsers.value && !userOptions.value.length) void loadUserOptions();
}

function closeDetail() {
  selectedId.value = '';
  record.value = null;
  comments.value = [];
  escalations.value = [];
  detailState.value = 'idle';
  commentsState.value = 'idle';
}

async function loadUserOptions() {
  try {
    userOptions.value = asItems(await apiRequest<unknown>('/users?limit=500&offset=0'))
      .map((row) => text(row.username, ''))
      .filter((name) => name && name !== '—');
  } catch {
    // users.view is a separate permission; assignment still works by typing a
    // username, so an unavailable list is not an error worth shouting about.
    userOptions.value = [];
  }
}

/**
 * Every lifecycle POST goes through here so a 409 is always surfaced verbatim.
 * The API names the offending state ("Cannot resolve an alert that is closed
 * (allowed from: …)"); swallowing that and showing "the action failed" would
 * throw away the only useful part of the response.
 */
async function runTransition(transition: Transition, body: RecordValue = {}) {
  if (!selectedId.value) return;
  if (transition === 'suppress' ? !canSuppress.value : !canAct.value) return;
  actionBusy.value = true;
  actionError.value = '';
  actionNotice.value = '';
  try {
    record.value = await apiRequest<AlertRecord>(`/alerts/${selectedId.value}/${transition}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    detailState.value = 'ok';
    actionNotice.value = `Alert ${transition}d — it is now ${text(record.value?.status)}.`;
    actionReason.value = '';
    await Promise.all([loadComments(selectedId.value), loadAlerts()]);
  } catch (reason) {
    actionError.value =
      reason instanceof ApiError && reason.status === 409
        ? reason.message
        : messageFrom(reason, `The alert could not be ${transition}d.`);
  } finally {
    actionBusy.value = false;
  }
}

function reasonBody(): RecordValue {
  return actionReason.value.trim() ? { reason: actionReason.value.trim() } : {};
}
function noteBody(): RecordValue {
  return actionReason.value.trim() ? { note: actionReason.value.trim() } : {};
}

function acknowledgeAlert() {
  return runTransition('acknowledge', noteBody());
}
function resolveAlert() {
  return runTransition('resolve', noteBody());
}
function assignAlert() {
  if (!assignee.value.trim()) {
    actionError.value = 'Enter the username to assign this alert to.';
    return;
  }
  return runTransition('assign', { assignee: assignee.value.trim() });
}
function suppressAlert() {
  if (!canSuppress.value) return;
  if (
    !window.confirm(
      `Suppress this alert for ${suppressMinutes.value} minute(s)?\n\nIt stays visible in the alert index and the correlation summary — only escalation stops. It returns to open automatically once the window lapses.`,
    )
  )
    return;
  return runTransition('suppress', {
    minutes: suppressMinutes.value,
    ...reasonBody(),
  });
}
function reopenAlert() {
  return runTransition('reopen', reasonBody());
}
function closeAlert() {
  if (
    !window.confirm(
      'Close this alert?\n\nThis is the terminal administrative state. It can still be reopened, which starts a fresh notification cycle.',
    )
  )
    return;
  return runTransition('close', reasonBody());
}

async function addComment() {
  if (!canAct.value || !selectedId.value) return;
  const body = commentDraft.value.trim();
  if (!body) return;
  actionBusy.value = true;
  actionError.value = '';
  try {
    await apiRequest(`/alerts/${selectedId.value}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    commentDraft.value = '';
    await loadComments(selectedId.value);
  } catch (reason) {
    actionError.value = messageFrom(reason, 'The comment could not be added.');
  } finally {
    actionBusy.value = false;
  }
}

const operatorComments = computed(() =>
  comments.value.filter((entry) => entry.kind !== 'transition'),
);
const transitionEntries = computed(() =>
  comments.value.filter((entry) => entry.kind === 'transition'),
);

/**
 * The incident as a Timeline (§13's "correlated evidence", the kit's Timeline).
 *
 * Assembled from four recorded sources — the alert's own open/escalate/resolve/
 * close stamps and the comment thread — rather than from a single table, because
 * no single table holds the whole incident. Everything here was written by the
 * platform or by an operator; nothing is inferred.
 *
 * The last step is the one that matters most and is the reason this is a
 * Timeline and not a list: an open, unacknowledged alert gets a `missing` step
 * for the acknowledgement. A hollow dashed dot says "this was expected and has
 * not happened". Omitting the step entirely would leave the timeline looking
 * complete, which is exactly the alert that gets missed.
 */
const incidentTimeline = computed(() => {
  const clock = (value: unknown): string => {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
  };
  const at = (value: unknown): number =>
    Number.isFinite(Date.parse(String(value ?? ''))) ? Date.parse(String(value)) : 0;

  const items: Array<{
    order: number;
    at: string;
    label: string;
    detail?: string;
    state: 'ok' | 'warn' | 'error' | 'missing' | 'info';
  }> = [];
  const alert = record.value;
  if (!alert) return [];

  if (alert.openedAt)
    items.push({
      order: at(alert.openedAt),
      at: clock(alert.openedAt),
      label: 'Alert opened',
      detail: alert.summary,
      state: String(alert.severity).toLowerCase() === 'critical' ? 'error' : 'warn',
    });

  for (const entry of comments.value)
    items.push({
      order: at(entry.createdAt),
      at: clock(entry.createdAt),
      label:
        entry.kind === 'transition'
          ? 'State change'
          : `Comment by ${entry.authorUsername ?? 'an operator'}`,
      detail: entry.body,
      state: entry.kind === 'transition' ? 'info' : 'ok',
    });

  if (alert.escalatedAt)
    items.push({
      order: at(alert.escalatedAt),
      at: clock(alert.escalatedAt),
      label: 'Escalated',
      detail: alert.previousSeverity
        ? `Severity raised from ${alert.previousSeverity} to ${alert.severity}.`
        : undefined,
      state: 'error',
    });

  // Each step the policy engine ran, with whether it actually reached anybody.
  // A failed step is drawn as an error rather than omitted: an escalation that
  // did not deliver is the most important thing on this timeline.
  for (const step of escalations.value) {
    const escalatedAt = step.escalated_at ?? step.escalatedAt;
    const status = String(step.status ?? '').toLowerCase();
    items.push({
      order: at(escalatedAt),
      at: clock(escalatedAt),
      label: `Escalation step ${text(step.step_index ?? step.stepIndex, '?')}`,
      detail: [text(step.policy_name ?? step.policyName, 'policy not named'), text(step.detail, '')]
        .filter((part) => part && part !== '—')
        .join(' — '),
      state: status === 'failed' || status === 'undeliverable' ? 'error' : 'info',
    });
  }

  if (alert.resolvedAt)
    items.push({
      order: at(alert.resolvedAt),
      at: clock(alert.resolvedAt),
      label: 'Recovered',
      detail: 'The recovery condition was met and the platform closed the condition itself.',
      state: 'ok',
    });

  if (alert.closedAt)
    items.push({
      order: at(alert.closedAt),
      at: clock(alert.closedAt),
      label: 'Closed',
      detail: 'An operator ended this incident. Recovery detection no longer reopens it.',
      state: 'ok',
    });

  items.sort((a, b) => a.order - b.order);

  const open = ['open', 'suppressed'].includes(status.value);
  const acknowledged = comments.value.some(
    (entry) => entry.kind === 'transition' && /acknowledg/i.test(String(entry.body ?? '')),
  );
  if (open && !acknowledged)
    items.push({
      order: Number.MAX_SAFE_INTEGER,
      at: 'not yet',
      label: 'Acknowledgement',
      detail: 'Nobody has taken this incident. It is open and unclaimed.',
      state: 'missing',
    });

  return items.map(({ order: _order, ...item }) => item);
});

// --- Auto refresh --------------------------------------------------------------
// The index only. The open detail is deliberately not polled: an operator
// typing a note must not have the record swapped underneath them.
// The interval is no longer a control: the live line states it, and a second
// dropdown for how often a screen re-reads itself was one of the four controls
// that band replaced.
const { autoRefresh, intervalSeconds, refreshing, refreshNow } = useLiveResource(
  () => loadAlerts(),
  { intervalSeconds: 30, immediate: false, pauseWhen: () => actionBusy.value },
);

// `/alert-lifecycle?alert=<id>` opens straight onto one alert — the link the
// Alerts grid uses, so triage does not have to re-find the row here.
const route = useRoute();

onMounted(() => {
  void loadAlerts();
  tickTimer = setInterval(() => {
    if (lastReadStamp.value)
      sinceRead.value = Math.floor((Date.now() - lastReadStamp.value.getTime()) / 1000);
  }, 1000);
  const deepLink = String(route.query.alert ?? '').trim();
  if (deepLink) void selectAlert(deepLink);
});
onBeforeUnmount(() => clearInterval(tickTimer));
</script>

<template>
  <div data-testid="alert-lifecycle-view">
    <p v-if="!canAct" class="source-note" data-testid="lifecycle-readonly">
      You can review alerts and their history. Acknowledging, resolving, assigning, reopening,
      closing and commenting require the alerts.acknowledge permission.
    </p>

    <!-- HEADER BAND ------------------------------------------------------------ -->
    <header class="screen-head">
      <div class="screen-actions">
        <RouterLink class="secondary-button" to="/alerts" data-testid="lifecycle-open-alerts">
          Alerts register
        </RouterLink>
        <RouterLink class="secondary-button" to="/alert-response">
          Escalation &amp; maintenance
        </RouterLink>
      </div>
    </header>

    <!-- THE VERDICT -------------------------------------------------------------
      Unacknowledged beats open: an open alert somebody has taken is being
      worked, and an open alert nobody has taken is the one that gets missed.
    -->
    <section class="status-line" :class="`is-${verdictTone}`" data-testid="lifecycle-status-line">
      <span class="status-chip">
        <span class="status-dot" aria-hidden="true"></span>{{ verdictWord }}
      </span>
      <p aria-live="polite">{{ verdictSentence }}</p>
      <button
        v-if="summary && summary.unacknowledged > 0 && activeTab !== 'open'"
        class="secondary-button is-compact"
        type="button"
        data-testid="lifecycle-show-open"
        @click="chooseTab('open')"
      >
        Show open
      </button>
    </section>

    <!-- SUMMARY STRIP -----------------------------------------------------------
      Four measured figures from `GET /alerts/summary`. The strip renders
      nothing at all when the tally fails: zeros would report an empty system.
    -->
    <section v-if="summary" class="stat-strip" data-testid="lifecycle-strip">
      <article>
        <p class="stat-label">Open</p>
        <b class="stat-figure" data-testid="lifecycle-stat-open">{{ summary.byStatus.open ?? 0 }}</b>
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
        <p class="stat-label">Unclaimed</p>
        <b class="stat-figure" data-testid="lifecycle-stat-unacked">{{ summary.unacknowledged }}</b>
        <p class="stat-caption">
          <template v-if="summary.oldestOpenedAt">
            Oldest opened {{ agoWhen(summary.oldestOpenedAt) }}
          </template>
          <template v-else>nobody is waiting</template>
        </p>
      </article>
      <article>
        <p class="stat-label">Resolved · 30 days</p>
        <b class="stat-figure" data-testid="lifecycle-stat-resolved">{{ summary.resolved30d }}</b>
        <p class="stat-caption">Closed out in the last 30 days</p>
      </article>
      <article>
        <p class="stat-label">Median time to resolve</p>
        <!-- `not measured`, never `0m`: a zero would read as instant
             resolution rather than as nothing to measure. -->
        <b class="stat-figure" data-testid="lifecycle-stat-median">{{
          medianResolve ?? 'not measured'
        }}</b>
        <p class="stat-caption">Across resolved alerts</p>
      </article>
    </section>

    <!-- Alert index ------------------------------------------------------------ -->
    <section class="panel" data-testid="lifecycle-index-panel" aria-label="Alerts">
      <!-- TABS + LIVE LINE ------------------------------------------------------
        The tab sets the server-side status filter, so the count on the tab and
        the rows beneath it are measuring the same thing.
      -->
      <div class="tab-bar">
        <div class="tab-row" role="group" aria-label="Alert status">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="tab"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-pressed="activeTab === tab.id"
            :data-testid="`lifecycle-tab-${tab.id}`"
            @click="chooseTab(tab.id)"
          >
            {{ tab.label }}
            <span v-if="tabCount(tab.id) !== null" class="tab-count">{{ tabCount(tab.id) }}</span>
          </button>
        </div>
        <div class="live-line" data-testid="lifecycle-live">
          <span class="live-dot" :class="{ 'is-paused': !autoRefresh }" aria-hidden="true"></span>
          <span
            >{{ autoRefresh ? 'Live' : 'Paused' }} · {{ refreshedLabel }} · every
            {{ intervalSeconds }}s</span
          >
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="lifecycle-auto-toggle"
            @click="autoRefresh = !autoRefresh"
          >
            {{ autoRefresh ? 'Pause' : 'Resume' }}
          </button>
          <button
            class="secondary-button is-compact"
            data-testid="lifecycle-refresh"
            :disabled="refreshing"
            @click="refreshNow(true)"
          >
            <AppIcon name="refresh" :size="14" />{{ refreshing ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- FILTER ROW -------------------------------------------------------------
        Severity is a segmented control, not a dropdown: four mutually
        exclusive choices that fit on one line should not cost a click to see.
      -->
      <div class="filter-row">
        <label class="filter-search">
          <span class="sr-only">Search alerts</span>
          <input
            v-model="searchQuery"
            data-testid="lifecycle-search"
            type="search"
            placeholder="Summary, details, or rule name"
            @keyup.enter="applyAlertFilters"
          />
        </label>
        <div class="segmented" role="group" aria-label="Severity">
          <button
            type="button"
            :class="{ 'is-active': severityFilter === '' }"
            data-testid="lifecycle-severity-any"
            @click="
              severityFilter = '';
              applyAlertFilters();
            "
          >
            Any severity
          </button>
          <button
            v-for="choice in SEVERITY_CHOICES"
            :key="choice"
            type="button"
            :class="{ 'is-active': severityFilter === choice }"
            :data-testid="`lifecycle-severity-${choice}`"
            @click="
              severityFilter = choice;
              applyAlertFilters();
            "
          >
            <span class="sev-dot" :class="severityTone(choice)" aria-hidden="true"></span>{{
              choice
            }}
          </button>
        </div>
        <!--
          The old Status dropdown is gone: it is the tab row now, which carries
          the counts the dropdown could not. This select is kept only so a
          deep-linked state outside the five tabs is still reachable.
        -->
        <label class="filter-select is-compact">
          <span>Per page</span>
          <select v-model.number="listLimit" data-testid="lifecycle-limit" @change="applyAlertFilters">
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>

      <p
        v-if="listState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="lifecycle-list-error"
      >
        {{ listMissing ? 'The alerts API is not available in this deployment.' : listError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <!--
                SIX COLUMNS, NOT THIRTEEN.

                This list ran 1,135px past its panel, which put Actions — and
                with it the Open button — off the right-hand edge. Thirteen
                columns is how the record is stored; it is not how an alert is
                triaged. Fields that answer one question now share a cell:
                what it is about, who has it, how long it has been running.
                Every value is still on the screen.
              -->
              <th scope="col">Severity</th>
              <th scope="col">Condition</th>
              <th scope="col">Subject</th>
              <th scope="col">Status</th>
              <th scope="col">Age</th>
              <th scope="col">Ownership</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <!-- The whole row opens the alert, as the design system's register
                 rows do. The Open button stays: a named control is what makes
                 the affordance discoverable. -->
            <tr
              v-for="row in alerts"
              :key="rowId(row)"
              class="selectable"
              :data-testid="`lifecycle-row-${rowId(row)}`"
              :class="{ selected: rowId(row) === selectedId }"
              tabindex="0"
              @click="selectAlert(rowId(row))"
              @keydown.enter="selectAlert(rowId(row))"
              @keydown.space.prevent="selectAlert(rowId(row))"
            >
              <td>
                <span class="status-badge" :class="severityTone(row.severity)">
                  {{ text(row.severity) }}
                </span>
              </td>
              <!--
                Prose, so it wraps and clamps rather than setting the width of
                the whole table from its longest sentence.

                ONE line, not two. This cell already carries a second line —
                the alert id — and three text lines took the row to 112px,
                past the height the layout audit allows. The full summary is
                in `title`, the row opens the alert, and nothing is dropped:
                the choice is between a second line of summary here and the
                register staying dense enough to scan.
              -->
              <td class="cell-wrap">
                <strong class="clamp-1" :title="text(row.summary ?? row.rule_name)">{{
                  text(row.summary ?? row.rule_name)
                }}</strong>
                <small class="row-id mono">{{ rowId(row) }}</small>
              </td>
              <td>
                <span class="metric-stack">
                  <span class="metric-line"
                    ><span class="v" :data-testid="`lifecycle-category-${rowId(row)}`">{{
                      alertCategory(row)
                    }}</span
                    ><span class="k">category</span></span
                  >
                  <span class="metric-line"
                    ><span class="v mono" :data-testid="`lifecycle-object-${rowId(row)}`">{{
                      alertObject(row)
                    }}</span
                    ><span class="k">object</span></span
                  >
                </span>
              </td>
              <td>
                <span class="chip-list">
                  <span class="status-badge" :class="statusTone(row.status)">
                    {{ text(row.status) }}
                  </span>
                  <span
                    class="status-badge"
                    :class="notificationTone(rowNotificationState(row))"
                    :data-testid="`lifecycle-notification-${rowId(row)}`"
                  >
                    {{ rowNotificationState(row) }}
                  </span>
                </span>
              </td>
              <!--
                Duration is measured to now while the alert is open, so it ages
                with the incident, and to resolution once it closes, so a
                settled incident stops growing. It leads the cell because it is
                the number that decides what to look at first; the start time
                and the occurrence count qualify it.
              -->
              <td>
                <span class="metric-stack">
                  <span class="metric-line"
                    ><span class="v mono" :data-testid="`lifecycle-duration-${rowId(row)}`">{{
                      alertDuration(row)
                    }}</span
                    ><span class="k">running</span></span
                  >
                  <span class="metric-line"
                    ><span
                      class="v mono"
                      :data-testid="`lifecycle-started-${rowId(row)}`"
                      :title="text(alertStarted(row))"
                      >{{ shortWhen(alertStarted(row)) }}</span
                    ><span class="k">started</span></span
                  >
                  <span class="metric-line"
                    ><span class="v mono" :data-testid="`lifecycle-occurrences-${rowId(row)}`">{{
                      alertOccurrences(row)
                    }}</span
                    ><span class="k">occurrences</span></span
                  >
                </span>
              </td>
              <td>
                <span class="metric-stack">
                  <span class="metric-line"
                    ><span class="v mono" :data-testid="`lifecycle-assignee-${rowId(row)}`">{{
                      rowAssignee(row) || 'unassigned'
                    }}</span
                    ><span class="k">assigned</span></span
                  >
                  <span class="metric-line"
                    ><span class="v" :data-testid="`lifecycle-ack-${rowId(row)}`">{{
                      alertAcknowledgement(row)
                    }}</span
                    ><span class="k">acknowledged</span></span
                  >
                  <!--
                    Only when there IS a suppression. Rendered unconditionally
                    this line read "— suppressed until" on every row that was
                    not suppressed, which is most of them — a third line of
                    nothing that took the rows to 112px and the register past
                    the height the layout audit allows. A stack should be as
                    tall as the row has to say.
                  -->
                  <span v-if="rowSuppressedUntil(row)" class="metric-line"
                    ><span
                      class="v mono"
                      :data-testid="`lifecycle-suppressed-${rowId(row)}`"
                      :title="rowSuppressedUntil(row) || ''"
                      >{{ shortWhen(rowSuppressedUntil(row)) }}</span
                    ><span class="k">suppressed until</span></span
                  >
                </span>
              </td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`lifecycle-open-${rowId(row)}`"
                  @click.stop="selectAlert(rowId(row))"
                >
                  Open
                </button>
              </td>
            </tr>
            <tr v-if="listState === 'ok' && !alerts.length">
              <td colspan="7" class="empty-cell" data-testid="lifecycle-empty">
                No alerts match this filter.
              </td>
            </tr>
            <tr v-if="listState === 'loading'">
              <td colspan="7" class="empty-cell">Loading alerts…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TablePager
        :shown="alerts.length"
        :total="listTotal"
        :offset="listOffset"
        :page-size="listLimit"
        :busy="listState === 'loading'"
        noun="alert"
        testid="alert-pager"
        @turn="turnAlertPage"
      />
      <p class="source-note">
        A suppressed alert is still listed here and still counts in the correlation summary — only
        its escalation is paused, and it returns to open when the window lapses.
      </p>
    </section>

    <!-- Alert detail ------------------------------------------------------------
         A sheet, not a panel below the register. An operator triaging an
         incident works down the alert list; a detail that unfolds underneath
         pushes the list away and loses their place, which is the reason the
         design system opens a record from a register in a Drawer. -->
    <DetailDrawer
      :open="Boolean(selectedId)"
      title="Alert detail"
      eyebrow="Alert"
      :subtitle="selectedId"
      wide
      @close="closeDetail"
    >
      <div data-testid="lifecycle-detail-panel">
        <p
          v-if="detailState === 'loading'"
          class="form-hint"
          data-testid="lifecycle-detail-loading"
        >
          Loading the lifecycle record…
        </p>
        <p
          v-else-if="detailState === 'error'"
          class="form-error"
          role="alert"
          data-testid="lifecycle-detail-error"
        >
          {{ detailError }}
        </p>
        <template v-else-if="record">
          <!--
            THE SHEET LEADS WITH WHAT YOU CAME TO DO.

            Acknowledge, Resolve, Reopen and Close used to sit below five
            badges, a summary line, two banners and a nine-row field list. On
            an alert with a long correlation group that was most of a screen
            of reading before the first control.

            The banners stay above them, because a suppressed or undeliverable
            alert changes which action is the right one.
          -->
          <p
            v-if="suppressionActive"
            class="warn-notice"
            role="status"
            data-testid="lifecycle-suppression-banner"
          >
            Suppressed until {{ text(record.suppressedUntil) }} — escalation is paused, so nobody is
            being paged for it.
            <span v-if="record.suppressedReason">Reason: {{ record.suppressedReason }}</span>
          </p>
          <p
            v-if="String(record.notificationState ?? '') === 'undeliverable'"
            class="warn-notice"
            role="alert"
            data-testid="lifecycle-undeliverable-banner"
          >
            This alert's escalation could not be delivered to any channel — it has reached nobody.
            Check notification readiness on the Escalation &amp; Maintenance workspace.
          </p>

          <!-- Actions ---------------------------------------------------------- -->
          <p class="panel-lede" data-testid="lifecycle-detail-summary">
            <strong>{{ text(record.summary) }}</strong>
          </p>
          <p v-if="actionNotice" class="notice" role="status" data-testid="lifecycle-action-notice">
            {{ actionNotice }}
          </p>
          <p
            v-if="actionError"
            class="form-error"
            role="alert"
            data-testid="lifecycle-action-error"
          >
            {{ actionError }}
          </p>

          <template v-if="canAct">
            <label class="filter-select filter-search">
              <span>Note / reason (recorded in the thread and the audit log)</span>
              <input
                v-model="actionReason"
                data-testid="lifecycle-reason"
                type="text"
                placeholder="What was found, or why this is being parked"
              />
            </label>
            <div class="detail-actions" data-testid="lifecycle-actions">
              <button
                class="secondary-button"
                data-testid="lifecycle-acknowledge"
                :disabled="actionBusy || !allowed('acknowledge')"
                :title="blockedReason('acknowledge') || undefined"
                @click="acknowledgeAlert"
              >
                Acknowledge
              </button>
              <button
                class="primary-button"
                data-testid="lifecycle-resolve"
                :disabled="actionBusy || !allowed('resolve')"
                :title="blockedReason('resolve') || undefined"
                @click="resolveAlert"
              >
                Resolve
              </button>
              <button
                class="secondary-button"
                data-testid="lifecycle-reopen"
                :disabled="actionBusy || !allowed('reopen')"
                :title="blockedReason('reopen') || undefined"
                @click="reopenAlert"
              >
                Reopen
              </button>
              <button
                class="secondary-button danger-button"
                data-testid="lifecycle-close"
                :disabled="actionBusy || !allowed('close')"
                :title="blockedReason('close') || undefined"
                @click="closeAlert"
              >
                Close
              </button>
            </div>

            <div class="grid-toolbar" data-testid="lifecycle-assign-row">
              <label class="filter-select filter-search">
                <span>Assign to</span>
                <input
                  v-model="assignee"
                  data-testid="lifecycle-assignee-input"
                  type="text"
                  list="lifecycle-user-options"
                  placeholder="username"
                />
              </label>
              <datalist id="lifecycle-user-options">
                <option v-for="name in userOptions" :key="name" :value="name" />
              </datalist>
              <button
                class="secondary-button"
                data-testid="lifecycle-assign"
                :disabled="actionBusy || !allowed('assign') || !assignee.trim()"
                :title="blockedReason('assign') || undefined"
                @click="assignAlert"
              >
                Assign
              </button>
              <span class="source-note">
                The assignee must be a user in this tenant; an unknown name is rejected rather than
                stored as free text that reaches nobody.
              </span>
            </div>
          </template>

          <div v-if="canSuppress" class="grid-toolbar" data-testid="lifecycle-suppress-row">
            <label class="filter-select">
              <span>Suppress for</span>
              <select v-model.number="suppressMinutes" data-testid="lifecycle-suppress-minutes">
                <option v-for="choice in SUPPRESS_CHOICES" :key="choice" :value="choice">
                  {{ choice }} minutes
                </option>
              </select>
            </label>
            <button
              class="secondary-button danger-button"
              data-testid="lifecycle-suppress"
              :disabled="actionBusy || !allowed('suppress')"
              :title="blockedReason('suppress') || undefined"
              @click="suppressAlert"
            >
              Suppress
            </button>
            <span class="source-note">
              Suppression stops escalation only. The alert stays visible and returns to open when
              the window lapses.
            </span>
          </div>
          <p v-else class="source-note" data-testid="lifecycle-suppress-denied">
            Suppressing an alert stops anyone being paged for it, so it requires the system.manage
            permission.
          </p>

          <!-- Reference -----------------------------------------------------------
            Below the actions, because this is what you check once you have
            decided what to do. A 130px label column so the labels align down
            the left and a field can be found without reading every one.

            Timestamps are relative with the instant in `title`: nine ISO
            strings stacked is the wall of text the register was freed from,
            and the sheet is no better a place to read a UTC offset.
          -->
          <h3 class="panel-heading">Record</h3>
          <dl class="panel-fields">
            <dt>Status</dt>
            <dd data-testid="lifecycle-detail-status">
              <span class="status-badge" :class="statusTone(record.status)">{{
                text(record.status)
              }}</span>
            </dd>
            <dt>Severity</dt>
            <dd>
              <span class="status-badge" :class="severityTone(record.severity)">{{
                text(record.severity)
              }}</span>
              <template v-if="record.previousSeverity">
                <small class="row-id">raised from {{ record.previousSeverity }}</small>
              </template>
            </dd>
            <dt>Notification</dt>
            <dd data-testid="lifecycle-detail-notification">
              <span class="status-badge" :class="notificationTone(record.notificationState)">{{
                text(record.notificationState, 'unknown')
              }}</span>
            </dd>
            <dt>Assigned to</dt>
            <dd class="mono" data-testid="lifecycle-detail-assignee">
              {{ text(record.assignedToUsername ?? record.assignedTo, 'unassigned') }}
              <small v-if="record.assignedAt" class="row-id" :title="text(record.assignedAt)"
                >{{ agoWhen(record.assignedAt) }}</small
              >
            </dd>
            <dt>Occurrences</dt>
            <dd class="mono">
              {{ Number(record.dedupCount ?? 1) }}
              <small v-if="Number(record.reopenCount ?? 0) > 0" class="row-id"
                >reopened {{ Number(record.reopenCount) }} time(s)</small
              >
            </dd>
            <dt>Opened</dt>
            <dd :title="text(record.openedAt)">{{ agoWhen(record.openedAt) || '—' }}</dd>
            <dt>Escalated</dt>
            <dd :title="text(record.escalatedAt)">{{ agoWhen(record.escalatedAt) || '—' }}</dd>
            <dt>Resolved</dt>
            <dd :title="text(record.resolvedAt)">{{ agoWhen(record.resolvedAt) || '—' }}</dd>
            <dt>Closed</dt>
            <dd :title="text(record.closedAt)">{{ agoWhen(record.closedAt) || '—' }}</dd>
            <dt>Suppressed until</dt>
            <dd data-testid="lifecycle-detail-suppressed" :title="text(record.suppressedUntil)">
              {{ shortWhen(record.suppressedUntil) || '—' }}
            </dd>
            <dt>Correlation</dt>
            <dd class="mono clamp-1" :title="text(record.correlationGroup)">
              {{ text(record.correlationGroup) }}
            </dd>
            <dt>Alert id</dt>
            <dd class="mono clamp-1" :title="text(record.id)">{{ text(record.id) }}</dd>
          </dl>

          <!-- Thread ----------------------------------------------------------- -->
          <h3 class="panel-heading">Timeline</h3>
          <p class="source-note">
            {{ operatorComments.length }} operator comment(s) and
            {{ transitionEntries.length }} recorded transition(s). Transitions are written by the
            platform when the alert moves state — they are history, not somebody's note.
          </p>
          <p
            v-if="commentsState === 'error'"
            class="form-error"
            role="alert"
            data-testid="lifecycle-comments-error"
          >
            {{ commentsError }}
          </p>
          <template v-else>
            <!-- Capped: a long-running incident with a busy thread would
                 otherwise push the comment box off the end of the sheet. -->
            <div v-if="incidentTimeline.length" class="capped-list">
              <EventTimeline :items="incidentTimeline" dense data-testid="lifecycle-thread" />
            </div>
            <p
              v-if="commentsState === 'ok' && !comments.length"
              class="source-note"
              data-testid="lifecycle-thread-empty"
            >
              Nothing has happened to this alert yet beyond it opening.
            </p>
            <p v-if="commentsState === 'loading'" class="source-note">Loading the thread…</p>
          </template>

          <div v-if="canAct" class="grid-toolbar" data-testid="lifecycle-comment-row">
            <label class="filter-select filter-search">
              <span>Add a comment</span>
              <input
                v-model="commentDraft"
                data-testid="lifecycle-comment-input"
                type="text"
                placeholder="What you found, what you did next"
                @keyup.enter="addComment"
              />
            </label>
            <button
              class="secondary-button"
              data-testid="lifecycle-comment-submit"
              :disabled="actionBusy || !commentDraft.trim()"
              @click="addComment"
            >
              Comment
            </button>
          </div>
        </template>
      </div>
    </DetailDrawer>
  </div>
</template>

<style src="./workspace-extras.css"></style>
