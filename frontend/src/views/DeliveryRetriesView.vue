<script setup lang="ts">
/**
 * DELIVERY RETRIES — what was re-sent, under which policy, and whether the
 * scanner is running.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `DeliveryRetryController` exposes nine operations and none of them had a
 * console surface. Retrying spends a customer's credit and puts real messages
 * on a carrier, and it could be switched on, tuned and swept only by calling
 * the API by hand — so nobody using the console could see whether it was on,
 * what it had done, or why a particular failure had not been retried.
 *
 * THREE TABS, IN THE ORDER THE QUESTIONS ARRIVE
 * ---------------------------------------------------------------------------
 *   Chains    which messages were retried and how they ended
 *   Attempts  each individual re-send, the bind it used and what it cost
 *   Policy    what the rules are, and what they WOULD do for a given pairing
 *
 * THE RULE THIS SCREEN KEEPS
 * ---------------------------------------------------------------------------
 * Retrying is a sending act, not a viewing one. Every control that changes
 * behaviour — saving a policy, running a scan, changing the poll interval — is
 * gated on `messages.send`, exactly as the controller gates it, and the screen
 * names the missing permission rather than hiding the control and leaving its
 * absence unexplained.
 *
 * Backend contract:
 *   GET  /delivery-retries                  chains grid          (messages.view)
 *   GET  /delivery-retries/attempts         attempts grid
 *   GET  /delivery-retries/:id              one chain, expanded
 *   GET  /delivery-retries/status           scanner watermark and counters
 *   GET  /delivery-retries/policies         configured + built-in defaults
 *   GET  /delivery-retries/policies/effective?smscId&customerId
 *   PUT  /delivery-retries/policies         upsert one scope     (messages.send)
 *   DELETE /delivery-retries/policies/:id
 *   POST /delivery-retries/scan             sweep now
 *   POST /delivery-retries/poll-interval    how often it sweeps
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import TabStrip from '../components/TabStrip.vue';
import { canAccess, session } from '../stores/session';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import { formatDuration } from '../utils/traffic';

type RecordValue = Record<string, unknown>;

const canSend = computed(() => canAccess(session.value, 'messages.send'));

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function scalar(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}
function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function stateFor(cause: unknown): State {
  return cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

const tab = ref('chains');
const TABS = computed(() => [
  { id: 'chains', label: 'Chains', count: chains.value.length || null },
  { id: 'attempts', label: 'Attempts', count: attempts.value.length || null },
  { id: 'policy', label: 'Policy', count: policies.value.length || null },
]);

// --- Scanner status ------------------------------------------------------------
const status = ref<RecordValue | null>(null);
const statusState = ref<State>('loading');
const actionError = ref('');
const actionNotice = ref('');
const actionBusy = ref(false);

async function loadStatus() {
  statusState.value = 'loading';
  try {
    status.value = await apiRequest<RecordValue>('/delivery-retries/status');
    statusState.value = 'live';
  } catch (cause) {
    status.value = null;
    statusState.value = stateFor(cause);
  }
}

async function runScan() {
  actionBusy.value = true;
  actionError.value = '';
  actionNotice.value = '';
  try {
    const result = await apiRequest<RecordValue>('/delivery-retries/scan', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // The scanner's own words. "Opened 0 chains" is a real and useful answer —
    // it means nothing qualified, not that the scan failed to run.
    actionNotice.value = `Scan complete. ${text(result?.opened ?? result?.chainsOpened, '0')} chain(s) opened.`;
    await Promise.all([loadStatus(), loadChains()]);
  } catch (cause) {
    actionError.value = messageFrom(cause, 'The scan could not be run.');
  } finally {
    actionBusy.value = false;
  }
}

const draftInterval = ref<number | null>(null);

async function savePollInterval() {
  if (draftInterval.value === null || draftInterval.value <= 0) {
    actionError.value = 'Enter how many seconds between sweeps.';
    return;
  }
  actionBusy.value = true;
  actionError.value = '';
  actionNotice.value = '';
  try {
    await apiRequest('/delivery-retries/poll-interval', {
      method: 'POST',
      body: JSON.stringify({ pollIntervalSeconds: draftInterval.value }),
    });
    actionNotice.value = 'Sweep interval saved.';
    await loadStatus();
  } catch (cause) {
    actionError.value = messageFrom(cause, 'The interval could not be saved.');
  } finally {
    actionBusy.value = false;
  }
}

// --- Chains --------------------------------------------------------------------
const chains = ref<RecordValue[]>([]);
const chainState = ref<State>('loading');
const chainError = ref('');
const expandedChain = ref('');
const chainDetail = ref<RecordValue | null>(null);

async function loadChains() {
  chainState.value = 'loading';
  try {
    chains.value = asItems(await apiRequest('/delivery-retries?limit=50&sort=-createdAt'));
    chainError.value = '';
    chainState.value = chains.value.length ? 'live' : 'empty';
  } catch (cause) {
    chains.value = [];
    chainError.value = messageFrom(cause, 'Retry chains could not be read.');
    chainState.value = stateFor(cause);
  }
}

async function openChain(id: string) {
  if (expandedChain.value === id) {
    expandedChain.value = '';
    chainDetail.value = null;
    return;
  }
  expandedChain.value = id;
  chainDetail.value = null;
  try {
    chainDetail.value = await apiRequest<RecordValue>(`/delivery-retries/${id}`);
  } catch (cause) {
    chainError.value = messageFrom(cause, 'That chain could not be read.');
  }
}

// --- Attempts ------------------------------------------------------------------
const attempts = ref<RecordValue[]>([]);
const attemptState = ref<State>('loading');
const attemptError = ref('');

async function loadAttempts() {
  attemptState.value = 'loading';
  try {
    attempts.value = asItems(
      await apiRequest('/delivery-retries/attempts?limit=50&sort=-createdAt'),
    );
    attemptError.value = '';
    attemptState.value = attempts.value.length ? 'live' : 'empty';
  } catch (cause) {
    attempts.value = [];
    attemptError.value = messageFrom(cause, 'Retry attempts could not be read.');
    attemptState.value = stateFor(cause);
  }
}

// --- Policy --------------------------------------------------------------------
const policies = ref<RecordValue[]>([]);
const defaults = ref<RecordValue | null>(null);
const policyState = ref<State>('loading');
const policyError = ref('');

async function loadPolicies() {
  policyState.value = 'loading';
  try {
    const payload = await apiRequest<RecordValue>('/delivery-retries/policies');
    policies.value = asItems(payload?.policies ?? payload);
    defaults.value = (payload?.defaults as RecordValue) ?? null;
    policyError.value = '';
    policyState.value = 'live';
  } catch (cause) {
    policies.value = [];
    defaults.value = null;
    policyError.value = messageFrom(cause, 'Retry policies could not be read.');
    policyState.value = stateFor(cause);
  }
}

/* The policy form. Bounds mirror the server's own parser so a value it would
 * reject is caught while the operator can still see the field, rather than
 * coming back as a 400 after the form has been submitted. */
