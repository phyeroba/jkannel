<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import { canAccess, session } from '../stores/session';

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
const statusFilter = ref('');
const severityFilter = ref('');
const searchQuery = ref('');
const listLimit = ref(50);

const STATUS_CHOICES = ['open', 'acknowledged', 'suppressed', 'resolved', 'closed'];
const SEVERITY_CHOICES = ['info', 'warning', 'critical'];

async function loadAlerts() {
  listState.value = listState.value === 'ok' ? 'ok' : 'loading';
  listMissing.value = false;
  const params = new URLSearchParams();
  params.set('limit', String(listLimit.value));
  params.set('offset', '0');
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
}

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
  await Promise.all([loadDetail(id), loadComments(id)]);
  if (canListUsers.value && !userOptions.value.length) void loadUserOptions();
}

function closeDetail() {
  selectedId.value = '';
  record.value = null;
  comments.value = [];
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

// --- Auto refresh --------------------------------------------------------------
// The index only. The open detail is deliberately not polled: an operator
// typing a note must not have the record swapped underneath them.
const refreshChoices = [10, 30, 60, 120];
const { autoRefresh, intervalSeconds, refreshing, lastRefreshedAt, refreshNow } = useLiveResource(
  () => loadAlerts(),
  { intervalSeconds: 30, immediate: false, pauseWhen: () => actionBusy.value },
);

// `/alert-lifecycle?alert=<id>` opens straight onto one alert — the link the
// Alerts grid uses, so triage does not have to re-find the row here.
const route = useRoute();

onMounted(() => {
  void loadAlerts();
  const deepLink = String(route.query.alert ?? '').trim();
  if (deepLink) void selectAlert(deepLink);
});
</script>

<template>
  <div data-testid="alert-lifecycle-view">
    <p v-if="!canAct" class="source-note" data-testid="lifecycle-readonly">
      You can review alerts and their history. Acknowledging, resolving, assigning, reopening,
      closing and commenting require the alerts.acknowledge permission.
    </p>

    <!-- Index + refresh -------------------------------------------------------- -->
    <section class="toolbar panel grid-toolbar" aria-label="Alert index filters">
      <label class="filter-select">
        <span>Status</span>
        <select v-model="statusFilter" data-testid="lifecycle-status-filter" @change="loadAlerts">
          <option value="">Any status</option>
          <option v-for="choice in STATUS_CHOICES" :key="choice" :value="choice">
            {{ choice }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Severity</span>
        <select
          v-model="severityFilter"
          data-testid="lifecycle-severity-filter"
          @change="loadAlerts"
        >
          <option value="">Any severity</option>
          <option v-for="choice in SEVERITY_CHOICES" :key="choice" :value="choice">
            {{ choice }}
          </option>
        </select>
      </label>
      <label class="filter-select filter-search">
        <span>Search</span>
        <input
          v-model="searchQuery"
          data-testid="lifecycle-search"
          type="search"
          placeholder="Summary, details, or rule name"
          @keyup.enter="loadAlerts"
        />
      </label>
      <label class="filter-select">
        <span>Auto refresh</span>
        <select v-model="autoRefresh" data-testid="lifecycle-auto-toggle">
          <option :value="true">On</option>
          <option :value="false">Off</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Every</span>
        <select v-model.number="intervalSeconds" data-testid="lifecycle-interval">
          <option v-for="choice in refreshChoices" :key="choice" :value="choice">
            {{ choice }}s
          </option>
        </select>
      </label>
      <button
        class="primary-button"
        data-testid="lifecycle-refresh"
        :disabled="refreshing"
        @click="refreshNow(true)"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh' }}
      </button>
      <span class="source-note" data-testid="lifecycle-last-refreshed">
        {{ lastRefreshedAt ? `Last updated ${lastRefreshedAt}` : 'Waiting for the first load…' }}
      </span>
    </section>

    <!-- Alert index ------------------------------------------------------------ -->
    <section class="panel" data-testid="lifecycle-index-panel" aria-label="Alerts">
      <header class="panel-header">
        <div>
          <h2>Alerts</h2>
          <p aria-live="polite">
            {{
              listState === 'loading'
                ? 'Loading alerts…'
                : `${alerts.length} of ${listTotal} alert(s) shown`
            }}
          </p>
        </div>
      </header>
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
              <th scope="col">Severity</th>
              <th scope="col">Condition</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned to</th>
              <th scope="col">Suppressed until</th>
              <th scope="col">Notification</th>
              <th scope="col">Opened</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in alerts"
              :key="rowId(row)"
              :data-testid="`lifecycle-row-${rowId(row)}`"
              :class="{ 'preset-active': rowId(row) === selectedId }"
            >
              <td>
                <span class="status-badge" :class="severityTone(row.severity)">
                  {{ text(row.severity) }}
                </span>
              </td>
              <td>
                <strong>{{ text(row.summary ?? row.rule_name) }}</strong>
                <small class="row-id mono">{{ rowId(row) }}</small>
              </td>
              <td>
                <span class="status-badge" :class="statusTone(row.status)">
                  {{ text(row.status) }}
                </span>
              </td>
              <td class="mono" :data-testid="`lifecycle-assignee-${rowId(row)}`">
                {{ rowAssignee(row) || 'unassigned' }}
              </td>
              <td :data-testid="`lifecycle-suppressed-${rowId(row)}`">
                {{ rowSuppressedUntil(row) || '—' }}
              </td>
              <td :data-testid="`lifecycle-notification-${rowId(row)}`">
                <span class="status-badge" :class="notificationTone(rowNotificationState(row))">
                  {{ rowNotificationState(row) }}
                </span>
              </td>
              <td>{{ text(row.opened_at ?? row.openedAt) }}</td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`lifecycle-open-${rowId(row)}`"
                  @click="selectAlert(rowId(row))"
                >
                  Open
                </button>
              </td>
            </tr>
            <tr v-if="listState === 'ok' && !alerts.length">
              <td colspan="8" class="empty-cell" data-testid="lifecycle-empty">
                No alerts match this filter.
              </td>
            </tr>
            <tr v-if="listState === 'loading'">
              <td colspan="8" class="empty-cell">Loading alerts…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="source-note">
        A suppressed alert is still listed here and still counts in the correlation summary — only
        its escalation is paused, and it returns to open when the window lapses.
      </p>
    </section>

    <!-- Alert detail ------------------------------------------------------------ -->
    <section
      v-if="selectedId"
      class="panel detail-panel"
      data-testid="lifecycle-detail-panel"
      aria-label="Alert detail"
    >
      <header>
        <h2>Alert detail</h2>
        <button class="secondary-button" data-testid="lifecycle-detail-close" @click="closeDetail">
          Close
        </button>
      </header>

      <p v-if="detailState === 'loading'" class="form-hint" data-testid="lifecycle-detail-loading">
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
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="lifecycle-detail-status">
              <span class="status-badge" :class="statusTone(record.status)">
                {{ text(record.status) }}
              </span>
            </strong>
            <small>Status</small>
          </div>
          <div class="metric">
            <strong>
              <span class="status-badge" :class="severityTone(record.severity)">
                {{ text(record.severity) }}
              </span>
            </strong>
            <small>
              Severity{{ record.previousSeverity ? ` (was ${record.previousSeverity})` : '' }}
            </small>
          </div>
          <div class="metric">
            <strong data-testid="lifecycle-detail-notification">
              <span class="status-badge" :class="notificationTone(record.notificationState)">
                {{ text(record.notificationState, 'unknown') }}
              </span>
            </strong>
            <small>Notification state</small>
          </div>
          <div class="metric">
            <strong>{{ Number(record.reopenCount ?? 0) }}</strong>
            <small>Reopened</small>
          </div>
          <div class="metric">
            <strong>{{ Number(record.dedupCount ?? 1) }}</strong>
            <small>Occurrences</small>
          </div>
        </div>

        <p class="row-id">
          <strong>{{ text(record.summary) }}</strong>
        </p>

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

        <dl class="detail-grid">
          <dt>Alert ID</dt>
          <dd class="mono">{{ text(record.id) }}</dd>
          <dt>Assigned to</dt>
          <dd class="mono" data-testid="lifecycle-detail-assignee">
            {{ text(record.assignedToUsername ?? record.assignedTo, 'unassigned') }}
          </dd>
          <dt>Assigned at</dt>
          <dd>{{ text(record.assignedAt) }}</dd>
          <dt>Suppressed until</dt>
          <dd data-testid="lifecycle-detail-suppressed">{{ text(record.suppressedUntil) }}</dd>
          <dt>Opened</dt>
          <dd>{{ text(record.openedAt) }}</dd>
          <dt>Escalated</dt>
          <dd>{{ text(record.escalatedAt) }}</dd>
          <dt>Resolved</dt>
          <dd>{{ text(record.resolvedAt) }}</dd>
          <dt>Closed</dt>
          <dd>{{ text(record.closedAt) }}</dd>
          <dt>Correlation group</dt>
          <dd class="mono">{{ text(record.correlationGroup) }}</dd>
        </dl>

        <!-- Actions ---------------------------------------------------------- -->
        <h3>Actions</h3>
        <p v-if="actionNotice" class="notice" role="status" data-testid="lifecycle-action-notice">
          {{ actionNotice }}
        </p>
        <p v-if="actionError" class="form-error" role="alert" data-testid="lifecycle-action-error">
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
            Suppression stops escalation only. The alert stays visible and returns to open when the
            window lapses.
          </span>
        </div>
        <p v-else class="source-note" data-testid="lifecycle-suppress-denied">
          Suppressing an alert stops anyone being paged for it, so it requires the system.manage
          permission.
        </p>

        <!-- Thread ----------------------------------------------------------- -->
        <h3>Thread</h3>
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
        <ul v-else class="sample-list" data-testid="lifecycle-thread">
          <li
            v-for="(entry, index) in comments"
            :key="entry.id ?? index"
            :data-testid="`lifecycle-thread-${entry.kind === 'transition' ? 'transition' : 'comment'}-${index}`"
          >
            <span class="status-badge" :class="entry.kind === 'transition' ? '' : 'good'">
              {{ entry.kind === 'transition' ? 'history' : 'comment' }}
            </span>
            <span class="mono">{{ text(entry.authorUsername, 'system') }}</span>
            <span>{{ text(entry.body) }}</span>
            <small>{{ text(entry.createdAt) }}</small>
          </li>
          <li
            v-if="commentsState === 'ok' && !comments.length"
            data-testid="lifecycle-thread-empty"
          >
            Nothing has happened to this alert yet beyond it opening.
          </li>
          <li v-if="commentsState === 'loading'">Loading the thread…</li>
        </ul>

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
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
