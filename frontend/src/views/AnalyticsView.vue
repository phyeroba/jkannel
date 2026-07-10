<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

const lastRefreshed = ref('Not yet');

async function refreshAll() {
  await Promise.all([
    loadOverview(),
    loadTrend(),
    loadBreakdown(),
    loadGrouping('/reports/analytics/per-smsc', perSmsc),
    loadGrouping('/reports/analytics/per-route', perRoute),
    loadCatalog(),
    loadVolume(),
  ]);
  lastRefreshed.value = new Date().toLocaleTimeString();
}

onMounted(() => void refreshAll());
</script>

<template>
  <div data-testid="analytics-view">
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
        <div v-else class="breakdown" data-testid="breakdown">
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
            <tr v-for="row in volumeRows" :key="text(row.id)">
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
    </section>
  </div>
</template>
