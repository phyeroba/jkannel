<script setup lang="ts">
/**
 * CARRIERS REGISTER (PLAN.md 2.3, spec §4.1).
 *
 * Backend contract: `backend/src/connectivity/carrier.controller.ts` +
 * `carrier.service.ts`.
 *
 *   GET    /carriers                     -> CarrierSummary[]
 *   GET    /carriers/unassigned-smscs    -> SMSCs with carrier_id IS NULL
 *   POST   /carriers                     -> create
 *   PATCH  /carriers/:id                 -> update
 *   DELETE /carriers/:id                 -> soft delete, unassigns its SMSCs
 *   POST   /carriers/:id/smscs {smscId}  -> attach
 *
 * Reads need `smsc.view` (also the route guard); every write needs
 * `smsc.manage`.
 *
 * WHY THE UNASSIGNED PANEL IS PERMANENT AND FIRST. Migration 048 back-filled
 * nothing — deliberately, because inferring a carrier from an SMSC's name would
 * have written a guess into the database as a fact, and nothing downstream
 * could then tell the guess from an operator's decision. The consequence is
 * that on first use EVERY connection is unassigned. That is a task list, not an
 * error, and the panel is worded so it reads as one.
 *
 * ON THE FILTER CONTROLS. `GET /carriers` takes no query parameters and returns
 * the whole register in one response, so search, health filter and sort here
 * run in the browser. That is stated on the screen rather than dressed up as
 * server-side paging that does not exist.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';
import DataState from '../components/DataState.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  CARRIER_STATUSES,
  HEALTH_ORDER,
  formatMarket,
  formatUtilisation,
  healthExplanation,
  healthTone,
  type CarrierHealth,
  type CarrierSummary,
  type UnassignedSmsc,
} from '../utils/connectivity';
import {
  formatLatency,
  formatShare,
  type BindQuality,
  type DlrPerformanceReport,
} from '../utils/traffic';

const canManage = computed(() => canAccess(session.value, 'smsc.manage'));

function failureState(reason: unknown): State {
  return reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
}
function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

// --- Register -----------------------------------------------------------------
const carriers = ref<CarrierSummary[]>([]);
const carrierState = ref<State>('loading');
const carrierError = ref('');
const notice = ref('');

const search = ref('');
const healthFilter = ref<'' | CarrierHealth>('');
const sortBy = ref<'health' | 'name' | 'queue' | 'smscs' | 'alerts'>('health');

const visibleCarriers = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return carriers.value
    .filter((carrier) => !healthFilter.value || carrier.health === healthFilter.value)
    .filter(
      (carrier) =>
        !needle ||
        [carrier.name, carrier.country_code, carrier.network_code, carrier.notes]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
    )
    .slice()
    .sort((a, b) => {
      switch (sortBy.value) {
        // Worst first: a register an operator opens during an incident should
        // not make them scroll to find what is broken.
        case 'health':
          return HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name);
        case 'queue':
          return b.queuedMessages - a.queuedMessages || a.name.localeCompare(b.name);
        case 'smscs':
          return b.smscCount - a.smscCount || a.name.localeCompare(b.name);
        case 'alerts':
          return b.openAlerts - a.openAlerts || a.name.localeCompare(b.name);
        default:
          return a.name.localeCompare(b.name);
      }
    });
});

const needingAttention = computed(
  () => carriers.value.filter((carrier) => carrier.health !== 'healthy').length,
);

async function loadCarriers() {
  carrierState.value = 'loading';
  try {
    const rows = await apiRequest<CarrierSummary[]>('/carriers');
    carriers.value = Array.isArray(rows) ? rows : [];
    carrierError.value = '';
    carrierState.value = carriers.value.length ? 'live' : 'empty';
  } catch (reason) {
    carriers.value = [];
    carrierError.value = messageFrom(reason, 'The carrier register could not be loaded.');
    carrierState.value = failureState(reason);
  }
}

/* --- DELIVERY QUALITY --------------------------------------------------------
 *
 * Delivery rate and receipt latency come from the DLR report rather than from
 * the carrier register, because they are a property of MESSAGES and the
 * register is a property of CONNECTIONS. One endpoint already computes them
 * per carrier over an explicit window, correlating MT to receipt on foreign_id
 * and taking percentiles per carrier — copying that into the carrier query
 * would mean two implementations of a correlation that has already been got
 * wrong once.
 *
 * It is a second request and it is allowed to fail on its own. `reports.view`
 * is a different permission from `smsc.view`, so an operator who can see the
 * register may legitimately not be able to see delivery quality; when that
 * happens the two columns say "not permitted" and the rest of the register is
 * unaffected.
 */
