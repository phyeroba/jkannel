<script setup lang="ts">
/**
 * FAILOVER (PLAN.md 5.2, spec §9, UC-RTE-02).
 *
 * A manual failover is not an edit to a route. It is an override that sits on
 * top of the route's configuration, holds even while the configured target
 * looks healthy, and is reverted rather than undone. The single hard UI
 * requirement in UC-RTE-02 follows from that: the console must **always show the
 * current active path and never hide that a manual override is in effect** —
 * because the failure mode of this feature is an override that outlives the
 * incident it was raised for, on a route nobody is looking at any more.
 *
 * Three structural decisions serve that requirement:
 *
 *   - The active-override panel is FIRST and is rendered in every data state,
 *     including loading and error. A screen that shows overrides only once
 *     everything else has loaded is a screen that shows none during an outage.
 *   - The route table's active-path column comes from `activePathOf()`, which
 *     returns the target and the mode as one value. There is no code path here
 *     that can render "MTN-P2" without also rendering "manual override".
 *   - Reverting is offered on the override itself, next to the reason it was
 *     raised with, rather than buried in the route's own screen.
 *
 * Backend contract (backend/src/connectivity/safe-control.controller.ts):
 *   GET  /control/failovers                    routes.view
 *   POST /control/routes/:id/failover          routes.manage  {toSmscId, reason}
 *   POST /control/routes/:id/failover/revert   routes.manage  {reason}
 * plus `GET /routes` for the configured targets and `GET /smscs` for the picker,
 * and `GET /smscs/:engineId/detail` for the health and capacity of the two
 * connections being compared.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import EventTimeline from '../components/EventTimeline.vue';
import ConfirmAction from '../components/ConfirmAction.vue';
import DataState from '../components/DataState.vue';
import { canAccess, session } from '../stores/session';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  bindTone,
  bindWord,
  formatCeiling,
  formatMoment,
  formatRate,
  formatUtilisation,
  type SmscDetail,
} from '../utils/connectivity';
import {
  actorLabel,
  activePathOf,
  smscOptionsFrom,
  type ActionImpact,
  type ActiveFailover,
  type RouteRow,
  type SmscOption,
} from '../utils/safe-control';

const canManage = computed(() => canAccess(session.value, 'routes.manage'));

const failovers = ref<ActiveFailover[]>([]);

/**
 * Failover history for the timeline.
 *
 * Each row of `route_failovers` is TWO events when it has ended — the move and
 * the return — so one row expands into two steps. Collapsing them into one
 * would hide the thing an operator most wants to see: how long traffic sat on
 * the alternate path before it came back, and whether it ever did.
 */
interface FailoverRecord {
  id: string;
  route_name?: string | null;
  to_engine_id?: string | null;
  from_engine_id?: string | null;
  reason?: string | null;
  started_by?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  ended_by?: string | null;
  end_reason?: string | null;
}
const history = ref<FailoverRecord[]>([]);

/** Explicit, because flatMap over a conditional return widens to unknown[]. */
interface HistoryStep {
  at: string;
  label: string;
  detail: string;
  state: 'ok' | 'warn' | 'error';
}

const historySteps = computed<HistoryStep[]>(() =>
  history.value
    .flatMap<HistoryStep>((row) => {
      const moved = {
        at: String(row.started_at ?? '')
          .slice(0, 16)
          .replace('T', ' '),
        label: `${row.route_name ?? 'route'} → ${row.to_engine_id ?? 'unknown target'}`,
        detail: [row.reason, row.started_by ? `by ${row.started_by}` : '']
          .filter(Boolean)
          .join(' · '),
        // Amber, not red: a deliberate move is not a fault. The red step is the
        // one below, when a route is still sitting on its alternate path.
        state: 'warn' as const,
      };
      if (!row.ended_at) {
        return [
          {
            ...moved,
            detail: `${moved.detail}${moved.detail ? ' · ' : ''}still in effect`,
            state: 'error' as const,
          },
        ];
      }
      return [
        {
          at: String(row.ended_at).slice(0, 16).replace('T', ' '),
          label: `${row.route_name ?? 'route'} returned to ${row.from_engine_id ?? 'its primary'}`,
          detail: [row.end_reason, row.ended_by ? `by ${row.ended_by}` : '']
            .filter(Boolean)
            .join(' · '),
          state: 'ok' as const,
        },
        moved,
      ];
    })
    .sort((a, b) => b.at.localeCompare(a.at)),
);

