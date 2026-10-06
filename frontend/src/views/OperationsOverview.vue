<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import MetricCard from '../components/MetricCard.vue';
import MiniChart from '../components/MiniChart.vue';
import { ApiError, apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import DetailDrawer from '../components/DetailDrawer.vue';
import { useRouter } from 'vue-router';
import { RANGE_PRESETS, selectedRange, setRangePreset } from '../stores/time-range';
import { healthTone, type CarrierSummary } from '../utils/connectivity';
import { alertDuration } from '../utils/alerts';
import {
  formatLatency,
  formatShare,
  type BindQuality,
  type DlrPerformanceReport,
} from '../utils/traffic';

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

/* --- DELIVERY QUALITY ---------------------------------------------------------
 *
 * P95 receipt latency and reject share, per carrier, over the last day. They
 * come from the DLR report rather than the carrier register for the same reason
 * they do on the Carriers screen: they are properties of MESSAGES, and that
 * endpoint already correlates MT to receipt and takes percentiles per carrier.
 *
 * A separate request that is allowed to fail alone. `reports.view` is not
 * `smsc.view`, so an operator who can read the dashboard may not be able to
 * read delivery quality — those cells then say so.
 */
const DELIVERY_WINDOW_HOURS = 24;
const deliveryByCarrier = ref<Record<string, BindQuality>>({});
const deliveryDenied = ref(false);

async function checkDelivery() {
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
  } catch (reason) {
    deliveryByCarrier.value = {};
    deliveryDenied.value = reason instanceof ApiError && reason.status === 403;
  }
}

function qualityFor(carrierId: string): BindQuality | null {
  return deliveryByCarrier.value[carrierId] ?? null;
}

/**
 * Rejects as a share of THIS carrier's own submissions.
 *
 * Against the estate's total instead, a small carrier rejecting everything
 * renders as a fraction of a percent behind a busy healthy one — which is
 * exactly the row a dashboard exists to surface.
 */
function rejectShare(carrierId: string): string {
  const quality = qualityFor(carrierId)?.quality;
  const submitted = quality?.funnel?.submitted ?? 0;
  if (!quality || !submitted) return 'unknown';
  return formatShare(quality.funnel.rejected / submitted, 'live');
}

/** Worst first, so the row that needs attention is the row you read. */
const HEALTH_ORDER: Record<string, number> = {
  critical: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
};
/**
 * ONE LINE THAT SAYS WHAT IS WRONG, BY NAME.
 *
 * The screen opened with an orange banner reading "Telemetry for 2 carriers
 * is not being observed" — true, and almost useless: it never said WHICH
 * carriers, never said what was actually degraded, and sat above a dashboard
 * the operator then had to read anyway to find out.
 *
 * This is the same information as a sentence an operator can act on: the
 * carrier that is genuinely degraded, named, with its bind count; the ones
 * that are merely silent, named, and explicitly called unknown rather than
 * healthy; and whether anything else is wrong. The button goes straight to
 * the worst one.
 */
const degradedCarriers = computed(() =>
  carriers.value.filter(
    (carrier) => carrier.bindsTotal > 0 && carrier.bindsHealthy < carrier.bindsTotal,
  ),
);
const silentCarriers = computed(() =>
  carriers.value.filter((carrier) => String(carrier.health).toLowerCase() === 'unknown'),
);
/** The one to open from the status line: worst first, then by name. */
const worstCarrier = computed(() => degradedCarriers.value[0] ?? carriersByHealth.value[0] ?? null);

type OverallTone = 'checking' | 'unknown' | 'bad' | 'warn' | 'good';
const overallTone = computed<OverallTone>(() => {
  if (carriersState.value === 'checking') return 'checking';
  // NEVER GREEN OVER NO DATA.
  //
  // With the carrier register unreadable there are no degraded carriers and
  // no silent ones, so every condition below falls through to "Healthy" —
  // the screen reporting that everything is fine because it cannot see
  // anything at all. That is the single worst thing this banner could say.
  if (carriersState.value === 'unavailable') return 'unknown';
  if (degradedCarriers.value.length) return 'bad';
  if (silentCarriers.value.length) return 'warn';
  return 'good';
});
const OVERALL_WORD: Record<OverallTone, string> = {
  checking: 'Checking',
  unknown: 'Unknown',
  bad: 'Degraded',
  warn: 'Partly unobserved',
  good: 'Healthy',
};
const overallWord = computed(() => OVERALL_WORD[overallTone.value]);

