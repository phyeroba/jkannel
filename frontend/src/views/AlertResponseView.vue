<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import ModalDialog from '../components/ModalDialog.vue';
import { canAccess, session } from '../stores/session';
import { agoWhen } from '../utils/when';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

interface Step {
  afterMinutes: number;
  channelType: string;
  target: string;
  severity: string;
}

/** Mirrors CHANNEL_TYPES / SEVERITIES in monitoring-depth.controller.ts. */
const CHANNEL_TYPES = ['dashboard', 'webhook', 'email', 'sms'];
const SEVERITIES = ['info', 'warning', 'critical'];

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

/**
 * `datetime-local` speaks "YYYY-MM-DDTHH:mm" in the browser's own zone, while the
 * API speaks ISO-8601 UTC. These two convert without ever showing the operator a
 * timestamp in a zone they did not choose.
 */
function toLocalInput(iso: unknown): string {
  const parsed = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(parsed)) return '';
  const local = new Date(parsed - new Date(parsed).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

// Reads are alerts.view (the route guard); every mutation is system.manage,
// exactly as monitoring-depth.controller.ts declares.
const canManage = computed(() => canAccess(session.value, 'system.manage'));

// --- Escalation policies ----------------------------------------------------
const policies = ref<RecordValue[]>([]);
const policyState = ref<LoadState>('loading');
const policyError = ref('');
const policyMissing = ref(false);
const policyNotice = ref('');
const policyFormError = ref('');
const policyBusy = ref(false);
const showPolicyForm = ref(false);
const editingPolicyId = ref('');
const policyName = ref('');
const policyEnabled = ref(true);
const policyReason = ref('');
const policySteps = ref<Step[]>([]);

function newStep(): Step {
  return { afterMinutes: 15, channelType: 'dashboard', target: '', severity: '' };
}
function stepsOf(policy: RecordValue): Step[] {
  const raw = policy.steps;
  const source = Array.isArray(raw) ? raw : [];
  return source
    .filter((entry): entry is RecordValue => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      afterMinutes: Number(entry.afterMinutes ?? 0) || 0,
      channelType: String(entry.channelType ?? 'dashboard'),
      target: String(entry.target ?? ''),
      severity:
        entry.severity === undefined || entry.severity === null ? '' : String(entry.severity),
    }));
}
/**
 * When readiness was last evaluated, for the banner's "Checked 51s ago".
 *
 * The banner makes a claim about NOW — "an alert firing now reaches
 * somebody" — and a claim about now is only worth anything with its age
 * beside it. A green banner from twenty minutes ago is not evidence.
 */
const readinessCheckedAt = ref<Date | null>(null);
const readinessAge = ref(0);
setInterval(() => {
  if (readinessCheckedAt.value) {
    readinessAge.value = Math.floor((Date.now() - readinessCheckedAt.value.getTime()) / 1000);
  }
}, 1000);

/**
 * Can this step's channel actually deliver?
 *
 * Read off the readiness evaluation rather than off the policy, because the
 * policy only records an intent. A step pointing at email is still a step
 * when SMTP_URL is unset — it just will not do anything, and that is exactly
 * what the rail has to show.
 */
function channelCanDeliver(channelType: string): boolean {
  const channel = readinessChannels.value.find((entry) => String(entry.type ?? '') === channelType);
  return Boolean(channel?.deliverable);
}

/** Which policy step, if any, depends on a channel — shown on the channel. */
function stepUsing(channel: ChannelReadiness): string {
  const type = String(channel.type ?? '');
  for (const policy of policies.value) {
    const steps = stepsOf(policy);
    const index = steps.findIndex((step) => step.channelType === type);
    if (index >= 0) return `Used by step ${index + 1} of ${text(policy.name)}.`;
  }
  return '';
}

/**
 * The banner's verdict. Both halves have to hold: a deliverable channel with
 * no enabled policy never gets told to fire, and an enabled policy with
 * nothing deliverable fires into nothing.
 */
const reachesSomebody = computed(() => {
  // The API's own warning outranks the two counts.
  //
  // `deliverableChannels > 0` and `enabledPolicies > 0` are statements about
  // CAPABILITY. The warning is a statement about what actually happened —
  // "N alerts could not be delivered" — and a green banner over that would
  // be the screen contradicting its own evidence. Capability is not delivery.
  if (readiness.value?.warning) return false;
  return deliverableCount.value > 0 && Number(readiness.value?.escalationPolicies ?? 0) > 0;
});

function describeSteps(policy: RecordValue): string {
  const steps = stepsOf(policy);
  if (!steps.length) return 'no steps';
  return steps
    .map((step) => `+${step.afterMinutes}m → ${step.channelType} ${step.target}`.trim())
    .join(' · ');
}

async function loadPolicies() {
  policyState.value = 'loading';
  policyMissing.value = false;
  try {
    policies.value = asItems(await apiRequest<unknown>('/monitoring/escalation/policies'));
    policyError.value = '';
    policyState.value = 'ok';
  } catch (reason) {
    policies.value = [];
    policyMissing.value = isMissing(reason);
    policyError.value = messageFrom(reason, 'Escalation policies could not be loaded.');
    policyState.value = 'error';
  }
}

