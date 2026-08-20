<script setup lang="ts">
/**
 * CARRIER DETAIL (PLAN.md 2.3, spec §4.1 / UC-CON-01).
 *
 *   GET    /carriers/:id                      -> the same CarrierSummary
 *   GET    /carriers/unassigned-smscs         -> what can be attached
 *   POST   /carriers/:id/smscs {smscId}       -> attach
 *   DELETE /carriers/:id/smscs/:smscId        -> detach
 *
 * HOW THE CONNECTION LIST IS BUILT, AND WHY IT COSTS WHAT IT COSTS. There is no
 * endpoint that returns the SMSCs belonging to a carrier: `GET /carriers/:id`
 * is a roll-up with counts only, and `GET /smscs` exposes neither `carrier_id`
 * nor bind state. The only place the link is readable is
 * `GET /smscs/:engineId/detail`, one call per connection.
 *
 * So the estate is enumerated once, the connections already known to be
 * unassigned are subtracted (that set is a single cheap call, and on a fresh
 * install it is ALL of them, which makes this page free), and a detail read is
 * issued for what remains, six at a time. The cost is stated on the screen
 * rather than hidden.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';
import DataState from '../components/DataState.vue';
import EventTimeline from '../components/EventTimeline.vue';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  bindTone,
  bindWord,
  formatCeiling,
  formatMarket,
  formatMoment,
  formatRate,
  formatUtilisation,
  healthExplanation,
  healthTone,
  mapWithConcurrency,
  type CarrierSummary,
  type SmscDetail,
  type SmscRow,
  type UnassignedSmsc,
} from '../utils/connectivity';

const route = useRoute();
const carrierId = computed(() => String(route.params.id ?? ''));
const canManage = computed(() => canAccess(session.value, 'smsc.manage'));

function failureState(reason: unknown): State {
  return reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
}
function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

const carrier = ref<CarrierSummary | null>(null);
const carrierState = ref<State>('loading');
const carrierError = ref('');
const notFound = ref(false);
const notice = ref('');

const members = ref<SmscDetail[]>([]);
const membersState = ref<State>('loading');
const membersError = ref('');
/** Detail reads that failed. Named, so a short list is never read as "all". */
const membersMissed = ref<string[]>([]);

const unassigned = ref<UnassignedSmsc[]>([]);
const attachChoice = ref('');
const busy = ref('');

async function loadCarrier() {
  carrierState.value = 'loading';
  notFound.value = false;
  try {
    carrier.value = await apiRequest<CarrierSummary>(`/carriers/${carrierId.value}`);
    carrierError.value = '';
    carrierState.value = 'live';
    // Published only now: a crumb that says "Carrier" and then changes under
    // the reader is a worse answer to "where am I" than no crumb at all.
    setBreadcrumbTrail(route.path, [
      { label: 'Carriers', to: '/carriers' },
      { label: carrier.value.name },
    ]);
  } catch (reason) {
    carrier.value = null;
    notFound.value = reason instanceof ApiError && reason.status === 404;
    carrierError.value = messageFrom(reason, 'This carrier could not be loaded.');
    carrierState.value = failureState(reason);
  }
}

/**
 * Recent carrier events — §4.1's connectivity history for the whole network.
 *
 * Every member SMSC's detail already carries its own bind transitions, so this
 * is a merge and a sort rather than a fetch: the carrier's history IS the union
 * of its connections' histories, which is exactly the question an operator asks
 * when a network degrades but no single bind looks obviously wrong.
 *
 * Capped at 40. The underlying history is never pruned, and a carrier with a
 * dozen flapping binds would otherwise render thousands of rows into a panel
 * nobody scrolls to the bottom of.
 */
const carrierEvents = computed(() =>
  members.value
    .flatMap((member) =>
      (member.transitions ?? []).map((entry) => ({
        engineId: member.engineId,
        name: member.name,
        entry,
      })),
    )
    .sort((a, b) => String(b.entry.observedAt).localeCompare(String(a.entry.observedAt)))
    .slice(0, 40)
    .map(({ name, entry }) => ({
      at: formatMoment(entry.observedAt),
      label: `${name}: ${entry.fromState ?? 'no recorded state'} → ${entry.toState ?? 'no recorded state'}`,
      detail: entry.kind,
      state:
        entry.toState === 'bound'
          ? ('ok' as const)
          : entry.toState === 'failed' || entry.toState === 'disconnected'
            ? ('error' as const)
            : entry.toState === null
              ? ('missing' as const)
              : ('warn' as const),
    })),
);

