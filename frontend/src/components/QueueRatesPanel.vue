<script setup lang="ts">
/**
 * QUEUE RATES (PLAN.md 3.1, spec §7).
 *
 * This is a panel rather than a screen, and it is mounted at the TOP of the
 * existing `/queues` workspace, above the message grid that was already there.
 *
 * The reason is that `/queues` and `/queue-metrics` describe two different
 * queues. The grid below lists individual rows in the SQLBox spool — the tier
 * JKANNEL can read, reroute and cancel. This panel describes bearerbox's
 * internal per-bind queue, which is a counter and nothing else: its messages
 * cannot be listed, reordered or cancelled. Putting the rates on a separate
 * screen would have left an operator comparing two "queue" numbers from two
 * pages with no statement of which is which; stacking them in one workspace,
 * with the API's own `notes` rendered verbatim between them, is the only layout
 * where the distinction is unavoidable.
 *
 * Backend contract:
 *   GET /queue-metrics?windowMinutes=<1..1440>   (perm messages.view)
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from './DataState.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import { bindTone, bindWord, formatMoment, formatRate } from '../utils/connectivity';
import {
  QUEUE_RATE_WINDOWS,
  describeCoverage,
  describeDrain,
  formatAge,
  formatSignedRate,
  growthTone,
  type QueueDestination,
  type QueueOverview,
} from '../utils/traffic';

const overview = ref<QueueOverview | null>(null);
const state = ref<State>('loading');
const error = ref('');
const windowMinutes = ref(15);
/**
 * Off by default, and the whole reason this control exists.
 *
 * The API returns destinations already sorted by depth descending, so a panel
 * that rendered them in arrival order would silently reshuffle every refresh —
 * exactly what §6 forbids. Engine id is the stable key and the default order.
 */
const rankByDepth = ref(false);

const destinations = computed<QueueDestination[]>(() => {
  const rows = overview.value?.destinations ?? [];
  const ordered = [...rows];
  return rankByDepth.value
    ? ordered.sort((a, b) => (b.depth ?? -1) - (a.depth ?? -1))
    : ordered.sort((a, b) => a.engineId.localeCompare(b.engineId));
});

/**
 * Null, not zero, when there is nothing to total.
 *
 * No destination in the window means no bind snapshot was recorded — not that
 * every queue is empty. A confident `0` there is exactly the §17 failure: a
 * plausible reading for a healthy gateway, produced by a measurement that never
 * happened.
 */
const totalDepth = computed(() =>
  destinations.value.length
    ? destinations.value.reduce((sum, row) => sum + (row.depth ?? 0), 0)
    : null,
);
const growingCount = computed(() =>
  destinations.value.length
    ? destinations.value.filter((row) => (row.growthPerSecond ?? 0) > 0).length
    : null,
);
const withoutEstimate = computed(() =>
  destinations.value.length
    ? destinations.value.filter((row) => Boolean(row.drainUnavailableReason)).length
    : null,
);

const spool = computed(() => overview.value?.spool ?? null);
const notes = computed(() => overview.value?.notes ?? []);

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