/**
 * Spare capacity on a path, in messages per second.
 *
 * `unknown` when either half is unmeasured — a headroom computed against an
 * unobserved rate would read as full capacity available, which is the single
 * most dangerous wrong answer on this screen: it invites moving traffic onto a
 * bind nobody has confirmed is even up.
 */
function headroomOf(detail: SmscDetail | null): string {
  // effectiveTps is the ceiling across all this SMSC's connections, which is
  // the number a failover decision has to respect - not the per-connection one.
  const ceiling = detail?.capacity?.effectiveTps ?? null;
  const observed = detail?.capacity?.observedTps ?? detail?.outboundRate ?? null;
  if (ceiling === null || observed === null) return 'unknown';
  return `${Math.max(0, ceiling - observed).toFixed(1)}/s free`;
}
async function loadHistory() {
  try {
    const page = await apiRequest<{ items?: FailoverRecord[] }>('/control/failovers/history');
    history.value = Array.isArray(page?.items) ? page.items : [];
  } catch {
    // The control panels above report their own failures; an unreadable history
    // shows its empty state rather than a second error banner for one screen.
    history.value = [];
  }
}
const routes = ref<RouteRow[]>([]);
const smscs = ref<SmscOption[]>([]);
const state = ref<State>('loading');
const error = ref('');
const notice = ref('');

/** Which reads failed, so `partial` names something instead of implying all. */
const missing = ref<string[]>([]);

// --- Start a failover ----------------------------------------------------------
const selectedRouteId = ref('');
const targetId = ref('');
const pendingStart = ref(false);
const busy = ref(false);

// --- Revert an override --------------------------------------------------------
const revertTarget = ref<ActiveFailover | null>(null);

/** Bind state and capacity for the two connections being compared. */
const currentDetail = ref<SmscDetail | null>(null);
const proposedDetail = ref<SmscDetail | null>(null);
const comparisonError = ref('');
const comparedAt = ref('');

const selectedRoute = computed(
  () => routes.value.find((route) => route.id === selectedRouteId.value) ?? null,
);
const selectedPath = computed(() =>
  selectedRoute.value ? activePathOf(selectedRoute.value, failovers.value) : null,
);
/** Every SMSC except the one the route's traffic is already on. */
const targetOptions = computed(() =>
  smscs.value.filter((option) => option.id !== selectedPath.value?.targetId),
);
const proposed = computed(() => smscs.value.find((option) => option.id === targetId.value) ?? null);

const overriddenRoutes = computed(() =>
  routes.value.filter((route) => activePathOf(route, failovers.value).overridden),
);

/**
 * Whether the override register has actually been read.
 *
 * `failovers` is empty in three different situations and only one of them means
 * "nothing is overridden". Before the read completes, and after it fails, an
 * empty array is the absence of an answer — and "no manual override" is the
 * single most reassuring sentence on this screen, so it must never be printed
 * on the strength of a request that has not returned (§17).
 */
