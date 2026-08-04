<script setup lang="ts">
import { computed, ref } from 'vue';
import MetricCard from '../components/MetricCard.vue';
import { apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';

type RecordValue = Record<string, unknown>;
type SourceState = 'checking' | 'ok' | 'unavailable';

const apiState = ref<'checking' | 'healthy' | 'unavailable'>('checking');
const refreshed = ref('Not yet');

const queueState = ref<SourceState>('checking');
const queueDepth = ref<number | null>(null);

const monitoringState = ref<SourceState>('checking');
const engineName = ref('');
const engineStatus = ref('unknown');
const engineTransport = ref('');

const volumeState = ref<SourceState>('checking');
const volumeSnapshots = ref<RecordValue[]>([]);

const alertsState = ref<SourceState>('checking');
const alertsTotal = ref(0);
const recentAlerts = ref<RecordValue[]>([]);

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

async function checkHealth() {
  try {
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api'}/v1/health`,
    );
    apiState.value = response.ok ? 'healthy' : 'unavailable';
  } catch {
    apiState.value = 'unavailable';
  }
}

/**
 * `/queues` answers with a page envelope:
 *
 *     { items, nextCursor, total, summary: { queued, oldestEpoch },
 *       source: { status: 'available', type: 'kamex-sqlbox' } }
 *
 * The depth lives at `summary.queued` and the availability at `source.status`.
 * An older build answered flat (`{ queued, source: 'kamex-sqlbox' }`), so both
 * shapes are read: reading only the flat one is what made this tile report
 * "store not observable" against every current deployment.
 */
function readQueueSnapshot(payload: unknown): {
  available: boolean;
  queued: number | null;
} {
  const result = (payload ?? {}) as RecordValue;
  const source = result.source;
  const status =
    typeof source === 'string'
      ? source
      : source && typeof source === 'object'
        ? String((source as RecordValue).status ?? '')
        : '';
  const summary = (
    result.summary && typeof result.summary === 'object' ? result.summary : {}
  ) as RecordValue;
  const queued =
    typeof summary.queued === 'number'
      ? summary.queued
      : typeof result.queued === 'number'
        ? result.queued
        : null;
  return { available: status !== 'unavailable' && queued !== null, queued };
}

async function checkQueues() {
  try {
    const snapshot = readQueueSnapshot(await apiRequest<RecordValue>('/queues'));
    if (!snapshot.available) {
      queueState.value = 'unavailable';
      queueDepth.value = null;
    } else {
      queueState.value = 'ok';
      queueDepth.value = snapshot.queued;
    }
  } catch {
    queueState.value = 'unavailable';
    queueDepth.value = null;
  }
}

async function checkMonitoring() {
  try {
    const result = await apiRequest<RecordValue>('/monitoring');
    const identity = (result.identity ?? {}) as RecordValue;
    const health = (result.health ?? {}) as RecordValue;
    engineName.value = `${text(identity.family, 'Engine')} ${text(identity.version, '')}`.trim();
    engineStatus.value = text(health.engine, 'unknown');
    engineTransport.value = text(health.transport, 'unknown');
    monitoringState.value = 'ok';
  } catch {
    monitoringState.value = 'unavailable';
    engineName.value = '';
    engineStatus.value = 'unknown';
    engineTransport.value = '';
  }
}

async function checkVolume() {
  try {
    const page = await apiRequest<unknown>(
      '/reports/volume?filter.periodType=daily&filter.scope=total&sort=-periodStart&limit=8',
    );
    volumeSnapshots.value = asItems(page).reverse();
    volumeState.value = 'ok';
  } catch {
    volumeSnapshots.value = [];
    volumeState.value = 'unavailable';
  }
}

async function checkAlerts() {
  try {
    const page = await apiRequest<unknown>('/alerts?sort=-openedAt&limit=5&offset=0');
    recentAlerts.value = asItems(page);
    alertsTotal.value =
      page && typeof page === 'object' && typeof (page as RecordValue).total === 'number'
        ? ((page as RecordValue).total as number)
        : recentAlerts.value.length;
    alertsState.value = 'ok';
  } catch {
    recentAlerts.value = [];
    alertsTotal.value = 0;
    alertsState.value = 'unavailable';
  }
}

/**
 * A background poll updates the tiles in place; it deliberately does NOT reset
 * them to "checking", because blanking a NOC screen every 30 seconds is worse
 * than a number that is a few seconds old. Only an explicit refresh does that.
 */
async function refresh() {
  await Promise.all([
    checkHealth(),
    checkQueues(),
    checkMonitoring(),
    checkVolume(),
    checkAlerts(),
  ]);
  refreshed.value = new Date().toLocaleTimeString();
}

