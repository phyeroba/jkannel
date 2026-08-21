<script setup lang="ts">
/**
 * SMSC DETAIL (PLAN.md 2.4, spec §4.2).
 *
 *   GET /smscs/:engineId/detail  ->  backend/src/connectivity/smsc-detail.controller.ts
 *
 * §4.2 asks for state, sessions, TPS, capacity and utilisation, queue depth and
 * oldest age, DLR rate, last event and actions. This screen shows the ones the
 * engine actually reports and says plainly which it does not:
 *
 *   - SESSIONS. bearerbox has no per-session view; `instances = N` collapses N
 *     real SMPP sessions into one `smsc-id`. The `limits` block says so, and
 *     there is no sessions table here pretending otherwise.
 *   - OLDEST QUEUED AGE. Not in `/status.json` and not in the bind snapshot, so
 *     it is absent rather than approximated from a rate.
 *   - DLR RATE. The counters below are the engine's own submission aggregates,
 *     not receipts. Labelled as such, because "failed" next to "sent" reads as
 *     a delivery outcome and is not one.
 *
 * CONTROLLED ACTIONS (reconnect / disable / enable / suspend / resume) are
 * PLAN.md 5.1–5.3. They live on the SMSC register grid, where every connection
 * is in reach, and each one goes through `components/ConfirmAction.vue` — which
 * states the backend's computed impact before offering the verb. They are not
 * duplicated here, because a second set of controls is a second thing to keep in
 * step with the impact contract.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import ObservabilityLimits from '../components/ObservabilityLimits.vue';
import EventTimeline from '../components/EventTimeline.vue';
import ConfirmAction from '../components/ConfirmAction.vue';
import { canAccess, session } from '../stores/session';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import {
  controlEndpoint,
  operationVerb,
  reasonIsRecorded,
  type ControlOperation,
} from '../utils/safe-control';
import { severityTone, type OperationalEvent } from '../utils/diagnostics';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  bindTone,
  bindWord,
  formatCeiling,
  formatMoment,
  formatRate,
  formatUtilisation,
  utilisationTone,
  type BindTransition,
  type SmscDetail,
} from '../utils/connectivity';
import { formatDuration } from '../utils/traffic';

const route = useRoute();
const engineId = computed(() => String(route.params.engineId ?? ''));

const smsc = ref<SmscDetail | null>(null);
const state = ref<State>('loading');
const error = ref('');
const notFound = ref(false);

const capacity = computed(() => smsc.value?.capacity ?? null);
const transitions = computed<BindTransition[]>(() => smsc.value?.transitions ?? []);
/** The most recent bind transition — §4.2's "last event". */
const lastEvent = computed<BindTransition | null>(() => transitions.value[0] ?? null);

/* --- SESSIONS ON THIS SMSC ---------------------------------------------------
 *
 * The design shows one row per SMPP session. This engine cannot: `instances = N`
 * forks N sessions that all share one smsc-id, and `/status.json` reports the
 * group as a single entry with combined counters. So the table has ONE row, and
 * it says how many sessions are collapsed into it rather than inventing N rows
 * with the group's figures repeated — which would look like per-session data
 * and be read as such.
 *
 * Timeouts is the design's seventh column and is absent for the same reason it
 * is absent everywhere else in this console: the engine reports no per-session
 * timing at all. An empty column would have said nobody timed out.
 */
const configuredSessions = computed(() => smsc.value?.limits?.configuredInstances ?? 1);

/**
 * How long the bind has held its current state.
 *
 * Only meaningful while bound: on a disconnected connection this is how long it
 * has been DOWN, which is a different fact and is labelled as such rather than
 * printed under a column called Uptime.
 */
const bindUptimeSeconds = computed<number | null>(() => {
  const since = smsc.value?.bindStateSince;
  if (!since) return null;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
});

