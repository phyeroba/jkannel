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
 * CONTROLLED ACTIONS (reconnect / suspend / resume) are PLAN.md 5.1–5.3 and are
 * not built here. No disabled buttons stand in for them: a control that cannot
 * act is worse than an absent one.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import ObservabilityLimits from '../components/ObservabilityLimits.vue';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
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

function toneForTransition(entry: BindTransition): string {
  if (entry.toState === 'bound') return 'good';
  if (entry.toState === 'failed' || entry.toState === 'disconnected') return 'bad';
  if (entry.toState === null) return 'muted';
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

onMounted(load);
watch(engineId, load);
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

        <div v-if="transitions.length" class="table-wrap">
          <table data-testid="smsc-transitions">
            <thead>
              <tr>
                <th scope="col">Observed</th>
                <th scope="col">Kind</th>
                <th scope="col">Transition</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in transitions"
                :key="`${entry.observedAt}-${index}`"
                :data-testid="`smsc-transition-${index}`"
              >
                <td class="mono">{{ formatMoment(entry.observedAt) }}</td>
                <td>
                  <span class="status-badge" :class="toneForTransition(entry)">{{
                    entry.kind
                  }}</span>
                </td>
                <td class="mono">{{ describeTransition(entry) }}</td>
                <td class="mono">{{ transitionDetail(entry) || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
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
    </template>
  </div>
</template>

<style src="./workspace-extras.css"></style>