function openPolicyForm(policy?: RecordValue) {
  showPolicyForm.value = true;
  policyFormError.value = '';
  policyNotice.value = '';
  editingPolicyId.value = policy ? text(policy.id, '') : '';
  policyName.value = policy ? text(policy.name, '') : '';
  policyEnabled.value = policy ? policy.enabled !== false : true;
  policyReason.value = '';
  policySteps.value = policy ? stepsOf(policy) : [newStep()];
  if (!policySteps.value.length) policySteps.value = [newStep()];
}
function closePolicyForm() {
  showPolicyForm.value = false;
  editingPolicyId.value = '';
  policyFormError.value = '';
}
function addStep() {
  policySteps.value = [...policySteps.value, newStep()];
}
function removeStep(index: number) {
  policySteps.value = policySteps.value.filter((_, position) => position !== index);
}

async function savePolicy() {
  if (!canManage.value) return;
  policyFormError.value = '';
  const name = policyName.value.trim();
  if (!name) {
    policyFormError.value = 'A policy name is required.';
    return;
  }
  const steps = policySteps.value.map((step) => ({
    afterMinutes: Number(step.afterMinutes),
    channelType: step.channelType,
    target: step.target.trim(),
    ...(step.severity ? { severity: step.severity } : {}),
  }));
  if (!steps.length) {
    policyFormError.value = 'A policy needs at least one escalation step.';
    return;
  }
  if (steps.some((step) => !step.target)) {
    policyFormError.value = 'Every step needs a target (an address, URL, or channel name).';
    return;
  }
  if (steps.some((step) => !Number.isFinite(step.afterMinutes) || step.afterMinutes < 0)) {
    policyFormError.value = 'Every step needs a non-negative "after" value in minutes.';
    return;
  }
  policyBusy.value = true;
  try {
    const body: RecordValue = { name, steps, enabled: policyEnabled.value };
    if (policyReason.value.trim()) body.reason = policyReason.value.trim();
    if (editingPolicyId.value)
      await apiRequest(`/monitoring/escalation/policies/${editingPolicyId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    else
      await apiRequest('/monitoring/escalation/policies', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    policyNotice.value = `Escalation policy “${name}” ${editingPolicyId.value ? 'updated' : 'created'}.`;
    closePolicyForm();
    await loadPolicies();
  } catch (reason) {
    policyFormError.value = messageFrom(reason, 'The escalation policy could not be saved.');
  } finally {
    policyBusy.value = false;
  }
}

async function deletePolicy(policy: RecordValue) {
  if (!canManage.value) return;
  const id = text(policy.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Delete the escalation policy “${text(policy.name, id)}”?\n\nAlerts that stay open will no longer escalate through these steps.`,
    )
  )
    return;
  policyBusy.value = true;
  policyNotice.value = '';
  try {
    await apiRequest(`/monitoring/escalation/policies/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Deleted from the operator console' }),
    });
    policyNotice.value = `Escalation policy “${text(policy.name, id)}” deleted.`;
    await loadPolicies();
  } catch (reason) {
    policyError.value = messageFrom(reason, 'The escalation policy could not be deleted.');
  } finally {
    policyBusy.value = false;
  }
}

// --- Maintenance windows ----------------------------------------------------
const windows = ref<RecordValue[]>([]);
const windowState = ref<LoadState>('loading');
const windowError = ref('');
const windowMissing = ref(false);
const windowNotice = ref('');
const windowFormError = ref('');
const windowBusy = ref(false);
const activeWindows = ref<RecordValue[]>([]);
const showWindowForm = ref(false);
const editingWindowId = ref('');
const windowName = ref('');
const windowStartsAt = ref('');
const windowEndsAt = ref('');
const windowScopeAll = ref(true);
const windowScopeSmscs = ref<string[]>([]);
const windowReason = ref('');
const smscOptions = ref<Array<{ value: string; label: string }>>([]);
const smscOptionsError = ref('');

function scopeOf(row: RecordValue): RecordValue {
  const scope = row.scope;
  return scope && typeof scope === 'object' && !Array.isArray(scope) ? (scope as RecordValue) : {};
}
function describeScope(row: RecordValue): string {
  const scope = scopeOf(row);
  if (scope.all === true) return 'everything';
  const parts: string[] = [];
  const smscs = Array.isArray(scope.smscs) ? (scope.smscs as unknown[]) : [];
  const routes = Array.isArray(scope.routes) ? (scope.routes as unknown[]) : [];
  if (smscs.length) parts.push(`${smscs.length} SMSC(s)`);
  if (routes.length) parts.push(`${routes.length} route(s)`);
  return parts.length ? parts.join(' + ') : 'nothing (empty scope suppresses no alerts)';
}
function isActiveNow(row: RecordValue): boolean {
  const starts = Date.parse(String(row.starts_at ?? row.startsAt ?? ''));
  const ends = Date.parse(String(row.ends_at ?? row.endsAt ?? ''));
  const now = Date.now();
  return Number.isFinite(starts) && Number.isFinite(ends) && starts <= now && ends > now;
}

async function loadWindows() {
  windowState.value = 'loading';
  windowMissing.value = false;
  try {
    const [all, active] = await Promise.all([
      apiRequest<unknown>('/monitoring/maintenance'),
      apiRequest<unknown>('/monitoring/maintenance/active').catch(() => []),
    ]);
    windows.value = asItems(all);
    activeWindows.value = asItems(active);
    windowError.value = '';
    windowState.value = 'ok';
  } catch (reason) {
    windows.value = [];
    activeWindows.value = [];
    windowMissing.value = isMissing(reason);
    windowError.value = messageFrom(reason, 'Maintenance windows could not be loaded.');
    windowState.value = 'error';
  }
}

async function loadSmscOptions() {
  smscOptionsError.value = '';
  try {
    const payload = await apiRequest<unknown>('/smscs?limit=500&offset=0');
    smscOptions.value = asItems(payload)
      .map((row) => ({
        // The ENGINE id, not the row UUID. A maintenance window's SMSC scope is
        // matched in MaintenanceWindowService against the `smsc` metric label,
        // and the only writer of that label is the status poller, which sets it
        // to `bind.engineId`. Sending UUIDs saved a window that looked correct
        // and suppressed absolutely nothing.
        value: text(row.engine_id ?? row.engineId, ''),
        label: `${text(row.name)} (${text(row.engine_id ?? row.engineId)})`,
      }))
      .filter((option) => option.value && option.value !== '—');
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value = messageFrom(reason, 'SMSC connections could not be loaded.');
  }
}

function openWindowForm(row?: RecordValue) {
  showWindowForm.value = true;
  windowFormError.value = '';
  windowNotice.value = '';
  editingWindowId.value = row ? text(row.id, '') : '';
  windowName.value = row ? text(row.name, '') : '';
  const now = Date.now();
  windowStartsAt.value = row
    ? toLocalInput(row.starts_at ?? row.startsAt)
    : toLocalInput(new Date(now).toISOString());
  windowEndsAt.value = row
    ? toLocalInput(row.ends_at ?? row.endsAt)
    : toLocalInput(new Date(now + 60 * 60_000).toISOString());
  const scope = row ? scopeOf(row) : {};
  windowScopeAll.value = row ? scope.all === true : true;
  windowScopeSmscs.value = Array.isArray(scope.smscs) ? (scope.smscs as unknown[]).map(String) : [];
  windowReason.value = row ? (text(row.reason, '') === '—' ? '' : String(row.reason ?? '')) : '';
  if (!smscOptions.value.length) void loadSmscOptions();
}
function closeWindowForm() {
  showWindowForm.value = false;
  editingWindowId.value = '';
  windowFormError.value = '';
}

async function saveWindow() {
  if (!canManage.value) return;
  windowFormError.value = '';
  const name = windowName.value.trim();
  const startsAt = fromLocalInput(windowStartsAt.value);
  const endsAt = fromLocalInput(windowEndsAt.value);
  if (!name) {
    windowFormError.value = 'A window name is required.';
    return;
  }
  if (!startsAt || !endsAt) {
    windowFormError.value = 'Both a start and an end time are required.';
    return;
  }
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    windowFormError.value = 'The end time must be after the start time.';
    return;
  }
  const scope: RecordValue = windowScopeAll.value
    ? { all: true }
    : { all: false, smscs: windowScopeSmscs.value };
  if (!windowScopeAll.value && !windowScopeSmscs.value.length) {
    windowFormError.value =
      'Select at least one SMSC, or scope the window to everything — an empty scope suppresses nothing.';
    return;
  }
  windowBusy.value = true;
  try {
    const body: RecordValue = { name, startsAt, endsAt, scope };
    if (windowReason.value.trim()) body.reason = windowReason.value.trim();
    if (editingWindowId.value)
      await apiRequest(`/monitoring/maintenance/${editingWindowId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    else
      await apiRequest('/monitoring/maintenance', { method: 'POST', body: JSON.stringify(body) });
    windowNotice.value = `Maintenance window “${name}” ${editingWindowId.value ? 'updated' : 'scheduled'}.`;
    closeWindowForm();
    await loadWindows();
  } catch (reason) {
    windowFormError.value = messageFrom(reason, 'The maintenance window could not be saved.');
  } finally {
    windowBusy.value = false;
  }
}

async function deleteWindow(row: RecordValue) {
  if (!canManage.value) return;
  const id = text(row.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Delete the maintenance window “${text(row.name, id)}”?\n\nAlert evaluation and escalation resume immediately for everything in its scope.`,
    )
  )
    return;
  windowBusy.value = true;
  windowNotice.value = '';
  try {
    await apiRequest(`/monitoring/maintenance/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Deleted from the operator console' }),
    });
    windowNotice.value = `Maintenance window “${text(row.name, id)}” deleted.`;
    await loadWindows();
  } catch (reason) {
    windowError.value = messageFrom(reason, 'The maintenance window could not be deleted.');
  } finally {
    windowBusy.value = false;
  }
}