/**
 * Open alerts against this carrier's binds.
 *
 * The poller keys bind alerts as `engine:bind:<engineId>`, so the carrier's
 * open alerts are the ones whose dedup key names one of its connections. The
 * summary already reports a COUNT; this panel says which, because "3 open
 * alerts" tells an operator to go looking and nothing more.
 */
const alertsState = ref<State>('loading');
const carrierAlerts = ref<Record<string, unknown>[]>([]);

async function loadAlerts() {
  alertsState.value = 'loading';
  try {
    const page = await apiRequest<{ items?: Record<string, unknown>[] }>(
      '/alerts?filter.status=open&sort=-openedAt&limit=100&offset=0',
    );
    const mine = new Set(members.value.map((member) => `engine:bind:${member.engineId}`));
    const rows = Array.isArray(page?.items) ? page.items : [];
    carrierAlerts.value = rows.filter((row) =>
      mine.has(String(row.dedup_key ?? row.dedupKey ?? '')),
    );
    alertsState.value = carrierAlerts.value.length ? 'live' : 'empty';
  } catch (reason) {
    carrierAlerts.value = [];
    alertsState.value = failureState(reason);
  }
}

async function loadMembers() {
  membersState.value = 'loading';
  membersMissed.value = [];
  try {
    const [page, free] = await Promise.all([
      apiRequest<{ items?: SmscRow[] }>('/smscs?limit=500&offset=0'),
      apiRequest<UnassignedSmsc[]>('/carriers/unassigned-smscs'),
    ]);
    unassigned.value = Array.isArray(free) ? free : [];
    const freeIds = new Set(unassigned.value.map((row) => row.id));
    const candidates = (Array.isArray(page?.items) ? page.items : []).filter(
      (row) => !freeIds.has(row.id),
    );
    const details = await mapWithConcurrency(candidates, 6, async (row) => {
      try {
        return await apiRequest<SmscDetail>(`/smscs/${row.engine_id}/detail`);
      } catch {
        membersMissed.value.push(row.engine_id);
        return null;
      }
    });
    members.value = details.filter(
      (detail): detail is SmscDetail => Boolean(detail) && detail!.carrierId === carrierId.value,
    );
    membersError.value = '';
    membersState.value = membersMissed.value.length
      ? 'partial'
      : members.value.length
        ? 'live'
        : 'empty';
  } catch (reason) {
    members.value = [];
    membersError.value = messageFrom(reason, 'The connections for this carrier could not be read.');
    membersState.value = failureState(reason);
  }
}

async function reload() {
  await Promise.all([loadCarrier(), loadMembers()]);
  // After members: an alert is matched to this carrier by its bind's engine id.
  await loadAlerts();
}

async function attach() {
  if (!canManage.value || !attachChoice.value) return;
  busy.value = attachChoice.value;
  notice.value = '';
  try {
    await apiRequest(`/carriers/${carrierId.value}/smscs`, {
      method: 'POST',
      body: JSON.stringify({ smscId: attachChoice.value }),
    });
    const name = unassigned.value.find((row) => row.id === attachChoice.value)?.name ?? 'It';
    notice.value = `${name} is now filed under ${carrier.value?.name ?? 'this carrier'}. Nothing about the connection itself changed.`;
    attachChoice.value = '';
    await reload();
  } catch (reason) {
    membersError.value = messageFrom(reason, 'The SMSC could not be attached.');
  } finally {
    busy.value = '';
  }
}

async function detach(smsc: SmscDetail) {
  if (!canManage.value) return;
  busy.value = smsc.id;
  notice.value = '';
  try {
    await apiRequest(`/carriers/${carrierId.value}/smscs/${smsc.id}`, { method: 'DELETE' });
    notice.value = `${smsc.name} is no longer filed under this carrier. It keeps running and now appears in the unassigned list on the Carriers register.`;
    await reload();
  } catch (reason) {
    membersError.value = messageFrom(reason, 'The SMSC could not be detached.');
  } finally {
    busy.value = '';
  }
}