const overrideKnown = computed(
  () => state.value !== 'loading' && state.value !== 'error' && state.value !== 'permission-denied',
);
const overrideBadge = computed(() => {
  if (state.value === 'loading') return { word: 'reading…', tone: 'muted' };
  if (!overrideKnown.value) return { word: 'unknown', tone: 'muted' };
  if (!failovers.value.length) return { word: 'no manual override', tone: 'good' };
  const count = failovers.value.length;
  return { word: `${count} manual override${count === 1 ? '' : 's'}`, tone: 'warn' };
});

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function asItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const items = (payload as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

async function load() {
  state.value = 'loading';
  missing.value = [];
  try {
    const overrides = await apiRequest<{ items?: ActiveFailover[] }>('/control/failovers');
    failovers.value = asItems<ActiveFailover>(overrides);
    error.value = '';
  } catch (cause) {
    failovers.value = [];
    error.value = messageFrom(cause, 'Active failovers could not be read.');
    state.value = cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
    return;
  }

  // The two supporting reads are allowed to fail independently: an operator must
  // still see that an override is in force even if the route register is down.
  try {
    routes.value = asItems<RouteRow>(await apiRequest('/routes?limit=200&offset=0'));
  } catch {
    routes.value = [];
    missing.value.push('the route register');
  }
  try {
    smscs.value = smscOptionsFrom(asItems(await apiRequest('/smscs?limit=500&offset=0')));
  } catch {
    smscs.value = [];
    missing.value.push('the SMSC list');
  }

  if (!selectedRouteId.value && routes.value.length) selectedRouteId.value = routes.value[0].id;
  state.value = missing.value.length ? 'partial' : 'live';
}

/**
 * Read the live state of the current and proposed connections.
 *
 * UC-RTE-02 asks for a health and capacity comparison before the move. These
 * are readings from `GET /smscs/:engineId/detail` taken at `comparedAt`, not a
 * judgement: the screen shows the bind state, the ceiling and the observed rate
 * and lets the operator conclude.
 */
async function loadComparison() {
  currentDetail.value = null;
  proposedDetail.value = null;
  comparisonError.value = '';
  comparedAt.value = '';
  const currentId = selectedPath.value?.targetId ?? null;
  const engineFor = (id: string | null) => smscs.value.find((o) => o.id === id)?.engineId ?? '';
  const currentEngine = engineFor(currentId);
  const proposedEngine = proposed.value?.engineId ?? '';
  if (!currentEngine && !proposedEngine) return;
  try {
    const [a, b] = await Promise.all([
      currentEngine ? apiRequest<SmscDetail>(`/smscs/${currentEngine}/detail`) : null,
      proposedEngine ? apiRequest<SmscDetail>(`/smscs/${proposedEngine}/detail`) : null,
    ]);
    currentDetail.value = a;
    proposedDetail.value = b;
    comparedAt.value = new Date().toLocaleString();
  } catch (cause) {
    comparisonError.value = messageFrom(
      cause,
      'The health of these connections could not be read, so this move would be made blind.',
    );
  }
}

/**
 * The impact of the failover, assembled from readings rather than composed as a
 * warning.
 *
 * There is no `/control/routes/:id/impact` endpoint, so unlike the SMSC verbs
 * this is built client-side — and every line below is either a value returned by
 * an API or a statement of what the endpoint itself does. `blockedReason` is set
 * only for a condition the API will also refuse, so the dialog never blocks
 * something the backend would have allowed, or allows something it will reject.
 */
const failoverImpact = computed<ActionImpact | null>(() => {
  const route = selectedRoute.value;
  const path = selectedPath.value;
  const target = proposed.value;
  if (!route || !path) return null;
  const consequences: string[] = [];
  consequences.push(
    `Route “${route.name}” is configured to target ${path.configuredName}. The configured target is not changed — this override sits on top of it and is reverted rather than edited away.`,
  );
  if (path.overridden)
    consequences.push(
      `A manual override is already in effect on this route, moving traffic to ${path.targetName} since ${formatMoment(path.failover?.started_at)}. Confirming replaces it; the audit trail records the earlier one as superseded.`,
    );
  if (currentDetail.value)
    consequences.push(
      `Current path ${currentDetail.value.name}: bind ${bindWord(currentDetail.value.bindState)}, ${formatRate(currentDetail.value.outboundRate)} observed against ${formatCeiling(currentDetail.value.capacity)}, ${displayValue(currentDetail.value.queued, 'live')} queued. Messages already queued there do not move.`,
    );
  if (proposedDetail.value)
    consequences.push(
      `Proposed path ${proposedDetail.value.name}: bind ${bindWord(proposedDetail.value.bindState)}, ${formatRate(proposedDetail.value.outboundRate)} observed against ${formatCeiling(proposedDetail.value.capacity)}, utilisation ${formatUtilisation(proposedDetail.value.capacity?.utilisation)}.`,
    );
  else if (target)
    consequences.push(
      `The proposed target ${target.label} could not be read, so nothing is known here about its bind state or spare capacity.`,
    );

  let blockedReason: string | null = null;
  if (!target) blockedReason = 'Choose a target connection before confirming.';
  else if (target.id === route.target_smsc_id && !path.overridden)
    // The API refuses this with a 400 for the same reason: it would appear in
    // the audit trail as a change that did not happen.
    blockedReason = `${target.label} is already this route's configured target, so there is nothing to move.`;
  else if (target.id === path.targetId)
    blockedReason = `This route's traffic is already on ${target.label}.`;

  return {
    operation: 'failover',
    subject: route.name,
    summary: target
      ? `Move ${route.name} traffic from ${path.targetName} to ${target.label}.`
      : `Move ${route.name} traffic away from ${path.targetName}.`,
    consequences,
    // The queue that matters at this moment is the one on the path being left.
    queuedMessages: currentDetail.value?.queued ?? null,
    reasonRequired: true,
    blockedReason,
  };
});

const revertImpact = computed<ActionImpact | null>(() => {
  const override = revertTarget.value;
  if (!override) return null;
  const route = routes.value.find((entry) => entry.id === override.route_id) ?? null;
  const configured = route?.target_smsc_name ?? route?.target_smsc_id ?? 'its configured target';
  return {
    operation: 'failover',
    subject: override.route_name ?? override.route_id,
    summary: `End the manual override on ${override.route_name ?? override.route_id} and return it to ${configured}.`,
    consequences: [
      `Traffic returns to ${configured}, whatever state that connection is in right now. Reverting does not check it.`,
      `The override being ended was raised ${formatMoment(override.started_at)} by ${actorLabel(override.started_by)} with the reason: ${override.reason ?? 'none recorded'}.`,
      'Automatic selection — including the route’s own fallback — applies again from the moment this is confirmed.',
    ],
    queuedMessages: null,
    reasonRequired: true,
    blockedReason: null,
  };
});

function openStart() {
  if (!proposed.value) return;
  pendingStart.value = true;
}

async function confirmStart(reason: string) {
  const route = selectedRoute.value;
  const target = proposed.value;
  if (!route || !target) return;
  busy.value = true;
  try {
    await apiRequest(`/control/routes/${route.id}/failover`, {
      method: 'POST',
      body: JSON.stringify({ toSmscId: target.id, reason }),
    });
    notice.value = `${route.name} is now on ${target.label} under a manual override. It stays there until an operator reverts it.`;
    pendingStart.value = false;
    await load();
    await loadComparison();
  } catch (cause) {
    error.value = messageFrom(cause, 'The failover was refused.');
    pendingStart.value = false;
  } finally {
    busy.value = false;
  }
}

function openRevert(override: ActiveFailover) {
  revertTarget.value = override;
}

async function confirmRevert(reason: string) {
  const override = revertTarget.value;
  if (!override) return;
  busy.value = true;
  try {
    await apiRequest(`/control/routes/${override.route_id}/failover/revert`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    notice.value = `The manual override on ${override.route_name ?? override.route_id} has ended. The route is back on its configured target.`;
    revertTarget.value = null;
    await load();
    await loadComparison();
  } catch (cause) {
    error.value = messageFrom(cause, 'The override could not be reverted.');
    revertTarget.value = null;
  } finally {
    busy.value = false;
  }
}

watch([selectedRouteId, targetId], () => {
  void loadComparison();
});
watch(targetOptions, (options) => {
  if (!options.some((option) => option.id === targetId.value)) targetId.value = '';
});

onMounted(() => {
  void load();
  void loadHistory();
});
</script>

<template>
  <div data-testid="failover-view">
    <!--
      ACTIVE OVERRIDES, FIRST AND UNCONDITIONALLY.
      Rendered outside the page's DataState so that a failed route or SMSC read
      cannot take the one fact an operator must not miss off the screen.
    -->
    <section
      class="panel override-panel"
      :class="overriddenRoutes.length || failovers.length ? 'active' : ''"
      data-testid="failover-active"
      aria-labelledby="failover-active-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="failover-active-heading">Manual overrides in effect</h2>
          <p>
            An override holds a route on a chosen connection until someone ends it. It does not
            expire and it does not report itself anywhere else.
          </p>
        </div>
        <span
          class="status-badge"
          :class="overrideBadge.tone"
          data-testid="failover-active-badge"
          >{{ overrideBadge.word }}</span
        >
      </header>

      <p v-if="notice" class="notice" role="status" data-testid="failover-notice">{{ notice }}</p>
      <p v-if="error" class="form-error" role="alert" data-testid="failover-error">{{ error }}</p>

      <p v-if="state === 'loading'" class="chart-empty" data-testid="failover-reading">
        Reading the override register. Until it answers, this screen makes no claim about whether a
        route is being held on a manual target.
      </p>
      <p v-else-if="!overrideKnown" class="warn-notice" role="alert" data-testid="failover-unknown">
        <strong>Whether any override is in effect could not be established.</strong>
        {{ error }} This is not a statement that none is in force — the register was not read, so a
        route may still be held on a manual target right now.
      </p>

      <div v-else-if="failovers.length" class="table-wrap">
        <table data-testid="failover-active-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Traffic is on</th>
              <th scope="col">Configured target</th>
              <th scope="col">Reason given</th>
              <th scope="col">Started</th>
              <th scope="col">By</th>
              <th scope="col">Revert</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="override in failovers"
              :key="override.id"
              :data-testid="`failover-row-${override.route_id}`"
            >
              <td>
                <strong>{{ override.route_name ?? override.route_id }}</strong>
                <small class="row-id mono">{{ override.route_id }}</small>
              </td>
              <td>
                <span class="status-badge warn">manual override</span>
                <small class="row-id mono">{{
                  override.to_name ?? override.to_engine_id ?? override.to_smsc_id
                }}</small>
              </td>
              <td class="mono">
                {{
                  routes.find((route) => route.id === override.route_id)?.target_smsc_name ??
                  'not read'
                }}
              </td>
              <td>{{ override.reason ?? 'none recorded' }}</td>
              <td class="mono">{{ formatMoment(override.started_at) }}</td>
              <td class="mono">{{ actorLabel(override.started_by) }}</td>
              <td>
                <button
                  v-if="canManage"
                  class="secondary-button"
                  type="button"
                  :data-testid="`failover-revert-${override.route_id}`"
                  @click="openRevert(override)"
                >
                  Revert
                </button>
                <span v-else class="row-id">needs routes.manage</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="chart-empty" data-testid="failover-none">
        No route is being held on a manual override. Every route below is on the target its own
        configuration selects, and automatic fallback applies normally.
      </p>
    </section>

    <!-- THE ESTATE, WITH ITS ACTIVE PATH -------------------------------------- -->
    <section class="panel" data-testid="failover-routes" aria-labelledby="failover-routes-heading">
      <header class="panel-header">
        <div>
          <h2 id="failover-routes-heading">Routes and their current path</h2>
          <p>
            The active path is what traffic follows now. Where it differs from the configured
            target, the mode column says why.
          </p>
        </div>
      </header>

      <DataState
        :state="state"
        subject="routes"
        skeleton="table"
        :skeleton-rows="5"
        :missing="missing"
        :detail="state === 'error' ? error : undefined"
        permission="routes.view"
        testid="failover-state"
        :on-retry="load"
      >
        <div v-if="routes.length" class="table-wrap">
          <table data-testid="failover-route-table">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col">Matches</th>
                <th scope="col">Active target</th>
                <th scope="col">Mode</th>
                <th scope="col">Configured target</th>
                <th scope="col">Configured fallback</th>
                <th scope="col">Enabled</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="route in routes"
                :key="route.id"
                :class="route.id === selectedRouteId ? 'selected-row' : ''"
                :data-testid="`route-${route.id}`"
              >
                <td>
                  <button
                    class="text-button link-button"
                    type="button"
                    :data-testid="`route-select-${route.id}`"
                    @click="selectedRouteId = route.id"
                  >
                    {{ route.name }}
                  </button>
                  <small class="row-id mono"
                    >priority {{ displayValue(route.priority, state) }}</small
                  >
                </td>
                <td class="mono">
                  {{ route.destination_prefix ? `prefix ${route.destination_prefix}` : 'any' }}
                </td>
                <td class="mono" :data-testid="`route-active-${route.id}`">
                  {{ activePathOf(route, failovers).targetName }}
                </td>
                <td>
                  <!-- The word, not only the colour (§17.1). -->
                  <span
                    class="status-badge"
                    :class="activePathOf(route, failovers).modeTone"
                    :data-testid="`route-mode-${route.id}`"
                    >{{ activePathOf(route, failovers).modeWord }}</span
                  >
                </td>
                <td class="mono">{{ activePathOf(route, failovers).configuredName }}</td>
                <td class="mono">{{ route.fallback_smsc_name ?? 'none configured' }}</td>
                <td>
                  <span class="status-badge" :class="route.enabled ? 'good' : 'muted'">{{
                    route.enabled ? 'enabled' : 'disabled'
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="chart-empty" data-testid="failover-routes-empty">
          No routing rule is configured, so there is nothing to fail over. Routes are created in the
          Routing workspace.
        </p>
      </DataState>
    </section>

    <!-- START A FAILOVER -------------------------------------------------------- -->
    <section
      v-if="selectedRoute && selectedPath"
      class="panel"
      data-testid="failover-form"
      aria-labelledby="failover-form-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="failover-form-heading">Fail over {{ selectedRoute.name }}</h2>
          <p>
            Traffic is currently on
            <strong data-testid="failover-current-path">{{ selectedPath.targetName }}</strong>
            ({{ selectedPath.modeWord }}). Compare the two connections before committing.
          </p>
        </div>
      </header>

      <p v-if="!canManage" class="warn-notice" role="note" data-testid="failover-readonly">
        You can read failover state but not change it. Starting or reverting an override requires
        the <span class="mono">routes.manage</span> permission.
      </p>

      <div class="grid-toolbar">
        <label class="filter-select">
          <span>Route</span>
          <select v-model="selectedRouteId" data-testid="failover-route-select">
            <option v-for="route in routes" :key="route.id" :value="route.id">
              {{ route.name }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Move traffic to</span>
          <select v-model="targetId" data-testid="failover-target-select">
            <option value="">Choose a connection…</option>
            <option v-for="option in targetOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>

      <div class="table-wrap">
        <table data-testid="failover-comparison">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Connection</th>
              <th scope="col">Bind</th>
              <th scope="col">Queued</th>
              <th scope="col">TPS</th>
              <th scope="col">Used / capacity</th>
              <!-- Headroom is the figure the decision actually turns on: how
                   much of the proposed path's ceiling is still free. Utilisation
                   says the same thing inverted, and an operator moving traffic
                   under pressure should not have to do the subtraction. -->
              <th scope="col">Headroom</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="failover-compare-current">
              <td>Current</td>
              <td class="mono">{{ selectedPath.targetName }}</td>
              <td>
                <span class="status-badge" :class="bindTone(currentDetail?.bindState)">{{
                  currentDetail ? bindWord(currentDetail.bindState) : 'not read'
                }}</span>
              </td>
              <td class="mono">{{ displayValue(currentDetail?.queued, 'live') }}</td>
              <td class="mono">{{ formatRate(currentDetail?.outboundRate) }}</td>
              <td class="mono">{{ formatCeiling(currentDetail?.capacity) }}</td>
              <td class="mono">{{ headroomOf(currentDetail) }}</td>
            </tr>
            <tr data-testid="failover-compare-proposed">
              <td>Proposed</td>
              <td class="mono">{{ proposed ? proposed.label : 'none chosen' }}</td>
              <td>
                <span class="status-badge" :class="bindTone(proposedDetail?.bindState)">{{
                  proposedDetail ? bindWord(proposedDetail.bindState) : 'not read'
                }}</span>
              </td>
              <td class="mono">{{ displayValue(proposedDetail?.queued, 'live') }}</td>
              <td class="mono">{{ formatRate(proposedDetail?.outboundRate) }}</td>
              <td class="mono">{{ formatCeiling(proposedDetail?.capacity) }}</td>
              <td class="mono">{{ headroomOf(proposedDetail) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="comparedAt" class="source-note" data-testid="failover-compared-at">
        Read from <span class="mono">GET /smscs/:engineId/detail</span> at {{ comparedAt }}. These
        are observations, not a recommendation — JKANNEL does not decide whether the proposed target
        can carry this route.
      </p>
      <p
        v-if="comparisonError"
        class="warn-notice"
        role="alert"
        data-testid="failover-compare-error"
      >
        {{ comparisonError }}
      </p>
      <p
        v-if="proposedDetail && proposedDetail.bindState !== 'bound'"
        class="warn-notice"
        role="alert"
        data-testid="failover-target-warning"
      >
        The proposed target's bind reads
        <strong>{{ bindWord(proposedDetail.bindState) }}</strong
        >, not <span class="mono">bound</span>. Moving traffic onto it would stop this route rather
        than restore it. The API will still accept the move — this console does not block it,
        because a bind that is mid-reconnect is a legitimate target for a planned switch.
      </p>

      <footer class="detail-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="failover-start"
          :disabled="!canManage || !proposed || busy"
          @click="openStart"
        >
          Review impact and fail over
        </button>
      </footer>
    </section>

    <ConfirmAction
      :open="pendingStart"
      operation="failover"
      :impact="failoverImpact"
      :title="`Fail over ${selectedRoute?.name ?? ''}`"
      verb="Fail over"
      :busy="busy"
      testid="failover-confirm"
      @close="pendingStart = false"
      @confirm="confirmStart"
    />

    <ConfirmAction
      :open="Boolean(revertTarget)"
      operation="failover"
      :impact="revertImpact"
      :title="`Revert the override on ${revertTarget?.route_name ?? ''}`"
      verb="Revert override"
      :busy="busy"
      testid="revert-confirm"
      @close="revertTarget = null"
      @confirm="confirmRevert"
    />

    <!--
      Transition history — §7, and the design system's second Failover panel.
      Read from `route_failovers`, which keeps ended rows with their end reason,
      so the record already existed and nothing new had to be captured.
    -->
    <section class="panel" data-testid="failover-history">
      <header class="panel-header">
        <div>
          <h2 id="failover-history-heading">Transition history</h2>
          <p>Every failover, with the reason given at the time</p>
        </div>
        <router-link class="text-button" to="/logs-audit">Open Audit Trail</router-link>
      </header>
      <EventTimeline v-if="historySteps.length" :items="historySteps" />
      <p v-else class="chart-empty" data-testid="failover-history-empty">
        No route has been failed over. The record is kept indefinitely, so an empty history means
        traffic has never been moved by hand — not that older moves have aged out.
      </p>
    </section>
  </div>
</template>

<style scoped>
.override-panel {
  border-left: 3px solid var(--good);
}
.override-panel.active {
  border-left-color: var(--warn);
}
.selected-row td {
  background: color-mix(in srgb, var(--brand) 8%, transparent);
}
.link-button {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
</style>
<style src="./workspace-extras.css"></style>
