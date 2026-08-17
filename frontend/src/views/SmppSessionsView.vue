<script setup lang="ts">
/**
 * SMPP SESSIONS (PLAN.md 2.5, spec §5).
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
 * Backend contract:
 *   GET /smscs?search=&filter.type=&filter.enabled=&filter.lifecycleState=
 *              &sort=&limit=&offset=      (server-side grid, console.repository.ts)
 *   GET /smscs/:engineId/detail           (bind state, capacity, limits, history)
 *
 * `/sessions` is user login sessions and stays that way; this is a distinct
 * path with a distinct label.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import ObservabilityLimits from '../components/ObservabilityLimits.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  bindTone,
  bindWord,
  formatCeiling,
  formatMoment,
  formatRate,
  formatUtilisation,
  mapWithConcurrency,
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

const rows = ref<SmscDetail[]>([]);
const state = ref<State>('loading');
const error = ref('');
/** Connections whose detail read failed; named so `partial` means something. */
const missed = ref<string[]>([]);

const total = ref(0);
const limit = ref(25);
const offset = ref(0);
const search = ref('');
const typeFilter = ref('smpp');
const enabledFilter = ref('');
const lifecycleFilter = ref('');
const sortField = ref('name');
const sortDirection = ref<'asc' | 'desc'>('asc');

const rangeLabel = computed(() =>
  rows.value.length
    ? `Showing ${offset.value + 1}–${offset.value + rows.value.length} of ${total.value}`
    : 'Showing 0 of 0',
);

const boundCount = computed(() => rows.value.filter((row) => row.bindState === 'bound').length);
const unobservedCount = computed(() => rows.value.filter((row) => !row.bindState).length);
const notBoundCount = computed(
  () => rows.value.filter((row) => row.bindState && row.bindState !== 'bound').length,
);
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

function lastTransition(row: SmscDetail): string {
  const entry = row.transitions?.[0];
  if (!entry) return 'none recorded';
  return `${entry.kind} · ${formatMoment(entry.observedAt)}`;
}

onMounted(load);
</script>