// --- Notification readiness -------------------------------------------------
/**
 * "If an alert fires right now, does anybody hear about it?" A fresh install
 * has no SMTP_URL and no webhook, so every escalation step past the dashboard
 * records "no enabled channel" in a column nobody reads and the alert sits open
 * looking fine. This panel is the difference between "alerts work" and "alerts
 * silently reach nobody", so it is rendered above the policies that depend on it.
 *
 * Reads need alerts.view (already the route guard); the repair that re-seeds
 * the always-deliverable dashboard channel and a default policy is system.manage.
 */
interface ChannelReadiness {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  deliverable?: boolean;
  reason?: string;
}
interface TenantReadiness {
  channels?: ChannelReadiness[];
  deliverableChannels?: number;
  openAlerts?: number;
  undeliverableAlerts?: number;
  unnotifiedAlerts?: number;
  escalationPolicies?: number;
  warning?: string | null;
}

const readiness = ref<TenantReadiness | null>(null);
const readinessState = ref<LoadState>('loading');
const readinessError = ref('');
const readinessMissing = ref(false);
const readinessNotice = ref('');
const readinessBusy = ref(false);

const readinessChannels = computed<ChannelReadiness[]>(() =>
  Array.isArray(readiness.value?.channels) ? readiness.value.channels : [],
);
const deliverableCount = computed(() => Number(readiness.value?.deliverableChannels ?? 0));

