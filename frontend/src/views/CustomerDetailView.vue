<script setup lang="ts">
/**
 * CUSTOMER DETAIL — entitlements, quota, credit and sender IDs.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `CustomerAccountsController` exposes fifteen operations — quota, credit
 * ledger, sender-id approval and route bindings — and until now not one of them
 * had a console surface. The customers workspace could list accounts and edit
 * their record; everything an operator actually does to an account after it
 * exists could only be done by calling the API by hand.
 *
 * FOUR TABS, BECAUSE THEY ARE FOUR JOBS
 * ---------------------------------------------------------------------------
 * Setting a monthly quota, posting a credit adjustment, approving a sender id
 * and binding a route are done by different people at different times. Stacked
 * down one page they would compete; as tabs each is the whole screen while you
 * are doing it.
 *
 * THE RULE THIS SCREEN KEEPS
 * ---------------------------------------------------------------------------
 * Every figure here is read back from the API after a change rather than
 * patched into local state. A quota this console believes it set, but which the
 * server rejected or clamped, is the kind of disagreement that only shows up
 * when a customer is throttled unexpectedly — so the write is followed by a
 * read, always.
 *
 * Backend contract (all under `/customer-accounts/:id`):
 *   GET/PUT/DELETE quota, POST quota/consume        (system.view / system.manage)
 *   GET credit, GET/POST credit/transactions
 *   GET/POST sender-ids, PATCH/DELETE sender-ids/:sid
 *   GET/POST routes, PATCH/DELETE routes/:bindingId
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import TabStrip from '../components/TabStrip.vue';
import { canAccess, session } from '../stores/session';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';

type RecordValue = Record<string, unknown>;

const route = useRoute();
const customerId = computed(() => String(route.params.id ?? ''));

const canManage = computed(() => canAccess(session.value, 'system.manage'));

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function stateFor(cause: unknown): State {
  return cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
}
/**
 * Narrows a JSONB-ish value for `displayValue`, which distinguishes "not
 * measured" from a number and needs to know which it has. Anything that is not
 * a string or a finite number is treated as absent rather than stringified —
 * an object rendered into a numeric cell is worse than an em dash.
 */
function scalar(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

const tab = ref('quota');
const TABS = computed(() => [
  { id: 'quota', label: 'Quota', count: quotas.value.length || null },
  { id: 'credit', label: 'Credit', count: transactions.value.length || null },
  { id: 'sender-ids', label: 'Sender IDs', count: senderIds.value.length || null },
  { id: 'routes', label: 'Routes', count: bindings.value.length || null },
]);

// --- The account itself --------------------------------------------------------
const customer = ref<RecordValue | null>(null);
const customerState = ref<State>('loading');
const notFound = ref(false);

async function loadCustomer() {
  customerState.value = 'loading';
  notFound.value = false;
  try {
    customer.value = await apiRequest<RecordValue>(`/customers/${customerId.value}`);
    customerState.value = 'live';
    setBreadcrumbTrail(route.path, [
      { label: 'Customers', to: '/customers' },
      { label: text(customer.value?.name, customerId.value) },
    ]);
  } catch (cause) {
    customer.value = null;
    notFound.value = cause instanceof ApiError && cause.status === 404;
    customerState.value = stateFor(cause);
  }
}

// --- Quota ---------------------------------------------------------------------
const PERIODS = ['daily', 'monthly'] as const;

const quotas = ref<RecordValue[]>([]);
const quotaState = ref<State>('loading');
const quotaError = ref('');
const quotaBusy = ref(false);
const draftPeriod = ref<string>('daily');
const draftLimit = ref<number | null>(null);

async function loadQuota() {
  quotaState.value = 'loading';
  try {
    quotas.value = asItems(await apiRequest(`/customer-accounts/${customerId.value}/quota`));
    quotaError.value = '';
    quotaState.value = quotas.value.length ? 'live' : 'empty';
  } catch (cause) {
    quotas.value = [];
    quotaError.value = messageFrom(cause, 'Quota could not be read.');
    quotaState.value = stateFor(cause);
  }
}

async function saveQuota() {
  if (draftLimit.value === null || draftLimit.value < 0) {
    quotaError.value = 'Enter a limit of zero or more. Zero means no messages may be sent.';
    return;
  }
  quotaBusy.value = true;
  quotaError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/quota`, {
      method: 'PUT',
      body: JSON.stringify({ period: draftPeriod.value, limit: draftLimit.value }),
    });
    // Read back rather than patch locally: a limit the console believes it set
    // but the server clamped only surfaces when a customer is throttled.
    await loadQuota();
  } catch (cause) {
    quotaError.value = messageFrom(cause, 'The quota could not be saved.');
  } finally {
    quotaBusy.value = false;
  }
}

async function removeQuota(period: string) {
  quotaBusy.value = true;
  quotaError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/quota/${encodeURIComponent(period)}`, {
      method: 'DELETE',
    });
    await loadQuota();
  } catch (cause) {
    quotaError.value = messageFrom(cause, 'The quota could not be removed.');
  } finally {
    quotaBusy.value = false;
  }
}