const draft = ref({
  scope: 'tenant',
  smscId: '',
  customerId: '',
  enabled: false,
  maxAttempts: 1,
  retryOnFailed: true,
  retryOnRejected: false,
  minDelaySeconds: 60,
  maxAgeSeconds: 3600,
  requireDifferentBind: true,
  chargeCreditOnRetry: true,
});

const policyBusy = ref(false);

async function savePolicy() {
  policyBusy.value = true;
  policyError.value = '';
  try {
    const body: RecordValue = { ...draft.value };
    if (draft.value.scope !== 'smsc') delete body.smscId;
    if (draft.value.scope !== 'customer') delete body.customerId;
    await apiRequest('/delivery-retries/policies', { method: 'PUT', body: JSON.stringify(body) });
    await Promise.all([loadPolicies(), loadStatus()]);
  } catch (cause) {
    policyError.value = messageFrom(cause, 'The policy could not be saved.');
  } finally {
    policyBusy.value = false;
  }
}

async function removePolicy(id: string) {
  policyBusy.value = true;
  policyError.value = '';
  try {
    await apiRequest(`/delivery-retries/policies/${id}`, { method: 'DELETE' });
    await loadPolicies();
  } catch (cause) {
    policyError.value = messageFrom(cause, 'The policy could not be removed.');
  } finally {
    policyBusy.value = false;
  }
}