async function loadReadiness() {
  readinessState.value = 'loading';
  readinessMissing.value = false;
  try {
    readiness.value = await apiRequest<TenantReadiness>('/monitoring/notifications/readiness');
    readinessError.value = '';
    readinessState.value = 'ok';
    // Stamped only on success. A failed re-check must not refresh the age on
    // a verdict that is now older than it looks.
    readinessCheckedAt.value = new Date();
    readinessAge.value = 0;
  } catch (reason) {
    readiness.value = null;
    readinessMissing.value = isMissing(reason);
    readinessError.value = messageFrom(reason, 'Notification readiness could not be evaluated.');
    readinessState.value = 'error';
  }
}

async function repairReadiness() {
  if (!canManage.value) return;
  readinessBusy.value = true;
  readinessNotice.value = '';
  readinessError.value = '';
  try {
    const result = await apiRequest<{ channel?: boolean; policy?: boolean }>(
      '/monitoring/notifications/readiness/repair',
      { method: 'POST', body: '{}' },
    );
    const seeded = [
      result.channel ? 'a default dashboard channel' : '',
      result.policy ? 'a default escalation policy' : '',
    ].filter(Boolean);
    readinessNotice.value = seeded.length
      ? `Seeded ${seeded.join(' and ')}. Dashboard delivery is in-app only — configure email, SMS or a webhook for anything that has to reach somebody off-console.`
      : 'Nothing needed seeding: a dashboard channel and an enabled escalation policy already exist.';
    await Promise.all([loadReadiness(), loadPolicies()]);
  } catch (reason) {
    readinessError.value = messageFrom(reason, 'Notification defaults could not be re-seeded.');
  } finally {
    readinessBusy.value = false;
  }
}

// --- Correlation groups -----------------------------------------------------
const correlations = ref<RecordValue[]>([]);
const correlationState = ref<LoadState>('loading');
const correlationError = ref('');

async function loadCorrelations() {
  correlationState.value = 'loading';
  try {
    correlations.value = asItems(await apiRequest<unknown>('/monitoring/correlations'));
    correlationError.value = '';
    correlationState.value = 'ok';
  } catch (reason) {
    correlations.value = [];
    correlationError.value = messageFrom(reason, 'Alert correlation groups could not be loaded.');
    correlationState.value = 'error';
  }
}

onMounted(() => {
  void loadPolicies();
  void loadWindows();
  void loadCorrelations();
  void loadReadiness();
});
</script>