/** Names joined the way a person writes them: "A and B", "A, B and C". */
function nameList(items: Array<{ name: string }>): string {
  const names = items.map((item) => item.name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Incidents still open. Drives the panel's heading, which used to claim
 *  every row was active regardless of its status. */
const openIncidents = computed(
  () =>
    recentAlerts.value.filter((alert) => {
      const status = String(alert.status ?? '').toLowerCase();
      return status !== 'resolved' && status !== 'closed';
    }).length,
);

const router = useRouter();

/**
 * The range select, bound to the shared store the shell's own picker uses.
 *
 * Two range controls that disagree is worse than one, so this writes to the
 * same place rather than keeping a second copy of the choice.
 */
const selectedRangeKey = computed({
  get: () => selectedRange.value.id,
  set: (key: string) => setRangePreset(key),
});

/** Severity colour for an incident dot. Unknown stays muted, never green. */
function severityTone(alert: RecordValue): string {
  const value = String(alert.severity ?? '').toLowerCase();
  if (value === 'critical') return 'bad';
  if (value === 'warning') return 'warn';
  if (value === 'info') return 'good';
  return '';
}

/**
 * Hand the question to the Copilot screen rather than answering it here.
 *
 * That screen owns the advisory opt-in header, the citation rendering and
 * the refusal path. A second implementation of any of those is a second
 * place for an advisory answer to be presented as fact.
 */
function askCopilot(question: string) {
  const text = question.trim();
  if (!text) return;
  void router.push({ path: '/copilot', query: { q: text } });
}

/* --- the Copilot box -----------------------------------------------------
 *
 * A QUESTION BOX, NOT A LINK.
 *
 * The dashboard had an "Ask AI Copilot" button on the action bar, which is a
 * link to another screen wearing the clothes of a feature. The design puts
 * the question where the data is and offers three starters, because the hard
 * part of a free-text box is knowing what it will answer.
 *
 * The question is carried to the Copilot screen rather than answered here:
 * that screen owns the opt-in header, the citation rendering and the refusal
 * path, and a second implementation of any of those would be a second place
 * for an advisory answer to be presented as fact.
 */
const copilotQuestion = ref('');
const copilotPrompts = computed(() => [
  degradedCarriers.value.length
    ? `Why is ${degradedCarriers.value[0].name} degraded?`
    : 'Which carrier is closest to its capacity?',
  'What changed in the last hour?',
  'Which binds have never been observed?',
]);

/* --- carrier bind segments ------------------------------------------------
 *
 * One block per bind: filled when it is up, hollow when it is down, and
 * outlined when it has never been observed. Three states, because "2 of 3"
 * hides which of the three — and an unobserved bind is not a down one.
 */
function bindSegments(carrier: CarrierSummary) {
  const total = Math.max(0, Number(carrier.bindsTotal) || 0);
  const up = Math.max(0, Number(carrier.bindsHealthy) || 0);
  const unobserved = Math.max(0, Number(carrier.bindsUnobserved) || 0);
  return Array.from({ length: total }, (_, index) => {
    if (index < up) return 'up';
    return index < up + (total - up - unobserved) ? 'down' : 'unobserved';
  });
}

/* --- the carrier panel ----------------------------------------------------
 *
 * Opened from a row. The register answers "which carrier"; the panel answers
 * "and what about it" without making the operator leave the dashboard and
 * lose the rest of the picture.
 */
const panelCarrier = ref<CarrierSummary | null>(null);
const panelSmscs = ref<RecordValue[]>([]);
const panelState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');

async function openCarrierPanel(carrier: CarrierSummary) {
  panelCarrier.value = carrier;
  panelSmscs.value = [];
  panelState.value = 'loading';
  try {
    const payload = await apiRequest<{ items?: RecordValue[] }>(
      `/smscs?limit=100&offset=0&filter.carrierId=${encodeURIComponent(carrier.id)}`,
    );
    // The filter is applied again here because a deployment whose API ignores
    // an unknown filter key would otherwise show every SMSC under one carrier.
    panelSmscs.value = (payload?.items ?? []).filter(
      (row) => String(row.carrier_id ?? row.carrierId ?? '') === carrier.id,
    );
    panelState.value = 'ok';
  } catch {
    panelState.value = 'error';
  }
}

/** The one sentence the panel opens with: what is true of this carrier now. */
const panelSummary = computed(() => {
  const carrier = panelCarrier.value;
  if (!carrier) return '';
  if (carrier.observedTps === null) {
    return `${carrier.name} sends no telemetry, so its health is unknown rather than healthy. ${carrier.smscCount} SMSC connection(s) are configured.`;
  }
  if (carrier.bindsTotal && carrier.bindsHealthy < carrier.bindsTotal) {
    return `${carrier.bindsHealthy} of ${carrier.bindsTotal} binds are up. The rest are not carrying traffic.`;
  }
  return `All ${carrier.bindsTotal} bind(s) are up and carrying traffic.`;
});

/* --- traffic totals -------------------------------------------------------
 *
 * The three figures above the chart. Summed over exactly the snapshots the
 * chart plots, so the totals and the bars can never disagree.
 */
/** One entry per plotted day, oldest first. Shared by the totals and the
 *  bars, so the two cannot end up describing different data. */
const trafficDaysRaw = computed(() =>
  trafficLabels.value.map((label, index) => ({
    label,
    messages: trafficSeries.value[0]?.values[index] ?? 0,
    dlrs: trafficSeries.value[1]?.values[index] ?? 0,
  })),
);

const trafficTotals = computed(() => {
  // `0 messages` is a measurement. An unreadable source has not made one, and
  // printing zero there says the gateway sent nothing — which is exactly the
  // claim the chart below refuses to make.
  if (volumeState.value === 'unavailable') {
    return [
      { k: 'Messages', v: 'unavailable' },
      { k: 'Delivery receipts', v: 'unavailable' },
      { k: 'Busiest day', v: 'unavailable' },
    ];
  }
  const rows = volumeSnapshots.value;
  const messages = rows.reduce((sum, row) => sum + (Number(row.message_count) || 0), 0);
  const dlrs = rows.reduce((sum, row) => sum + (Number(row.dlr_count ?? row.dlrCount) || 0), 0);
  /*
   * NOT A "RECEIPT RATE".
   *
   * The obvious third figure is dlrs/messages as a percentage, and on real
   * data it read 182%. A message can produce more than one receipt — an SMSC
   * acknowledgement and a handset delivery are both DLRs — and a snapshot's
   * receipts can belong to messages sent in an earlier period. A percentage
   * over 100 is the screen saying the framing is wrong, and dividing two
   * numbers that are not one-to-one and calling the result a rate is exactly
   * the confident wrong answer this console is not allowed to give.
   *
   * The busiest day is a fact about the same snapshots, and it is what an
   * operator actually looks for in a week of bars.
   */
  const busiest = [...trafficDaysRaw.value].sort((a, b) => b.messages - a.messages)[0] ?? null;
  return [
    { k: 'Messages', v: messages.toLocaleString() },
    { k: 'Delivery receipts', v: dlrs.toLocaleString() },
    {
      k: 'Busiest day',
      v:
        busiest && busiest.messages
          ? `${busiest.label} · ${busiest.messages.toLocaleString()}`
          : 'no traffic',
    },
  ];
});

/* The chart's own scale, so the axis labels and the bar heights agree. */
const trafficMax = computed(() =>
  Math.max(1, ...trafficSeries.value.flatMap((series) => series.values)),
);
const trafficDays = computed(() => trafficDaysRaw.value);

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
    checkDelivery(),
  ]);
  refreshed.value = new Date().toLocaleTimeString();
}