/* --- WHICH POLICY WOULD APPLY -------------------------------------------------
 *
 * Answers "why was this failure not retried" without making somebody resolve
 * three scopes by hand. Most-specific-wins is resolved by the server, so the
 * answer here is the one the scanner would actually use.
 */
const probeSmscId = ref('');
const probeCustomerId = ref('');
const effective = ref<RecordValue | null>(null);
const effectiveError = ref('');

async function resolveEffective() {
  effectiveError.value = '';
  const params = new URLSearchParams();
  if (probeSmscId.value.trim()) params.set('smscId', probeSmscId.value.trim());
  if (probeCustomerId.value.trim()) params.set('customerId', probeCustomerId.value.trim());
  try {
    effective.value = await apiRequest<RecordValue>(
      `/delivery-retries/policies/effective?${params.toString()}`,
    );
  } catch (cause) {
    effective.value = null;
    effectiveError.value = messageFrom(cause, 'The effective policy could not be resolved.');
  }
}

function policyLine(policy: RecordValue | null): string {
  if (!policy) return '';
  if (policy.enabled === false)
    return 'Retrying is OFF for this pairing. A failed message is not re-sent.';
  const attemptsAllowed = text(policy.maxAttempts ?? policy.max_attempts, '?');
  const delay = Number(policy.minDelaySeconds ?? policy.min_delay_seconds);
  return `Up to ${attemptsAllowed} attempt(s), no sooner than ${
    Number.isFinite(delay) ? formatDuration(delay) : '?'
  } after the failure.`;
}

onMounted(() => {
  void loadStatus();
  void loadChains();
  void loadAttempts();
  void loadPolicies();
});
</script>