async function load() {
  state.value = 'loading';
  try {
    const data = await apiRequest<QueueOverview>(
      `/queue-metrics?windowMinutes=${windowMinutes.value}`,
    );
    overview.value = data;
    error.value = '';
    state.value = data.destinations?.length
      ? // The spool is a second, independent read inside the same response, and
        // it fails on its own. Reporting the whole panel as live while the spool
        // line says nothing would be the "zero that looks real" §17 warns about.
        data.spool?.available === false
        ? 'partial'
        : 'live'
      : 'empty';
  } catch (reason) {
    overview.value = null;
    error.value = messageFrom(reason, 'Queue rates could not be loaded.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

function changeWindow() {
  void load();
}

onMounted(load);
</script>

<template>
  <section class="panel" data-testid="queue-rates-panel" aria-labelledby="queue-rates-heading">
    <header class="panel-header">
      <div>
        <h2 id="queue-rates-heading">Queue rates per destination</h2>
        <p aria-live="polite" data-testid="queue-rates-summary">
          {{
            state === 'loading'
              ? 'Deriving rates from the stored bind snapshots…'
              : `${destinations.length} destination(s) over the last ${overview?.windowMinutes ?? windowMinutes} minute(s)`
          }}
        </p>
      </div>
      <button class="secondary-button" data-testid="queue-rates-refresh" @click="load">
        Refresh
      </button>
    </header>

    <div class="grid-toolbar">
      <label class="filter-select">
        <span>Rate window</span>
        <select
          v-model.number="windowMinutes"
          data-testid="queue-rates-window"
          @change="changeWindow"
        >
          <option v-for="minutes in QUEUE_RATE_WINDOWS" :key="minutes" :value="minutes">
            {{ minutes >= 60 ? `${minutes / 60} hour(s)` : `${minutes} minutes` }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Rank by depth</span>
        <select v-model="rankByDepth" data-testid="queue-rates-rank">
          <option :value="false">off — hold row order steady</option>
          <option :value="true">on — deepest queue first</option>
        </select>
      </label>
    </div>

    <div class="summary-strip">
      <div class="metric">
        <strong data-testid="queue-rates-total-depth">{{ displayValue(totalDepth, state) }}</strong>
        <small>queued inside the engine, all destinations</small>
      </div>
      <div class="metric">
        <strong data-testid="queue-rates-spool-queued">{{
          displayValue(spool?.available ? spool.queued : null, state)
        }}</strong>
        <small>pending in the SQLBox spool</small>
      </div>
      <div class="metric">
        <strong data-testid="queue-rates-spool-oldest">{{
          spool?.available ? formatAge(spool.oldestAgeSeconds, state) : '—'
        }}</strong>
        <small>oldest message in the spool</small>
      </div>
      <div class="metric">
        <strong data-testid="queue-rates-growing">{{ displayValue(growingCount, state) }}</strong>
        <small>destination(s) growing</small>
      </div>
      <div class="metric">
        <strong data-testid="queue-rates-no-estimate">{{
          displayValue(withoutEstimate, state)
        }}</strong>
        <small>without a drain estimate</small>
      </div>
    </div>

    <!--
      The spool line is a separate read that can fail while the rates succeed.
      Its `detail` is the API's own sentence and is printed as-is.
    -->
    <p
      v-if="spool && !spool.available"
      class="warn-notice"
      role="alert"
      data-testid="queue-rates-spool-unavailable"
    >
      The SQLBox spool could not be read, so the two spool figures above are blank rather than zero.
      <span class="mono">{{ spool.detail }}</span>
    </p>

    <p v-if="error" class="form-error" role="alert" data-testid="queue-rates-error">{{ error }}</p>

    <DataState
      :state="state"
      subject="queue rates"
      skeleton="table"
      :skeleton-rows="4"
      :detail="
        state === 'empty'
          ? 'No bind snapshot was recorded in this window, so no rate can be derived. Rates need at least two observations of the same bind; widen the window or check that the status poller is running.'
          : state === 'error'
            ? error
            : state === 'partial'
              ? 'Per-destination rates were read successfully; the SQLBox spool was not.'
              : undefined
      "
      :missing="state === 'partial' ? ['SQLBox spool'] : []"
      permission="messages.view"
      testid="queue-rates-state"
      :on-retry="load"
    >
      <div class="table-wrap">
        <table data-testid="queue-rates-table">
          <thead>
            <tr>
              <th scope="col">Destination</th>
              <th scope="col">Carrier</th>
              <th scope="col">Bind</th>
              <th scope="col">Depth</th>
              <th scope="col">Ingress</th>
              <th scope="col">Egress</th>
              <th scope="col">Growth</th>
              <th scope="col">Drain estimate</th>
              <th scope="col">Oldest spooled</th>
              <th scope="col">Measured from</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in destinations"
              :key="row.engineId"
              :data-testid="`queue-rate-${row.engineId}`"
            >
              <td>
                <router-link class="text-link" :to="`/smsc/${row.engineId}`">{{
                  row.smscName ?? row.engineId
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
                <span class="status-badge" :class="bindTone(row.bindState)">{{
                  bindWord(row.bindState)
                }}</span>
              </td>
              <td class="mono" :data-testid="`queue-depth-${row.engineId}`">
                {{ displayValue(row.depth, state) }}
              </td>
              <td class="mono" :data-testid="`queue-ingress-${row.engineId}`">
                {{ formatRate(row.ingressPerSecond, state) }}
              </td>
              <td class="mono" :data-testid="`queue-egress-${row.engineId}`">
                {{ formatRate(row.egressPerSecond, state) }}
              </td>
              <td class="mono" :data-testid="`queue-growth-${row.engineId}`">
                <span class="status-badge" :class="growthTone(row.growthPerSecond)">{{
                  formatSignedRate(row.growthPerSecond, state)
                }}</span>
              </td>
              <!--
                VERBATIM. `drainUnavailableReason` names which of four causes
                applies, and collapsing them into one word throws that away.
              -->
              <td :data-testid="`queue-drain-${row.engineId}`" class="drain-cell">
                <span class="status-badge" :class="describeDrain(row, state).tone">{{
                  describeDrain(row, state).estimated ? 'estimated' : 'unavailable'
                }}</span>
                <span class="drain-text">{{ describeDrain(row, state).text }}</span>
              </td>
              <td class="mono" :data-testid="`queue-oldest-${row.engineId}`">
                {{ formatAge(row.oldestSpoolAgeSeconds, state) }}
              </td>
              <td class="row-id" :data-testid="`queue-coverage-${row.engineId}`">
                {{ describeCoverage(row) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </DataState>

    <p class="source-note" data-testid="queue-rates-observed">
      {{
        overview
          ? `Observed ${formatMoment(overview.observedAt)}. Row order is held on engine id so a refresh updates the figures without moving the rows; switch ranking on to sort by depth.`
          : 'Waiting for the first reading…'
      }}
    </p>

    <!-- The API's own caveats, rendered as sent. -->
    <ul v-if="notes.length" class="sample-list" data-testid="queue-rates-notes">
      <li v-for="note in notes" :key="note">{{ note }}</li>
    </ul>

    <p class="source-note" data-testid="queue-rates-oldest-note">
      “Oldest spooled” is per destination and the API does not populate it yet, so it reads as an em
      dash on every row rather than as a zero age. The estate-wide oldest spool age is the figure in
      the strip above.
    </p>
  </section>
</template>

<style scoped>
.drain-cell {
  min-width: 220px;
}
.drain-text {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
</style>
<style src="../views/workspace-extras.css"></style>