// Live dashboard: the shared composable owns the timer, the overlap guard, the
// hidden-tab pause and the unmount cleanup.
const { autoRefresh, intervalSeconds, refreshing, refreshNow } = useLiveResource(refresh, {
  intervalSeconds: 30,
});
const refreshChoices = [15, 30, 60, 300];

function manualRefresh() {
  apiState.value = 'checking';
  queueState.value = 'checking';
  monitoringState.value = 'checking';
  volumeState.value = 'checking';
  alertsState.value = 'checking';
  return refreshNow(true);
}

const latestVolume = computed(() =>
  volumeSnapshots.value.length ? volumeSnapshots.value[volumeSnapshots.value.length - 1] : null,
);
const volumeMax = computed(() =>
  Math.max(1, ...volumeSnapshots.value.map((row) => Number(row.message_count) || 0)),
);
const queueMetric = computed(() =>
  queueState.value === 'checking'
    ? { value: '…', detail: 'Checking SQLBox queue', tone: 'primary' as const }
    : queueState.value === 'unavailable'
      ? { value: 'unavailable', detail: 'SQLBox queue not observable', tone: 'warn' as const }
      : {
          value: String(queueDepth.value ?? 0),
          detail: 'Messages waiting in SQLBox',
          tone: 'good' as const,
        },
);
const messagesMetric = computed(() =>
  volumeState.value === 'checking'
    ? { value: '…', detail: 'Loading volume snapshots' }
    : volumeState.value === 'unavailable'
      ? { value: 'unavailable', detail: 'Volume reports not observable' }
      : latestVolume.value
        ? {
            value: text(latestVolume.value.message_count, '0'),
            detail: `Daily snapshot ${text(latestVolume.value.period_start, '')}`.trim(),
          }
        : { value: '—', detail: 'No volume snapshots yet' },
);
const dlrMetric = computed(() =>
  volumeState.value === 'checking'
    ? { value: '…', detail: 'Loading volume snapshots' }
    : volumeState.value === 'unavailable'
      ? { value: 'unavailable', detail: 'Volume reports not observable' }
      : latestVolume.value
        ? {
            value: text(latestVolume.value.dlr_count, '0'),
            detail: 'DLRs in latest daily snapshot',
          }
        : { value: '—', detail: 'No delivery samples yet' },
);
const alertsMetric = computed(() =>
  alertsState.value === 'checking'
    ? { value: '…', detail: 'Loading alerts', tone: 'primary' as const }
    : alertsState.value === 'unavailable'
      ? { value: 'unavailable', detail: 'Alerts not observable', tone: 'warn' as const }
      : {
          value: String(alertsTotal.value),
          detail: 'Alert instances recorded',
          tone: alertsTotal.value ? ('warn' as const) : ('good' as const),
        },
);

interface HealthRow {
  name: string;
  detail: string;
  status: string;
}

const healthRows = computed<HealthRow[]>(() => [
  {
    name: engineName.value || 'Messaging engine',
    detail:
      monitoringState.value === 'ok'
        ? `transport ${engineTransport.value}`
        : monitoringState.value === 'checking'
          ? 'checking'
          : 'engine adapter not observable',
    status:
      monitoringState.value === 'ok'
        ? engineStatus.value
        : monitoringState.value === 'checking'
          ? 'checking'
          : 'unknown',
  },
  {
    name: 'SQLBox message store',
    detail:
      queueState.value === 'ok'
        ? 'PostgreSQL SQLBox reachable'
        : queueState.value === 'checking'
          ? 'checking'
          : 'store not observable',
    status:
      queueState.value === 'ok'
        ? 'available'
        : queueState.value === 'checking'
          ? 'checking'
          : 'unknown',
  },
  {
    name: 'JKANNEL API',
    detail: apiState.value === 'healthy' ? 'REST control plane responding' : apiState.value,
    status: apiState.value,
  },
]);