// Live dashboard: the shared composable owns the timer, the overlap guard, the
// hidden-tab pause and the unmount cleanup.
const { autoRefresh, intervalSeconds, refreshing, refreshNow } = useLiveResource(refresh, {
  intervalSeconds: 30,
});
/**
 * Seconds until the next automatic refresh.
 *
 * The bar used to say "Last updated 9:50:54 AM", which answers a question
 * nobody asks. What an operator wants to know from a live screen is whether
 * it is about to move, so it counts down instead.
 */
const secondsToNext = ref(0);
setInterval(() => {
  if (!autoRefresh.value) return;
  secondsToNext.value = secondsToNext.value > 0 ? secondsToNext.value - 1 : intervalSeconds.value;
}, 1000);
watch([autoRefresh, intervalSeconds], () => {
  secondsToNext.value = intervalSeconds.value;
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
  /**
   * The KIND of component, not its state.
   *
   * The list carried a status dot and a status badge — two encodings of the
   * same fact — and nothing at all to say what each row was. An operator
   * scanning three rows reads the names; an operator scanning a dozen reads
   * the shapes, and there were none. The colour stays with the status; the
   * icon says whether this is an engine, a store or an API.
   */
  icon: string;
}

const healthRows = computed<HealthRow[]>(() => [
  {
    name: engineName.value || 'Messaging engine',
    icon: 'server',
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
    icon: 'db',
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
    icon: 'api',
    detail: apiState.value === 'healthy' ? 'REST control plane responding' : apiState.value,
    status: apiState.value,
  },
]);

/**
 * "30 Sep 08:11" rather than "2026-09-30T08:11:53.046Z".
 *
 * The incidents panel is the narrow half of the dashboard grid and the raw
 * ISO string was the widest unbreakable thing in it. Wrapping it closed the
 * overflow and took the rows to 141px, which is the same problem wearing the
 * other axis. The seconds, the milliseconds and the offset are not what
 * anyone reads off a dashboard; the duration beside it carries the precision.
 *
 * The year is dropped only when it is THIS year — an incident carried over
 * from last year must not read as one from this week.
 */
function openedAtLabel(alert: RecordValue): string {
  const raw = alert.opened_at ?? alert.openedAt;
  if (raw === null || raw === undefined || raw === '') return 'unknown';
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) return String(raw);
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
    OPERATIONS — rebuilt to `Kamex Dashboard.dc.html`.

    Reading order is the design's, and it is the order an operator asks the
    questions in: is anything wrong (status line), ask about it (Copilot),
    how much is moving (figures), through whom (carriers), on what
    (platform), over time (traffic), and what broke (incidents).
  -->
  <div data-testid="operations-view">
    <!-- CONTROLS --------------------------------------------------------- -->
    <!--
      Range, live state and refresh in one small bar on the right. These are
      three settings of the VIEW, not three actions, and they used to occupy
      a full-width band of labelled selects above the content.
    -->
    <!--
      `filters`, which is what this bar is: three independent settings of the
      view, each captioned only for a screen reader. The layout audit excludes
      that class from its inline-label rule precisely for toolbars, and the
      design shows these with no visible caption at all.
    -->
    <div class="ops-controls filters">
      <label class="filter-select is-compact">
        <span class="sr-only">Time range</span>
        <select v-model="selectedRangeKey" data-testid="dashboard-range">
          <option v-for="preset in RANGE_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.label }}
          </option>
        </select>
      </label>
      <div class="live-group">
        <button
          type="button"
          class="live-toggle"
          :class="{ 'is-live': autoRefresh }"
          data-testid="dashboard-auto-toggle"
          :title="autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'"
          @click="autoRefresh = !autoRefresh"
        >
          <span class="live-dot" aria-hidden="true"></span>
          {{ autoRefresh ? `Live · ${secondsToNext}s` : 'Paused' }}
        </button>
        <label class="filter-select is-compact">
          <span class="sr-only">Refresh every</span>
          <select
            v-model.number="intervalSeconds"
            :disabled="!autoRefresh"
            data-testid="dashboard-interval"
          >
            <option v-for="choice in refreshChoices" :key="choice" :value="choice">
              {{ choice }}s
            </option>
          </select>
        </label>
      </div>
      <button
        class="secondary-button is-compact"
        type="button"
        data-testid="refresh-dashboard"
        :disabled="refreshing"
        @click="manualRefresh"
      >
        <AppIcon name="refresh" :size="14" />{{ refreshing ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <!-- STATUS LINE ------------------------------------------------------ -->
    <!--
      THE VERDICT, IN ONE LINE, WITH NAMES IN IT.

      Replaces an orange banner reading "Telemetry for 2 carriers is not
      being observed" — true, and nearly useless: it named no carrier,
      described nothing actually wrong, and sat above a dashboard the
      operator had to read anyway to find out which two and what for.
    -->
    <section class="status-line" :class="`is-${overallTone}`" data-testid="dashboard-status">
      <span class="status-chip">
        <span class="status-dot" aria-hidden="true"></span>{{ overallWord }}
      </span>
      <p>
        <template v-if="carriersState !== 'unavailable' && degradedCarriers.length">
          <strong>{{ nameList(degradedCarriers) }}</strong>
          {{ degradedCarriers.length === 1 ? 'has' : 'have' }}
          {{ degradedCarriers[0].bindsHealthy }} of {{ degradedCarriers[0].bindsTotal }} binds up.
        </template>
        <template v-if="carriersState !== 'unavailable' && silentCarriers.length">
          <strong>{{ nameList(silentCarriers) }}</strong>
          {{ silentCarriers.length === 1 ? 'sends' : 'send' }} no telemetry, so
          {{ silentCarriers.length === 1 ? 'its' : 'their' }} health is unknown rather than healthy.
        </template>
        <template v-if="carriersState === 'unavailable'">
          The carrier register could not be read, so the state of every carrier is unknown.
        </template>
        <template
          v-else-if="
            carriersState !== 'checking' && !degradedCarriers.length && !silentCarriers.length
          "
        >
          Every carrier is reporting and every bind is up.
        </template>
      </p>
      <button
        v-if="worstCarrier"
        class="secondary-button is-compact"
        type="button"
        data-testid="dashboard-inspect"
        @click="openCarrierPanel(worstCarrier)"
      >
        Inspect {{ worstCarrier.name }}
      </button>
    </section>

    <!-- COPILOT ---------------------------------------------------------- -->
    <!--
      A question box where the data is, with three starters — the hard part
      of a free-text box is knowing what it will answer. The question is
      carried to the Copilot screen rather than answered here: that screen
      owns the opt-in header, the citations and the refusal path.
    -->
    <section class="copilot" data-testid="dashboard-copilot">
      <span class="copilot-label">Copilot</span>
      <form class="copilot-form" @submit.prevent="askCopilot(copilotQuestion)">
        <input
          v-model="copilotQuestion"
          placeholder="Ask about this gateway"
          data-testid="copilot-input"
        />
        <button class="secondary-button is-compact" type="submit" data-testid="copilot-ask">
          Ask
        </button>
      </form>
      <div class="copilot-prompts">
        <button
          v-for="prompt in copilotPrompts"
          :key="prompt"
          type="button"
          class="prompt-chip"
          @click="askCopilot(prompt)"
        >
          {{ prompt }}
        </button>
      </div>
    </section>

    <!-- FIGURES ---------------------------------------------------------- -->
    <section class="metrics-grid">
      <MetricCard label="Queue depth" v-bind="queueMetric" />
      <MetricCard label="Messages · latest report" v-bind="messagesMetric" />
      <MetricCard label="Delivery receipts" v-bind="dlrMetric" />
      <MetricCard label="Alerts recorded" v-bind="alertsMetric" />
    </section>

    <!-- CARRIERS | PLATFORM ---------------------------------------------- -->
    <div class="ops-grid">
      <!--
        CARRIERS COME FIRST. This answers the question the dashboard exists
        for — can we send, and through whom — and it used to be the last
        panel on the page, four screens below the fold.
      -->
      <section class="panel" data-testid="carrier-connectivity">
        <header class="panel-header">
          <div>
            <h2>Carriers</h2>
            <p>Worst first · click a row for binds and alerts</p>
          </div>
          <RouterLink class="text-link" to="/carriers">All carriers</RouterLink>
        </header>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <!--
                  FIVE COLUMNS, FROM SIX. This panel is 1.6fr of a two-column
                  grid, so it has well under a screen to work in, and six
                  nowrap columns ran it 66px past its edge — on the screen an
                  operator watches all day. Health and the 24h alert count
                  answer the same question, so they share a cell.
                -->
                <th scope="col">Carrier</th>
                <th scope="col">Health</th>
                <th scope="col">Binds up</th>
                <th scope="col">Throughput</th>
                <th scope="col">Delivery</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="carrier in carriersByHealth"
                :key="carrier.id"
                class="selectable"
                :data-testid="`dashboard-carrier-${carrier.id}`"
                tabindex="0"
                @click="openCarrierPanel(carrier)"
                @keydown.enter="openCarrierPanel(carrier)"
              >
                <td>
                  <strong>{{ carrier.name }}</strong>
                  <small class="row-id">{{
                    [carrier.country_code, carrier.network_code].filter(Boolean).join(' · ') ||
                    'no network code'
                  }}</small>
                </td>
                <td class="cell-clip">
                  <span class="status-badge" :class="healthTone(carrier.health)">{{
                    carrier.health
                  }}</span>
                  <small class="row-id">{{ carrier.openAlerts }} alert(s) · 24h</small>
                  <small
                    class="row-id clamp-1"
                    :data-testid="`dashboard-last-event-${carrier.id}`"
                    :title="carrier.lastEvent || ''"
                    >{{ carrier.lastEvent || 'no transitions' }}</small
                  >
                </td>
                <!--
                  One block per bind: filled when up, hollow when down,
                  outlined when never observed. "2 of 3" hides which of the
                  three, and an unobserved bind is not a down one.
                -->
                <td>
                  <span class="mono">{{ carrier.bindsHealthy }} / {{ carrier.bindsTotal }}</span>
                  <span v-if="carrier.bindsTotal" class="bind-bars" aria-hidden="true">
                    <span
                      v-for="(segment, index) in bindSegments(carrier)"
                      :key="index"
                      :class="`seg-${segment}`"
                    ></span>
                  </span>
                </td>
                <!-- A carrier nobody is sampling says so ONCE, instead of
                     filling its row with three separate `unknown`s. -->
                <td>
                  <span v-if="carrier.observedTps === null" class="no-telemetry">
                    No telemetry
                  </span>
                  <template v-else>
                    <span class="mono">{{ carrier.observedTps }}/s</span>
                    <small class="row-id">{{ utilisationLabel(carrier) }} of ceiling</small>
                  </template>
                </td>
                <td>
                  <template v-if="deliveryDenied">
                    <span class="no-telemetry">not permitted</span>
                  </template>
                  <template v-else>
                    <span class="mono" :data-testid="`dashboard-p95-${carrier.id}`">{{
                      formatLatency(qualityFor(carrier.id)?.quality.latency?.p95)
                    }}</span>
                    <small class="row-id" :data-testid="`dashboard-reject-${carrier.id}`"
                      >{{ rejectShare(carrier.id) }} rejected</small
                    >
                  </template>
                </td>

              </tr>
              <tr v-if="carriersState === 'ok' && !carriers.length">
                <td colspan="5" class="empty-cell" data-testid="dashboard-carriers-empty">
                  No carrier is registered yet. Add one on the Carriers screen to group SMSCs by
                  network.
                </td>
              </tr>
              <tr v-if="carriersState === 'checking'">
                <td colspan="5" class="empty-cell">Loading carriers…</td>
              </tr>
              <tr v-if="carriersState === 'unavailable'">
                <td colspan="6" class="empty-cell" data-testid="dashboard-carriers-unavailable">
                  Carrier connectivity is unavailable — the register could not be read.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!--
        PLATFORM — services and queue pressure in ONE panel. They were two,
        and both answer the same question: is anything underneath the
        carriers unwell. Neither is long enough to earn a panel of its own.
      -->
      <section class="panel" data-testid="dashboard-platform">
        <header class="panel-header">
          <div><h2>Platform</h2></div>
          <RouterLink class="text-link" to="/services" data-testid="open-services"
            >All services</RouterLink
          >
        </header>

        <ul class="health-list" data-testid="health-list">
          <li v-for="row in healthRows" :key="row.name">
            <span class="health-icon" :class="statusTone(row.status)" aria-hidden="true"
              ><AppIcon :name="row.icon" :size="15"
            /></span>
            <span
              ><strong>{{ row.name }}</strong
              ><small>{{ row.detail }}</small></span
            >
            <span class="status-badge" :class="statusTone(row.status)">{{ row.status }}</span>
          </li>
        </ul>

        <div class="queue-block" data-testid="dashboard-queue-pressure">
          <div class="queue-head">
            <span>Queue pressure</span>
            <RouterLink class="text-link" to="/queues">Queues</RouterLink>
          </div>
          <ul v-if="queuePressure.length" class="queue-list">
            <li v-for="row in queuePressure" :key="row.id">
              <span class="queue-name">{{ row.label }}</span>
              <span class="queue-track" aria-hidden="true">
                <span :style="{ width: `${row.share}%` }"></span>
              </span>
              <span class="queue-depth mono">{{ row.depth.toLocaleString() }}</span>
            </li>
          </ul>
          <!-- An empty spool is a GOOD state and is said as one, rather than
               drawn as a list of zero-height bars. -->
          <p v-else class="queue-empty">Every carrier spool is empty.</p>
        </div>
      </section>
    </div>

    <!-- TRAFFIC | INCIDENTS ---------------------------------------------- -->
    <div class="ops-grid wide-left">
      <section class="panel" data-testid="dashboard-traffic-row">
        <header class="panel-header">
          <div>
            <h2>Traffic</h2>
            <p>Daily messages and delivery receipts, from report snapshots</p>
          </div>
          <div class="legend">
            <span><i class="key-messages"></i>Messages</span>
            <span><i class="key-dlrs"></i>DLRs</span>
            <RouterLink class="text-link" to="/live-traffic">Live traffic</RouterLink>
          </div>
        </header>

        <!-- Totals summed over exactly the snapshots the chart plots, so the
             figures and the bars cannot disagree. -->
        <div class="traffic-totals">
          <div v-for="total in trafficTotals" :key="total.k">
            <b>{{ total.v }}</b>
            <span>{{ total.k }}</span>
          </div>
        </div>

        <!--
          OLDEST ON THE LEFT. The old chart ran newest-first, so a rising
          week sloped downwards — every reader of a time series expects time
          to run left to right, and reversing it inverts the trend.
        -->
        <div v-if="hasTraffic" class="chart" data-testid="dashboard-traffic-chart">
          <div class="chart-axis" aria-hidden="true">
            <span>{{ trafficMax.toLocaleString() }}</span>
            <span>{{ Math.round(trafficMax / 2).toLocaleString() }}</span>
            <span>0</span>
          </div>
          <div class="chart-body">
            <div class="chart-bars">
              <div
                v-for="day in trafficDays"
                :key="day.label"
                class="day"
                :title="`${day.label} · ${day.messages.toLocaleString()} messages · ${day.dlrs.toLocaleString()} receipts`"
              >
                <span
                  class="bar bar-messages"
                  :style="{ height: `${(day.messages / trafficMax) * 100}%` }"
                ></span>
                <span
                  class="bar bar-dlrs"
                  :style="{ height: `${(day.dlrs / trafficMax) * 100}%` }"
                ></span>
              </div>
            </div>
            <div class="chart-labels">
              <span v-for="day in trafficDays" :key="day.label">{{ day.label }}</span>
            </div>
          </div>
        </div>
        <!--
          "Nothing has been written" and "we cannot read what was written"
          are different claims, and the rebuild collapsed them into the
          first. An unreadable source reported as an empty one tells the
          operator their gateway sent nothing.
        -->
        <p
          v-else-if="volumeState === 'unavailable'"
          class="chart-empty"
          data-testid="dashboard-traffic-unavailable"
        >
          Volume report data is unavailable. The daily series cannot be plotted — this is an outage,
          not an absence of traffic.
        </p>
        <p v-else class="chart-empty" data-testid="dashboard-traffic-empty">
          No report snapshot has been written yet, so there is no daily series to plot.
        </p>
      </section>

      <section class="panel" data-testid="dashboard-incidents">
        <header class="panel-header">
          <div>
            <h2>Incidents</h2>
            <!--
              The old subtitle described the SORT ORDER and said nothing
              about the state, so a week where everything had been resolved
              still read "Active incidents · Longest running first" above
              five closed rows.
            -->
            <p>
              {{ openIncidents }} open ·
              {{ Math.max(0, recentAlerts.length - openIncidents) }} resolved
            </p>
          </div>
          <RouterLink class="text-link" to="/alerts">All alerts</RouterLink>
        </header>

        <p
          v-if="alertsState === 'unavailable'"
          class="chart-empty"
          data-testid="alerts-unavailable"
        >
          Alert data is unavailable.
        </p>
        <template v-else>
          <p v-if="!openIncidents && recentAlerts.length" class="incident-none">
            <span class="status-dot good" aria-hidden="true"></span>No open incidents. Recently
            resolved:
          </p>
          <ul class="incident-list">
            <li
              v-for="alert in recentAlerts"
              :key="text(alert.id)"
              :data-testid="`incident-${text(alert.id)}`"
            >
              <span class="incident-dot" :class="severityTone(alert)" aria-hidden="true"></span>
              <span class="incident-body">
                <strong class="clamp-1" :title="text(alert.summary ?? alert.rule_name)">{{
                  text(alert.summary ?? alert.rule_name)
                }}</strong>
                <small>{{ text(alert.severity) }} · {{ text(alert.status) }}</small>
              </span>
              <span class="incident-dur mono" :data-testid="`incident-duration-${text(alert.id)}`">
                {{ alertDuration(alert) }}
                <small>{{ openedAtLabel(alert) }}</small>
              </span>
            </li>
            <li v-if="alertsState === 'ok' && !recentAlerts.length" class="incident-empty">
              No alert instance has been recorded.
            </li>
            <li v-if="alertsState === 'checking'" class="incident-empty">Loading alerts…</li>
          </ul>
        </template>
      </section>
    </div>

    <!-- CARRIER PANEL ----------------------------------------------------- -->
    <DetailDrawer
      :open="Boolean(panelCarrier)"
      :eyebrow="
        panelCarrier
          ? [panelCarrier.country_code, panelCarrier.network_code].filter(Boolean).join(' · ')
          : ''
      "
      :title="panelCarrier?.name ?? 'Carrier'"
      @close="panelCarrier = null"
    >
      <template v-if="panelCarrier">
        <div class="panel-actions">
          <RouterLink
            class="primary-button"
            :to="`/carriers/${panelCarrier.id}`"
            data-testid="panel-open-carrier"
          >
            Open carrier
          </RouterLink>
          <RouterLink class="secondary-button" to="/alerts">View alerts</RouterLink>
        </div>

        <p class="panel-summary">{{ panelSummary }}</p>

        <section class="panel-block">
          <h3>SMSC binds</h3>
          <ul v-if="panelSmscs.length" class="bind-list-simple">
            <li v-for="smsc in panelSmscs" :key="String(smsc.id)">
              <span class="status-dot" :class="statusTone(String(smsc.bind_state ?? ''))"></span>
              <span class="mono">{{ text(smsc.engine_id ?? smsc.engineId) }}</span>
              <span>{{ text(smsc.bind_state ?? smsc.bindState, 'never observed') }}</span>
            </li>
          </ul>
          <p v-else-if="panelState === 'loading'" class="source-note">Loading binds…</p>
          <p v-else-if="panelState === 'error'" class="source-note">
            The connections for this carrier could not be read.
          </p>
          <p v-else class="source-note">No SMSC is configured for this carrier.</p>
        </section>

        <dl class="panel-fields">
          <dt>Health</dt>
          <dd>{{ panelCarrier.health }}</dd>
          <dt>Binds up</dt>
          <dd class="mono">{{ panelCarrier.bindsHealthy }} / {{ panelCarrier.bindsTotal }}</dd>
          <dt>Throughput</dt>
          <dd class="mono">
            {{
              panelCarrier.observedTps === null ? 'no telemetry' : `${panelCarrier.observedTps}/s`
            }}
          </dd>
          <dt>Of ceiling</dt>
          <dd class="mono">{{ utilisationLabel(panelCarrier) }}</dd>
          <dt>Queued</dt>
          <dd class="mono">{{ panelCarrier.queuedMessages.toLocaleString() }}</dd>
          <dt>Failed</dt>
          <dd class="mono">{{ panelCarrier.failedMessages.toLocaleString() }}</dd>
          <dt>Open alerts</dt>
          <dd class="mono">{{ panelCarrier.openAlerts }}</dd>
          <dt>Last event</dt>
          <dd>{{ panelCarrier.lastEvent || 'no transitions recorded' }}</dd>
        </dl>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
/* CONTROLS — three settings of the view, on one small bar on the right. */
.ops-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  /* ONE LINE until there is genuinely no room.
     The range select is the widest thing here ("Last 15 minutes"), and with
     `wrap` it pushed Refresh onto a second row at full width — which reads,
     correctly, as a broken control group. It shrinks instead, and the whole
     bar only stacks on a narrow screen. */
  flex-wrap: nowrap;
  margin-bottom: 12px;
}
.ops-controls > .filter-select select {
  min-width: 0;
}
/* ONE HEIGHT ACROSS THE BAR.
   The refresh button rendered 42px against the live toggle's 26px, so their
   top edges differed by 8px — visibly out of line, and read by the layout
   audit as a cluster broken over two rows. The design pins these at 32px;
   matching it is cheaper than chasing whichever padding rule won. */
.ops-controls > .secondary-button,
.ops-controls > .filter-select select,
.live-group {
  height: 32px;
}
.ops-controls > .secondary-button {
  /* `min-height: 42px` from the button base wins against `height` — a
     min-height is a floor, not a preference — so it has to be lowered
     explicitly or the bar keeps two different button heights. */
  min-height: 32px;
  padding-block: 0;
}
.live-group {
  padding-block: 0;
}
@media (max-width: 760px) {
  .ops-controls {
    flex-wrap: wrap;
  }
}
.live-group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface);
}
.live-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 4px;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.live-toggle .live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.live-toggle.is-live {
  color: var(--text-strong);
}
.live-toggle.is-live .live-dot {
  background: var(--ok, #1a7f37);
}

/* COPILOT — a question box where the data is, with three starters. */
.copilot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 11px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface);
}
.copilot-label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.copilot-form {
  display: flex;
  gap: 8px;
  flex: 1 1 320px;
  min-width: 0;
}
.copilot-form input {
  flex: 1;
  min-width: 0;
}
.copilot-prompts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.prompt-chip {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--surface-2);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.prompt-chip:hover {
  border-color: var(--brand);
  color: var(--brand);
}