const bindUptime = computed(() => {
  if (bindUptimeSeconds.value === null) return 'never observed';
  const held = formatDuration(bindUptimeSeconds.value);
  return bindTone(smsc.value?.bindState) === 'good' ? held : `down ${held}`;
});

/**
 * Reconnects: transitions INTO a bound state.
 *
 * Counted from the transition history, which is never pruned, so this is the
 * lifetime count rather than a window — stated on the screen, because "4
 * reconnects" means something very different over an hour than over a month.
 */
const reconnectCount = computed(
  () => transitions.value.filter((entry) => entry.toState === 'bound').length,
);

function toneForTransition(entry: BindTransition): string {
  if (entry.toState === 'bound') return 'good';
  if (entry.toState === 'failed' || entry.toState === 'disconnected') return 'bad';
  if (entry.toState === null) return 'muted';
  return 'warn';
}

/**
 * The same judgement as {@link toneForTransition}, in the timeline's own
 * vocabulary. `missing` is deliberately reachable: a transition recorded with
 * no destination state is a gap in what we observed, and the design system
 * draws that as a hollow dashed dot rather than letting it pass as a normal
 * step.
 */
function timelineState(entry: BindTransition): 'ok' | 'warn' | 'error' | 'missing' {
  if (entry.toState === 'bound') return 'ok';
  if (entry.toState === 'failed' || entry.toState === 'disconnected') return 'error';
  if (entry.toState === null) return 'missing';
  return 'warn';
}

function describeTransition(entry: BindTransition): string {
  const from = entry.fromState ?? 'no recorded state';
  const to = entry.toState ?? 'no recorded state';
  return `${from} → ${to}`;
}