onMounted(reload);
watch(carrierId, reload);
</script>

<template>
  <div data-testid="carrier-detail-view">
    <!--
      Above the content, never in place of it. A carrier whose binds have never
      been observed still has a name, a market and a connection list worth
      reading; what it does not have is a health claim, and this says so without
      hiding everything else.
    -->
    <p
      v-if="carrier && carrier.health === 'unknown'"
      class="stale-banner"
      data-testid="carrier-stale-banner"
    >
      No bind under this carrier has been observed, so its health is reported unknown rather than
      healthy. Throughput and utilisation below read “unknown” for the same reason.
    </p>
    <p v-if="notice" class="notice" role="status" data-testid="carrier-detail-notice">
      {{ notice }}
    </p>

    <section v-if="notFound" class="panel" data-testid="carrier-not-found">
      <h2>Carrier not found</h2>
      <p>
        This carrier is not in the register. It may have been deleted, or the link may be stale.
      </p>
      <router-link class="primary-button" to="/carriers">Back to Carriers</router-link>
    </section>

    <template v-else>
      <!-- IDENTITY + ROLL-UP ------------------------------------------------ -->
      <section class="panel" data-testid="carrier-identity" aria-labelledby="carrier-heading">
        <DataState
          :state="carrierState"
          subject="this carrier"
          skeleton="cards"
          :skeleton-rows="3"
          :detail="carrierState === 'error' ? carrierError : undefined"
          permission="smsc.view"
          testid="carrier-detail-state"
          :on-retry="loadCarrier"
        >
          <header class="panel-header">
            <div>
              <h2 id="carrier-heading">{{ carrier?.name }}</h2>
              <p>
                {{ formatMarket(carrier ?? { country_code: null, network_code: null }) }} ·
                {{ carrier?.status }}
              </p>
            </div>
            <span
              class="status-badge"
              :class="healthTone(carrier?.health)"
              data-testid="carrier-detail-health"
              >{{ carrier?.health }}</span
            >
          </header>

          <!-- The verdict in a sentence. A badge on its own does not tell an
               operator why `unknown` is not the same as `healthy`. -->
          <p class="baseline-info" data-testid="carrier-health-explanation">
            {{ carrier ? healthExplanation(carrier) : 'Health has not been read yet.' }}
          </p>

          <div class="summary-strip">
            <div class="metric">
              <strong data-testid="carrier-metric-smscs">{{
                displayValue(carrier?.smscCount, carrierState)
              }}</strong>
              <small>SMSC connections</small>
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-binds"
                >{{ displayValue(carrier?.bindsHealthy, carrierState) }} /
                {{ displayValue(carrier?.bindsTotal, carrierState) }}</strong
              >
              <small
                >binds up<template v-if="carrier?.bindsUnobserved">
                  · {{ carrier.bindsUnobserved }} never observed</template
                ></small
              >
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-queued">{{
                displayValue(carrier?.queuedMessages, carrierState)
              }}</strong>
              <small>queued across its binds</small>
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-failed">{{
                displayValue(carrier?.failedMessages, carrierState)
              }}</strong>
              <small>failed across its binds</small>
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-capacity">{{
                displayValue(carrier?.capacityTps, carrierState, (value) => `${value}/s`)
              }}</strong>
              <small>configured ceiling, summed</small>
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-utilisation">{{
                formatUtilisation(carrier?.utilisation, carrierState)
              }}</strong>
              <small>utilisation</small>
            </div>
            <div class="metric">
              <strong data-testid="carrier-metric-alerts">{{
                displayValue(carrier?.openAlerts, carrierState)
              }}</strong>
              <small>open bind alerts</small>
            </div>
          </div>

          <dl class="detail-grid">
            <dt>Country</dt>
            <dd class="mono">{{ carrier?.country_code || 'not recorded' }}</dd>
            <dt>Network code</dt>
            <dd class="mono">{{ carrier?.network_code || 'not recorded' }}</dd>
            <dt>Notes</dt>
            <dd>{{ carrier?.notes || '—' }}</dd>
            <dt>Created</dt>
            <dd class="mono">{{ formatMoment(carrier?.created_at) }}</dd>
            <dt>Last changed</dt>
            <dd class="mono">{{ formatMoment(carrier?.updated_at) }}</dd>
          </dl>

          <p class="source-note" data-testid="carrier-utilisation-note">
            The carrier roll-up sums the configured ceilings of its SMSCs but does not compute an
            observed rate, so utilisation here reads <span class="mono">unknown</span> rather than a
            number nobody measured. Observed throughput and real utilisation are per connection and
            appear on each SMSC's own page below.
          </p>
        </DataState>
      </section>

      <!-- CONNECTIONS -------------------------------------------------------- -->
      <section class="panel" data-testid="carrier-smscs" aria-labelledby="carrier-smscs-heading">
        <header class="panel-header">
          <div>
            <h2 id="carrier-smscs-heading">Connections filed under this carrier</h2>
            <p aria-live="polite">
              {{
                membersState === 'loading'
                  ? 'Reading each connection…'
                  : `${members.length} connection(s).`
              }}
            </p>
          </div>
        </header>

        <div v-if="canManage" class="grid-toolbar" data-testid="carrier-attach-controls">
          <label class="filter-select filter-search">
            <span>Attach an unassigned SMSC</span>
            <select v-model="attachChoice" data-testid="carrier-attach-select">
              <option value="">Choose a connection…</option>
              <option v-for="smsc in unassigned" :key="smsc.id" :value="smsc.id">
                {{ smsc.name }} ({{ smsc.engine_id }})
              </option>
            </select>
          </label>
          <button
            class="primary-button"
            data-testid="carrier-attach"
            :disabled="!attachChoice || Boolean(busy)"
            @click="attach"
          >
            Attach
          </button>
          <span v-if="!unassigned.length" class="row-id" data-testid="carrier-attach-none"
            >Every connection is already filed under a carrier.</span
          >
        </div>

        <p v-if="membersError" class="form-error" role="alert" data-testid="carrier-smscs-error">
          {{ membersError }}
        </p>

        <DataState
          :state="membersState"
          subject="connections for this carrier"
          skeleton="table"
          :skeleton-rows="3"
          :missing="membersMissed"
          :detail="
            membersState === 'empty'
              ? 'No SMSC is filed under this carrier yet. Attach one above — until you do, this carrier\'s health reads unknown because there is nothing to be healthy.'
              : membersState === 'error'
                ? membersError
                : undefined
          "
          permission="smsc.view"
          testid="carrier-smscs-state"
          :on-retry="loadMembers"
        >
          <div class="table-wrap">
            <table data-testid="carrier-smscs-table">
              <thead>
                <tr>
                  <th scope="col">Connection</th>
                  <th scope="col">Bind state</th>
                  <th scope="col">Since</th>
                  <th scope="col">Queued</th>
                  <th scope="col">Failed</th>
                  <th scope="col">TPS out</th>
                  <th scope="col">Ceiling</th>
                  <th scope="col">Utilisation</th>
                  <!-- The kit also lists Sessions, Oldest and Delivery here. None
                   are observable per connection: Kamex collapses instances=N
                   behind one smsc-id, queue age is per-message in SQLBox, and
                   per-SMSC delivery needs the receipt correlation that DLR
                   Performance owns. Columns of dashes would imply we looked. -->
                  <th scope="col">Last event</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="smsc in members"
                  :key="smsc.id"
                  :data-testid="`carrier-smsc-${smsc.engineId}`"
                >
                  <td>
                    <router-link class="text-link" :to="`/smsc/${smsc.engineId}`">{{
                      smsc.name
                    }}</router-link>
                    <small class="row-id mono">{{ smsc.engineId }}</small>
                  </td>
                  <td>
                    <span class="status-badge" :class="bindTone(smsc.bindState)">{{
                      bindWord(smsc.bindState)
                    }}</span>
                  </td>
                  <td class="mono">{{ formatMoment(smsc.bindStateSince) }}</td>
                  <td class="mono">{{ displayValue(smsc.queued, 'live') }}</td>
                  <td class="mono">{{ displayValue(smsc.failed, 'live') }}</td>
                  <td class="mono">{{ formatRate(smsc.outboundRate) }}</td>
                  <td class="mono">{{ formatCeiling(smsc.capacity) }}</td>
                  <td class="mono" :data-testid="`carrier-smsc-utilisation-${smsc.engineId}`">
                    {{ formatUtilisation(smsc.capacity?.utilisation) }}
                  </td>
                  <td class="mono" :data-testid="`carrier-smsc-last-event-${smsc.engineId}`">
                    {{
                      smsc.transitions?.[0]
                        ? `${smsc.transitions[0].toState ?? 'unknown'} ${formatMoment(smsc.transitions[0].observedAt)}`
                        : 'no transitions recorded'
                    }}
                  </td>
                  <td class="row-actions">
                    <router-link class="secondary-button" :to="`/smsc/${smsc.engineId}`"
                      >Open</router-link
                    >
                    <button
                      v-if="canManage"
                      class="secondary-button"
                      :data-testid="`carrier-detach-${smsc.engineId}`"
                      :disabled="busy === smsc.id"
                      @click="detach(smsc)"
                    >
                      {{ busy === smsc.id ? 'Detaching…' : 'Detach' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>

        <p class="source-note" data-testid="carrier-smscs-source-note">
          No endpoint returns the connections belonging to a carrier: the register is a roll-up of
          counts, and the SMSC list carries neither a carrier column nor bind state. This table is
          therefore assembled by reading each connection's own detail. Connections already known to
          be unassigned are skipped, so a fresh install costs nothing extra here.
        </p>
      </section>

      <!--
        Open alerts and Recent carrier events — two of the four panels the
        design system's CarrierDetailScreen specifies.

        Both are assembled from data this page already had: the alert register
        keys bind alerts as `engine:bind:<engineId>`, and every member SMSC's
        detail carries its own transition history. Neither needed a new endpoint.
      -->
      <section class="split-grid" data-testid="carrier-context">
        <article class="panel" data-testid="carrier-open-alerts">
          <header class="panel-header">
            <div>
              <h2>Open alerts</h2>
              <p>Unresolved alerts raised against this carrier's binds</p>
            </div>
            <router-link class="text-button" to="/alerts">Open Alerts</router-link>
          </header>
          <DataState
            :state="alertsState"
            subject="alerts for this carrier"
            skeleton="text"
            :skeleton-rows="3"
            empty-message="No open alert names a bind belonging to this carrier."
            testid="carrier-alerts-state"
            :on-retry="loadAlerts"
          >
            <ul class="health-list">
              <li
                v-for="alert in carrierAlerts"
                :key="String(alert.id)"
                :data-testid="`carrier-alert-${alert.id}`"
              >
                <span
                  class="status-dot"
                  :class="String(alert.severity) === 'critical' ? 'bad' : 'warn'"
                ></span>
                <span>
                  <strong>{{ alert.summary ?? alert.rule_name ?? 'alert' }}</strong>
                  <small>{{ alert.opened_at ?? alert.openedAt }}</small>
                </span>
                <span
                  class="status-badge"
                  :class="String(alert.severity) === 'critical' ? 'bad' : 'warn'"
                  >{{ alert.severity }}</span
                >
              </li>
            </ul>
          </DataState>
        </article>

        <article class="panel" data-testid="carrier-events">
          <header class="panel-header">
            <div>
              <h2>Recent carrier events</h2>
              <p>Bind transitions across every connection filed under this carrier</p>
            </div>
          </header>
          <EventTimeline v-if="carrierEvents.length" dense :items="carrierEvents" />
          <p v-else class="chart-empty" data-testid="carrier-events-empty">
            No bind transition has been recorded for any connection under this carrier. The history
            is never pruned, so an empty timeline means nothing has been observed to change — not
            that older entries aged out.
          </p>
        </article>
      </section>
    </template>
  </div>
</template>

<style src="./workspace-extras.css"></style>