<template>
  <div data-testid="smpp-sessions-view">
    <!--
      THE HEADLINE STATEMENT. First thing on the screen, before any figure,
      because the gap between what this screen is called and what it can show is
      the single most important thing an operator needs to know about it.
    -->
    <section class="panel scope-note" data-testid="sessions-scope" aria-labelledby="scope-heading">
      <h2 id="scope-heading">This is a register of binds, not of sessions</h2>
      <p>
        A “session” in SMPP is one bound TCP connection. This gateway's engine does not expose them
        individually: it reports one entry per <span class="mono">smsc-id</span>, and an SMSC
        configured with <span class="mono">instances = N</span> opens N real sessions that all share
        that single id. There is therefore no per-session row to show, and this screen does not
        invent one. Each row below is a <strong>configured bind</strong> and everything on it is the
        total across whatever sessions that bind is running.
      </p>
    </section>

    <section class="panel" data-testid="sessions-panel" aria-labelledby="sessions-heading">
      <header class="panel-header">
        <div>
          <h2 id="sessions-heading">SMPP Sessions</h2>
          <p aria-live="polite" data-testid="sessions-summary">
            {{
              state === 'loading'
                ? 'Reading bind state for each connection…'
                : `${rows.length} bind(s) on this page.`
            }}
          </p>
        </div>
      </header>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="sessions-metric-bound">{{ displayValue(boundCount, state) }}</strong>
          <small>bound</small>
        </div>
        <div class="metric">
          <strong data-testid="sessions-metric-notbound">{{
            displayValue(notBoundCount, state)
          }}</strong>
          <small>observed, not bound</small>
        </div>
        <div class="metric">
          <strong data-testid="sessions-metric-unobserved">{{
            displayValue(unobservedCount, state)
          }}</strong>
          <small>never observed</small>
        </div>
        <div class="metric">
          <strong data-testid="sessions-metric-configured">{{
            displayValue(configuredSessions, state)
          }}</strong>
          <small>SMPP sessions configured behind these binds</small>
        </div>
      </div>
      <p class="source-note" data-testid="sessions-configured-note">
        The last figure is <strong>configuration, not observation</strong>: it is the sum of the
        configured connection counts, which is how many sessions the engine was told to open. How
        many are actually up right now is not reported.
      </p>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="sessions-search"
            type="search"
            placeholder="Name, engine id, host or description"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select">
          <span>Protocol</span>
          <select v-model="typeFilter" data-testid="sessions-filter-type" @change="applyFilters">
            <option value="smpp">smpp</option>
            <option value="">Any type</option>
            <option value="http">http</option>
            <option value="at">at</option>
            <option value="fake">fake</option>
          </select>
        </label>
        <label class="filter-select">
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
        <label class="filter-select">
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
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="sortField" data-testid="sessions-sort" @change="applyFilters">
            <option v-for="field in SORT_FIELDS" :key="field.value" :value="field.value">
              {{ field.label }}
            </option>
          </select>
        </label>
        <label class="filter-select">
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
        <label class="filter-select">
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
          <table data-testid="sessions-table">
            <thead>
              <tr>
                <th scope="col">Bind</th>
                <th scope="col">Carrier</th>
                <th scope="col">State</th>
                <th scope="col">Since</th>
                <th scope="col">Last observed</th>
                <th scope="col">Sessions behind it</th>
                <th scope="col">Queued</th>
                <th scope="col">Failed</th>
                <th scope="col">Out rate</th>
                <th scope="col">Ceiling</th>
                <th scope="col">Utilisation</th>
                <th scope="col">Last transition</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id" :data-testid="`session-${row.engineId}`">
                <td>
                  <router-link class="text-link" :to="`/smsc/${row.engineId}`">{{
                    row.name
                  }}</router-link>
                  <small class="row-id mono">{{ row.engineId }}</small>
                </td>
                <td>
                  <router-link
                    v-if="row.carrierId"
                    class="text-link"
                    :to="`/carriers/${row.carrierId}`"
                    >{{ row.carrierName }}</router-link
                  >
                  <span v-else class="row-id">unassigned</span>
                </td>
                <td>
                  <!-- Word first; the tone class only repeats what it says (§17.1). -->
                  <span
                    class="status-badge"
                    :class="bindTone(row.bindState)"
                    :data-testid="`session-state-${row.engineId}`"
                    >{{ bindWord(row.bindState) }}</span
                  >
                </td>
                <td class="mono">{{ formatMoment(row.bindStateSince) }}</td>
                <td class="mono">{{ formatMoment(row.bindObservedAt) }}</td>
                <td :data-testid="`session-collapsed-${row.engineId}`">
                  <template v-if="row.limits?.sessionsCollapsed">
                    <span class="status-badge warn"
                      >{{ row.limits.configuredInstances }} collapsed into 1</span
                    >
                    <small class="row-id"
                      >figures on this row are the total across all
                      {{ row.limits.configuredInstances }}</small
                    >
                  </template>
                  <span v-else class="row-id">1 configured</span>
                </td>
                <td class="mono">{{ displayValue(row.queued, state) }}</td>
                <td class="mono">{{ displayValue(row.failed, state) }}</td>
                <td class="mono">{{ formatRate(row.outboundRate, state) }}</td>
                <td class="mono">{{ formatCeiling(row.capacity) }}</td>
                <td class="mono" :data-testid="`session-utilisation-${row.engineId}`">
                  {{ formatUtilisation(row.capacity?.utilisation, state) }}
                </td>
                <td class="mono">{{ lastTransition(row) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="pager">
          <span data-testid="sessions-range">{{ rangeLabel }}</span>
          <div class="pager-buttons">
            <button
              class="secondary-button"
              data-testid="sessions-prev"
              :disabled="offset === 0"
              @click="turnPage(-1)"
            >
              Previous
            </button>
            <button
              class="secondary-button"
              data-testid="sessions-next"
              :disabled="offset + rows.length >= total"
              @click="turnPage(1)"
            >
              Next
            </button>
          </div>
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

      <p class="source-note" data-testid="sessions-grid-note">
        Search, protocol, enabled, lifecycle, sort and paging are applied by the API. Bind state,
        capacity and the transition history are not on the list endpoint, so each row on the page is
        then read individually — which is why the page size is deliberately small. There is no
        filter or sort on bind state, because the API cannot do either and filtering one page in the
        browser would report “no failing binds” while looking at a fraction of the estate.
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
  </div>
</template>

<style scoped>
.scope-note {
  border-left: 3px solid var(--warn);
}
.scope-note h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.scope-note p {
  margin: 0;
}
</style>
<style src="./workspace-extras.css"></style>