/** The `detail` JSON is free-form; render it as text rather than dropping it. */
function transitionDetail(entry: BindTransition): string {
  if (!entry.detail || typeof entry.detail !== 'object') return '';
  const parts = Object.entries(entry.detail).map(
    ([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
  );
  return parts.join(' · ');
}

async function load() {
  state.value = 'loading';
  notFound.value = false;
  try {
    const detail = await apiRequest<SmscDetail>(`/smscs/${engineId.value}/detail`);
    smsc.value = detail;
    error.value = '';
    state.value = 'live';
    // The real hierarchy (§2.1). An unfiled connection genuinely has no carrier
    // ancestor, so it gets the SMSC register as its parent instead of an
    // invented one.
    setBreadcrumbTrail(
      route.path,
      detail.carrierId && detail.carrierName
        ? [
            { label: 'Carriers', to: '/carriers' },
            { label: detail.carrierName, to: `/carriers/${detail.carrierId}` },
            { label: detail.name },
          ]
        : [{ label: 'SMSC Connections', to: '/smsc' }, { label: detail.name }],
    );
  } catch (reason) {
    smsc.value = null;
    notFound.value = reason instanceof ApiError && reason.status === 404;
    error.value = messageFrom(reason, 'This SMSC could not be loaded.');
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/* --- RECENT EVENTS -----------------------------------------------------------
 *
 * Structured operational events recorded against this connection. Distinct from
 * the bind timeline below it: that is JKANNEL's own observation of state
 * changes, while these are events the platform CHOSE to record — a suspension,
 * a failover, an alert opening — and they carry a severity the transitions do
 * not.
 */
const events = ref<OperationalEvent[]>([]);
const eventsState = ref<State>('loading');

async function loadEvents() {
  eventsState.value = 'loading';
  try {
    const page = await apiRequest<{ items?: OperationalEvent[] }>(
      `/diagnostics/events?limit=25&subjectType=smsc&subjectId=${encodeURIComponent(engineId.value)}`,
    );
    events.value = Array.isArray(page?.items) ? page.items : [];
    eventsState.value = events.value.length ? 'live' : 'empty';
  } catch (reason) {
    events.value = [];
    eventsState.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

/* --- CONTROLLED OPERATIONS ----------------------------------------------------
 *
 * `smsc_deployments` is not a config-deployment log despite the name: it is the
 * record of every controlled operation run against this connection — reconnect,
 * disable, suspend, resume — with who asked, the reason they gave and how it
 * was verified.
 *
 * It belongs beside the page actions rather than in the audit trail, because
 * the question it answers is local: "has somebody already tried this, and what
 * happened". An operator about to reconnect a flapping bind for the third time
 * should be able to see the first two.
 */
const operations = ref<Record<string, unknown>[]>([]);
const operationsState = ref<State>('loading');

async function loadOperations() {
  operationsState.value = 'loading';
  const id = smsc.value?.id;
  if (!id) {
    operationsState.value = 'empty';
    return;
  }
  try {
    const rows = await apiRequest<unknown>(`/smscs/${id}/deployments`);
    operations.value = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    operationsState.value = operations.value.length ? 'live' : 'empty';
  } catch (reason) {
    operations.value = [];
    operationsState.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

/**
 * Whether the bind observation is old enough to distrust.
 *
 * The poller's cadence is not known to this screen, so the threshold is a flat
 * five minutes — comfortably longer than any configured interval, which means a
 * banner here is a real gap in observation rather than a slow cycle.
 */
const STALE_AFTER_SECONDS = 300;

const observationAgeSeconds = computed<number | null>(() => {
  const at = smsc.value?.bindObservedAt;
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
});

const observationStale = computed(
  () => observationAgeSeconds.value !== null && observationAgeSeconds.value > STALE_AFTER_SECONDS,
);

const suspended = computed(() => Boolean(smsc.value?.trafficSuspendedAt));

/* --- CONTROLLED ACTIONS ------------------------------------------------------
 *
 * The design puts reconnect / suspend / resume on the connection they affect,
 * and it is right: an operator who has drilled into a failing bind should not
 * have to navigate back to the register to act on it.
 *
 * These are not a second implementation. They open the SAME `ConfirmAction`
 * component the register uses, which fetches its impact from
 * `GET /control/smscs/:id/impact/:operation` and posts through the same
 * `controlEndpoint()` — so there is one impact contract and one place that
 * knows which operations actually record a reason.
 */
const canManage = computed(() => canAccess(session.value, 'smsc.manage'));
const pendingOperation = ref<ControlOperation | null>(null);
const actionBusy = ref(false);
const actionNotice = ref('');
const actionError = ref('');

async function confirmAction(reason: string) {
  const operation = pendingOperation.value;
  const id = smsc.value?.id;
  if (!operation || !id) return;
  actionBusy.value = true;
  actionError.value = '';
  try {
    await apiRequest(controlEndpoint(operation, id), {
      method: 'POST',
      body: JSON.stringify(reasonIsRecorded(operation) ? { reason } : {}),
    });
    actionNotice.value = `${operationVerb(operation)} accepted on ${smsc.value?.name ?? id}.`;
    pendingOperation.value = null;
    await load();
  } catch (cause) {
    actionError.value = messageFrom(cause, `The ${operation} could not be carried out.`);
  } finally {
    actionBusy.value = false;
  }
}

async function reload() {
  await load();
  // Both keyed on the record loaded above: events on the engine id, operations
  // on the uuid, so neither can run before it is known.
  await Promise.all([loadEvents(), loadOperations()]);
}

onMounted(reload);
watch(engineId, reload);
</script>

<template>
  <div data-testid="smsc-detail-view">
    <section v-if="notFound" class="panel" data-testid="smsc-not-found">
      <h2>SMSC not found</h2>
      <p>
        No connection with the engine id <span class="mono">{{ engineId }}</span> is in the
        register. It may have been removed, or the link may be stale.
      </p>
      <router-link class="primary-button" to="/smsc">Back to SMSC Connections</router-link>
    </section>

    <template v-else>
      <!--
        PAGE ACTIONS. The design's PageAction bar: the controls for a connection
        sit with the connection, so an operator who has drilled into a failing
        bind does not have to navigate back to the register to act on it. They
        open the same ConfirmAction the register opens, against the same impact
        endpoint — one contract, two places it can be reached from.
      -->
      <div v-if="smsc && canManage" class="page-actions" data-testid="smsc-page-actions">
        <button
          v-if="!suspended"
          class="primary-button"
          type="button"
          data-testid="smsc-action-reconnect"
          @click="pendingOperation = 'reconnect'"
        >
          Reconnect
        </button>
        <button
          v-if="suspended"
          class="secondary-button"
          type="button"
          data-testid="smsc-action-resume"
          @click="pendingOperation = 'resume'"
        >
          Resume traffic
        </button>
        <button
          v-else
          class="secondary-button danger-button"
          type="button"
          data-testid="smsc-action-suspend"
          @click="pendingOperation = 'suspend'"
        >
          Suspend traffic
        </button>
      </div>

      <p v-if="actionNotice" class="notice" role="status" data-testid="smsc-action-notice">
        {{ actionNotice }}
      </p>
      <p v-if="actionError" class="form-error" role="alert" data-testid="smsc-action-error">
        {{ actionError }}
      </p>

      <!--
        Suspension is an operator's decision, not a carrier fault, and the two
        look identical in a bind state. Saying so here stops somebody escalating
        to a carrier about traffic their own colleague stopped.
      -->
      <p v-if="suspended" class="stale-banner" role="status" data-testid="smsc-suspended-banner">
        <strong>Suspended by an operator — this is not a carrier fault.</strong>
        Traffic stops here until somebody resumes it.
        <template v-if="smsc?.trafficSuspendedReason">
          Reason given: {{ smsc.trafficSuspendedReason }}.
        </template>
        <template v-if="smsc?.trafficSuspendedBy"> Suspended by {{ smsc.trafficSuspendedBy }}.</template>
      </p>

      <p
        v-else-if="observationStale"
        class="stale-banner"
        role="status"
        data-testid="smsc-stale-banner"
      >
        <strong>This connection has not been observed recently.</strong>
        The last poll landed {{ formatDuration(observationAgeSeconds ?? 0) }} ago, so every figure
        below is that old. It is not a report that the bind is down — nobody has looked.
      </p>

      <section class="panel" data-testid="smsc-identity" aria-labelledby="smsc-heading">
        <DataState
          :state="state"
          subject="this SMSC connection"
          skeleton="cards"
          :skeleton-rows="4"
          :detail="state === 'error' ? error : undefined"
          permission="smsc.view"
          testid="smsc-detail-state"
          :on-retry="load"
        >
          <header class="panel-header">
            <div>
              <h2 id="smsc-heading">{{ smsc?.name }}</h2>
              <p>
                <span class="mono">{{ smsc?.engineId }}</span> · {{ smsc?.type }} ·
                <template v-if="smsc?.carrierId">
                  <router-link class="text-link" :to="`/carriers/${smsc.carrierId}`">{{
                    smsc.carrierName
                  }}</router-link>
                </template>
                <template v-else>not filed under a carrier</template>
              </p>
            </div>
            <span
              class="status-badge"
              :class="bindTone(smsc?.bindState)"
              data-testid="smsc-bind-badge"
              >{{ bindWord(smsc?.bindState) }}</span
            >
          </header>

          <p
            v-if="smsc && !smsc.bindState"
            class="warn-notice"
            role="note"
            data-testid="smsc-never-observed"
          >
            The poller has never recorded a bind state for this connection. That is not the same as
            “disconnected” — it means nothing has been observed, so no claim is made about whether
            this bind is up.
          </p>

          <div class="summary-strip">
            <div class="metric">
              <strong data-testid="smsc-metric-queued">{{
                displayValue(smsc?.queued, state)
              }}</strong>
              <small>queued for this bind</small>
            </div>
            <div class="metric">
              <strong data-testid="smsc-metric-failed">{{
                displayValue(smsc?.failed, state)
              }}</strong>
              <small>failed submissions</small>
            </div>
            <div class="metric">
              <strong data-testid="smsc-metric-sent">{{ displayValue(smsc?.sent, state) }}</strong>
              <small>sent, since engine start</small>
            </div>
            <div class="metric">
              <strong data-testid="smsc-metric-received">{{
                displayValue(smsc?.received, state)
              }}</strong>
              <small>received, since engine start</small>
            </div>
            <div class="metric">
              <strong data-testid="smsc-metric-out">{{
                formatRate(smsc?.outboundRate, state)
              }}</strong>
              <small>outbound rate</small>
            </div>
            <div class="metric">
              <strong data-testid="smsc-metric-in">{{
                formatRate(smsc?.inboundRate, state)
              }}</strong>
              <small>inbound rate</small>
            </div>
          </div>

          <p class="source-note" data-testid="smsc-counter-note">
            These are the engine's own aggregate counters for this
            <span class="mono">smsc-id</span>, not delivery receipts.
            <strong>“Failed” counts submissions the engine could not hand to the carrier</strong> —
            it is not a count of undelivered messages, and there is no delivery-receipt breakdown at
            this level. Delivery outcomes live in Delivery Reports, which is keyed on messages
            rather than on binds.
          </p>
        </DataState>
      </section>

      <!--
        THE LIMITS BLOCK. Placed directly under the figures it qualifies, not at
        the bottom of the page: an operator reading "0 failed" has to be able to
        see, without scrolling, which failures this engine is even capable of
        reporting.
      -->
      <ObservabilityLimits v-if="smsc" :limits="smsc.limits" scope="smsc" testid="smsc-limits" />

      <!-- CAPACITY ----------------------------------------------------------- -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-capacity"
        aria-labelledby="smsc-capacity-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-capacity-heading">Capacity and utilisation</h2>
            <p>Configured ceiling against the rate actually observed.</p>
          </div>
          <span
            class="status-badge"
            :class="utilisationTone(capacity?.utilisation)"
            data-testid="smsc-utilisation-badge"
            >{{ formatUtilisation(capacity?.utilisation, state) }}</span
          >
        </header>

        <dl class="detail-grid">
          <dt>Per connection</dt>
          <dd class="mono" data-testid="smsc-capacity-per-connection">
            {{
              capacity?.perConnectionTps === null
                ? 'not configured'
                : `${capacity?.perConnectionTps}/s`
            }}
          </dd>
          <dt>Connections</dt>
          <dd class="mono" data-testid="smsc-capacity-connections">
            {{ capacity?.connections }}
          </dd>
          <dt>Effective ceiling</dt>
          <dd class="mono" data-testid="smsc-capacity-effective">
            {{ formatCeiling(capacity) }}
          </dd>
          <dt>Observed</dt>
          <dd class="mono" data-testid="smsc-capacity-observed">
            {{ formatRate(capacity?.observedTps, state) }}
          </dd>
          <dt>Utilisation</dt>
          <dd class="mono" data-testid="smsc-capacity-utilisation">
            {{ formatUtilisation(capacity?.utilisation, state) }}
          </dd>
        </dl>

        <!-- Verbatim from the API: the per-connection multiplier is the part
             that surprises people, and paraphrasing it here would let the
             console's wording drift from the arithmetic behind it. -->
        <p class="warn-notice" role="note" data-testid="smsc-capacity-note">
          {{ capacity?.note }}
        </p>
        <p
          v-if="capacity && capacity.utilisation === null"
          class="source-note"
          data-testid="smsc-utilisation-unknown"
        >
          Utilisation reads <span class="mono">unknown</span> because
          {{
            capacity.effectiveTps === null
              ? 'no throughput ceiling is configured for this connection'
              : 'no outbound rate has been observed for this connection'
          }}. It is not 0% and it is not 100%; nobody has measured it.
        </p>
      </section>

      <!-- CONNECTION FACTS ---------------------------------------------------- -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-connection"
        aria-labelledby="smsc-connection-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-connection-heading">Connection</h2>
            <p>Credentials stay with the engine and are never sent to the browser.</p>
          </div>
        </header>
        <dl class="detail-grid">
          <dt>Bind state</dt>
          <dd>
            <span class="status-badge" :class="bindTone(smsc.bindState)">{{
              bindWord(smsc.bindState)
            }}</span>
          </dd>
          <dt>In this state since</dt>
          <dd class="mono">{{ formatMoment(smsc.bindStateSince) }}</dd>
          <dt>Last observed</dt>
          <dd class="mono" data-testid="smsc-observed-at">
            {{ formatMoment(smsc.bindObservedAt) }}
          </dd>
          <dt>Endpoint</dt>
          <dd class="mono">
            {{ smsc.host || 'not recorded' }}<template v-if="smsc.port">:{{ smsc.port }}</template>
          </dd>
          <dt>Type</dt>
          <dd class="mono">{{ smsc.type }}</dd>
          <dt>Enabled</dt>
          <dd>
            <span class="status-badge" :class="smsc.enabled ? 'good' : 'muted'">{{
              smsc.enabled ? 'enabled' : 'disabled'
            }}</span>
          </dd>
          <dt>Lifecycle</dt>
          <dd class="mono">{{ smsc.lifecycleState }}</dd>
          <dt>Carrier</dt>
          <dd>
            <router-link
              v-if="smsc.carrierId"
              class="text-link"
              :to="`/carriers/${smsc.carrierId}`"
              >{{ smsc.carrierName }}</router-link
            >
            <span v-else
              >unassigned —
              <router-link class="text-link" to="/carriers"
                >file it under a carrier</router-link
              ></span
            >
          </dd>
          <dt>Last event</dt>
          <dd data-testid="smsc-last-event">
            <template v-if="lastEvent">
              <span class="mono">{{ formatMoment(lastEvent.observedAt) }}</span> —
              {{ lastEvent.kind }} ({{ describeTransition(lastEvent) }})
            </template>
            <template v-else>no bind transition has ever been recorded</template>
          </dd>
        </dl>
      </section>

      <!-- SESSIONS ON THIS SMSC ------------------------------------------------ -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-sessions"
        aria-labelledby="smsc-sessions-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-sessions-heading">Sessions on this SMSC</h2>
            <p>
              Compare siblings to tell a session fault from a carrier-wide one — which this engine
              makes impossible, and the row below says how.
            </p>
          </div>
          <RouterLink class="text-button" to="/sessions-smpp">Open SMPP Sessions</RouterLink>
        </header>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Bind</th>
                <th scope="col">Uptime</th>
                <th scope="col">Reconnects</th>
                <th scope="col">Top error</th>
                <th scope="col">Health</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="smsc-session-row">
                <td class="mono">
                  {{ smsc.engineId }}
                  <small v-if="configuredSessions > 1" class="row-id"
                    >{{ configuredSessions }} sessions reported as one</small
                  >
                </td>
                <td class="mono">{{ smsc.type }}</td>
                <td class="mono" data-testid="smsc-session-uptime">{{ bindUptime }}</td>
                <td class="figures" data-testid="smsc-session-reconnects">
                  {{ reconnectCount }}
                  <small class="row-id">lifetime</small>
                </td>
                <!--
                  The latest error the engine recorded, not the most frequent —
                  it keeps one string per connection and no history of them, so
                  "top" would be a claim about a distribution we cannot see.
                -->
                <td class="mono cell-tight" data-testid="smsc-session-error">
                  {{ smsc.lastError || 'none recorded' }}
                </td>
                <td>
                  <span class="status-badge" :class="bindTone(smsc.bindState)">{{
                    bindWord(smsc.bindState)
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="source-note" data-testid="smsc-sessions-note">
          One row, whatever <span class="mono">instances</span> is set to. The engine gives every
          session on a connection the same <span class="mono">smsc-id</span> and reports their
          combined counters, so there is no per-session identity to key a second row on. There is no
          Timeouts column for the same reason — no per-session timing is reported at all, and an
          empty column would have said nobody timed out.
        </p>
      </section>

      <!-- QUEUE AND ROUTING ---------------------------------------------------- -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-queue-routing"
        aria-labelledby="smsc-queue-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-queue-heading">Queue and routing</h2>
            <p>What depends on this connection staying up</p>
          </div>
          <RouterLink class="text-button" to="/queues">Open Queues</RouterLink>
        </header>

        <dl class="detail-grid">
          <dt>Queued on this bind</dt>
          <dd class="mono">{{ displayValue(smsc.queued, state) }}</dd>
          <dt>Failed on this bind</dt>
          <dd class="mono">{{ displayValue(smsc.failed, state) }}</dd>
          <dt>Sent / received</dt>
          <dd class="mono">
            {{ displayValue(smsc.sent, state) }} / {{ displayValue(smsc.received, state) }}
          </dd>
        </dl>
        <p class="source-note">
          These are the engine's own counters for this bind since it last started, not a queue age.
          Per-message queue age is not reported per connection, so the oldest waiting message
          cannot be named here — Queues has the spool-level figure.
        </p>

        <div class="t-caps route-heading">Routes using this connection</div>
        <ul v-if="smsc.routes?.length" class="route-list" data-testid="smsc-routes">
          <li v-for="rule in smsc.routes" :key="`${rule.id}-${rule.role}`">
            <span>
              {{ rule.name }}
              <small v-if="rule.destinationPrefix" class="row-id mono"
                >prefix {{ rule.destinationPrefix }}</small
              >
            </span>
            <span class="mono route-role">
              {{ rule.role }}
              <template v-if="!rule.enabled"> · disabled</template>
            </span>
          </li>
        </ul>
        <p v-else class="chart-empty" data-testid="smsc-routes-empty">
          No routing rule targets this connection, as a primary or as a fallback. Suspending it
          would divert nothing, because nothing is routed here.
        </p>
      </section>

      <!-- CONTROLLED OPERATIONS ------------------------------------------------ -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-operations"
        aria-labelledby="smsc-operations-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-operations-heading">Operations on this connection</h2>
            <p>
              Every reconnect, disable, suspend and resume run against it — who asked, the reason
              they gave, and how the result was verified.
            </p>
          </div>
        </header>
        <div v-if="operations.length" class="table-wrap">
          <table data-testid="smsc-operations-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Operation</th>
                <th scope="col">Status</th>
                <th scope="col">By</th>
                <th scope="col">Reason</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in operations" :key="String(row.id)">
                <td class="mono cell-tight">{{ formatMoment(String(row.created_at ?? '')) }}</td>
                <td class="mono">{{ row.operation }}</td>
                <td>
                  <span
                    class="status-badge"
                    :class="
                      String(row.status) === 'succeeded'
                        ? 'good'
                        : String(row.status) === 'failed'
                          ? 'bad'
                          : 'warn'
                    "
                    >{{ row.status }}</span
                  >
                </td>
                <td class="mono cell-tight">{{ row.requested_by ?? 'not recorded' }}</td>
                <!--
                  Reconnect, disable and enable do not persist a reason — their
                  handler reads no body. Saying "not recorded for this
                  operation" keeps that apart from an operator who gave none.
                -->
                <td>{{ row.reason ?? 'not recorded for this operation' }}</td>
                <td class="cell-tight">{{ row.verification ?? row.detail ?? 'none' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="chart-empty" data-testid="smsc-operations-empty">
          {{
            operationsState === 'permission-denied'
              ? 'Reading the operation history needs the smsc.view permission.'
              : operationsState === 'error'
                ? 'The operation history could not be read, so this panel cannot say whether anything has been run.'
                : 'No controlled operation has been run against this connection.'
          }}
        </p>
      </section>

      <!-- RECENT EVENTS -------------------------------------------------------- -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-events"
        aria-labelledby="smsc-events-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-events-heading">Recent events</h2>
            <p>
              Structured events recorded against this connection — a suspension, a failover, an
              alert opening. Distinct from the bind timeline below, which is what the poller
              observed rather than what the platform decided.
            </p>
          </div>
          <RouterLink class="text-button" to="/events">All events</RouterLink>
        </header>
        <EventTimeline
          v-if="events.length"
          dense
          data-testid="smsc-event-timeline"
          :items="
            events.map((entry) => ({
              at: formatMoment(entry.observed_at),
              label: entry.kind,
              detail: entry.summary,
              state:
                severityTone(entry.severity) === 'bad'
                  ? 'error'
                  : severityTone(entry.severity) === 'warn'
                    ? 'warn'
                    : 'info',
            }))
          "
        />
        <p v-else class="chart-empty" data-testid="smsc-events-empty">
          {{
            eventsState === 'permission-denied'
              ? 'Reading operational events needs the monitoring.view permission.'
              : eventsState === 'error'
                ? 'Events for this connection could not be read, so this panel cannot say whether any were recorded.'
                : 'No operational event has been recorded against this connection.'
          }}
        </p>
      </section>

      <!-- BIND TIMELINE -------------------------------------------------------- -->
      <section
        v-if="smsc"
        class="panel"
        data-testid="smsc-timeline"
        aria-labelledby="smsc-timeline-heading"
      >
        <header class="panel-header">
          <div>
            <h2 id="smsc-timeline-heading">Bind transition timeline</h2>
            <p>
              JKANNEL's own observation history, kept forever — most recent first, up to the last
              100 transitions.
            </p>
          </div>
        </header>

        <!--
          A TIMELINE, NOT A TABLE.

          This is the design system's treatment for bind history, and it is the
          right one: a table invites you to read down a column, and the question
          here is what happened in what order. The rail makes the sequence the
          primary axis, and a flap — the thing this panel exists to diagnose —
          shows up as a visible rhythm of dots rather than as repeated words in
          a "Transition" column.
        -->
        <EventTimeline
          v-if="transitions.length"
          data-testid="smsc-transitions"
          :items="
            transitions.map((entry) => ({
              at: formatMoment(entry.observedAt),
              label: describeTransition(entry),
              detail: transitionDetail(entry) || entry.kind,
              state: timelineState(entry),
            }))
          "
        />
        <p v-else class="chart-empty" data-testid="smsc-timeline-empty">
          No bind transition has been recorded for this connection. The history is kept forever, so
          an empty timeline means the poller has never seen this bind change state — not that older
          entries have aged out.
        </p>

        <p class="source-note">
          This timeline is JKANNEL's record of what it observed, not session data reported by the
          engine. It is the evidence a flapping bind is diagnosed from, and it is the only bind
          history that exists: bearerbox keeps none.
        </p>
      </section>
      <ConfirmAction
        v-if="pendingOperation && smsc"
        :open="true"
        :smsc-id="smsc.id"
        :operation="pendingOperation"
        :busy="actionBusy"
        :danger="pendingOperation === 'suspend'"
        testid="smsc-detail-confirm"
        @close="pendingOperation = null"
        @confirm="confirmAction"
      />
    </template>
  </div>
</template>

<style scoped>
/* The design's PageAction bar: right-aligned above the content, so it reads as
   acting on the page rather than on the first panel under it. */
.page-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}
.route-heading {
  margin: 20px 0 8px;
}
.route-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.route-list li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13.5px;
}
.route-role {
  color: var(--muted);
}
.cell-tight {
  font-size: 12.5px;
}
</style>
<style src="./workspace-extras.css"></style>