function statusTone(status: string) {
  const value = status.toLowerCase();
  if (['healthy', 'available', 'running', 'connected', 'active', 'ok', 'up'].includes(value))
    return 'good';
  if (['checking', 'unknown', 'degraded'].includes(value)) return 'warn';
  return 'bad';
}
</script>
<template>
  <div class="dashboard-actions">
    <button
      class="secondary-button"
      data-testid="refresh-dashboard"
      :disabled="refreshing"
      @click="manualRefresh"
    >
      {{ refreshing ? 'Refreshing…' : 'Refresh dashboard' }}</button
    ><RouterLink class="secondary-button" to="/copilot" data-testid="open-copilot"
      >Ask AI Copilot</RouterLink
    ><label class="filter-select"
      ><span>Auto refresh</span
      ><select v-model="autoRefresh" data-testid="dashboard-auto-toggle">
        <option :value="true">On</option>
        <option :value="false">Off</option>
      </select></label
    ><label class="filter-select"
      ><span>Every</span
      ><select v-model.number="intervalSeconds" data-testid="dashboard-interval">
        <option v-for="choice in refreshChoices" :key="choice" :value="choice">
          {{ choice }}s
        </option>
      </select></label
    ><span data-testid="dashboard-last-checked"
      >Last checked: {{ refreshed }}{{ autoRefresh ? '' : ' — auto refresh is off' }}</span
    >
  </div>
  <section class="metrics-grid">
    <MetricCard
      label="Queue depth"
      :value="queueMetric.value"
      :detail="queueMetric.detail"
      :tone="queueMetric.tone"
      icon="queue"
    /><MetricCard
      label="Messages (latest daily)"
      :value="messagesMetric.value"
      :detail="messagesMetric.detail"
      icon="sms"
    /><MetricCard
      label="DLRs (latest daily)"
      :value="dlrMetric.value"
      :detail="dlrMetric.detail"
      icon="check"
    /><MetricCard
      label="Alerts"
      :value="alertsMetric.value"
      :detail="alertsMetric.detail"
      :tone="alertsMetric.tone"
      icon="alert"
    />
  </section>
  <section class="dashboard-grid">
    <article class="panel wide">
      <header class="panel-header">
        <div>
          <h2>Message volume</h2>
          <p>Daily total-scope report snapshots</p>
        </div>
      </header>
      <div
        v-if="volumeState === 'ok' && volumeSnapshots.length"
        class="chart"
        aria-label="Daily message volume"
        data-testid="volume-chart"
      >
        <div
          v-for="row in volumeSnapshots"
          :key="text(row.id)"
          :style="{
            height: `${Math.max(4, Math.round(((Number(row.message_count) || 0) / volumeMax) * 100))}%`,
          }"
          :title="`${text(row.period_start)}: ${text(row.message_count, '0')} messages`"
        ></div>
      </div>
      <p v-else-if="volumeState === 'checking'" class="chart-empty">Loading volume snapshots…</p>
      <p
        v-else-if="volumeState === 'unavailable'"
        class="chart-empty"
        data-testid="volume-unavailable"
      >
        Volume report data is unavailable.
      </p>
      <p v-else class="chart-empty" data-testid="volume-empty">
        No daily volume snapshots have been generated yet.
      </p>
    </article>
    <article class="panel">
      <header class="panel-header">
        <div>
          <h2>Platform health</h2>
          <p>Observed dependency state</p>
        </div>
      </header>
      <ul class="health-list" data-testid="health-list">
        <li v-for="row in healthRows" :key="row.name">
          <span class="status-dot" :class="statusTone(row.status)"></span
          ><span
            ><strong>{{ row.name }}</strong
            ><small>{{ row.detail }}</small></span
          ><span class="status-badge" :class="statusTone(row.status)">{{ row.status }}</span>
        </li>
      </ul>
    </article>
    <article class="panel wide">
      <header class="panel-header">
        <div>
          <h2>Operational attention</h2>
          <p>Most recent alert instances</p>
        </div>
        <RouterLink class="text-link" to="/alerts">View all alerts</RouterLink>
      </header>
      <p v-if="alertsState === 'unavailable'" class="chart-empty" data-testid="alerts-unavailable">
        Alert data is unavailable.
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Condition</th>
              <th>Status</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="alert in recentAlerts" :key="text(alert.id)">
              <td>
                <span
                  class="status-badge"
                  :class="
                    alert.severity === 'critical'
                      ? 'bad'
                      : alert.severity === 'warning'
                        ? 'warn'
                        : 'good'
                  "
                  >{{ text(alert.severity) }}</span
                >
              </td>
              <td>{{ text(alert.summary ?? alert.rule_name) }}</td>
              <td>{{ text(alert.status) }}</td>
              <td>{{ text(alert.opened_at ?? alert.openedAt) }}</td>
            </tr>
            <tr v-if="alertsState === 'ok' && !recentAlerts.length">
              <td colspan="4" class="empty-cell" data-testid="alerts-empty">
                No alert instances recorded.
              </td>
            </tr>
            <tr v-if="alertsState === 'checking'">
              <td colspan="4" class="empty-cell">Loading alerts…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