// --- Credit --------------------------------------------------------------------
const balance = ref<RecordValue | null>(null);
const transactions = ref<RecordValue[]>([]);
const creditState = ref<State>('loading');
const creditError = ref('');
const creditBusy = ref(false);
const draftDirection = ref<'credit' | 'debit'>('credit');
const draftAmount = ref<number | null>(null);
const draftReason = ref('');
const draftReference = ref('');

async function loadCredit() {
  creditState.value = 'loading';
  try {
    const [account, ledger] = await Promise.all([
      apiRequest<RecordValue>(`/customer-accounts/${customerId.value}/credit`),
      apiRequest(`/customer-accounts/${customerId.value}/credit/transactions?limit=50`),
    ]);
    balance.value = account;
    transactions.value = asItems(ledger);
    creditError.value = '';
    creditState.value = 'live';
  } catch (cause) {
    balance.value = null;
    transactions.value = [];
    creditError.value = messageFrom(cause, 'The credit ledger could not be read.');
    creditState.value = stateFor(cause);
  }
}

async function postTransaction() {
  if (draftAmount.value === null || draftAmount.value <= 0) {
    creditError.value = 'Enter an amount greater than zero.';
    return;
  }
  creditBusy.value = true;
  creditError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/credit/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        direction: draftDirection.value,
        amount: draftAmount.value,
        reason: draftReason.value.trim() || undefined,
        reference: draftReference.value.trim() || undefined,
      }),
    });
    draftAmount.value = null;
    draftReason.value = '';
    draftReference.value = '';
    await loadCredit();
  } catch (cause) {
    creditError.value = messageFrom(cause, 'The adjustment could not be posted.');
  } finally {
    creditBusy.value = false;
  }
}

// --- Sender IDs ----------------------------------------------------------------
const senderIds = ref<RecordValue[]>([]);
const senderState = ref<State>('loading');
const senderError = ref('');
const senderBusy = ref('');
const draftSenderId = ref('');

async function loadSenderIds() {
  senderState.value = 'loading';
  try {
    senderIds.value = asItems(await apiRequest(`/customer-accounts/${customerId.value}/sender-ids`));
    senderError.value = '';
    senderState.value = senderIds.value.length ? 'live' : 'empty';
  } catch (cause) {
    senderIds.value = [];
    senderError.value = messageFrom(cause, 'Sender IDs could not be read.');
    senderState.value = stateFor(cause);
  }
}

async function requestSenderId() {
  const value = draftSenderId.value.trim();
  if (!value) {
    senderError.value = 'Enter the sender id to register.';
    return;
  }
  senderBusy.value = 'new';
  senderError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/sender-ids`, {
      method: 'POST',
      body: JSON.stringify({ senderId: value }),
    });
    draftSenderId.value = '';
    await loadSenderIds();
  } catch (cause) {
    senderError.value = messageFrom(cause, 'The sender id could not be registered.');
  } finally {
    senderBusy.value = '';
  }
}

async function reviewSenderId(sid: string, status: 'approved' | 'rejected') {
  senderBusy.value = sid;
  senderError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/sender-ids/${sid}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadSenderIds();
  } catch (cause) {
    senderError.value = messageFrom(cause, `The sender id could not be ${status}.`);
  } finally {
    senderBusy.value = '';
  }
}

async function deleteSenderId(sid: string) {
  senderBusy.value = sid;
  senderError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/sender-ids/${sid}`, {
      method: 'DELETE',
    });
    await loadSenderIds();
  } catch (cause) {
    senderError.value = messageFrom(cause, 'The sender id could not be removed.');
  } finally {
    senderBusy.value = '';
  }
}

