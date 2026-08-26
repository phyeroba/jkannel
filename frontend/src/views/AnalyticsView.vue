<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import ModalDialog from '../components/ModalDialog.vue';
import MetricCard from '../components/MetricCard.vue';
import MiniChart, { type ChartSeries } from '../components/MiniChart.vue';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type SectionState = 'loading' | 'ok' | 'error';

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

/** A 404/501 means the analytics endpoints are not deployed yet — treat as "not available". */
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}

// --- Overview KPI cards -----------------------------------------------------
interface OverviewCard {
  key: string;
  label: string;
  value: number | string;
  unit?: string;
}
const overviewState = ref<SectionState>('loading');
const overviewMissing = ref(false);
const overviewError = ref('');
const overviewCards = ref<OverviewCard[]>([]);
const latestDailyPeriod = ref<string | null>(null);

const hasOverviewData = computed(() =>
  overviewCards.value.some((card) => num(card.value) !== 0 || Boolean(latestDailyPeriod.value)),
);

async function loadOverview() {
  overviewState.value = 'loading';
  overviewMissing.value = false;
  overviewError.value = '';
  try {
    const data = await apiRequest<{ cards?: OverviewCard[]; latestDailyPeriod?: string | null }>(
      '/reports/analytics/overview',
    );
    overviewCards.value = Array.isArray(data.cards) ? data.cards : [];
    latestDailyPeriod.value = data.latestDailyPeriod ?? null;
    overviewState.value = 'ok';
  } catch (reason) {
    overviewCards.value = [];
    latestDailyPeriod.value = null;
    overviewMissing.value = isMissing(reason);
    overviewError.value = messageFrom(reason, 'The analytics service could not be reached.');
    overviewState.value = 'error';
  }
}

// --- Traffic trend ----------------------------------------------------------
interface TrendPoint {
  date: string;
  messages: number;
  dlrs: number;
}
const trendState = ref<SectionState>('loading');
const trendMissing = ref(false);
const trendError = ref('');
const trendPoints = ref<TrendPoint[]>([]);
const trendDays = ref(30);
/**
 * The only reports that can honour a window are the three whose endpoint takes
 * `days`: traffic-trend (clamped 1–180 server-side) and hourly-heatmap /
 * latency-sla (clamped 1–90). The per-SMSC, per-route, success-rate and
 * delivery-breakdown endpoints read the latest report snapshot period and take
 * no parameter, so they deliberately have no range control — one that silently
 * did nothing would be worse than none.
 */
const rangeOptions = [7, 14, 30, 90];

const trendSeries = computed<ChartSeries[]>(() => [
  { label: 'Messages', color: 'var(--brand)', values: trendPoints.value.map((p) => p.messages) },
  { label: 'DLRs', color: 'var(--info)', values: trendPoints.value.map((p) => p.dlrs) },
]);
const trendLabels = computed(() => trendPoints.value.map((p) => p.date));
const hasTrendData = computed(() =>
  trendPoints.value.some((p) => p.messages !== 0 || p.dlrs !== 0),
);

async function loadTrend() {
  trendState.value = 'loading';
  trendMissing.value = false;
  trendError.value = '';
  try {
    const data = await apiRequest<{ series?: TrendPoint[] }>(
      `/reports/analytics/traffic-trend?days=${trendDays.value}`,
    );
    trendPoints.value = (Array.isArray(data.series) ? data.series : []).map((point) => ({
      date: text(point.date, ''),
      messages: num(point.messages),
      dlrs: num(point.dlrs),
    }));
    trendState.value = 'ok';
  } catch (reason) {
    trendPoints.value = [];
    trendMissing.value = isMissing(reason);
    trendError.value = messageFrom(reason, 'The traffic trend could not be loaded.');
    trendState.value = 'error';
  }
}

function changeRange(days: number) {
  if (days === trendDays.value) return;
  trendDays.value = days;
  void loadTrend();
}

// --- Delivery breakdown -----------------------------------------------------
interface BreakdownSegment {
  label: string;
  value: number;
}
const breakdownState = ref<SectionState>('loading');
const breakdownMissing = ref(false);
const breakdownError = ref('');
const breakdownSegments = ref<BreakdownSegment[]>([]);
const breakdownTotal = ref(0);

const hasBreakdownData = computed(() => breakdownTotal.value > 0);

/**
 * One bar per outcome. Each segment gets its own series so the legend names it:
 * the colour is a second signal, never the only one — the label and the count
 * are printed beside every bar in the list below the chart too.
 */
const BREAKDOWN_COLORS = ['var(--good)', 'var(--warn)', 'var(--info)', 'var(--brand)'];
const breakdownSeries = computed<ChartSeries[]>(() =>
  breakdownSegments.value.map((segment, index) => ({
    label: segment.label,
    color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
    values: breakdownSegments.value.map((_, position) => (position === index ? segment.value : 0)),
  })),
);
const breakdownLabels = computed(() => breakdownSegments.value.map((segment) => segment.label));

function segmentPercent(value: number) {
  if (breakdownTotal.value <= 0) return 0;
  return Math.round((value / breakdownTotal.value) * 100);
}

async function loadBreakdown() {
  breakdownState.value = 'loading';
  breakdownMissing.value = false;
  breakdownError.value = '';
  try {
    const data = await apiRequest<{ segments?: BreakdownSegment[]; total?: number }>(
      '/reports/analytics/delivery-breakdown',
    );
    breakdownSegments.value = (Array.isArray(data.segments) ? data.segments : []).map((seg) => ({
      label: text(seg.label, 'Segment'),
      value: num(seg.value),
    }));
    breakdownTotal.value = num(data.total);
    breakdownState.value = 'ok';
  } catch (reason) {
    breakdownSegments.value = [];
    breakdownTotal.value = 0;
    breakdownMissing.value = isMissing(reason);
    breakdownError.value = messageFrom(reason, 'The delivery breakdown could not be loaded.');
    breakdownState.value = 'error';
  }
}

// --- Grouped analytics (per SMSC / per route) -------------------------------
interface GroupRow {
  label: string;
  messages: number;
  dlrs: number;
}
interface Grouping {
  state: SectionState;
  missing: boolean;
  error: string;
  period: string;
  groups: GroupRow[];
}
function newGrouping(): Grouping {
  return { state: 'loading', missing: false, error: '', period: '', groups: [] };
}
const perSmsc = ref<Grouping>(newGrouping());
const perRoute = ref<Grouping>(newGrouping());
const topN = 8;

function groupSeries(grouping: Grouping): ChartSeries[] {
  const rows = grouping.groups.slice(0, topN);
  return [
    { label: 'Messages', color: 'var(--brand)', values: rows.map((r) => r.messages) },
    { label: 'DLRs', color: 'var(--info)', values: rows.map((r) => r.dlrs) },
  ];
}
function groupLabels(grouping: Grouping) {
  return grouping.groups.slice(0, topN).map((r) => r.label);
}
function hasGroupData(grouping: Grouping) {
  return grouping.groups.some((r) => r.messages !== 0 || r.dlrs !== 0);
}