const DELIVERY_WINDOW_HOURS = 24;

const deliveryByCarrier = ref<Record<string, BindQuality>>({});
const deliveryState = ref<State>('loading');
const deliveryDenied = ref(false);

async function loadDelivery() {
  deliveryState.value = 'loading';
  const to = new Date();
  const from = new Date(to.getTime() - DELIVERY_WINDOW_HOURS * 3_600_000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  try {
    const report = await apiRequest<DlrPerformanceReport>(
      `/reports/dlr-performance?${params.toString()}`,
    );
    const map: Record<string, BindQuality> = {};
    for (const row of report?.byCarrier ?? []) if (row.carrierId) map[row.carrierId] = row;
    deliveryByCarrier.value = map;
    deliveryDenied.value = false;
    // `partial` when the store could not be read: the carrier rows are still
    // real, so the register must not be blanked over a secondary failure.
    deliveryState.value = report?.available === false ? 'partial' : 'live';
  } catch (reason) {
    deliveryByCarrier.value = {};
    deliveryDenied.value = reason instanceof ApiError && reason.status === 403;
    deliveryState.value = deliveryDenied.value ? 'permission-denied' : 'error';
  }
}

function qualityFor(carrierId: string): BindQuality | null {
  return deliveryByCarrier.value[carrierId] ?? null;
}

// --- Unassigned SMSCs ----------------------------------------------------------
const unassigned = ref<UnassignedSmsc[]>([]);
const unassignedState = ref<State>('loading');
const unassignedError = ref('');
/** Chosen carrier per unassigned SMSC id; nothing is pre-selected on purpose. */
const attachTarget = ref<Record<string, string>>({});
const attachBusy = ref('');

async function loadUnassigned() {
  unassignedState.value = 'loading';
  try {
    const rows = await apiRequest<UnassignedSmsc[]>('/carriers/unassigned-smscs');
    unassigned.value = Array.isArray(rows) ? rows : [];
    unassignedError.value = '';
    unassignedState.value = unassigned.value.length ? 'live' : 'empty';
  } catch (reason) {
    unassigned.value = [];
    unassignedError.value = messageFrom(reason, 'Unassigned SMSCs could not be loaded.');
    unassignedState.value = failureState(reason);
  }
}

async function attach(smsc: UnassignedSmsc) {
  if (!canManage.value) return;
  const carrierId = attachTarget.value[smsc.id];
  if (!carrierId) {
    unassignedError.value = `Choose the carrier ${smsc.name} belongs to before attaching it.`;
    return;
  }
  attachBusy.value = smsc.id;
  unassignedError.value = '';
  try {
    await apiRequest(`/carriers/${carrierId}/smscs`, {
      method: 'POST',
      body: JSON.stringify({ smscId: smsc.id }),
    });
    const carrier = carriers.value.find((row) => row.id === carrierId);
    notice.value = `${smsc.name} is now filed under ${carrier?.name ?? 'that carrier'}. Its traffic and configuration are unchanged — only the carrier label moved.`;
    await Promise.all([loadUnassigned(), loadCarriers()]);
  } catch (reason) {
    unassignedError.value = messageFrom(reason, 'The SMSC could not be attached.');
  } finally {
    attachBusy.value = '';
  }
}

// --- Create / edit --------------------------------------------------------------
const showForm = ref(false);
const editingId = ref('');
const formError = ref('');
const formBusy = ref(false);
const draftName = ref('');
const draftCountry = ref('');
const draftNetwork = ref('');
const draftStatus = ref<string>('active');
const draftNotes = ref('');

function openForm(carrier?: CarrierSummary) {
  showForm.value = true;
  formError.value = '';
  notice.value = '';
  editingId.value = carrier?.id ?? '';
  draftName.value = carrier?.name ?? '';
  draftCountry.value = carrier?.country_code ?? '';
  draftNetwork.value = carrier?.network_code ?? '';
  draftStatus.value = carrier?.status ?? 'active';
  draftNotes.value = carrier?.notes ?? '';
}
function closeForm() {
  showForm.value = false;
  editingId.value = '';
  formError.value = '';
}

async function saveCarrier() {
  if (!canManage.value) return;
  formError.value = '';
  const name = draftName.value.trim();
  if (!name) {
    formError.value = 'A carrier name is required.';
    return;
  }
  // Checked here as well as server-side so the operator is told which of the
  // two codes is wrong, rather than being handed a joined validation string.
  const country = draftCountry.value.trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    formError.value = 'Country must be a two-letter ISO 3166-1 alpha-2 code, for example UG.';
    return;
  }
  const network = draftNetwork.value.trim();
  if (network && !/^[0-9]{4,6}$/.test(network)) {
    formError.value =
      'Network code must be 4–6 digits (MCC then MNC). Leading zeros are significant, so it stays text.';
    return;
  }
  const body = {
    name,
    countryCode: country || null,
    networkCode: network || null,
    status: draftStatus.value,
    notes: draftNotes.value.trim() || null,
  };
  formBusy.value = true;
  try {
    if (editingId.value) {
      await apiRequest(`/carriers/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      notice.value = `Carrier “${name}” updated.`;
    } else {
      await apiRequest('/carriers', { method: 'POST', body: JSON.stringify(body) });
      notice.value = `Carrier “${name}” created. It has no SMSCs yet, so its health reads unknown until you attach one.`;
    }
    closeForm();
    await loadCarriers();
  } catch (reason) {
    formError.value = messageFrom(reason, 'The carrier could not be saved.');
  } finally {
    formBusy.value = false;
  }
}

// --- Delete ----------------------------------------------------------------------
/** Impact is stated before the verb (§16), from figures already on screen. */
const pendingDelete = ref<CarrierSummary | null>(null);
const deleteBusy = ref(false);

async function confirmDelete() {
  const carrier = pendingDelete.value;
  if (!carrier || !canManage.value) return;
  deleteBusy.value = true;
  try {
    const result = await apiRequest<{ id: string; smscsUnassigned: number }>(
      `/carriers/${carrier.id}`,
      { method: 'DELETE' },
    );
    notice.value = `Carrier “${carrier.name}” deleted. ${result.smscsUnassigned} SMSC(s) are now unassigned and are listed above; they keep running and keep their configuration.`;
    pendingDelete.value = null;
    await Promise.all([loadCarriers(), loadUnassigned()]);
  } catch (reason) {
    carrierError.value = messageFrom(reason, 'The carrier could not be deleted.');
  } finally {
    deleteBusy.value = false;
  }
}

onMounted(() => {
  void loadCarriers();
  void loadUnassigned();
  void loadDelivery();
});
</script>

<template>
  <div data-testid="carriers-view">
    <p v-if="!canManage" class="source-note" data-testid="carriers-readonly">
      You can review the register. Creating, editing and deleting a carrier, and attaching an SMSC
      to one, all require the smsc.manage permission.
    </p>
    <p v-if="notice" class="notice" role="status" data-testid="carriers-notice">{{ notice }}</p>

    <!--
      UNASSIGNED SMSCs — first, permanent, and never hidden when empty.
      Everything about this panel is written on the assumption that a full list
      here is the NORMAL first-run state and the operator's next job.
    -->
    <section
      class="panel unassigned-panel"
      data-testid="carriers-unassigned-panel"
      aria-labelledby="unassigned-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="unassigned-heading">SMSCs not yet filed under a carrier</h2>
          <p aria-live="polite" data-testid="unassigned-summary">
            {{
              unassignedState === 'loading'
                ? 'Checking which connections have no carrier…'
                : unassigned.length
                  ? `${unassigned.length} connection(s) to file.`
                  : 'Every connection is filed.'
            }}
          </p>
        </div>
      </header>

      <p class="baseline-info" data-testid="unassigned-explainer">
        When carriers were introduced, <strong>nothing was back-filled</strong>. Inferring a carrier
        from a connection's name would have written a guess into the database as a fact, and nothing
        afterwards could tell that guess apart from an operator's decision. So every existing SMSC
        starts here. <strong>This is a list of work to do, not a fault.</strong> An unassigned
        connection carries traffic exactly as before; it is only missing its carrier label, and
        until it has one it is absent from every carrier roll-up on this screen.
      </p>

      <DataState
        :state="unassignedState"
        subject="unassigned SMSC connections"
        skeleton="table"
        :skeleton-rows="3"
        :detail="
          unassignedState === 'empty'
            ? 'Every SMSC connection is filed under a carrier. A newly created connection appears here until somebody files it.'
            : unassignedState === 'error'
              ? unassignedError
              : undefined
        "
        permission="smsc.view"
        testid="unassigned-state"
        :on-retry="loadUnassigned"
      >
        <div class="table-wrap">
          <table data-testid="unassigned-table">
            <thead>
              <tr>
                <th scope="col">Connection</th>
                <th scope="col">Engine id</th>
                <th scope="col">Type</th>
                <th scope="col">Enabled</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">File under</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="smsc in unassigned" :key="smsc.id" :data-testid="`unassigned-${smsc.id}`">
                <td>
                  <router-link class="text-link" :to="`/smsc/${smsc.engine_id}`">{{
                    smsc.name
                  }}</router-link>
                </td>
                <td class="mono">{{ smsc.engine_id }}</td>
                <td>{{ smsc.type }}</td>
                <td>
                  <span class="status-badge" :class="smsc.enabled ? 'good' : 'muted'">{{
                    smsc.enabled ? 'enabled' : 'disabled'
                  }}</span>
                </td>
                <td class="mono">{{ smsc.lifecycle_state }}</td>
                <td class="row-actions">
                  <template v-if="canManage">
                    <label class="filter-select">
                      <span class="sr-only">Carrier for {{ smsc.name }}</span>
                      <select
                        v-model="attachTarget[smsc.id]"
                        :data-testid="`unassigned-select-${smsc.id}`"
                      >
                        <option value="">Choose a carrier…</option>
                        <option v-for="carrier in carriers" :key="carrier.id" :value="carrier.id">
                          {{ carrier.name }}
                        </option>
                      </select>
                    </label>
                    <button
                      class="primary-button"
                      :data-testid="`unassigned-attach-${smsc.id}`"
                      :disabled="attachBusy === smsc.id || !carriers.length"
                      @click="attach(smsc)"
                    >
                      {{ attachBusy === smsc.id ? 'Attaching…' : 'Attach' }}
                    </button>
                  </template>
                  <span v-else class="row-id">smsc.manage required</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="canManage && !carriers.length && carrierState !== 'loading'"
          class="warn-notice"
          role="note"
          data-testid="unassigned-no-carriers"
        >
          There is no carrier to file these under yet. Create one below first — the attach control
          stays disabled until at least one carrier exists.
        </p>
      </DataState>
      <p v-if="unassignedError" class="form-error" role="alert" data-testid="unassigned-error">
        {{ unassignedError }}
      </p>
    </section>

    <!-- REGISTER --------------------------------------------------------------- -->
    <section class="panel" data-testid="carriers-panel" aria-labelledby="carriers-heading">
      <header class="panel-header">
        <div>
          <h2 id="carriers-heading">Carriers</h2>
          <p aria-live="polite" data-testid="carriers-summary">
            {{
              carrierState === 'loading'
                ? 'Loading the carrier register…'
                : `${needingAttention} of ${carriers.length} carrier(s) are not healthy. Open one for its connections and roll-up.`
            }}
          </p>
        </div>
        <button
          v-if="canManage"
          class="primary-button"
          data-testid="carrier-create"
          @click="openForm()"
        >
          New carrier
        </button>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="carrier-search"
            type="search"
            placeholder="Name, country, network code or notes"
          />
        </label>
        <label class="filter-select">
          <span>Health</span>
          <select v-model="healthFilter" data-testid="carrier-filter-health">
            <option value="">Any</option>
            <option value="critical">critical</option>
            <option value="degraded">degraded</option>
            <option value="unknown">unknown</option>
            <option value="healthy">healthy</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="sortBy" data-testid="carrier-sort">
            <option value="health">Worst health first</option>
            <option value="queue">Largest queue first</option>
            <option value="alerts">Most open alerts first</option>
            <option value="smscs">Most SMSCs first</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <DataState
        :state="carrierState"
        subject="carriers"
        skeleton="table"
        :detail="
          carrierState === 'empty'
            ? 'No carrier has been created yet. Create one, then file the connections listed above under it.'
            : carrierState === 'error'
              ? carrierError
              : undefined
        "
        permission="smsc.view"
        testid="carriers-state"
        :on-retry="loadCarriers"
      >
        <div class="table-wrap">
          <table data-testid="carriers-table">
            <thead>
              <tr>
                <th scope="col">Carrier</th>
                <th scope="col">Market</th>
                <th scope="col">Health</th>
                <th scope="col">SMSCs</th>
                <th scope="col">Sessions</th>
                <th scope="col">Binds up</th>
                <th scope="col">Queued</th>
                <th scope="col">Failed</th>
                <th scope="col">MT TPS</th>
                <th scope="col">Utilisation</th>
                <th scope="col">Delivery</th>
                <th scope="col">P95 DLR</th>
                <th scope="col">Open alerts</th>
                <th scope="col">Last connectivity event</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="carrier in visibleCarriers"
                :key="carrier.id"
                :data-testid="`carrier-${carrier.id}`"
              >
                <td>
                  <router-link class="text-link" :to="`/carriers/${carrier.id}`">{{
                    carrier.name
                  }}</router-link>
                  <small v-if="carrier.notes" class="row-id">{{ carrier.notes }}</small>
                </td>
                <td class="mono">{{ formatMarket(carrier) }}</td>
                <td>
                  <!-- §17.1: the word carries the meaning; the colour only repeats it. -->
                  <span
                    class="status-badge"
                    :class="healthTone(carrier.health)"
                    :data-testid="`carrier-health-${carrier.id}`"
                    :title="healthExplanation(carrier)"
                    >{{ carrier.health }}</span
                  >
                </td>
                <td class="mono">{{ displayValue(carrier.smscCount, carrierState) }}</td>
                <!--
                  Configured, not observed. `instances = N` forks N SMPP
                  sessions behind one smsc-id and the engine reports them as
                  one, so this is what we asked for rather than what is up. The
                  Binds up column beside it is the observed half.
                -->
                <td class="mono" :data-testid="`carrier-sessions-${carrier.id}`">
                  {{ displayValue(carrier.configuredSessions, carrierState) }}
                  <small class="row-id">configured</small>
                </td>
                <td class="mono" :data-testid="`carrier-binds-${carrier.id}`">
                  {{ displayValue(carrier.bindsHealthy, carrierState) }} /
                  {{ displayValue(carrier.bindsTotal, carrierState) }}
                  <small v-if="carrier.bindsUnobserved" class="row-id"
                    >{{ carrier.bindsUnobserved }} never observed</small
                  >
                </td>
                <td class="mono">{{ displayValue(carrier.queuedMessages, carrierState) }}</td>
                <td class="mono">{{ displayValue(carrier.failedMessages, carrierState) }}</td>
                <!-- Summed from the latest snapshot of each bind. `unknown`,
                     not 0, when no bind has ever been sampled: an unobserved
                     carrier is not an idle one. -->
                <td class="mono" :data-testid="`carrier-tps-${carrier.id}`">
                  {{ carrier.observedTps === null ? 'unknown' : carrier.observedTps.toFixed(1) }}
                </td>
                <td class="mono" :data-testid="`carrier-utilisation-${carrier.id}`">
                  {{ formatUtilisation(carrier.utilisation, carrierState) }}
                </td>
                <!--
                  Delivery quality over the last 24 hours, from the DLR report.
                  "not permitted" rather than an em dash when the operator lacks
                  reports.view: they must be able to tell a permission boundary
                  from a carrier that delivered nothing.
                -->
                <td class="mono" :data-testid="`carrier-delivery-${carrier.id}`">
                  <template v-if="deliveryDenied">not permitted</template>
                  <template v-else>{{
                    formatShare(qualityFor(carrier.id)?.quality.deliveryRate ?? null, deliveryState)
                  }}</template>
                </td>
                <td class="mono" :data-testid="`carrier-p95-${carrier.id}`">
                  <template v-if="deliveryDenied">not permitted</template>
                  <template v-else>{{
                    formatLatency(qualityFor(carrier.id)?.quality.latency?.p95)
                  }}</template>
                </td>
                <td class="mono">{{ displayValue(carrier.openAlerts, carrierState) }}</td>
                <td class="mono" :data-testid="`carrier-last-event-${carrier.id}`">
                  {{ carrier.lastEvent || 'no transitions recorded' }}
                </td>
                <td>
                  <span class="status-badge" :class="carrier.status === 'active' ? '' : 'warn'">{{
                    carrier.status
                  }}</span>
                </td>
                <td class="row-actions">
                  <router-link class="secondary-button" :to="`/carriers/${carrier.id}`"
                    >Open</router-link
                  >
                  <template v-if="canManage">
                    <button
                      class="secondary-button"
                      :data-testid="`carrier-edit-${carrier.id}`"
                      @click="openForm(carrier)"
                    >
                      Edit
                    </button>
                    <button
                      class="secondary-button danger-button"
                      :data-testid="`carrier-delete-${carrier.id}`"
                      @click="pendingDelete = carrier"
                    >
                      Delete
                    </button>
                  </template>
                </td>
              </tr>
              <tr v-if="!visibleCarriers.length">
                <td colspan="14" class="empty-cell" data-testid="carriers-filtered-empty">
                  No carrier matches this search or health filter. {{ carriers.length }} carrier(s)
                  are in the register.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <p class="source-note" data-testid="carriers-grid-note">
        Every figure in this table is derived at read time from the bind telemetry, not stored on
        the carrier — a stored copy could disagree with its own source and there would be no way to
        tell which was lying. Utilisation reads <span class="mono">unknown</span> in the register
        because the carrier roll-up does not compute an observed rate; the per-connection figure is
        on each SMSC's own page. <span class="mono">GET /carriers</span> takes no query parameters
        and returns the whole register in one response, so the search, filter and sort above run in
        the browser rather than on the server.
      </p>
    </section>

    <!-- CREATE / EDIT --------------------------------------------------------- -->
    <section v-if="showForm" class="panel composer" data-testid="carrier-form" aria-label="Carrier">
      <h2>{{ editingId ? 'Edit carrier' : 'New carrier' }}</h2>
      <label class="filter-select filter-search">
        <span>Name (required, up to 120 characters)</span>
        <input v-model="draftName" data-testid="carrier-form-name" type="text" />
      </label>
      <label class="filter-select">
        <span>Country (ISO 3166-1 alpha-2, e.g. UG)</span>
        <input
          v-model="draftCountry"
          data-testid="carrier-form-country"
          type="text"
          maxlength="2"
        />
      </label>
      <label class="filter-select">
        <span>Network code (MCC+MNC, 4–6 digits)</span>
        <input v-model="draftNetwork" data-testid="carrier-form-network" type="text" />
      </label>
      <label class="filter-select">
        <span>Operational status</span>
        <select v-model="draftStatus" data-testid="carrier-form-status">
          <option v-for="status in CARRIER_STATUSES" :key="status" :value="status">
            {{ status }}
          </option>
        </select>
      </label>
      <label class="filter-select filter-search">
        <span>Notes</span>
        <input v-model="draftNotes" data-testid="carrier-form-notes" type="text" />
      </label>
      <p v-if="formError" class="form-error" role="alert" data-testid="carrier-form-error">
        {{ formError }}
      </p>
      <div class="detail-actions">
        <button
          class="primary-button"
          data-testid="carrier-form-save"
          :disabled="formBusy"
          @click="saveCarrier"
        >
          {{ formBusy ? 'Saving…' : 'Save carrier' }}
        </button>
        <button class="secondary-button" data-testid="carrier-form-cancel" @click="closeForm">
          Cancel
        </button>
      </div>
      <p v-if="editingId" class="warn-notice" role="note" data-testid="carrier-form-clear-note">
        Emptying the country, network code or notes field leaves the stored value unchanged. The
        update endpoint treats a null as “no change”, so this form cannot clear a field once it has
        been set — it can only replace it.
      </p>
    </section>

    <!-- DELETE CONFIRMATION ---------------------------------------------------- -->
    <section
      v-if="pendingDelete"
      class="panel detail-panel"
      data-testid="carrier-delete-confirm"
      role="alertdialog"
      aria-labelledby="carrier-delete-heading"
    >
      <h2 id="carrier-delete-heading">Delete {{ pendingDelete.name }}?</h2>
      <dl class="detail-grid">
        <dt>SMSCs attached</dt>
        <dd data-testid="carrier-delete-impact">
          {{ pendingDelete.smscCount }} — each becomes unassigned and reappears in the panel at the
          top of this screen.
        </dd>
        <dt>Effect on traffic</dt>
        <dd>
          None. The connections keep their configuration and keep carrying traffic; they lose only
          their carrier label.
        </dd>
        <dt>Effect on roll-ups</dt>
        <dd>
          This carrier's health, queue and alert totals disappear from the register until the
          connections are filed under another carrier.
        </dd>
        <dt>Recoverable</dt>
        <dd>
          The carrier row is soft-deleted, but the console offers no undelete. Re-filing the
          connections afterwards is manual.
        </dd>
      </dl>
      <div class="detail-actions">
        <button
          class="secondary-button danger-button"
          data-testid="carrier-delete-go"
          :disabled="deleteBusy"
          @click="confirmDelete"
        >
          {{ deleteBusy ? 'Deleting…' : 'Delete carrier' }}
        </button>
        <button
          class="secondary-button"
          data-testid="carrier-delete-cancel"
          @click="pendingDelete = null"
        >
          Keep it
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.unassigned-panel {
  border-left: 3px solid var(--brand);
}
.unassigned-panel .row-actions {
  align-items: flex-end;
}
</style>
<style src="./workspace-extras.css"></style>
