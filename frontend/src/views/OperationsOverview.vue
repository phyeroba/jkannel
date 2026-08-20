<script setup lang="ts">
import { computed, ref } from 'vue';
import MetricCard from '../components/MetricCard.vue';
import MiniChart from '../components/MiniChart.vue';
import { apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import { healthTone, type CarrierSummary } from '../utils/connectivity';

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

/**
 * Carrier connectivity and carrier quality — §3 of the specification, and two
 * of the six panels the design system's DashboardScreen specifies.
 *
 * The design shows `unknown` rather than a dash wherever a figure is not
 * measured, and that is not a placeholder for something to fill in later: it is
 * the honest state. This deployment derives observed throughput and delivery
 * rate from engine telemetry that is frequently absent, so those columns are
 * genuinely unknown a lot of the time and the design already accounts for it.
 * Nothing here computes a number the backend did not supply.
 */
const carriersState = ref<SourceState>('checking');
const carriers = ref<CarrierSummary[]>([]);

async function checkCarriers() {
  try {
    // Coerced through asItems rather than trusted as an array. `/carriers`
    // returns a bare list today, but every other list endpoint here returns a
    // `{ items }` page, and assuming the wrong one turns a shape change into a
    // render-time crash that takes the whole dashboard down — not a panel
    // showing "unavailable", which is what a data problem should look like.
    carriers.value = asItems(await apiRequest<unknown>('/carriers')) as unknown as CarrierSummary[];
    carriersState.value = 'ok';
  } catch {
    carriers.value = [];
    carriersState.value = 'unavailable';
  }
}

/** Worst first, so the row that needs attention is the row you read. */
const HEALTH_ORDER: Record<string, number> = {
  critical: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
};
const carriersByHealth = computed(() =>
  [...carriers.value].sort(
    (a, b) =>
      (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || a.name.localeCompare(b.name),
  ),
);

/**
 * How many carriers report a health we could not observe.
 *
 * This drives the stale-telemetry banner, which the design places ABOVE the
 * content rather than in place of it: an operator must still be able to read
 * everything else while being told which part of it is not current.
 */
const unobservedCarriers = computed(
  () => carriers.value.filter((carrier) => carrier.health === 'unknown').length,
);

const utilisationLabel = (carrier: CarrierSummary) =>
  carrier.utilisation === null ? '—' : `${Math.round(carrier.utilisation * 100)}%`;

/**
 * The Traffic panel's series, for the design system's dashboard line chart.
 *
 * The kit plots MT, MO and DLR as per-minute rates over the selected range. We
 * do not sample traffic per minute — the volume report is a DAILY roll-up — so
 * this plots what we actually have and the subtitle says so, rather than
 * inventing a resolution the data does not carry. Same shape, honest period.
 */
const trafficSeries = computed(() => {
  const rows = [...volumeSnapshots.value].reverse();
  const mt = rows.map((row) => Number(row.message_count) || 0);
  const dlr = rows.map((row) => Number(row.dlr_count ?? row.dlrCount) || 0);
  const series = [{ label: 'Messages', values: mt }];
  // Only plot DLRs when the report actually carries them; an all-zero series
  // reads as "no receipts came back", which is a very different claim.
  if (dlr.some((value) => value > 0)) series.push({ label: 'DLRs', values: dlr });
  return series;
});
const trafficLabels = computed(() =>
  [...volumeSnapshots.value]
    .reverse()
    .map((row) => String(row.period_start ?? '').slice(5, 10) || '—'),
);
const hasTraffic = computed(() => trafficSeries.value[0]?.values.some((value) => value > 0));

/**
 * Queue pressure, ranked by depth — the design system's second dashboard panel.
 *
 * The kit ranks per-destination queues by depth and growth. Our per-destination
 * depth is per BIND (`smsc_bind_state.queued_count`, surfaced on the SMSC
 * register), which is the same operational question: which connection is
 * backing up. Growth needs two samples of the same bind and is left out rather
 * than approximated from one.
 */
interface QueuePressureRow {
  id: string;
  label: string;
  depth: number;
  share: number;
  rate: number | null;
}
const queuePressure = computed<QueuePressureRow[]>(() => {
  const rows = carriers.value
    .map((carrier) => ({
      id: carrier.id,
      label: carrier.name,
      depth: Number(carrier.queuedMessages) || 0,
      rate: carrier.observedTps,
    }))
    .filter((row) => row.depth > 0)
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 5);
  const deepest = Math.max(1, ...rows.map((row) => row.depth));
  return rows.map((row) => ({ ...row, share: Math.round((row.depth / deepest) * 100) }));
});

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
    checkCarriers(),
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
  <!--
    Stale telemetry is announced ABOVE the content, never in place of it. An
    operator has to be able to read everything on the screen while being told
    which part of it is not current — replacing the dashboard with a warning
    hides exactly the numbers they came to look at.
  -->
  <p v-if="unobservedCarriers" class="stale-banner" data-testid="dashboard-stale-banner">
    Telemetry for {{ unobservedCarriers }}
    {{ unobservedCarriers === 1 ? 'carrier is' : 'carriers are' }} not being observed, so
    {{ unobservedCarriers === 1 ? 'its' : 'their' }} health is reported unknown rather than healthy.
  </p>
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
    <!--
      Each tile drills into the screen that owns the figure. Reading a worrying
      number and then hunting the sidebar for where to act on it is friction the
      tile can remove.
    -->
    <MetricCard
      label="Queue depth"
      :value="queueMetric.value"
      :detail="queueMetric.detail"
      :tone="queueMetric.tone"
      icon="queue"
      to="/queues"
    /><MetricCard
      label="Messages (latest daily)"
      :value="messagesMetric.value"
      :detail="messagesMetric.detail"
      icon="sms"
      to="/messages"
    /><MetricCard
      label="DLRs (latest daily)"
      :value="dlrMetric.value"
      :detail="dlrMetric.detail"
      icon="check"
      to="/dlr-performance"
    /><MetricCard
      label="Alerts"
      :value="alertsMetric.value"
      :detail="alertsMetric.detail"
      :tone="alertsMetric.tone"
      icon="alert"
      to="/alerts"
    />
  </section>
  <!--
    Traffic and Queue pressure — the two panels the design system's
    DashboardScreen leads with, and the two this dashboard was missing. Their
    absence is why the console did not look like the package even after every
    token and component class matched.
  -->
  <section class="split-grid wide-left" data-testid="dashboard-traffic-row">
    <article class="panel">
      <header class="panel-header">
        <div>
          <h2>Traffic</h2>
          <p>Daily message and receipt volume, from the report snapshots</p>
        </div>
        <RouterLink class="text-button" to="/live-traffic">Open Live Traffic</RouterLink>
      </header>
      <MiniChart
        v-if="hasTraffic"
        type="line"
        title="Daily message volume"
        :series="trafficSeries"
        :labels="trafficLabels"
        :height="180"
        grid
        data-testid="dashboard-traffic-chart"
      />
      <p v-else-if="volumeState === 'checking'" class="chart-empty">Loading volume snapshots…</p>
      <p v-else-if="volumeState === 'unavailable'" class="chart-empty">
        Volume report data is unavailable.
      </p>
      <p v-else class="chart-empty" data-testid="dashboard-traffic-empty">
        No traffic has been recorded in the snapshots held so far.
      </p>
    </article>

    <article class="panel" data-testid="dashboard-queue-pressure">
      <header class="panel-header">
        <div>
          <h2>Queue pressure</h2>
          <p>Carriers with messages waiting, deepest first</p>
        </div>
        <RouterLink class="text-button" to="/queues">Open Queues</RouterLink>
      </header>
      <div v-if="queuePressure.length" class="pressure-list">
        <div v-for="row in queuePressure" :key="row.id" class="pressure-row">
          <div class="pressure-head">
            <span class="mono">{{ row.label }}</span>
            <strong class="figures">{{ row.depth.toLocaleString() }}</strong>
          </div>
          <span class="breakdown-track"
            ><span class="breakdown-fill" :style="{ width: `${row.share}%` }"></span
          ></span>
          <span class="pressure-note">
            {{ row.rate === null ? 'drain rate unknown' : `draining at ${row.rate}/s` }}
          </span>
        </div>
      </div>
      <p v-else-if="carriersState === 'checking'" class="chart-empty">Loading carriers…</p>
      <p v-else class="chart-empty" data-testid="dashboard-queue-pressure-empty">
        Nothing is queued. Every carrier's spool is empty.
      </p>
    </article>
  </section>
  <section class="dashboard-grid">
    <article class="panel">
      <header class="panel-header">
        <div>
          <h2>System health</h2>
          <p>Observed dependency state</p>
        </div>
        <!-- The services board is the fuller version of this list: every
             component, its dependencies, and which one to fix first. -->
        <RouterLink class="text-link" to="/services" data-testid="open-services"
          >All services</RouterLink
        >
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
          <h2>Active incidents</h2>
          <p>Longest running first</p>
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

  <!--
    Carrier connectivity — the design system's DashboardScreen centrepiece, and
    the panel §3 asks for so a shift can be assessed in ten seconds: every
    network this gateway binds to, worst first, each row opening its carrier.

    Every column here is a field `GET /carriers` already returns. Throughput and
    utilisation are derived from engine telemetry that is often absent, so they
    read `unknown` rather than 0 — the design specifies that treatment, and a
    zero we never measured is the one thing this console must never print.
  -->
  <article class="panel" data-testid="carrier-connectivity">
    <header class="panel-header">
      <div>
        <h2>Carrier connectivity</h2>
        <p>Every network this gateway binds to, worst first</p>
      </div>
      <RouterLink class="text-button" to="/carriers">Open Carriers</RouterLink>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Carrier</th>
            <th scope="col">Health</th>
            <th scope="col">SMSCs</th>
            <th scope="col">Sessions</th>
            <th scope="col" class="numeric">MT TPS</th>
            <th scope="col" class="numeric">Utilisation</th>
            <th scope="col" class="numeric">Queue</th>
            <th scope="col" class="numeric">Open alerts</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="carrier in carriersByHealth"
            :key="carrier.id"
            class="selectable"
            :data-testid="`dashboard-carrier-${carrier.id}`"
            tabindex="0"
            @click="$router.push(`/carriers/${carrier.id}`)"
            @keydown.enter="$router.push(`/carriers/${carrier.id}`)"
          >
            <td>
              <strong>{{ carrier.name }}</strong>
              <span class="row-id">{{
                [carrier.country_code, carrier.network_code].filter(Boolean).join(' · ') ||
                'no network code'
              }}</span>
            </td>
            <td>
              <span class="status-badge" :class="healthTone(carrier.health)">{{
                carrier.health
              }}</span>
            </td>
            <td class="figures">{{ carrier.smscCount }}</td>
            <td class="figures">{{ carrier.bindsHealthy }} / {{ carrier.bindsTotal }}</td>
            <td class="figures numeric">
              {{ carrier.observedTps === null ? 'unknown' : carrier.observedTps }}
            </td>
            <td class="figures numeric">{{ utilisationLabel(carrier) }}</td>
            <td class="figures numeric">{{ carrier.queuedMessages.toLocaleString() }}</td>
            <td class="figures numeric">{{ carrier.openAlerts }}</td>
          </tr>
          <tr v-if="carriersState === 'ok' && !carriers.length">
            <td colspan="8" class="empty-cell" data-testid="dashboard-carriers-empty">
              No carrier is registered yet. Add one on the Carriers screen to group SMSCs by
              network.
            </td>
          </tr>
          <tr v-if="carriersState === 'checking'">
            <td colspan="8" class="empty-cell">Loading carriers…</td>
          </tr>
          <tr v-if="carriersState === 'unavailable'">
            <td colspan="8" class="empty-cell" data-testid="dashboard-carriers-unavailable">
              Carrier connectivity is unavailable — the register could not be read.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </article>
</template>

<style scoped>
/* Queue pressure rows. The track and fill themselves come from the design
   system's components.css (`breakdown-track` / `breakdown-fill`); only the row
   rhythm around them is local. */
.pressure-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}
.pressure-row {
  display: grid;
  gap: 5px;
}
.pressure-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
}
.pressure-head strong {
  color: var(--text-strong);
}
.pressure-note {
  font-size: 12.5px;
  color: var(--muted);
}
</style>