async function loadGrouping(path: string, target: typeof perSmsc) {
  target.value = newGrouping();
  try {
    const data = await apiRequest<{ period?: string; groups?: GroupRow[] }>(path);
    target.value = {
      state: 'ok',
      missing: false,
      error: '',
      period: text(data.period, ''),
      groups: (Array.isArray(data.groups) ? data.groups : []).map((g) => ({
        label: text(g.label, 'Unnamed'),
        messages: num(g.messages),
        dlrs: num(g.dlrs),
      })),
    };
  } catch (reason) {
    target.value = {
      state: 'error',
      missing: isMissing(reason),
      error: messageFrom(reason, 'This breakdown could not be loaded.'),
      period: '',
      groups: [],
    };
  }
}

// --- Report catalog ---------------------------------------------------------
interface CatalogKind {
  key: string;
  name: string;
  available: boolean;
}
interface CatalogCategory {
  key: string;
  name: string;
  description: string;
  kinds: CatalogKind[];
}
const catalogState = ref<SectionState>('loading');
const catalogMissing = ref(false);
const catalogError = ref('');
const catalogCategories = ref<CatalogCategory[]>([]);

async function loadCatalog() {
  catalogState.value = 'loading';
  catalogMissing.value = false;
  catalogError.value = '';
  try {
    const data = await apiRequest<{ categories?: CatalogCategory[] }>('/reports/analytics/catalog');
    catalogCategories.value = (Array.isArray(data.categories) ? data.categories : []).map(
      (cat) => ({
        key: text(cat.key, ''),
        name: text(cat.name, 'Category'),
        description: text(cat.description, ''),
        kinds: Array.isArray(cat.kinds)
          ? cat.kinds.map((kind) => ({
              key: text(kind.key, ''),
              name: text(kind.name, 'Report'),
              available: Boolean(kind.available),
            }))
          : [],
      }),
    );
    catalogState.value = 'ok';
  } catch (reason) {
    catalogCategories.value = [];
    catalogMissing.value = isMissing(reason);
    catalogError.value = messageFrom(reason, 'The report catalog could not be loaded.');
    catalogState.value = 'error';
  }
}

// --- Raw volume snapshots + exports -----------------------------------------
const volumeState = ref<SectionState>('loading');
const volumeMissing = ref(false);
const volumeError = ref('');
const volumeRows = ref<RecordValue[]>([]);
const volumeTotal = ref(0);
const volumeNotice = ref('');
const busy = ref(false);

const canGenerate = computed(() => canAccess(session.value, 'system.manage'));

async function loadVolume() {
  volumeState.value = 'loading';
  volumeMissing.value = false;
  volumeError.value = '';
  try {
    const data = await apiRequest<{ items?: RecordValue[]; total?: number }>(
      '/reports/volume?sort=-periodStart&limit=12&offset=0',
    );
    volumeRows.value = Array.isArray(data.items)
      ? data.items.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
      : [];
    volumeTotal.value = num(data.total);
    volumeState.value = 'ok';
  } catch (reason) {
    volumeRows.value = [];
    volumeTotal.value = 0;
    volumeMissing.value = isMissing(reason);
    volumeError.value = messageFrom(reason, 'Volume snapshots could not be loaded.');
    volumeState.value = 'error';
  }
}

// --- Volume snapshot detail drawer ------------------------------------------
const snapshotOpen = ref(false);
const snapshotLoading = ref(false);
const snapshotError = ref('');
const snapshotDetail = ref<RecordValue | null>(null);
const snapshotRelated = computed<RecordValue[]>(() => {
  const related = snapshotDetail.value?.related;
  return Array.isArray(related) ? (related as RecordValue[]) : [];
});