<template>
  <div data-testid="alert-response-view">
    <p v-if="!canManage" class="source-note" data-testid="alert-response-readonly">
      You can review escalation policies and maintenance windows. Creating, editing and deleting
      them requires the system.manage permission.
    </p>

    <!-- Active maintenance banner ------------------------------------------- -->
    <p
      v-if="activeWindows.length"
      class="warn-notice"
      role="status"
      data-testid="maintenance-active-banner"
    >
      {{ activeWindows.length }} maintenance window(s) are active right now — alert evaluation and
      escalation are suppressed for their scope:
      <span class="mono">{{ activeWindows.map((row) => text(row.name)).join(', ') }}</span>
    </p>

    <!-- Notification readiness -------------------------------------------------- -->
    <!--
      THE VERDICT FIRST, THEN THE EVIDENCE.

      This screen answers one question — would an alert firing right now
      reach a human — and the answer was buried: a panel heading, a
      paragraph, a green notice, then a bare row of five numbers above a
      one-row table. The banner states the verdict, in colour and in words,
      with its own age beside it, because a claim about "now" is worth
      nothing without saying how old it is.
    -->
    <section
      class="panel readiness-panel"
      data-testid="readiness-panel"
      aria-label="Notification readiness"
    >
      <div
        class="status-banner"
        :class="reachesSomebody ? 'is-ok' : 'is-bad'"
        role="status"
        data-testid="readiness-banner"
      >
        <span class="banner-dot" aria-hidden="true"></span>
        <div class="banner-text">
          <h2 v-if="readinessState === 'loading'">Checking whether an alert reaches anybody…</h2>
          <h2 v-else-if="reachesSomebody">An alert firing now reaches somebody</h2>
          <h2 v-else>An alert firing now reaches nobody</h2>
          <p>
            {{ deliverableCount }} of {{ readinessChannels.length }}
            {{ readinessChannels.length === 1 ? 'channel' : 'channels' }} can deliver and
            {{ Number(readiness?.escalationPolicies ?? 0) }} escalation
            {{ Number(readiness?.escalationPolicies ?? 0) === 1 ? 'policy is' : 'policies are' }}
            enabled.
          </p>
        </div>
        <div class="banner-actions">
          <span v-if="readinessCheckedAt" class="banner-age" data-testid="readiness-checked"
            >Checked {{ readinessAge }}s ago</span
          >
          <button
            class="secondary-button is-compact"
            data-testid="readiness-refresh"
            @click="loadReadiness"
          >
            Re-check
          </button>
          <button
            v-if="canManage"
            class="secondary-button is-compact"
            data-testid="readiness-repair"
            :disabled="readinessBusy"
            @click="repairReadiness"
          >
            {{ readinessBusy ? 'Seeding…' : 'Re-seed defaults' }}
          </button>
        </div>
      </div>

      <p v-if="readinessNotice" class="notice" role="status" data-testid="readiness-notice">
        {{ readinessNotice }}
      </p>
      <p
        v-if="readinessState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="readiness-error"
      >
        {{
          readinessMissing
            ? 'The notification readiness API is not available in this deployment, so whether an alert reaches anybody cannot be verified here.'
            : readinessError
        }}
      </p>
      <template v-else>
        <p
          v-if="readiness?.warning"
          class="warn-notice"
          role="alert"
          data-testid="readiness-warning"
        >
          {{ readiness.warning }}
        </p>

        <!-- The five figures behind the verdict, in one divided row. -->
        <div class="figure-row" data-testid="readiness-figures">
          <div>
            <b data-testid="readiness-deliverable">{{ deliverableCount }}</b>
            <span>Deliverable channels</span>
          </div>
          <div>
            <b data-testid="readiness-open-alerts">{{ Number(readiness?.openAlerts ?? 0) }}</b>
            <span>Open alerts</span>
          </div>
          <div>
            <b data-testid="readiness-undeliverable">{{
              Number(readiness?.undeliverableAlerts ?? 0)
            }}</b>
            <span>Reached nobody</span>
          </div>
          <div>
            <b data-testid="readiness-unnotified">{{ Number(readiness?.unnotifiedAlerts ?? 0) }}</b>
            <span>Not yet attempted</span>
          </div>
          <div>
            <b>{{ Number(readiness?.escalationPolicies ?? 0) }}</b>
            <span>Enabled policies</span>
          </div>
        </div>
      </template>
    </section>

    <!--
      Channels and policies side by side, because they are two halves of one
      answer: a deliverable channel nothing calls is as useless as a policy
      whose channels cannot deliver.
    -->
    <div class="response-grid">
      <section class="panel" data-testid="channels-panel" aria-label="Notification channels">
        <header class="panel-header">
          <div>
            <h2>Notification channels</h2>
            <p aria-live="polite">
              {{ deliverableCount }} of {{ readinessChannels.length }} can deliver right now
            </p>
          </div>
        </header>

        <!--
          A card per channel, not a five-column table.
          The table's "Why not" column was the only one carrying anything an
          operator could act on, and it was last. Here the reason sits under
          the channel it belongs to, with the step that depends on it.
        -->
        <ul class="channel-list">
          <li
            v-for="channel in readinessChannels"
            :key="text(channel.id)"
            :data-testid="`readiness-channel-${text(channel.id)}`"
          >
            <div class="channel-head">
              <strong>{{ text(channel.name) }}</strong>
              <span class="status-badge" :class="channel.deliverable ? 'good' : 'bad'">
                {{ channel.deliverable ? 'Deliverable' : 'Not deliverable' }}
              </span>
            </div>
            <p class="channel-transport mono">
              {{ text(channel.type)
              }}<template v-if="channel.enabled === false"> · disabled</template>
              <template v-if="text(channel.reason, '')"> · {{ text(channel.reason, '') }}</template>
            </p>
            <p v-if="stepUsing(channel)" class="channel-use">{{ stepUsing(channel) }}</p>
          </li>
          <li v-if="readinessState === 'ok' && !readinessChannels.length" class="channel-empty">
            <strong>No notification channels exist at all</strong>
            <p>
              Every alert reaches nobody.
              {{
                canManage
                  ? 'Re-seed defaults to create the always-deliverable dashboard channel.'
                  : 'Seeding the defaults requires the system.manage permission.'
              }}
            </p>
          </li>
          <li v-if="readinessState === 'loading'" class="channel-empty">Evaluating channels…</li>
        </ul>
        <p class="source-note">
          Deliverable means the transport is usable: SMTP_URL for email, an http(s) URL for a
          webhook, an MSISDN for SMS. It reports capability, not a delivery that happened.
        </p>
      </section>

      <!-- Escalation policies --------------------------------------------------- -->
      <section class="panel" data-testid="escalation-panel" aria-label="Escalation policies">
        <header class="panel-header">
          <div>
            <h2>Escalation policies</h2>
            <p aria-live="polite">
              {{
                policyState === 'loading'
                  ? 'Loading escalation policies…'
                  : `${policies.length} policy(ies) defined`
              }}
            </p>
          </div>
          <button
            v-if="canManage"
            class="primary-button"
            data-testid="policy-create"
            :disabled="policyBusy"
            @click="openPolicyForm()"
          >
            New policy
          </button>
        </header>
        <p class="source-note">
          A policy fires its steps in order once an alert has stayed open (unacknowledged) for the
          step's “after” interval. Acknowledging an alert stops its escalation.
        </p>

        <p v-if="policyNotice" class="notice" role="status" data-testid="policy-notice">
          {{ policyNotice }}
        </p>

        <!-- A Dialog, per the design system: a form that makes a record is an
           overlay, not a block that unfolds above the register it adds to. -->
        <ModalDialog
          :open="showPolicyForm"
          :title="editingPolicyId ? 'Edit escalation policy' : 'New escalation policy'"
          testid="policy-form"
          wide
          @close="closePolicyForm"
        >
          <label class="filter-select">
            <span>Name</span>
            <input
              v-model="policyName"
              data-testid="policy-name"
              type="text"
              placeholder="On-call tier 1"
            />
          </label>
          <label class="filter-select">
            <span>Enabled</span>
            <select v-model="policyEnabled" data-testid="policy-enabled">
              <option :value="true">Yes</option>
              <option :value="false">No</option>
            </select>
          </label>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">After (minutes)</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Target</th>
                  <th scope="col">Minimum severity</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(step, index) in policySteps"
                  :key="index"
                  :data-testid="`policy-step-${index}`"
                >
                  <td>
                    <input
                      v-model.number="step.afterMinutes"
                      :data-testid="`policy-step-after-${index}`"
                      type="number"
                      min="0"
                    />
                  </td>
                  <td>
                    <select
                      v-model="step.channelType"
                      :data-testid="`policy-step-channel-${index}`"
                    >
                      <option v-for="channel in CHANNEL_TYPES" :key="channel" :value="channel">
                        {{ channel }}
                      </option>
                    </select>
                  </td>
                  <td>
                    <input
                      v-model="step.target"
                      :data-testid="`policy-step-target-${index}`"
                      type="text"
                      placeholder="noc@example.com / https://hooks…"
                    />
                  </td>
                  <td>
                    <select v-model="step.severity" :data-testid="`policy-step-severity-${index}`">
                      <option value="">any</option>
                      <option v-for="severity in SEVERITIES" :key="severity" :value="severity">
                        {{ severity }}
                      </option>
                    </select>
                  </td>
                  <td class="row-actions">
                    <button
                      class="secondary-button danger-button"
                      :data-testid="`policy-step-remove-${index}`"
                      :disabled="policySteps.length <= 1"
                      @click="removeStep(index)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <label v-if="editingPolicyId" class="filter-select filter-search">
            <span>Change reason (audited)</span>
            <input v-model="policyReason" data-testid="policy-reason" type="text" />
          </label>

          <p v-if="policyFormError" class="form-error" role="alert" data-testid="policy-form-error">
            {{ policyFormError }}
          </p>
          <!-- "Add step" edits the form; it does not submit it, so it stays in
             the body rather than joining the two footer verbs. -->
          <div class="detail-actions">
            <button class="secondary-button" data-testid="policy-add-step" @click="addStep">
              Add step
            </button>
          </div>
          <template #footer>
            <button class="secondary-button" data-testid="policy-cancel" @click="closePolicyForm">
              Cancel
            </button>
            <button
              class="primary-button"
              data-testid="policy-save"
              :disabled="policyBusy"
              @click="savePolicy"
            >
              {{ policyBusy ? 'Saving…' : 'Save policy' }}
            </button>
          </template>
        </ModalDialog>

        <p
          v-if="policyState === 'error'"
          class="chart-empty"
          role="alert"
          data-testid="policy-error"
        >
          {{
            policyMissing
              ? 'The escalation policy API is not available in this deployment.'
              : policyError
          }}
        </p>
        <div v-else class="table-wrap">
          <!--
          A TIMELINE, NOT A SENTENCE IN A CELL.

          The chain was one line of text — "+0m → dashboard Default dashboard
          · +5m → email · +15m → webhook" — which is a policy described
          rather than a policy shown. Read as a rail, the shape of the
          escalation is the thing you see first: how long before it moves on,
          and which of those steps will do nothing because its channel
          cannot deliver.
        -->
          <ul class="policy-list">
            <li
              v-for="policy in policies"
              :key="text(policy.id)"
              :data-testid="`policy-row-${text(policy.id)}`"
            >
              <div class="policy-head">
                <div>
                  <strong>{{ text(policy.name) }}</strong>
                  <small class="row-id mono"
                    >{{ text(policy.id).split('-')[0] }} · created by
                    {{ text(policy.created_by ?? policy.createdBy) }} · updated
                    {{ agoWhen(policy.updated_at ?? policy.updatedAt) }}</small
                  >
                </div>
                <div class="policy-actions">
                  <span class="status-badge" :class="policy.enabled === false ? '' : 'good'">
                    {{ policy.enabled === false ? 'Disabled' : 'Enabled' }}
                  </span>
                  <template v-if="canManage">
                    <button
                      class="secondary-button is-compact"
                      :data-testid="`policy-edit-${text(policy.id)}`"
                      @click="openPolicyForm(policy)"
                    >
                      Edit
                    </button>
                    <button
                      class="secondary-button danger-button is-compact"
                      :data-testid="`policy-delete-${text(policy.id)}`"
                      :disabled="policyBusy"
                      @click="deletePolicy(policy)"
                    >
                      Delete
                    </button>
                  </template>
                </div>
              </div>

              <ol class="step-rail">
                <li
                  v-for="(step, index) in stepsOf(policy)"
                  :key="index"
                  :class="{ 'is-skipped': !channelCanDeliver(step.channelType) }"
                >
                  <span class="step-at mono">+{{ step.afterMinutes }}m</span>
                  <span class="step-node" aria-hidden="true"></span>
                  <span class="step-card">
                    <strong>{{ step.target || step.channelType }}</strong>
                    <span v-if="channelCanDeliver(step.channelType)" class="step-ok"
                      >Deliverable</span
                    >
                    <span v-else class="step-skip">Not deliverable, this step is skipped</span>
                  </span>
                </li>
                <li v-if="!stepsOf(policy).length" class="step-none">
                  This policy has no steps, so it escalates to nobody.
                </li>
              </ol>
            </li>

            <li
              v-if="policyState === 'ok' && !policies.length"
              class="policy-empty"
              data-testid="policy-empty"
            >
              <strong>No escalation policies</strong>
              <p>An alert that nobody acknowledges will never be escalated to anyone.</p>
            </li>
            <li v-if="policyState === 'loading'" class="policy-empty">
              Loading escalation policies…
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- Maintenance windows ---------------------------------------------------- -->
    <section class="panel" data-testid="maintenance-panel" aria-label="Maintenance windows">
      <header class="panel-header">
        <div>
          <h2>Maintenance windows</h2>
          <p aria-live="polite">
            {{
              windowState === 'loading'
                ? 'Loading maintenance windows…'
                : `${windows.length} window(s) · ${activeWindows.length} active now`
            }}
          </p>
        </div>
        <button
          v-if="canManage"
          class="primary-button"
          data-testid="maintenance-create"
          :disabled="windowBusy"
          @click="openWindowForm()"
        >
          Schedule window
        </button>
      </header>
      <!--
        This used to end "there is no per-alert 'suppress' action". There is:
        POST /alerts/:id/suppress, and the Alert Lifecycle screen already ships
        the control. Left uncorrected, the note sent operators looking for a
        capability the console had, and told them it did not exist.
      -->
      <p class="source-note">
        During a window, alert rule evaluation and escalation are suppressed for everything in its
        scope — this is how planned work is kept out of the alert stream. To silence one alert
        rather than a scope, use the per-alert suppress action on
        <RouterLink class="text-link" to="/alert-lifecycle">Alert Lifecycle</RouterLink>.
      </p>
      <p class="source-note" data-testid="maintenance-scope-note">
        Scoped windows match on the SMSC <strong>engine id</strong> carried by the metric samples
        the alert rules evaluate, which is what the picker below sends.
      </p>

      <p v-if="windowNotice" class="notice" role="status" data-testid="maintenance-notice">
        {{ windowNotice }}
      </p>

      <ModalDialog
        :open="showWindowForm"
        :title="editingWindowId ? 'Edit maintenance window' : 'Schedule maintenance window'"
        testid="maintenance-form"
        wide
        @close="closeWindowForm"
      >
        <label class="filter-select filter-search">
          <span>Name</span>
          <input
            v-model="windowName"
            data-testid="maintenance-name"
            type="text"
            placeholder="Carrier SMPP upgrade"
          />
        </label>
        <label class="filter-select">
          <span>Starts</span>
          <input v-model="windowStartsAt" data-testid="maintenance-starts" type="datetime-local" />
        </label>
        <label class="filter-select">
          <span>Ends</span>
          <input v-model="windowEndsAt" data-testid="maintenance-ends" type="datetime-local" />
        </label>
        <label class="filter-select">
          <span>Scope</span>
          <select v-model="windowScopeAll" data-testid="maintenance-scope-all">
            <option :value="true">Everything</option>
            <option :value="false">Selected SMSCs</option>
          </select>
        </label>
        <fieldset v-if="!windowScopeAll" class="role-checkboxes" data-testid="maintenance-smscs">
          <legend>SMSCs in scope</legend>
          <p v-if="smscOptionsError" class="source-note">{{ smscOptionsError }}</p>
          <label
            v-for="option in smscOptions"
            :key="option.value"
            class="role-option"
            :data-testid="`maintenance-smsc-${option.value}`"
          >
            <input v-model="windowScopeSmscs" type="checkbox" :value="option.value" />
            <span class="role-text"
              ><strong>{{ option.label }}</strong></span
            >
          </label>
          <p v-if="!smscOptions.length && !smscOptionsError" class="source-note">
            No SMSC connections are defined yet.
          </p>
        </fieldset>
        <label class="filter-select filter-search">
          <span>Reason (audited)</span>
          <input v-model="windowReason" data-testid="maintenance-reason" type="text" />
        </label>
        <p
          v-if="windowFormError"
          class="form-error"
          role="alert"
          data-testid="maintenance-form-error"
        >
          {{ windowFormError }}
        </p>
        <template #footer>
          <button
            class="secondary-button"
            data-testid="maintenance-cancel"
            @click="closeWindowForm"
          >
            Cancel
          </button>
          <button
            class="primary-button"
            data-testid="maintenance-save"
            :disabled="windowBusy"
            @click="saveWindow"
          >
            {{ windowBusy ? 'Saving…' : 'Save window' }}
          </button>
        </template>
      </ModalDialog>

      <p
        v-if="windowState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="maintenance-error"
      >
        {{
          windowMissing
            ? 'The maintenance window API is not available in this deployment.'
            : windowError
        }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Window</th>
              <th scope="col">Starts</th>
              <th scope="col">Ends</th>
              <th scope="col">Scope</th>
              <th scope="col">State</th>
              <th scope="col">Reason</th>
              <th v-if="canManage" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in windows"
              :key="text(row.id)"
              :data-testid="`maintenance-row-${text(row.id)}`"
            >
              <td>
                <strong>{{ text(row.name) }}</strong>
                <small class="row-id mono">{{ text(row.id) }}</small>
              </td>
              <td>{{ text(row.starts_at ?? row.startsAt) }}</td>
              <td>{{ text(row.ends_at ?? row.endsAt) }}</td>
              <td>{{ describeScope(row) }}</td>
              <td>
                <span class="status-badge" :class="isActiveNow(row) ? 'warn' : ''">
                  {{ isActiveNow(row) ? 'active' : 'scheduled/past' }}
                </span>
              </td>
              <td>{{ text(row.reason) }}</td>
              <td v-if="canManage" class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`maintenance-edit-${text(row.id)}`"
                  @click="openWindowForm(row)"
                >
                  Edit
                </button>
                <button
                  class="secondary-button danger-button"
                  :data-testid="`maintenance-delete-${text(row.id)}`"
                  :disabled="windowBusy"
                  @click="deleteWindow(row)"
                >
                  Delete
                </button>
              </td>
            </tr>
            <tr v-if="windowState === 'ok' && !windows.length">
              <td :colspan="canManage ? 7 : 6" class="empty-cell" data-testid="maintenance-empty">
                No maintenance windows are scheduled.
              </td>
            </tr>
            <tr v-if="windowState === 'loading'">
              <td :colspan="canManage ? 7 : 6" class="empty-cell">Loading maintenance windows…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Correlation groups ----------------------------------------------------- -->
    <section class="panel" data-testid="correlation-panel" aria-label="Alert correlation groups">
      <header class="panel-header">
        <div>
          <h2>Correlated alert groups</h2>
          <p aria-live="polite">
            {{
              correlationState === 'loading'
                ? 'Loading correlation groups…'
                : `${correlations.length} unresolved group(s)`
            }}
          </p>
        </div>
        <button
          class="secondary-button"
          data-testid="correlation-refresh"
          @click="loadCorrelations"
        >
          Refresh
        </button>
      </header>
      <p
        v-if="correlationState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="correlation-error"
      >
        {{ correlationError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Alerts</th>
              <th scope="col">Occurrences</th>
              <th scope="col">Max severity</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="group in correlations"
              :key="text(group.correlation_group)"
              :data-testid="`correlation-row-${text(group.correlation_group)}`"
            >
              <td class="mono">{{ text(group.correlation_group) }}</td>
              <td>{{ text(group.alert_count, '0') }}</td>
              <td>{{ text(group.total_occurrences, '0') }}</td>
              <td>
                <span class="status-badge" :class="severityTone(group.max_severity)">
                  {{ text(group.max_severity) }}
                </span>
              </td>
              <td>{{ text(group.first_seen) }}</td>
              <td>{{ text(group.last_seen) }}</td>
            </tr>
            <tr v-if="correlationState === 'ok' && !correlations.length">
              <td colspan="6" class="empty-cell" data-testid="correlation-empty">
                No unresolved alerts are correlated into groups.
              </td>
            </tr>
            <tr v-if="correlationState === 'loading'">
              <td colspan="6" class="empty-cell">Loading correlation groups…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* THE VERDICT BANNER ------------------------------------------------------
   Green or red, the sentence spelled out, and the age of the check beside
   it. Colour repeats the words; it never carries the meaning alone. */
.status-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  margin-bottom: 14px;
}
.status-banner.is-ok {
  border-color: var(--ok, #1a7f37);
  background: var(--ok-soft, #e6f4ea);
}
.status-banner.is-bad {
  border-color: var(--bad, #b42318);
  background: var(--bad-soft, #fbe6e2);
}
.banner-dot {
  width: 9px;
  height: 9px;
  margin-top: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-banner.is-ok .banner-dot {
  background: var(--ok, #1a7f37);
}
.status-banner.is-bad .banner-dot {
  background: var(--bad, #b42318);
}
.banner-text {
  flex: 1 1 320px;
  min-width: 0;
}
.banner-text h2 {
  margin: 0;
  font-size: 16px;
}
.banner-text p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.banner-age {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

/* Five figures, divided, one row. */
.figure-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--border);
  overflow: hidden;
}
@media (max-width: 880px) {
  .figure-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
.figure-row div {
  background: var(--surface);
  padding: 12px 16px;
}
.figure-row b {
  display: block;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.figure-row span {
  color: var(--muted);
  font-size: 12px;
}

/* Channels and policies side by side: two halves of one answer. */
.response-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 1100px) {
  .response-grid {
    grid-template-columns: 1fr;
  }
}

.channel-list,
.policy-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.channel-list > li,
.policy-list > li {
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
}
.channel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.channel-transport {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12px;
  word-break: break-word;
}
.channel-use {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.channel-empty,
.policy-empty {
  color: var(--muted);
  font-size: 13px;
}
.channel-empty p,
.policy-empty p {
  margin: 3px 0 0;
}

/* THE ESCALATION RAIL ------------------------------------------------------
   Offset on the left, a node on the rail, the step's card on the right. A
   step whose channel cannot deliver is tinted and says so, because the
   difference between "three steps" and "one step that will actually fire" is
   the whole point of this screen. */
.policy-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.policy-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}
.step-rail {
  list-style: none;
  margin: 0;
  padding: 0;
}
.step-rail > li {
  display: grid;
  grid-template-columns: 52px 16px minmax(0, 1fr);
  align-items: stretch;
  gap: 8px;
}
.step-at {
  padding-top: 11px;
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}
/* The rail is the node's ::after, so it stops at the last step instead of
   hanging below it. */
.step-node {
  position: relative;
  display: block;
}
.step-node::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 13px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--ok, #1a7f37);
  border-radius: 50%;
  background: var(--surface);
}
.step-rail > li:not(:last-child) .step-node::after {
  content: '';
  position: absolute;
  left: 7px;
  top: 23px;
  bottom: -4px;
  width: 1px;
  background: var(--border);
}
.step-rail > li.is-skipped .step-node::before {
  border-color: var(--warn, #9a6700);
}
.step-card {
  display: block;
  padding: 8px 11px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  min-width: 0;
}
.step-rail > li.is-skipped .step-card {
  border-color: var(--warn, #9a6700);
  background: var(--warn-soft, #fbf0d8);
}
.step-card strong {
  display: block;
  font-size: 13.5px;
}
.step-ok {
  color: var(--ok, #1a7f37);
  font-size: 12px;
}
.step-skip {
  color: var(--warn-strong, var(--warn, #9a6700));
  font-size: 12px;
}
.step-none {
  color: var(--muted);
  font-size: 12.5px;
}
</style>
<style src="./workspace-extras.css"></style>