<template>
  <div data-testid="delivery-retries-view">
    <!--
      What retrying costs, stated before anything that turns it on. A retry is
      a real submission: it spends credit and puts a message on a carrier.
    -->
    <section class="panel scope-note" data-testid="retries-scope">
      <h2>Retrying re-sends real messages</h2>
      <p>
        A retry goes through the ordinary send path. It consumes the customer's quota, it is
        billable unless the policy says otherwise, and it reaches a real handset — so enabling a
        policy, running a sweep and changing the interval all need the
        <span class="mono">messages.send</span> permission, the same one that submits a message.
      </p>
    </section>

    <!-- SCANNER STATUS ------------------------------------------------------ -->
    <section class="panel" data-testid="retries-status" aria-labelledby="retries-status-heading">
      <header class="panel-header">
        <div>
          <h2 id="retries-status-heading">Scanner</h2>
          <p>The sweep that finds failed messages and opens a retry chain for them.</p>
        </div>
        <button
          v-if="canSend"
          class="secondary-button"
          type="button"
          :disabled="actionBusy"
          data-testid="retries-scan"
          @click="runScan"
        >
          {{ actionBusy ? 'Sweeping…' : 'Sweep now' }}
        </button>
      </header>

      <p v-if="actionNotice" class="notice" role="status" data-testid="retries-notice">
        {{ actionNotice }}
      </p>
      <p v-if="actionError" class="form-error" role="alert" data-testid="retries-error">
        {{ actionError }}
      </p>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="retries-last-sweep">{{
            status?.lastScanAt || status?.last_scan_at
              ? formatMoment(text(status?.lastScanAt ?? status?.last_scan_at, ''))
              : 'never swept'
          }}</strong>
          <small>last sweep</small>
        </div>
        <div class="metric">
          <strong>{{
            displayValue(scalar(status?.chainsOpened ?? status?.chains_opened), statusState)
          }}</strong>
          <small>chains opened, lifetime</small>
        </div>
        <div class="metric">
          <strong>{{
            displayValue(
              scalar(status?.pollIntervalSeconds ?? status?.poll_interval_seconds),
              statusState,
            )
          }}</strong>
          <small>seconds between sweeps</small>
        </div>
      </div>

      <div v-if="canSend" class="field-grid" data-testid="retries-interval-form">
        <label class="filter-select">
          <span>Sweep every (seconds)</span>
          <input
            v-model.number="draftInterval"
            type="number"
            min="1"
            data-testid="retries-interval"
          />
        </label>
        <button
          class="secondary-button"
          type="button"
          :disabled="actionBusy"
          data-testid="retries-interval-save"
          @click="savePollInterval"
        >
          Save interval
        </button>
      </div>
      <p v-else class="source-note" data-testid="retries-readonly">
        Sweeping and changing the interval need <span class="mono">messages.send</span>. Everything
        below is readable without it.
      </p>
    </section>

    <TabStrip
      v-model="tab"
      :tabs="TABS"
      label="Delivery retries"
      testid="retries-tab"
      class="retries-tabs"
    />

    <!-- CHAINS -------------------------------------------------------------- -->
    <section
      v-show="tab === 'chains'"
      id="retries-tab-panel-chains"
      role="tabpanel"
      aria-labelledby="retries-tab-chains"
      class="panel"
      data-testid="retries-chains"
    >
      <header class="panel-header">
        <div>
          <h2>Retry chains</h2>
          <p>One row per message a carrier failed to deliver and this platform tried again.</p>
        </div>
      </header>

      <p v-if="chainError" class="form-error" role="alert">{{ chainError }}</p>

      <DataState
        :state="chainState"
        subject="retry chains"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          chainState === 'empty'
            ? 'No message has been retried. With no policy enabled that is the expected result, not a gap — the Policy tab says what is configured.'
            : undefined
        "
        permission="messages.view"
        testid="chains-state"
        :on-retry="loadChains"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Opened</th>
                <th scope="col">Original message</th>
                <th scope="col">Trigger</th>
                <th scope="col">Attempts</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="chain in chains" :key="text(chain.id)">
                <tr :data-testid="`chain-${text(chain.id)}`">
                  <td class="mono">
                    {{ formatMoment(text(chain.created_at ?? chain.createdAt, '')) }}
                  </td>
                  <td class="mono cell-tight">
                    {{ text(chain.original_message_id ?? chain.originalMessageId) }}
                  </td>
                  <td class="mono cell-tight">
                    {{ text(chain.trigger_dlr_event ?? chain.triggerDlrEvent) }}
                  </td>
                  <td class="mono">{{ displayValue(scalar(chain.attempts), chainState) }}</td>
                  <td>
                    <span
                      class="status-badge"
                      :class="
                        text(chain.status) === 'delivered'
                          ? 'good'
                          : text(chain.status) === 'exhausted'
                            ? 'bad'
                            : 'warn'
                      "
                      >{{ text(chain.status) }}</span
                    >
                  </td>
                  <td class="row-actions">
                    <button
                      class="secondary-button"
                      type="button"
                      :data-testid="`chain-open-${text(chain.id)}`"
                      @click="openChain(text(chain.id, ''))"
                    >
                      {{ expandedChain === text(chain.id) ? 'Hide' : 'Expand' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedChain === text(chain.id)">
                  <td colspan="6">
                    <pre
                      v-if="chainDetail"
                      class="json-block"
                      :data-testid="`chain-detail-${text(chain.id)}`"
                      >{{ JSON.stringify(chainDetail, null, 2) }}</pre>
                    <p v-else class="source-note">Reading the chain…</p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </DataState>
    </section>

    <!-- ATTEMPTS ------------------------------------------------------------ -->
    <section
      v-show="tab === 'attempts'"
      id="retries-tab-panel-attempts"
      role="tabpanel"
      aria-labelledby="retries-tab-attempts"
      class="panel"
      data-testid="retries-attempts"
    >
      <header class="panel-header">
        <div>
          <h2>Attempts</h2>
          <p>
            Each individual re-send: which bind carried it, which binds were excluded, and how it
            ended.
          </p>
        </div>
      </header>

      <p v-if="attemptError" class="form-error" role="alert">{{ attemptError }}</p>

      <DataState
        :state="attemptState"
        subject="retry attempts"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          attemptState === 'empty'
            ? 'No re-send has been made. Chains open before their first attempt, so an empty list beside open chains means the first attempt has not come due yet.'
            : undefined
        "
        permission="messages.view"
        testid="attempts-state"
        :on-retry="loadAttempts"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Chain</th>
                <th scope="col">Attempt</th>
                <th scope="col">Bind used</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="attempt in attempts"
                :key="text(attempt.id)"
                :data-testid="`attempt-${text(attempt.id)}`"
              >
                <td class="mono">
                  {{ formatMoment(text(attempt.created_at ?? attempt.createdAt, '')) }}
                </td>
                <td class="mono cell-tight">{{ text(attempt.chain_id ?? attempt.chainId) }}</td>
                <td class="mono">
                  {{
                    displayValue(
                      scalar(attempt.attempt_number ?? attempt.attemptNumber),
                      attemptState,
                    )
                  }}
                </td>
                <td class="mono cell-tight">
                  {{ text(attempt.smsc_id ?? attempt.smscId, 'not recorded') }}
                </td>
                <td>{{ text(attempt.outcome ?? attempt.status) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>
    </section>

    <!-- POLICY -------------------------------------------------------------- -->
    <section
      v-show="tab === 'policy'"
      id="retries-tab-panel-policy"
      role="tabpanel"
      aria-labelledby="retries-tab-policy"
      class="panel"
      data-testid="retries-policy"
    >
      <header class="panel-header">
        <div>
          <h2>Policy</h2>
          <p>
            Configured policies, and the built-in defaults that apply where none matches. Most
            specific wins: a customer policy beats an SMSC one, which beats the tenant's.
          </p>
        </div>
      </header>

      <p v-if="policyError" class="form-error" role="alert" data-testid="policy-error">
        {{ policyError }}
      </p>

      <DataState
        :state="policyState"
        subject="retry policies"
        skeleton="table"
        :skeleton-rows="3"
        permission="messages.view"
        testid="policy-state"
        :on-retry="loadPolicies"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Enabled</th>
                <th scope="col">Max attempts</th>
                <th scope="col">Min delay</th>
                <th scope="col">Retries on</th>
                <th scope="col">Charges credit</th>
                <th v-if="canSend" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="policy in policies"
                :key="text(policy.policyId ?? policy.policy_id ?? policy.scope)"
                :data-testid="`policy-${text(policy.scope)}`"
              >
                <td class="mono">{{ text(policy.scope) }}</td>
                <td>
                  <span class="status-badge" :class="policy.enabled ? 'good' : 'muted'">
                    {{ policy.enabled ? 'on' : 'off' }}
                  </span>
                </td>
                <td class="mono">
                  {{ displayValue(scalar(policy.maxAttempts ?? policy.max_attempts), policyState) }}
                </td>
                <td class="mono">
                  {{
                    formatDuration(Number(policy.minDelaySeconds ?? policy.min_delay_seconds) || 0)
                  }}
                </td>
                <td>
                  {{
                    [
                      (policy.retryOnFailed ?? policy.retry_on_failed) ? 'failed' : '',
                      (policy.retryOnRejected ?? policy.retry_on_rejected) ? 'rejected' : '',
                    ]
                      .filter(Boolean)
                      .join(', ') || 'nothing'
                  }}
                </td>
                <td>
                  {{ (policy.chargeCreditOnRetry ?? policy.charge_credit_on_retry) ? 'yes' : 'no' }}
                </td>
                <td v-if="canSend" class="row-actions">
                  <button
                    v-if="policy.policyId ?? policy.policy_id"
                    class="secondary-button danger-button"
                    type="button"
                    :disabled="policyBusy"
                    :data-testid="`policy-remove-${text(policy.scope)}`"
                    @click="removePolicy(text(policy.policyId ?? policy.policy_id, ''))"
                  >
                    Remove
                  </button>
                  <span v-else class="cell-health">built in</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <p v-if="defaults" class="source-note" data-testid="policy-defaults">
        With nothing configured the built-in default applies, and it is
        <strong>{{ defaults.enabled ? 'on' : 'off' }}</strong> — read from the server rather than
        written into this screen, so it cannot drift from what the scanner does.
      </p>

      <!-- WHICH POLICY WOULD APPLY -->
      <h3 class="probe-heading">Which policy would apply</h3>
      <p class="source-note">
        Answers “why was this failure not retried” without resolving three scopes by hand. Leave
        both boxes empty for the tenant-wide answer.
      </p>
      <div class="field-grid" data-testid="policy-probe">
        <label class="filter-select">
          <span>SMSC id</span>
          <input v-model="probeSmscId" type="text" data-testid="probe-smsc" />
        </label>
        <label class="filter-select">
          <span>Customer id</span>
          <input v-model="probeCustomerId" type="text" data-testid="probe-customer" />
        </label>
        <button
          class="secondary-button"
          type="button"
          data-testid="probe-resolve"
          @click="resolveEffective"
        >
          Resolve
        </button>
      </div>
      <p v-if="effectiveError" class="form-error" role="alert">{{ effectiveError }}</p>
      <p v-else-if="effective" class="notice" role="status" data-testid="probe-result">
        <strong>{{ text(effective.scope) }} policy.</strong> {{ policyLine(effective) }}
      </p>

      <!-- SAVE A POLICY -->
      <template v-if="canSend">
        <h3 class="probe-heading">Set a policy</h3>
        <div class="field-grid" data-testid="policy-form">
          <label class="filter-select">
            <span>Scope</span>
            <select v-model="draft.scope" data-testid="draft-scope">
              <option value="tenant">tenant — everything</option>
              <option value="smsc">smsc — one connection</option>
              <option value="customer">customer — one account</option>
            </select>
          </label>
          <label v-if="draft.scope === 'smsc'" class="filter-select">
            <span>SMSC id</span>
            <input v-model="draft.smscId" type="text" data-testid="draft-smsc" />
          </label>
          <label v-if="draft.scope === 'customer'" class="filter-select">
            <span>Customer id</span>
            <input v-model="draft.customerId" type="text" data-testid="draft-customer" />
          </label>
          <label class="filter-select">
            <span>Max attempts (1–5)</span>
            <input
              v-model.number="draft.maxAttempts"
              type="number"
              min="1"
              max="5"
              data-testid="draft-attempts"
            />
          </label>
          <label class="filter-select">
            <span>Min delay (seconds)</span>
            <input v-model.number="draft.minDelaySeconds" type="number" min="0" />
          </label>
          <label class="filter-select">
            <span>Give up after (seconds)</span>
            <input v-model.number="draft.maxAgeSeconds" type="number" min="0" />
          </label>
        </div>
        <div class="toggle-row">
          <label
            ><input v-model="draft.enabled" type="checkbox" data-testid="draft-enabled" />
            Enabled</label
          >
          <label><input v-model="draft.retryOnFailed" type="checkbox" /> Retry on failed</label>
          <label><input v-model="draft.retryOnRejected" type="checkbox" /> Retry on rejected</label>
          <label
            ><input v-model="draft.requireDifferentBind" type="checkbox" /> Require a different
            bind</label
          >
          <label><input v-model="draft.chargeCreditOnRetry" type="checkbox" /> Charge credit</label>
        </div>
        <footer class="detail-actions">
          <button
            class="primary-button"
            type="button"
            :disabled="policyBusy"
            data-testid="policy-save"
            @click="savePolicy"
          >
            {{ policyBusy ? 'Saving…' : 'Save policy' }}
          </button>
        </footer>
        <p class="source-note">
          Turning a policy on also starts the scanner, so retrying begins rather than waiting for an
          unrelated event. Switching credit charging off suppresses the DEBIT only — the retry still
          consumes the customer's quota, because it goes through the shared send path.
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* The margin is the shared `.panel` rule's — this only adds the accent. */
.scope-note {
  border-left: 3px solid var(--warn);
}
/* Not a panel, so it needs the gap explicitly; the token keeps it in step. */
.retries-tabs {
  margin-bottom: var(--gap-panel);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
.toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
  font-size: 13.5px;
}
.toggle-row label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.probe-heading {
  margin: 22px 0 6px;
  font-size: 14px;
}
.cell-tight {
  font-size: 12.5px;
}
</style>
<style src="./workspace-extras.css"></style>