async function openSnapshot(row: RecordValue) {
  const id = text(row.id ?? row.uuid, '');
  if (!id || id === '—') return;
  snapshotOpen.value = true;
  snapshotLoading.value = true;
  snapshotError.value = '';
  snapshotDetail.value = null;
  try {
    snapshotDetail.value = await apiRequest<RecordValue>(`/reports/volume/${id}`);
  } catch (reason) {
    snapshotError.value = messageFrom(reason, 'The snapshot detail could not be loaded.');
  } finally {
    snapshotLoading.value = false;
  }
}
function closeSnapshot() {
  snapshotOpen.value = false;
  snapshotDetail.value = null;
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// --- Exports ----------------------------------------------------------------
/**
 * Only the reports the API can actually export get a button here. Each entry
 * names a real endpoint; a report with no export route is listed in
 * `unexportableReports` below instead of getting a button that half-works.
 */
interface ExportableReport {
  key: string;
  name: string;
  detail: string;
  /** Path without the `.csv` / `.pdf` suffix. */
  base: string;
  query: string;
  formats: Array<'csv' | 'pdf'>;
  permission?: string;
}
const exportableReports: ExportableReport[] = [
  {
    key: 'volume',
    name: 'Volume report snapshots',
    detail: 'Persisted daily/weekly message-volume snapshots, newest first.',
    base: '/reports/volume/export',
    query: 'sort=-periodStart&limit=500&offset=0',
    formats: ['csv', 'pdf'],
  },
  {
    key: 'delivery',
    name: 'Delivery receipts',
    detail: 'Every delivery-receipt row from the SQLBox message store.',
    base: '/reports/delivery/export',
    query: 'limit=500',
    // The API exposes reports/delivery/export.csv only — there is no PDF route.
    formats: ['csv'],
  },
  {
    key: 'messages',
    name: 'Message detail',
    detail: 'Full message rows with encoding, segmentation and delivery outcome.',
    base: '/messages/export',
    query: 'limit=500',
    formats: ['csv', 'pdf'],
    permission: 'messages.export',
  },
];
/** Analytics panels the API has no export route for, stated rather than faked. */
const unexportableReports = [
  'Traffic trend',
  'Delivery confirmation',
  'Traffic by SMSC',
  'Traffic by route',
  'SMSC success rate',
  'Route performance',
  'Hourly traffic heatmap',
  'Delivery latency (SLA)',
];
const visibleExports = computed(() =>
  exportableReports.filter((report) => canAccess(session.value, report.permission)),
);
const exportNotice = ref('');
const exportError = ref('');

async function runExport(report: ExportableReport, format: 'csv' | 'pdf') {
  busy.value = true;
  exportNotice.value = '';
  exportError.value = '';
  try {
    const exported = await apiDownloadFile(`${report.base}.${format}?${report.query}`);
    saveDownloadedFile(exported.blob, exported.filename);
    exportNotice.value = `${report.name}: exported ${
      exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'
    } rows as ${format.toUpperCase()}.`;
  } catch (reason) {
    exportError.value = messageFrom(reason, `The ${report.name} export failed.`);
  } finally {
    busy.value = false;
  }
}

async function exportVolume(format: 'csv' | 'pdf') {
  busy.value = true;
  volumeNotice.value = '';
  volumeError.value = '';
  try {
    const exported = await apiDownloadFile(
      `/reports/volume/export.${format}?sort=-periodStart&limit=500&offset=0`,
    );
    saveDownloadedFile(exported.blob, exported.filename);
    volumeNotice.value = `Exported ${
      exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'
    } rows as ${format.toUpperCase()}.`;
  } catch (reason) {
    volumeError.value = messageFrom(reason, 'The export failed.');
  } finally {
    busy.value = false;
  }
}

async function generateNow() {
  busy.value = true;
  volumeNotice.value = '';
  volumeError.value = '';
  try {
    await apiRequest('/reports/volume/run', { method: 'POST', body: '{}' });
    volumeNotice.value = 'Volume report generation started. Refreshing analytics…';
    await refreshAll();
  } catch (reason) {
    volumeError.value = messageFrom(reason, 'The report job could not be started.');
  } finally {
    busy.value = false;
  }
}

// --- Success-rate groupings (per SMSC / per route) --------------------------
interface RateRow {
  label: string;
  messages: number;
  dlrs: number;
  successRate: number;
  failureRate: number;
}
interface RateGrouping {
  state: SectionState;
  missing: boolean;
  error: string;
  period: string;
  groups: RateRow[];
}
function newRateGrouping(): RateGrouping {
  return { state: 'loading', missing: false, error: '', period: '', groups: [] };
}
const smscSuccess = ref<RateGrouping>(newRateGrouping());
const routePerformance = ref<RateGrouping>(newRateGrouping());

function formatRate(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/**
 * Success/failure as a grouped bar per SMSC or route. A percentage table makes
 * you read every row to find the outlier; the bars make the outlier the first
 * thing you see, and the table under them keeps the exact numbers.
 */
function rateSeries(grouping: RateGrouping): ChartSeries[] {
  const rows = grouping.groups.slice(0, topN);
  return [
    { label: 'Success %', color: 'var(--good)', values: rows.map((row) => row.successRate) },
    { label: 'Failure %', color: 'var(--bad)', values: rows.map((row) => row.failureRate) },
  ];
}
function rateLabels(grouping: RateGrouping) {
  return grouping.groups.slice(0, topN).map((row) => row.label);
}

async function loadRates(path: string, target: typeof smscSuccess) {
  target.value = newRateGrouping();
  try {
    const data = await apiRequest<{ period?: string; groups?: RateRow[] }>(path);
    target.value = {
      state: 'ok',
      missing: false,
      error: '',
      period: text(data.period, ''),
      groups: (Array.isArray(data.groups) ? data.groups : []).map((g) => ({
        label: text(g.label, 'Unnamed'),
        messages: num(g.messages),
        dlrs: num(g.dlrs),
        successRate: num(g.successRate),
        failureRate: num(g.failureRate),
      })),
    };
  } catch (reason) {
    target.value = {
      state: 'error',
      missing: isMissing(reason),
      error: messageFrom(reason, 'This breakdown could not be loaded.'),
      period: '',
      groups: [],
    };
  }
}

// --- Hourly heatmap ---------------------------------------------------------
interface HeatCell {
  dow: number;
  hour: number;
  count: number;
}
const heatState = ref<SectionState>('loading');
const heatMissing = ref(false);
const heatError = ref('');
const heatCells = ref<HeatCell[]>([]);
const heatMax = ref(0);
const heatWindow = ref('');
const heatDays = ref(7);
const heatDows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const heatHours = Array.from({ length: 24 }, (_, hour) => hour);
const heatLookup = computed(() => {
  const map = new Map<string, number>();
  for (const cell of heatCells.value) map.set(`${cell.dow}:${cell.hour}`, cell.count);
  return map;
});
const hasHeatData = computed(() => heatCells.value.some((cell) => cell.count > 0));
function heatCount(dow: number, hour: number): number {
  return heatLookup.value.get(`${dow}:${hour}`) ?? 0;
}
function heatIntensity(dow: number, hour: number): number {
  const count = heatCount(dow, hour);
  if (count <= 0 || heatMax.value <= 0) return 0;
  return 0.12 + 0.88 * (count / heatMax.value);
}

async function loadHeatmap() {
  heatState.value = 'loading';
  heatMissing.value = false;
  heatError.value = '';
  try {
    const data = await apiRequest<{
      cells?: HeatCell[];
      maxCount?: number;
      window?: string;
    }>(`/reports/analytics/hourly-heatmap?days=${heatDays.value}`);
    heatCells.value = (Array.isArray(data.cells) ? data.cells : []).map((cell) => ({
      dow: num(cell.dow),
      hour: num(cell.hour),
      count: num(cell.count),
    }));
    heatMax.value = num(data.maxCount);
    heatWindow.value = text(data.window, '');
    heatState.value = 'ok';
  } catch (reason) {
    heatCells.value = [];
    heatMax.value = 0;
    heatMissing.value = isMissing(reason);
    heatError.value = messageFrom(reason, 'The hourly heatmap could not be loaded.');
    heatState.value = 'error';
  }
}

function changeHeatRange(days: number) {
  if (days === heatDays.value) return;
  heatDays.value = days;
  void loadHeatmap();
}

// --- Latency / SLA ----------------------------------------------------------
interface LatencySla {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  unit: string;
  window: string;
  note: string;
}
const latencyState = ref<SectionState>('loading');
const latencyMissing = ref(false);
const latencyError = ref('');
const latency = ref<LatencySla | null>(null);
const latencyDays = ref(7);
const hasLatencyData = computed(() => (latency.value ? latency.value.count > 0 : false));
/** p50/p95/p99 as one bar each: the shape of the tail, not three numbers to diff. */
const latencySeries = computed<ChartSeries[]>(() => [
  {
    label: `Latency (${latency.value?.unit ?? 'seconds'})`,
    color: 'var(--brand)',
    values: latency.value ? [latency.value.p50, latency.value.p95, latency.value.p99] : [],
  },
]);
const latencyLabels = ['p50', 'p95', 'p99'];

async function loadLatency() {
  latencyState.value = 'loading';
  latencyMissing.value = false;
  latencyError.value = '';
  try {
    const data = await apiRequest<Partial<LatencySla>>(
      `/reports/analytics/latency-sla?days=${latencyDays.value}`,
    );
    latency.value = {
      count: num(data.count),
      p50: num(data.p50),
      p95: num(data.p95),
      p99: num(data.p99),
      unit: text(data.unit, 'seconds'),
      window: text(data.window, ''),
      note: text(data.note, ''),
    };
    latencyState.value = 'ok';
  } catch (reason) {
    latency.value = null;
    latencyMissing.value = isMissing(reason);
    latencyError.value = messageFrom(reason, 'Latency percentiles could not be loaded.');
    latencyState.value = 'error';
  }
}

function changeLatencyRange(days: number) {
  if (days === latencyDays.value) return;
  latencyDays.value = days;
  void loadLatency();
}

// --- Saved report definitions ----------------------------------------------
interface Definition {
  id: string;
  name: string;
  reportType: string;
  schedule: string;
  format: string;
  enabled: boolean;
  createdAt: string;
}
const defState = ref<SectionState>('loading');
const defMissing = ref(false);
const defError = ref('');
const defRows = ref<Definition[]>([]);
const defTotal = ref(0);
const defNotice = ref('');

/**
 * The report kinds a SAVED DEFINITION may name.
 *
 * Mirrors REPORT_TYPES in backend/src/reporting-depth/report-definitions.
 * repository.ts, which the create/update endpoints validate against. It is a
 * strict subset of the catalog's `available` kinds — a catalog kind can be
 * renderable on demand without the scheduler having a runner for it. Offering
 * the whole catalog here put six options in the menu (smsc_success_rate,
 * route_success_rate, queue_status, engine_health, recent_changes,
 * audit_activity) that always answered 400.
 */
const DEFINABLE_REPORT_TYPES = new Set([
  'daily_volume',
  'weekly_volume',
  'traffic_trend',
  'delivery_breakdown',
  'smsc_volume',
  'smsc_success',
  'route_volume',
  'route_performance',
  'hourly_heatmap',
  'latency_sla',
]);

/** Definable catalog kinds, for the create form. */
const availableKinds = computed(() => {
  const kinds: Array<{ key: string; label: string }> = [];
  // `hourly_heatmap` is listed under two catalog categories, so dedupe by key —
  // otherwise the <select> renders it twice with a duplicate :key.
  const seen = new Set<string>();
  for (const category of catalogCategories.value) {
    for (const kind of category.kinds) {
      if (!kind.available || !DEFINABLE_REPORT_TYPES.has(kind.key) || seen.has(kind.key)) continue;
      seen.add(kind.key);
      kinds.push({ key: kind.key, label: `${category.name} · ${kind.name}` });
    }
  }
  return kinds;
});

function mapDefinition(raw: RecordValue): Definition {
  return {
    id: text(raw.id ?? raw.uuid, ''),
    name: text(raw.name),
    reportType: text(raw.report_type ?? raw.reportType),
    schedule: text(raw.schedule, 'manual'),
    format: text(raw.format, 'summary'),
    enabled: raw.enabled === true || raw.enabled === 'true',
    createdAt: text(raw.created_at ?? raw.createdAt),
  };
}

async function loadDefinitions() {
  defState.value = 'loading';
  defMissing.value = false;
  defError.value = '';
  try {
    const data = await apiRequest<{ items?: RecordValue[]; total?: number }>(
      '/reports/definitions?sort=-createdAt&limit=50&offset=0',
    );
    defRows.value = (Array.isArray(data.items) ? data.items : [])
      .filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
      .map(mapDefinition);
    defTotal.value = num(data.total);
    defState.value = 'ok';
  } catch (reason) {
    defRows.value = [];
    defTotal.value = 0;
    defMissing.value = isMissing(reason);
    defError.value = messageFrom(reason, 'Saved report definitions could not be loaded.');
    defState.value = 'error';
  }
}

const showDefForm = ref(false);
const newDefName = ref('');
const newDefType = ref('');
const newDefSchedule = ref<'' | 'hourly' | 'daily' | 'weekly'>('');
const newDefFormat = ref<'csv' | 'summary'>('summary');
const newDefEnabled = ref(true);

function openDefForm() {
  showDefForm.value = true;
  newDefName.value = '';
  newDefType.value = availableKinds.value[0]?.key ?? '';
  newDefSchedule.value = '';
  newDefFormat.value = 'summary';
  newDefEnabled.value = true;
  defError.value = '';
  defNotice.value = '';
}

async function createDefinition() {
  if (!newDefName.value.trim() || !newDefType.value) return;
  busy.value = true;
  defError.value = '';
  defNotice.value = '';
  try {
    await apiRequest('/reports/definitions', {
      method: 'POST',
      body: JSON.stringify({
        name: newDefName.value.trim(),
        reportType: newDefType.value,
        format: newDefFormat.value,
        enabled: newDefEnabled.value,
        ...(newDefSchedule.value ? { schedule: newDefSchedule.value } : {}),
      }),
    });
    showDefForm.value = false;
    defNotice.value = 'Saved report definition created.';
    await loadDefinitions();
  } catch (reason) {
    defError.value = messageFrom(reason, 'The report definition could not be created.');
  } finally {
    busy.value = false;
  }
}

async function toggleDefinition(def: Definition) {
  busy.value = true;
  defError.value = '';
  defNotice.value = '';
  try {
    await apiRequest(`/reports/definitions/${def.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !def.enabled }),
    });
    defNotice.value = `Definition ${def.enabled ? 'disabled' : 'enabled'}.`;
    await loadDefinitions();
  } catch (reason) {
    defError.value = messageFrom(reason, 'The report definition could not be updated.');
  } finally {
    busy.value = false;
  }
}

async function deleteDefinition(def: Definition) {
  if (!confirm(`Delete saved report definition “${def.name}”?`)) return;
  busy.value = true;
  defError.value = '';
  defNotice.value = '';
  try {
    await apiRequest(`/reports/definitions/${def.id}`, { method: 'DELETE' });
    defNotice.value = 'Saved report definition deleted.';
    if (selectedDefId.value === def.id) closeRuns();
    await loadDefinitions();
  } catch (reason) {
    defError.value = messageFrom(reason, 'The report definition could not be deleted.');
  } finally {
    busy.value = false;
  }
}

const runsOpen = ref(false);
const runsLoading = ref(false);
const runsError = ref('');
const runsRows = ref<RecordValue[]>([]);
const selectedDefId = ref('');
const selectedDefName = ref('');

async function openRuns(def: Definition) {
  runsOpen.value = true;
  runsLoading.value = true;
  runsError.value = '';
  runsRows.value = [];
  selectedDefId.value = def.id;
  selectedDefName.value = def.name;
  try {
    const data = await apiRequest<{ items?: RecordValue[] } | RecordValue[]>(
      `/reports/definitions/${def.id}/runs`,
    );
    runsRows.value = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
  } catch (reason) {
    runsError.value = messageFrom(reason, 'The run history could not be loaded.');
  } finally {
    runsLoading.value = false;
  }
}
function closeRuns() {
  runsOpen.value = false;
  runsRows.value = [];
  selectedDefId.value = '';
  selectedDefName.value = '';
}

const lastRefreshed = ref('Not yet');

async function refreshAll() {
  await Promise.all([
    loadOverview(),
    loadTrend(),
    loadBreakdown(),
    loadGrouping('/reports/analytics/per-smsc', perSmsc),
    loadGrouping('/reports/analytics/per-route', perRoute),
    loadRates('/reports/analytics/smsc-success', smscSuccess),
    loadRates('/reports/analytics/route-performance', routePerformance),
    loadHeatmap(),
    loadLatency(),
    loadCatalog(),
    loadVolume(),
    loadDefinitions(),
  ]);
  lastRefreshed.value = new Date().toLocaleTimeString();
}

onMounted(() => void refreshAll());
</script>

<template>
  <div class="analytics-page" data-testid="analytics-view">
    <div class="dashboard-actions">
      <button
        class="secondary-button"
        data-testid="analytics-refresh"
        :disabled="busy"
        @click="refreshAll"
      >
        Refresh analytics
      </button>
      <button
        v-if="canGenerate"
        class="primary-button"
        data-testid="analytics-generate"
        :disabled="busy"
        @click="generateNow"
      >
        Generate now
      </button>
      <span>Last refreshed: {{ lastRefreshed }}</span>
    </div>

    <p v-if="volumeNotice" class="notice" role="status" data-testid="analytics-notice">
      {{ volumeNotice }}
    </p>

    <!-- KPI cards --------------------------------------------------------- -->
    <section aria-label="Key metrics">
      <p v-if="overviewState === 'loading'" class="chart-empty">Loading key metrics…</p>
      <p
        v-else-if="overviewState === 'error'"
        class="chart-empty"
        data-testid="overview-unavailable"
      >
        {{ overviewMissing ? 'Analytics reporting is not available yet.' : overviewError }}
      </p>
      <p v-else-if="!hasOverviewData" class="chart-empty" data-testid="overview-empty">
        No report snapshots have been generated yet. Metrics appear after the scheduled reporting
        job runs.
      </p>
      <div v-else class="metrics-grid" data-testid="overview-cards">
        <MetricCard
          v-for="card in overviewCards"
          :key="card.key"
          :label="card.label"
          :value="`${text(card.value, '0')}${card.unit ? ' ' + card.unit : ''}`"
          :detail="
            latestDailyPeriod ? `Latest daily period ${latestDailyPeriod}` : 'Report snapshot'
          "
          icon="chart"
        />
      </div>
    </section>

    <section class="dashboard-grid">
      <!-- Traffic trend --------------------------------------------------- -->
      <article class="panel wide">
        <header class="panel-header">
          <div>
            <h2>Traffic trend</h2>
            <p>Messages and delivery receipts over time</p>
          </div>
          <div class="range-select" role="group" aria-label="Trend range">
            <button
              v-for="option in rangeOptions"
              :key="option"
              type="button"
              class="range-button"
              :class="{ active: trendDays === option }"
              :data-testid="`trend-range-${option}`"
              @click="changeRange(option)"
            >
              {{ option }}d
            </button>
          </div>
        </header>
        <p v-if="trendState === 'loading'" class="chart-empty">Loading traffic trend…</p>
        <p v-else-if="trendState === 'error'" class="chart-empty" data-testid="trend-unavailable">
          {{ trendMissing ? 'Traffic trend reporting is not available yet.' : trendError }}
        </p>
        <p v-else-if="!hasTrendData" class="chart-empty" data-testid="trend-empty">
          No traffic has been recorded in this window yet.
        </p>
        <MiniChart
          v-else
          type="area"
          data-testid="trend-chart"
          title="Messages and DLRs by day"
          :series="trendSeries"
          :labels="trendLabels"
          :height="180"
        />
      </article>

      <!-- Delivery breakdown ---------------------------------------------- -->
      <article class="panel">
        <header class="panel-header">
          <div>
            <h2>Delivery confirmation</h2>
            <p>Confirmed vs unconfirmed messages</p>
          </div>
        </header>
        <p v-if="breakdownState === 'loading'" class="chart-empty">Loading breakdown…</p>
        <p
          v-else-if="breakdownState === 'error'"
          class="chart-empty"
          data-testid="breakdown-unavailable"
        >
          {{ breakdownMissing ? 'Delivery breakdown is not available yet.' : breakdownError }}
        </p>
        <p v-else-if="!hasBreakdownData" class="chart-empty" data-testid="breakdown-empty">
          No delivery data yet.
        </p>
        <template v-else>
          <MiniChart
            type="bar"
            data-testid="breakdown-chart"
            title="Delivery outcome breakdown"
            :series="breakdownSeries"
            :labels="breakdownLabels"
            :height="140"
          />
          <div class="breakdown" data-testid="breakdown">
            <div v-for="seg in breakdownSegments" :key="seg.label" class="breakdown-row">
              <div class="breakdown-label">
                <span>{{ seg.label }}</span>
                <strong>{{ seg.value }} ({{ segmentPercent(seg.value) }}%)</strong>
              </div>
              <div class="breakdown-track">
                <span
                  class="breakdown-fill"
                  :style="{ width: `${segmentPercent(seg.value)}%` }"
                ></span>
              </div>
            </div>
            <small class="breakdown-total">Total {{ breakdownTotal }} messages</small>
          </div>
        </template>
      </article>
    </section>

    <!-- Per-SMSC / Per-route ---------------------------------------------- -->
    <section class="dashboard-grid">
      <article
        v-for="group in [
          { key: 'smsc', title: 'Traffic by SMSC', data: perSmsc },
          { key: 'route', title: 'Traffic by route', data: perRoute },
        ]"
        :key="group.key"
        class="panel"
      >
        <header class="panel-header">
          <div>
            <h2>{{ group.title }}</h2>
            <p>{{ group.data.period ? `Period ${group.data.period}` : 'Latest report period' }}</p>
          </div>
        </header>
        <p v-if="group.data.state === 'loading'" class="chart-empty">Loading…</p>
        <p
          v-else-if="group.data.state === 'error'"
          class="chart-empty"
          :data-testid="`${group.key}-unavailable`"
        >
          {{ group.data.missing ? 'This breakdown is not available yet.' : group.data.error }}
        </p>
        <p
          v-else-if="!hasGroupData(group.data)"
          class="chart-empty"
          :data-testid="`${group.key}-empty`"
        >
          No traffic recorded for this period yet.
        </p>
        <template v-else>
          <MiniChart
            type="bar"
            :data-testid="`${group.key}-chart`"
            :title="group.title"
            :series="groupSeries(group.data)"
            :labels="groupLabels(group.data)"
            :height="160"
          />
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ group.key === 'smsc' ? 'SMSC' : 'Route' }}</th>
                  <th scope="col">Messages</th>
                  <th scope="col">DLRs</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in group.data.groups.slice(0, topN)" :key="row.label">
                  <td>{{ row.label }}</td>
                  <td>{{ row.messages }}</td>
                  <td>{{ row.dlrs }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </article>
    </section>

    <!-- Success rates (per SMSC / per route) ------------------------------ -->
    <section class="dashboard-grid">
      <article
        v-for="group in [
          { key: 'smsc-success', title: 'SMSC success rate', data: smscSuccess, unit: 'SMSC' },
          {
            key: 'route-performance',
            title: 'Route performance',
            data: routePerformance,
            unit: 'Route',
          },
        ]"
        :key="group.key"
        class="panel"
      >
        <header class="panel-header">
          <div>
            <h2>{{ group.title }}</h2>
            <p>{{ group.data.period ? `Period ${group.data.period}` : 'Latest report period' }}</p>
          </div>
        </header>
        <p v-if="group.data.state === 'loading'" class="chart-empty">Loading…</p>
        <p
          v-else-if="group.data.state === 'error'"
          class="chart-empty"
          :data-testid="`${group.key}-unavailable`"
        >
          {{ group.data.missing ? 'This breakdown is not available yet.' : group.data.error }}
        </p>
        <p
          v-else-if="!group.data.groups.length"
          class="chart-empty"
          :data-testid="`${group.key}-empty`"
        >
          No traffic recorded for this period yet.
        </p>
        <template v-else>
          <MiniChart
            type="bar"
            :data-testid="`${group.key}-chart`"
            :title="`${group.title} — success and failure percentage`"
            :series="rateSeries(group.data)"
            :labels="rateLabels(group.data)"
            :height="150"
          />
          <div class="table-wrap" :data-testid="`${group.key}-table`">
            <table>
              <thead>
                <tr>
                  <th scope="col">Messages</th>
                  <th scope="col">DLRs</th>
                  <th scope="col">Success</th>
                  <th scope="col">Failure</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in group.data.groups.slice(0, topN)" :key="row.label">
                  <td>{{ row.label }}</td>
                  <td>{{ row.messages }}</td>
                  <td>{{ row.dlrs }}</td>
                  <td>
                    <span class="status-badge good">{{ formatRate(row.successRate) }}</span>
                  </td>
                  <td>
                    <span class="status-badge" :class="row.failureRate > 0 ? 'muted' : ''">{{
                      formatRate(row.failureRate)
                    }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </article>
    </section>

    <!-- Hourly heatmap ---------------------------------------------------- -->
    <section class="panel" aria-label="Hourly traffic heatmap">
      <header class="panel-header">
        <div>
          <h2>Hourly traffic heatmap</h2>
          <p>Message volume by day of week and hour{{ heatWindow ? ` · ${heatWindow}` : '' }}</p>
        </div>
        <div class="range-select" role="group" aria-label="Heatmap range">
          <button
            v-for="option in rangeOptions"
            :key="option"
            type="button"
            class="range-button"
            :class="{ active: heatDays === option }"
            :data-testid="`heatmap-range-${option}`"
            @click="changeHeatRange(option)"
          >
            {{ option }}d
          </button>
        </div>
      </header>
      <p v-if="heatState === 'loading'" class="chart-empty">Loading heatmap…</p>
      <p v-else-if="heatState === 'error'" class="chart-empty" data-testid="heatmap-unavailable">
        {{ heatMissing ? 'The hourly heatmap is not available yet.' : heatError }}
      </p>
      <p v-else-if="!hasHeatData" class="chart-empty" data-testid="heatmap-empty">
        No traffic has been recorded in this window yet.
      </p>
      <div v-else class="heatmap" data-testid="heatmap">
        <div class="heatmap-row heatmap-head">
          <span class="heatmap-daylabel"></span>
          <span v-for="hour in heatHours" :key="`h-${hour}`" class="heatmap-hourlabel">{{
            hour % 6 === 0 ? hour : ''
          }}</span>
        </div>
        <div v-for="(day, dow) in heatDows" :key="day" class="heatmap-row">
          <span class="heatmap-daylabel">{{ day }}</span>
          <span
            v-for="hour in heatHours"
            :key="`${dow}-${hour}`"
            class="heatmap-cell"
            :style="{ opacity: heatIntensity(dow, hour) || 0.04 }"
            :title="`${day} ${hour}:00 — ${heatCount(dow, hour)} messages`"
          ></span>
        </div>
        <small class="source-note">Peak hour volume: {{ heatMax }} messages.</small>
      </div>
    </section>

    <!-- Latency / SLA ----------------------------------------------------- -->
    <section class="panel" aria-label="Delivery latency SLA">
      <header class="panel-header">
        <div>
          <h2>Delivery latency (SLA)</h2>
          <p>
            Submit-to-DLR latency percentiles{{ latency?.window ? ` · ${latency.window}` : '' }}
          </p>
        </div>
        <div class="range-select" role="group" aria-label="Latency range">
          <button
            v-for="option in rangeOptions"
            :key="option"
            type="button"
            class="range-button"
            :class="{ active: latencyDays === option }"
            :data-testid="`latency-range-${option}`"
            @click="changeLatencyRange(option)"
          >
            {{ option }}d
          </button>
        </div>
      </header>
      <p v-if="latencyState === 'loading'" class="chart-empty">Loading latency…</p>
      <p v-else-if="latencyState === 'error'" class="chart-empty" data-testid="latency-unavailable">
        {{ latencyMissing ? 'Latency reporting is not available yet.' : latencyError }}
      </p>
      <p v-else-if="!hasLatencyData" class="chart-empty" data-testid="latency-empty">
        No delivery receipts with latency were recorded in this window yet.
      </p>
      <template v-else-if="latency">
        <div class="metrics-grid" data-testid="latency-cards">
          <MetricCard
            label="Median (p50)"
            :value="`${latency.p50} ${latency.unit}`"
            :detail="`${latency.count} samples`"
            icon="chart"
          />
          <MetricCard
            label="p95"
            :value="`${latency.p95} ${latency.unit}`"
            detail="95th percentile"
            icon="chart"
          />
          <MetricCard
            label="p99"
            :value="`${latency.p99} ${latency.unit}`"
            detail="99th percentile"
            icon="chart"
          />
        </div>
        <MiniChart
          type="bar"
          data-testid="latency-chart"
          :title="`Submit-to-DLR latency percentiles in ${latency.unit}`"
          :series="latencySeries"
          :labels="latencyLabels"
          :height="150"
        />
        <p v-if="latency.note" class="source-note">{{ latency.note }}</p>
      </template>
    </section>

    <!-- Report catalog ---------------------------------------------------- -->
    <section class="panel" aria-label="Report catalog">
      <header class="panel-header">
        <div>
          <h2>Report catalog</h2>
          <p>Report categories available in this platform</p>
        </div>
      </header>
      <p v-if="catalogState === 'loading'" class="chart-empty">Loading catalog…</p>
      <p v-else-if="catalogState === 'error'" class="chart-empty" data-testid="catalog-unavailable">
        {{ catalogMissing ? 'The report catalog is not available yet.' : catalogError }}
      </p>
      <p v-else-if="!catalogCategories.length" class="chart-empty" data-testid="catalog-empty">
        No report categories are registered.
      </p>
      <div v-else class="catalog-grid" data-testid="catalog">
        <article
          v-for="category in catalogCategories"
          :key="category.key"
          class="catalog-card"
          :data-testid="`catalog-${category.key}`"
        >
          <h3>{{ category.name }}</h3>
          <p>{{ category.description }}</p>
          <ul class="catalog-kinds">
            <li v-for="kind in category.kinds" :key="kind.key">
              <span>{{ kind.name }}</span>
              <span class="status-badge" :class="kind.available ? 'good' : 'muted'">{{
                kind.available ? 'available' : 'planned'
              }}</span>
            </li>
          </ul>
        </article>
      </div>
    </section>

    <!-- Exports ------------------------------------------------------------ -->
    <section class="panel" aria-label="Report exports" data-testid="exports-panel">
      <header class="panel-header">
        <div>
          <h2>Exports</h2>
          <p>Download a report as a file. Only reports the API can export are listed.</p>
        </div>
      </header>
      <p v-if="exportNotice" class="notice" role="status" data-testid="export-notice">
        {{ exportNotice }}
      </p>
      <p v-if="exportError" class="chart-empty" role="alert" data-testid="export-error">
        {{ exportError }}
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Report</th>
              <th scope="col">Contents</th>
              <th scope="col">Download</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="report in visibleExports"
              :key="report.key"
              :data-testid="`export-${report.key}`"
            >
              <td>{{ report.name }}</td>
              <td>{{ report.detail }}</td>
              <td class="row-actions">
                <button
                  v-for="format in report.formats"
                  :key="format"
                  class="secondary-button"
                  :data-testid="`export-${report.key}-${format}`"
                  :disabled="busy"
                  @click="runExport(report, format)"
                >
                  {{ format.toUpperCase() }}
                </button>
                <small v-if="!report.formats.includes('pdf')" class="source-note"
                  >CSV only — the API has no PDF route for this report.</small
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="source-note" data-testid="exports-unavailable-note">
        No export endpoint exists for {{ unexportableReports.join(', ') }}. Those panels are read on
        screen only; use the volume snapshot export for the underlying period totals.
      </p>
    </section>

    <!-- Raw volume snapshots + exports ------------------------------------ -->
    <section class="panel">
      <header class="panel-header">
        <div>
          <h2>Volume report snapshots</h2>
          <p aria-live="polite">
            {{
              volumeState === 'loading'
                ? 'Loading snapshots…'
                : `${volumeRows.length} of ${volumeTotal} snapshots`
            }}
          </p>
        </div>
        <div class="row-actions">
          <button
            class="secondary-button"
            data-testid="volume-export-csv"
            :disabled="busy"
            @click="exportVolume('csv')"
          >
            Export CSV
          </button>
          <button
            class="secondary-button"
            data-testid="volume-export-pdf"
            :disabled="busy"
            @click="exportVolume('pdf')"
          >
            Export PDF
          </button>
        </div>
      </header>
      <p v-if="volumeState === 'error'" class="chart-empty" data-testid="volume-unavailable">
        {{ volumeMissing ? 'Volume reporting is not available yet.' : volumeError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Type</th>
              <th scope="col">Scope</th>
              <th scope="col">Messages</th>
              <th scope="col">DLRs</th>
              <th scope="col">Generated</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in volumeRows"
              :key="text(row.id)"
              class="selectable"
              :data-testid="`snapshot-${text(row.id)}`"
              tabindex="0"
              @click="openSnapshot(row)"
              @keydown.enter="openSnapshot(row)"
              @keydown.space.prevent="openSnapshot(row)"
            >
              <td>{{ text(row.period_start ?? row.periodStart) }}</td>
              <td>{{ text(row.period_type ?? row.periodType) }}</td>
              <td>{{ text(row.scope) }}</td>
              <td>{{ text(row.message_count ?? row.messageCount, '0') }}</td>
              <td>{{ text(row.dlr_count ?? row.dlrCount, '0') }}</td>
              <td>{{ text(row.generated_at ?? row.generatedAt) }}</td>
            </tr>
            <tr v-if="volumeState === 'ok' && !volumeRows.length">
              <td colspan="6" class="empty-cell" data-testid="volume-empty">
                No volume snapshots have been generated yet. They appear after the scheduled
                reporting job runs.
              </td>
            </tr>
            <tr v-if="volumeState === 'loading'">
              <td colspan="6" class="empty-cell">Loading snapshots…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="volumeState === 'ok' && volumeRows.length" class="source-note">
        Select a snapshot to view its total plus per-SMSC and per-route breakdown.
      </p>
    </section>

    <!-- Saved report definitions ------------------------------------------ -->
    <section class="panel" aria-label="Saved report definitions">
      <header class="panel-header">
        <div>
          <h2>Saved report definitions</h2>
          <p aria-live="polite">
            {{
              defState === 'loading'
                ? 'Loading definitions…'
                : `${defRows.length} of ${defTotal} saved definitions`
            }}
          </p>
        </div>
        <div class="row-actions">
          <button
            v-if="canGenerate"
            class="primary-button"
            data-testid="definition-new"
            :disabled="busy || !availableKinds.length"
            @click="openDefForm"
          >
            New definition
          </button>
        </div>
      </header>

      <p v-if="defNotice" class="notice" role="status" data-testid="definition-notice">
        {{ defNotice }}
      </p>
      <p v-if="defError" class="chart-empty" role="alert" data-testid="definition-error">
        {{ defError }}
      </p>

      <!--
        A DIALOG, BECAUSE CREATING SOMETHING IS A DIALOG.

        This was a `.composer` section that appeared BELOW the register when
        "New definition" was pressed — the inline-panel pattern the kit does not
        have and the console has been removing everywhere else. Add / New /
        Create opens a centred dialog; a record opens a sheet; a controlled
        action opens a confirmation. Nothing opens a div under the list.

        It also read as broken rather than merely inconsistent: `dialog-audit`
        pressed the button and reported "the button did not open a dialog",
        which is what an operator experiences too — a page that shifts and a
        form somewhere below the fold.
      -->
      <ModalDialog
        :open="showDefForm"
        title="New report definition"
        wide
        testid="definition-dialog"
        @close="showDefForm = false"
      >
        <p class="source-note">
          A definition is a saved report the scheduler can run on its own. Only the kinds the
          scheduler can actually run are offered — other panels on this page can be read here but
          not saved as a definition.
        </p>
        <div class="dialog-grid">
          <label class="field">
            <span>Name</span>
            <input
              v-model="newDefName"
              data-testid="definition-name"
              placeholder="Daily volume CSV"
            />
          </label>
          <label class="field">
            <span>Report type</span>
            <select v-model="newDefType" data-testid="definition-type">
              <option v-for="kind in availableKinds" :key="kind.key" :value="kind.key">
                {{ kind.label }}
              </option>
            </select>
            <small data-testid="definition-type-note">
              Only the kinds the scheduler can run are listed.
            </small>
          </label>
          <label class="field">
            <span>Schedule</span>
            <select v-model="newDefSchedule" data-testid="definition-schedule">
              <option value="">Manual (no schedule)</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label class="field">
            <span>Format</span>
            <select v-model="newDefFormat" data-testid="definition-format">
              <option value="summary">Summary</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label class="field checkbox-row dialog-span">
            <input v-model="newDefEnabled" type="checkbox" data-testid="definition-enabled" />
            <span>Enabled — the scheduler may run this definition</span>
          </label>
        </div>
        <template #footer>
          <button class="secondary-button" @click="showDefForm = false">Cancel</button>
          <button
            class="primary-button"
            data-testid="definition-submit"
            :disabled="busy || !newDefName.trim() || !newDefType"
            @click="createDefinition"
          >
            Create definition
          </button>
        </template>
      </ModalDialog>

      <p
        v-if="defState === 'error' && defMissing"
        class="chart-empty"
        data-testid="definition-unavailable"
      >
        Saved report definitions are not available yet.
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Report type</th>
              <th scope="col">Schedule</th>
              <th scope="col">Format</th>
              <th scope="col">Enabled</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="def in defRows" :key="def.id" :data-testid="`definition-${def.id}`">
              <td>{{ def.name }}</td>
              <td class="mono">{{ def.reportType }}</td>
              <td>{{ def.schedule }}</td>
              <td>{{ def.format }}</td>
              <td>
                <span class="status-badge" :class="def.enabled ? 'good' : 'muted'">{{
                  def.enabled ? 'enabled' : 'disabled'
                }}</span>
              </td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`definition-runs-${def.id}`"
                  @click="openRuns(def)"
                >
                  Runs
                </button>
                <button
                  v-if="canGenerate"
                  class="secondary-button"
                  :data-testid="`definition-toggle-${def.id}`"
                  :disabled="busy"
                  @click="toggleDefinition(def)"
                >
                  {{ def.enabled ? 'Disable' : 'Enable' }}
                </button>
                <button
                  v-if="canGenerate"
                  class="secondary-button danger-button"
                  :data-testid="`definition-delete-${def.id}`"
                  :disabled="busy"
                  @click="deleteDefinition(def)"
                >
                  Delete
                </button>
              </td>
            </tr>
            <tr v-if="defState === 'ok' && !defRows.length">
              <td colspan="6" class="empty-cell" data-testid="definition-empty">
                No saved report definitions yet. Create one to schedule recurring reports.
              </td>
            </tr>
            <tr v-if="defState === 'loading'">
              <td colspan="6" class="empty-cell">Loading definitions…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- A record opened from a register goes in a sheet, so the register
         stays visible behind it. See `DetailDrawer.vue`. -->
    <DetailDrawer
      :open="runsOpen"
      title="Runs"
      :subtitle="selectedDefName"
      eyebrow="Report definition"
      wide
      @close="closeRuns"
    >
      <div data-testid="runs-panel">
        <p v-if="runsLoading" class="chart-empty" data-testid="runs-loading">Loading…</p>
        <p v-else-if="runsError" class="chart-empty" role="alert" data-testid="runs-error">
          {{ runsError }}
        </p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Rows</th>
                <th scope="col">Started</th>
                <th scope="col">Completed</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(run, index) in runsRows" :key="text(run.id, String(index))">
                <td>{{ text(run.status) }}</td>
                <td>{{ text(run.row_count ?? run.rowCount, '0') }}</td>
                <td>
                  {{ text(run.started_at ?? run.startedAt ?? run.created_at ?? run.createdAt) }}
                </td>
                <td>{{ text(run.completed_at ?? run.completedAt) }}</td>
                <td>{{ text(run.detail ?? run.error) }}</td>
              </tr>
              <tr v-if="!runsRows.length">
                <td colspan="5" class="empty-cell" data-testid="runs-empty">
                  No runs recorded for this definition yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </DetailDrawer>

    <DetailDrawer
      :open="snapshotOpen"
      title="Volume snapshot detail"
      eyebrow="Snapshot"
      wide
      @close="closeSnapshot"
    >
      <div data-testid="snapshot-panel">
        <p v-if="snapshotLoading" class="chart-empty" data-testid="snapshot-loading">Loading…</p>
        <p v-else-if="snapshotError" class="chart-empty" role="alert" data-testid="snapshot-error">
          {{ snapshotError }}
        </p>
        <template v-else-if="snapshotDetail">
          <h3>Snapshot</h3>
          <pre class="json-block" data-testid="snapshot-summary">{{
            prettyJson(snapshotDetail.snapshot)
          }}</pre>
          <h3>Related breakdown</h3>
          <ul class="sample-list" data-testid="snapshot-related">
            <li v-for="(item, index) in snapshotRelated" :key="index">
              {{ text(item.scope ?? item.label ?? item.smsc ?? item.route ?? item.type) }} —
              {{
                text(item.message_count ?? item.messageCount ?? item.messages ?? item.total, '0')
              }}
              messages
              <small>{{ text(item.dlr_count ?? item.dlrCount ?? item.dlrs, '') }}</small>
            </li>
            <li v-if="!snapshotRelated.length">No related breakdown for this period.</li>
          </ul>
        </template>
      </div>
    </DetailDrawer>
  </div>
</template>

<style src="./workspace-extras.css"></style>

<style scoped>
/*
  The page is a stack of sections, and none of them carried a bottom margin: the
  three `.dashboard-grid` rows (traffic trend / by SMSC / success rate, and their
  right-hand column) ran straight into each other and into the heatmap below.
  One gap on the stack gives every seam the same 16px the grids use internally.
*/
.analytics-page {
  display: grid;
  /* minmax(0,1fr), not the implicit `auto`: an auto column is sized by its
     widest content, which a wide report table would push past the viewport. */
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
/* These already spaced themselves; their margin would double up against the gap.
   The latency percentile cards keep theirs — a chart follows them inside the
   same panel, and that seam is not the stack's to space. */
.analytics-page > .dashboard-actions,
.analytics-page [data-testid='overview-cards'] {
  margin-bottom: 0;
}
.heatmap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-x: auto;
}
.heatmap-row {
  display: flex;
  align-items: center;
  gap: 3px;
}
.heatmap-daylabel {
  flex: 0 0 34px;
  font-size: 0.7rem;
  color: var(--muted, #64748b);
  text-align: right;
  padding-right: 4px;
}
.heatmap-hourlabel {
  flex: 1 1 0;
  min-width: 14px;
  font-size: 0.62rem;
  color: var(--muted, #64748b);
  text-align: center;
}
.heatmap-cell {
  flex: 1 1 0;
  min-width: 14px;
  height: 18px;
  border-radius: 3px;
  background: var(--brand, #2563eb);
}
.heatmap .source-note {
  margin-top: 6px;
}
</style>