/* Two columns; carriers get the wider side. */
.ops-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  margin-bottom: 14px;
}
.ops-grid.wide-left {
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
}
@media (max-width: 1100px) {
  .ops-grid,
  .ops-grid.wide-left {
    grid-template-columns: 1fr;
  }
}

/* One block per bind: filled up, hollow down, outlined never observed.
   "2 of 3" hides which of the three, and an unobserved bind is not a
   down one. */
.bind-bars {
  display: flex;
  gap: 3px;
  margin-top: 4px;
}
.bind-bars > span {
  width: 14px;
  height: 5px;
  border-radius: 2px;
}
.bind-bars .seg-up {
  background: var(--ok, #1a7f37);
}
.bind-bars .seg-down {
  background: var(--bad, #b42318);
}
.bind-bars .seg-unobserved {
  background: transparent;
  border: 1px solid var(--border);
}
.no-telemetry {
  color: var(--muted);
  font-size: 12.5px;
}

/* Queue pressure, sharing the Platform panel. */
.queue-block {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.queue-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.queue-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px auto;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 12.5px;
}
.queue-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-track {
  height: 5px;
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}
.queue-track > span {
  display: block;
  height: 100%;
  background: var(--brand);
}
.queue-depth {
  font-variant-numeric: tabular-nums;
}
/* An empty spool is a GOOD state and is said as one, rather than drawn
   as a list of zero-height bars. */
.queue-empty {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
}

/* TRAFFIC — totals, then paired bars running oldest to newest. */
.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}
.legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 5px;
  vertical-align: -1px;
}
.key-messages {
  background: var(--brand);
}
.key-dlrs {
  background: var(--accent, #78bde4);
}
.traffic-totals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin: 12px 0 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--border);
  overflow: hidden;
}
.traffic-totals div {
  background: var(--surface);
  padding: 10px 14px;
}
.traffic-totals b {
  display: block;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.traffic-totals span {
  color: var(--muted);
  font-size: 12px;
}
.chart {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 8px;
}
.chart-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 160px;
  color: var(--muted);
  font-size: 11px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 160px;
  padding-bottom: 1px;
  border-bottom: 1px solid var(--border);
}
.day {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 1;
  height: 100%;
  min-width: 0;
}
.bar {
  flex: 1;
  min-height: 2px;
  border-radius: 2px 2px 0 0;
}
.bar-messages {
  background: var(--brand);
}
.bar-dlrs {
  background: var(--accent, #78bde4);
}
.chart-labels {
  display: flex;
  gap: 6px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 10.5px;
}
.chart-labels span {
  flex: 1;
  min-width: 0;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* INCIDENTS */
.incident-none {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12.5px;
}
.incident-none .status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok, #1a7f37);
}
.incident-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.incident-list li {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
}
.incident-list li:last-child {
  border-bottom: none;
}
.incident-dot {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.incident-dot.bad {
  background: var(--bad, #b42318);
}
.incident-dot.warn {
  background: var(--warn, #9a6700);
}
.incident-dot.good {
  background: var(--ok, #1a7f37);
}
.incident-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.incident-body strong {
  font-size: 13px;
  font-weight: 500;
}
.incident-body small,
.incident-dur small {
  display: block;
  color: var(--muted);
  font-size: 11.5px;
}
.incident-dur {
  text-align: right;
  font-size: 12.5px;
  white-space: nowrap;
}
.incident-empty {
  padding: 16px 0;
  color: var(--muted);
  font-size: 12.5px;
}

/* CARRIER PANEL */
.panel-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.panel-summary {
  margin: 0 0 18px;
  font-size: 13px;
}
.panel-block {
  margin-bottom: 20px;
}
.panel-block h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.bind-list-simple {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12.5px;
}
.bind-list-simple li {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.bind-list-simple .status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.bind-list-simple .status-dot.good {
  background: var(--ok, #1a7f37);
}
.bind-list-simple .status-dot.warn {
  background: var(--warn, #9a6700);
}
.bind-list-simple .status-dot.bad {
  background: var(--bad, #b42318);
}
.panel-fields {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  row-gap: 10px;
  column-gap: 12px;
  margin: 0;
  font-size: 13px;
}
.panel-fields dt {
  color: var(--muted);
}
.panel-fields dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}

/* THE STATUS LINE ---------------------------------------------------------
   A severity chip, a sentence naming the carriers, and a way into the worst
   of them. Colour repeats the word; it never carries the meaning alone. */
.status-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  background: var(--surface);
}
.status-line p {
  flex: 1 1 340px;
  min-width: 0;
  margin: 0;
  font-size: 13px;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 10px;
  border-radius: 20px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentcolor;
}
.status-line.is-good {
  border-color: var(--ok, #1a7f37);
}
.status-line.is-good .status-chip {
  background: var(--ok-soft, #e6f4ea);
  color: var(--ok-strong, var(--ok, #1a7f37));
}
.status-line.is-warn {
  border-color: var(--warn, #9a6700);
}
.status-line.is-warn .status-chip {
  background: var(--warn-soft, #fbf0d8);
  color: var(--warn-strong, var(--warn, #9a6700));
}
.status-line.is-bad {
  border-color: var(--bad, #b42318);
}
.status-line.is-unknown {
  border-color: var(--warn, #9a6700);
}
.status-line.is-unknown .status-chip {
  background: var(--surface-2);
  color: var(--muted);
}
.status-line.is-bad .status-chip {
  background: var(--bad-soft, #fbe6e2);
  color: var(--bad-strong, var(--bad, #b42318));
}

/* A carrier we are not measuring says so once. */
.no-telemetry {
  color: var(--muted);
  font-size: 12.5px;
}

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