// --- Route bindings ------------------------------------------------------------
const bindings = ref<RecordValue[]>([]);
const bindingState = ref<State>('loading');
const bindingError = ref('');
const bindingBusy = ref('');
const routeOptions = ref<RecordValue[]>([]);
const draftRouteId = ref('');
const draftPriority = ref<number | null>(null);

async function loadBindings() {
  bindingState.value = 'loading';
  try {
    bindings.value = asItems(await apiRequest(`/customer-accounts/${customerId.value}/routes`));
    bindingError.value = '';
    bindingState.value = bindings.value.length ? 'live' : 'empty';
  } catch (cause) {
    bindings.value = [];
    bindingError.value = messageFrom(cause, 'Route bindings could not be read.');
    bindingState.value = stateFor(cause);
  }
}

async function loadRouteOptions() {
  try {
    routeOptions.value = asItems(await apiRequest('/routes?limit=200&offset=0'));
  } catch {
    // A binding can still be created by id; losing the picker is not fatal.
    routeOptions.value = [];
  }
}

async function bindRoute() {
  if (!draftRouteId.value) {
    bindingError.value = 'Choose a route to bind.';
    return;
  }
  bindingBusy.value = 'new';
  bindingError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/routes`, {
      method: 'POST',
      body: JSON.stringify({
        routeId: draftRouteId.value,
        ...(draftPriority.value === null ? {} : { priority: draftPriority.value }),
      }),
    });
    draftRouteId.value = '';
    draftPriority.value = null;
    await loadBindings();
  } catch (cause) {
    bindingError.value = messageFrom(cause, 'The route could not be bound.');
  } finally {
    bindingBusy.value = '';
  }
}

async function toggleBinding(binding: RecordValue) {
  const id = text(binding.id, '');
  if (!id || id === '—') return;
  bindingBusy.value = id;
  bindingError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/routes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !(binding.enabled !== false) }),
    });
    await loadBindings();
  } catch (cause) {
    bindingError.value = messageFrom(cause, 'The binding could not be updated.');
  } finally {
    bindingBusy.value = '';
  }
}

async function unbindRoute(binding: RecordValue) {
  const id = text(binding.id, '');
  if (!id || id === '—') return;
  bindingBusy.value = id;
  bindingError.value = '';
  try {
    await apiRequest(`/customer-accounts/${customerId.value}/routes/${id}`, { method: 'DELETE' });
    await loadBindings();
  } catch (cause) {
    bindingError.value = messageFrom(cause, 'The binding could not be removed.');
  } finally {
    bindingBusy.value = '';
  }
}

async function reload() {
  await loadCustomer();
  if (notFound.value) return;
  await Promise.all([loadQuota(), loadCredit(), loadSenderIds(), loadBindings(), loadRouteOptions()]);
}

onMounted(reload);
watch(customerId, reload);
</script>

<template>
  <div data-testid="customer-detail-view">
    <section v-if="notFound" class="panel" data-testid="customer-not-found">
      <h2>Customer not found</h2>
      <p>
        No customer account with id <span class="mono">{{ customerId }}</span> is in the register.
        It may have been removed, or the link may be stale.
      </p>
      <RouterLink class="primary-button" to="/customers">Back to Customers</RouterLink>
    </section>

    <template v-else>
      <section class="panel" data-testid="customer-identity" aria-labelledby="customer-heading">
        <header class="panel-header">
          <div>
            <h2 id="customer-heading">{{ text(customer?.name, customerId) }}</h2>
            <p>
              <span class="mono">{{ text(customer?.code) }}</span>
              · {{ text(customer?.contact_email ?? customer?.contactEmail, 'no contact recorded') }}
            </p>
          </div>
          <span class="status-badge" :class="text(customer?.status) === 'active' ? 'good' : 'warn'">
            {{ text(customer?.status) }}
          </span>
        </header>
        <p v-if="!canManage" class="source-note" data-testid="customer-readonly">
          Everything on this screen is readable with <span class="mono">system.view</span>. Setting
          quota, posting credit, approving a sender id and binding a route all need
          <span class="mono">system.manage</span>, which your role does not hold.
        </p>
      </section>

      <TabStrip
        v-model="tab"
        :tabs="TABS"
        label="Customer account"
        testid="customer-tab"
        class="customer-tabs"
      />

      <!-- QUOTA -------------------------------------------------------------- -->
      <section
        v-show="tab === 'quota'"
        id="customer-tab-panel-quota"
        role="tabpanel"
        aria-labelledby="customer-tab-quota"
        class="panel"
        data-testid="customer-quota"
      >
        <header class="panel-header">
          <div>
            <h2>Quota</h2>
            <p>
              How many messages this account may send per period. A period with no quota is
              unlimited — which is a decision, not an oversight, and reads differently from a quota
              of zero.
            </p>
          </div>
        </header>

        <p v-if="quotaError" class="form-error" role="alert" data-testid="quota-error">
          {{ quotaError }}
        </p>

        <DataState
          :state="quotaState"
          subject="quota"
          skeleton="table"
          :skeleton-rows="2"
          :detail="
            quotaState === 'empty'
              ? 'No quota is set for any period, so this account is not limited by quota. Rate limiting is separate and lives on the customer record.'
              : undefined
          "
          permission="system.view"
          testid="quota-state"
          :on-retry="loadQuota"
        >
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Used</th>
                  <th scope="col">Remaining</th>
                  <th v-if="canManage" scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="quota in quotas"
                  :key="text(quota.period)"
                  :data-testid="`quota-${text(quota.period)}`"
                >
                  <td class="mono">{{ text(quota.period) }}</td>
                  <td class="mono">
                    {{ displayValue(scalar(quota.limit ?? quota.quota_limit), quotaState) }}
                  </td>
                  <td class="mono">
                    {{ displayValue(scalar(quota.used ?? quota.consumed), quotaState) }}
                  </td>
                  <td class="mono">{{ displayValue(scalar(quota.remaining), quotaState) }}</td>
                  <td v-if="canManage" class="row-actions">
                    <button
                      class="secondary-button danger-button"
                      type="button"
                      :disabled="quotaBusy"
                      :data-testid="`quota-remove-${text(quota.period)}`"
                      @click="removeQuota(text(quota.period))"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>

        <div v-if="canManage" class="field-grid" data-testid="quota-form">
          <label class="filter-select">
            <span>Period</span>
            <select v-model="draftPeriod" data-testid="quota-period">
              <option v-for="period in PERIODS" :key="period" :value="period">{{ period }}</option>
            </select>
          </label>
          <label class="filter-select">
            <span>Limit (messages)</span>
            <input v-model.number="draftLimit" type="number" min="0" data-testid="quota-limit" />
          </label>
          <button
            class="primary-button"
            type="button"
            :disabled="quotaBusy"
            data-testid="quota-save"
            @click="saveQuota"
          >
            {{ quotaBusy ? 'Saving…' : 'Set quota' }}
          </button>
        </div>
      </section>

      <!-- CREDIT ------------------------------------------------------------- -->
      <section
        v-show="tab === 'credit'"
        id="customer-tab-panel-credit"
        role="tabpanel"
        aria-labelledby="customer-tab-credit"
        class="panel"
        data-testid="customer-credit"
      >
        <header class="panel-header">
          <div>
            <h2>Credit</h2>
            <p>The account balance and every adjustment posted against it, newest first.</p>
          </div>
        </header>

        <p v-if="creditError" class="form-error" role="alert" data-testid="credit-error">
          {{ creditError }}
        </p>

        <DataState
          :state="creditState"
          subject="the credit ledger"
          skeleton="table"
          :skeleton-rows="3"
          permission="system.view"
          testid="credit-state"
          :on-retry="loadCredit"
        >
          <div class="summary-strip">
            <div class="metric">
              <strong data-testid="credit-balance">{{
                displayValue(scalar(balance?.balance), creditState)
              }}</strong>
              <small>current balance</small>
            </div>
            <div class="metric">
              <strong>{{ displayValue(transactions.length, creditState) }}</strong>
              <small>adjustments shown</small>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in transactions"
                  :key="text(entry.id)"
                  :data-testid="`credit-txn-${text(entry.id)}`"
                >
                  <td class="mono">{{ formatMoment(text(entry.created_at ?? entry.createdAt, '')) }}</td>
                  <td>
                    <span
                      class="status-badge"
                      :class="text(entry.direction) === 'credit' ? 'good' : 'warn'"
                      >{{ text(entry.direction) }}</span
                    >
                  </td>
                  <td class="mono">{{ text(entry.amount) }}</td>
                  <td>{{ text(entry.reason, 'none given') }}</td>
                  <td class="mono">{{ text(entry.reference, 'none') }}</td>
                </tr>
                <tr v-if="!transactions.length">
                  <td colspan="5" class="empty-cell" data-testid="credit-empty">
                    No adjustment has been posted against this account.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>

        <div v-if="canManage" class="field-grid" data-testid="credit-form">
          <label class="filter-select">
            <span>Direction</span>
            <select v-model="draftDirection" data-testid="credit-direction">
              <option value="credit">credit — add funds</option>
              <option value="debit">debit — take funds</option>
            </select>
          </label>
          <label class="filter-select">
            <span>Amount</span>
            <input
              v-model.number="draftAmount"
              type="number"
              min="0"
              step="0.01"
              data-testid="credit-amount"
            />
          </label>
          <label class="filter-select">
            <span>Reason</span>
            <input v-model="draftReason" type="text" data-testid="credit-reason" />
          </label>
          <label class="filter-select">
            <span>Reference</span>
            <input v-model="draftReference" type="text" data-testid="credit-reference" />
          </label>
          <button
            class="primary-button"
            type="button"
            :disabled="creditBusy"
            data-testid="credit-post"
            @click="postTransaction"
          >
            {{ creditBusy ? 'Posting…' : 'Post adjustment' }}
          </button>
        </div>
        <p v-if="canManage" class="source-note">
          An adjustment is a ledger entry, not an edit — the balance is the sum of what is above,
          so a mistake is corrected by posting its opposite rather than by changing history.
        </p>
      </section>

      <!-- SENDER IDS --------------------------------------------------------- -->
      <section
        v-show="tab === 'sender-ids'"
        id="customer-tab-panel-sender-ids"
        role="tabpanel"
        aria-labelledby="customer-tab-sender-ids"
        class="panel"
        data-testid="customer-sender-ids"
      >
        <header class="panel-header">
          <div>
            <h2>Sender IDs</h2>
            <p>
              The alphanumeric senders this account may use. A pending id is registered and not yet
              usable — approval is a deliberate act, because a sender id is how a subscriber decides
              whether to trust a message.
            </p>
          </div>
        </header>

        <p v-if="senderError" class="form-error" role="alert" data-testid="sender-error">
          {{ senderError }}
        </p>

        <DataState
          :state="senderState"
          subject="sender IDs"
          skeleton="table"
          :skeleton-rows="3"
          :detail="
            senderState === 'empty'
              ? 'No sender id is registered for this account, so it can only send from whatever default the route supplies.'
              : undefined
          "
          permission="system.view"
          testid="sender-state"
          :on-retry="loadSenderIds"
        >
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Sender ID</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Reviewed</th>
                  <th v-if="canManage" scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in senderIds"
                  :key="text(entry.id)"
                  :data-testid="`sender-${text(entry.id)}`"
                >
                  <td class="mono">{{ text(entry.sender_id ?? entry.senderId) }}</td>
                  <td>
                    <span
                      class="status-badge"
                      :class="
                        text(entry.status) === 'approved'
                          ? 'good'
                          : text(entry.status) === 'rejected'
                            ? 'bad'
                            : 'warn'
                      "
                      >{{ text(entry.status) }}</span
                    >
                  </td>
                  <td class="mono">
                    {{ formatMoment(text(entry.created_at ?? entry.createdAt, '')) }}
                  </td>
                  <td class="mono">
                    {{
                      entry.reviewed_at || entry.reviewedAt
                        ? formatMoment(text(entry.reviewed_at ?? entry.reviewedAt, ''))
                        : 'not reviewed'
                    }}
                  </td>
                  <td v-if="canManage" class="row-actions">
                    <template v-if="text(entry.status) === 'pending'">
                      <button
                        class="secondary-button"
                        type="button"
                        :disabled="Boolean(senderBusy)"
                        :data-testid="`sender-approve-${text(entry.id)}`"
                        @click="reviewSenderId(text(entry.id), 'approved')"
                      >
                        Approve
                      </button>
                      <button
                        class="secondary-button"
                        type="button"
                        :disabled="Boolean(senderBusy)"
                        :data-testid="`sender-reject-${text(entry.id)}`"
                        @click="reviewSenderId(text(entry.id), 'rejected')"
                      >
                        Reject
                      </button>
                    </template>
                    <button
                      class="secondary-button danger-button"
                      type="button"
                      :disabled="Boolean(senderBusy)"
                      :data-testid="`sender-delete-${text(entry.id)}`"
                      @click="deleteSenderId(text(entry.id))"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>

        <div v-if="canManage" class="field-grid" data-testid="sender-form">
          <label class="filter-select filter-search">
            <span>Register a sender id</span>
            <input
              v-model="draftSenderId"
              type="text"
              data-testid="sender-input"
              placeholder="JKANNEL"
              @keyup.enter="requestSenderId"
            />
          </label>
          <button
            class="primary-button"
            type="button"
            :disabled="Boolean(senderBusy)"
            data-testid="sender-request"
            @click="requestSenderId"
          >
            Register
          </button>
        </div>
      </section>

      <!-- ROUTE BINDINGS ----------------------------------------------------- -->
      <section
        v-show="tab === 'routes'"
        id="customer-tab-panel-routes"
        role="tabpanel"
        aria-labelledby="customer-tab-routes"
        class="panel"
        data-testid="customer-routes"
      >
        <header class="panel-header">
          <div>
            <h2>Routes</h2>
            <p>
              Which routes this account's traffic may use, in the order it should try them. An
              account with no binding uses the estate's own routing rules.
            </p>
          </div>
        </header>

        <p v-if="bindingError" class="form-error" role="alert" data-testid="binding-error">
          {{ bindingError }}
        </p>

        <DataState
          :state="bindingState"
          subject="route bindings"
          skeleton="table"
          :skeleton-rows="2"
          :detail="
            bindingState === 'empty'
              ? 'No route is bound to this account, so its traffic follows the estate-wide routing rules like everyone else.'
              : undefined
          "
          permission="system.view"
          testid="binding-state"
          :on-retry="loadBindings"
        >
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Enabled</th>
                  <th v-if="canManage" scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="binding in bindings"
                  :key="text(binding.id)"
                  :data-testid="`binding-${text(binding.id)}`"
                >
                  <td>
                    {{ text(binding.route_name ?? binding.routeName ?? binding.route_id) }}
                    <small class="row-id mono">{{ text(binding.route_id ?? binding.routeId) }}</small>
                  </td>
                  <td class="mono">{{ displayValue(scalar(binding.priority), bindingState) }}</td>
                  <td>
                    <span class="status-badge" :class="binding.enabled === false ? 'muted' : 'good'">
                      {{ binding.enabled === false ? 'disabled' : 'enabled' }}
                    </span>
                  </td>
                  <td v-if="canManage" class="row-actions">
                    <button
                      class="secondary-button"
                      type="button"
                      :disabled="Boolean(bindingBusy)"
                      :data-testid="`binding-toggle-${text(binding.id)}`"
                      @click="toggleBinding(binding)"
                    >
                      {{ binding.enabled === false ? 'Enable' : 'Disable' }}
                    </button>
                    <button
                      class="secondary-button danger-button"
                      type="button"
                      :disabled="Boolean(bindingBusy)"
                      :data-testid="`binding-remove-${text(binding.id)}`"
                      @click="unbindRoute(binding)"
                    >
                      Unbind
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>

        <div v-if="canManage" class="field-grid" data-testid="binding-form">
          <label class="filter-select">
            <span>Route</span>
            <select v-model="draftRouteId" data-testid="binding-route">
              <option value="">choose a route</option>
              <option v-for="option in routeOptions" :key="text(option.id)" :value="text(option.id)">
                {{ text(option.name) }}
              </option>
            </select>
          </label>
          <label class="filter-select">
            <span>Priority</span>
            <input
              v-model.number="draftPriority"
              type="number"
              min="0"
              data-testid="binding-priority"
            />
          </label>
          <button
            class="primary-button"
            type="button"
            :disabled="Boolean(bindingBusy)"
            data-testid="binding-add"
            @click="bindRoute"
          >
            Bind route
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Not a panel, so it needs the gap explicitly; the token keeps it in step. */
.customer-tabs {
  margin-bottom: var(--gap-panel);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 16px;
}
</style>
<style src="./workspace-extras.css"></style>
