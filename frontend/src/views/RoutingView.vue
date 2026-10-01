<script setup lang="ts">
/**
 * ROUTING / ADVANCED ROUTING — rebuilt to the 2026-10 design.
 *
 * See `docs/handbook/CONSOLE_DESIGN_SPEC.md` and the source pages
 * `Kamex Routing.dc.html` / `Kamex Advanced Routing.dc.html`.
 *
 * ONE COMPONENT, TWO ROUTES
 * ---------------------------------------------------------------------------
 * The two screens showed the same routes from the same table with two column
 * sets, and the design keeps them as separate pages while making them
 * obviously the same screen. So this is one component with an `advanced` flag
 * off the route meta: Routing shows Load and hides operator/rotation behind a
 * link; Advanced shows weighted targets, the time window and the cost, with
 * operator and rotation always visible. Writing it twice would have meant two
 * route tables to keep in step, which is how they drifted apart in the first
 * place.
 *
 * THE TESTER IS LIVE, AND IT IS NOT A SIMULATION
 * ---------------------------------------------------------------------------
 * `POST /routing/resolve` is a preview: nothing is sent and no rotation
 * counter moves. It now returns a verdict per route — selected, outranked, or
 * no match and why — produced inside the engine's own matcher. That is the
 * whole reason this panel can be trusted: the alternative was to recompute
 * the match rules in the browser, and a second implementation of routing is
 * a second thing that can disagree with where messages actually go.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';
import DetailDrawer from '../components/DetailDrawer.vue';
import DataState from '../components/DataState.vue';
import { agoWhen, shortWhen } from '../utils/when';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'live' | 'error' | 'empty' | 'permission-denied';

interface RouteWindow {
  start?: string | null;
  end?: string | null;
  days?: number[] | null;
}
interface WeightedTarget {
  smscId?: string;
  weight?: number;
}
interface RouteRow {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  routeType: string;
  strategy: string;
  matchPrefix: string | null;
  countryCode: string | null;
  operator: string | null;
  destinationPrefix: string | null;
  sender: string | null;
  cost: number | null;
  targetSmscId: string | null;
  fallbackSmscId: string | null;
  window: RouteWindow;
  targets: WeightedTarget[];
  updatedAt: string | null;
}
interface SmscRow {
  id: string;
  name: string;
  engineId: string;
  tps: number | null;
  queued: number;
  bindState: string;
}
interface Verdict {
  routeId: string;
  name: string;
  priority: number;
  verdict: 'selected' | 'outranked' | 'no-match';
  reason: string;
}
interface Resolution {
  smscId: string | null;
  routeId: string | null;
  routeName: string | null;
  strategy: string | null;
  fallbackUsed: boolean;
  reason: string;
  candidates?: Verdict[];
}

const routeMeta = useRoute();
const advanced = computed(() => routeMeta.path.includes('advanced'));
const canManage = computed(() => canAccess(session.value, 'routes.manage'));

const rows = ref<RouteRow[]>([]);
const smscs = ref<SmscRow[]>([]);
const state = ref<LoadState>('loading');
const error = ref('');
const actionError = ref('');
const notice = ref('');

const tab = ref<'all' | 'live' | 'undeployed' | 'disabled'>('all');
const search = ref('');
const smscFilter = ref('');
const sortAsc = ref(true);

const openRoute = ref<RouteRow | null>(null);
const versions = ref<RecordValue[]>([]);
const busyId = ref('');

/* --- loading ------------------------------------------------------------- */
function toRoute(raw: RecordValue): RouteRow {
  const win = (raw.window ?? {}) as RouteWindow;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    priority: Number(raw.priority ?? 0),
    enabled: raw.enabled !== false,
    routeType: String(raw.routeType ?? raw.route_type ?? 'static'),
    strategy: String(raw.strategy ?? 'priority'),
    matchPrefix: (raw.matchPrefix ?? raw.match_prefix ?? null) as string | null,
    countryCode: (raw.countryCode ?? raw.country_code ?? null) as string | null,
    operator: (raw.operator ?? null) as string | null,
    destinationPrefix: (raw.destinationPrefix ?? raw.destination_prefix ?? null) as string | null,
    sender: (raw.sender ?? null) as string | null,
    cost: raw.cost === null || raw.cost === undefined ? null : Number(raw.cost),
    targetSmscId: (raw.targetSmscId ?? raw.target_smsc_id ?? null) as string | null,
    fallbackSmscId: (raw.fallbackSmscId ?? raw.fallback_smsc_id ?? null) as string | null,
    window: win && typeof win === 'object' ? win : {},
    targets: Array.isArray(raw.targets) ? (raw.targets as WeightedTarget[]) : [],
    updatedAt: (raw.updatedAt ?? raw.updated_at ?? null) as string | null,
  };
}

async function load() {
  state.value = 'loading';
  error.value = '';
  try {
    const [routePayload, smscPayload] = await Promise.all([
      apiRequest<{ items?: RecordValue[] }>('/routing/routes?limit=200&offset=0'),
      apiRequest<{ items?: RecordValue[] }>('/smscs?limit=500&offset=0').catch(() => ({
        items: [],
      })),
    ]);
    rows.value = (routePayload?.items ?? []).map(toRoute);
    smscs.value = (smscPayload?.items ?? []).map((raw) => ({
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      engineId: String(raw.engine_id ?? raw.engineId ?? ''),
      tps: raw.tps === null || raw.tps === undefined ? null : Number(raw.tps),
      queued: Number(raw.queued_count ?? raw.queuedCount ?? 0) || 0,
      bindState: String(raw.bind_state ?? raw.bindState ?? 'unknown'),
    }));
    state.value = rows.value.length ? 'live' : 'empty';
  } catch (reason) {
    rows.value = [];
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
    error.value = reason instanceof Error ? reason.message : 'Routes could not be loaded.';
  }
}

/* --- lookups ------------------------------------------------------------- */
function smscOf(id: string | null): SmscRow | null {
  return id ? (smscs.value.find((entry) => entry.id === id) ?? null) : null;
}
function smscName(id: string | null): string {
  const found = smscOf(id);
  return found ? found.name : id ? 'unknown SMSC' : '';
}

/**
 * `25670*|25671*|25672*|25674*|25675*…` → `25670–2*, 25674–5*`.
 *
 * A wildcard list of nine alternatives is one idea written nine times, and at
 * full length it was the widest thing in the table. Consecutive prefixes
 * collapse to a range; anything that is not a simple run is left exactly as
 * written, because a pattern an operator cannot recognise is worse than a
 * long one.
 */
function shortenPattern(pattern: string): string {
  const parts = pattern
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return pattern;
  const stems = parts.map((p) => p.replace(/\*$/, ''));
  const width = stems[0].length;
  if (!stems.every((stem) => stem.length === width && /^\d+$/.test(stem))) return pattern;
  const head = stems[0].slice(0, width - 1);
  if (!stems.every((stem) => stem.slice(0, width - 1) === head)) return pattern;

  const digits = stems.map((stem) => Number(stem.slice(-1))).sort((a, b) => a - b);
  const runs: string[] = [];
  let from = digits[0];
  let prev = digits[0];
  for (const digit of digits.slice(1).concat(Number.NaN)) {
    if (digit === prev + 1) {
      prev = digit;
      continue;
    }
    runs.push(from === prev ? `${head}${from}*` : `${head}${from}–${prev}*`);
    from = digit;
    prev = digit;
  }
  return runs.join(', ');
}

function matchesText(row: RouteRow): string {
  if (row.routeType === 'wildcard') {
    return shortenPattern(row.matchPrefix ?? row.destinationPrefix ?? '');
  }
  if (row.routeType === 'country') return row.countryCode ? `+${row.countryCode}` : 'any country';
  if (row.routeType === 'operator') return row.operator ?? 'any operator';
  const prefix = row.matchPrefix ?? row.destinationPrefix ?? '';
  return prefix ? `+${prefix.replace(/^\+/, '')}` : 'every destination';
}

function windowText(row: RouteRow): string {
  const { start, end, days } = row.window ?? {};
  if (!start && !end) return 'Always';
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const list = Array.isArray(days) && days.length ? days.map((d) => DAY[d] ?? d).join(' ') : '';
  return `${start ?? '00:00'}–${end ?? '24:00'}${list ? ` ${list}` : ''}`;
}

/** Live, or the reason it is not. A disabled route is not "not deployed". */
function statusOf(row: RouteRow): { word: string; tone: string } {
  if (!row.enabled) return { word: 'Disabled', tone: '' };
  if (!row.targetSmscId) return { word: 'No target', tone: 'warn' };
  return { word: 'Live', tone: 'good' };
}

/* --- summary strip ------------------------------------------------------- */
/**
 * Derived from the full route list, which this screen loads in one page of
 * 200 — so unlike a paginated register these counts are the whole table and
 * are honest. If routes ever outgrow that, these move to an endpoint rather
 * than quietly becoming per-page figures.
 */
const liveCount = computed(() => rows.value.filter((r) => statusOf(r).word === 'Live').length);
const withFallback = computed(() => rows.value.filter((r) => Boolean(r.fallbackSmscId)).length);
const noTarget = computed(() => rows.value.filter((r) => r.enabled && !r.targetSmscId).length);
const throughput = computed(() => {
  // Queue depth across the SMSCs these routes point at. Named for what it is;
  // the engine publishes no per-route rate, and inventing one would be worse
  // than showing the figure we do have.
  const ids = new Set(rows.value.map((r) => r.targetSmscId).filter(Boolean) as string[]);
  return [...ids].reduce((sum, id) => sum + (smscOf(id)?.queued ?? 0), 0);
});

/* --- filtering ----------------------------------------------------------- */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'undeployed', label: 'No target' },
  { id: 'disabled', label: 'Disabled' },
] as const;

function inTab(row: RouteRow, which: string): boolean {
  const status = statusOf(row).word;
  if (which === 'live') return status === 'Live';
  if (which === 'undeployed') return status === 'No target';
  if (which === 'disabled') return status === 'Disabled';
  return true;
}
function tabCount(which: string): number {
  return rows.value.filter((row) => inTab(row, which)).length;
}

const visible = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return rows.value
    .filter((row) => {
      if (!inTab(row, tab.value)) return false;
      if (smscFilter.value && row.targetSmscId !== smscFilter.value) return false;
      if (
        needle &&
        !`${row.name} ${matchesText(row)} ${row.sender ?? ''}`.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => (sortAsc.value ? a.priority - b.priority : b.priority - a.priority));
});

/* --- the live tester ----------------------------------------------------- */
const destination = ref('+256700000000');
const sender = ref('');
const operator = ref('');
const rotation = ref(0);
const showOperator = ref(false);
const resolution = ref<Resolution | null>(null);
const resolveError = ref('');

let resolveTimer: ReturnType<typeof setTimeout> | undefined;
async function resolveNow() {
  if (!destination.value.trim()) {
    resolution.value = null;
    return;
  }
  try {
    resolution.value =
      (await apiRequest<Resolution>('/routing/resolve', {
        method: 'POST',
        body: JSON.stringify({
          msisdn: destination.value.trim(),
          sender: sender.value.trim() || undefined,
          operator: operator.value.trim() || undefined,
          rotation: rotation.value || undefined,
        }),
      })) ?? null;
    resolveError.value = '';
  } catch (reason) {
    resolution.value = null;
    resolveError.value =
      reason instanceof Error ? reason.message : 'The destination could not be resolved.';
  }
}
/* Debounced, because it fires on every keystroke by design. */
watch([destination, sender, operator, rotation], () => {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(resolveNow, 300);
});

const resolvedRoute = computed(() =>
  resolution.value?.routeId ? rows.value.find((r) => r.id === resolution.value?.routeId) : null,
);

/* --- the detail panel ---------------------------------------------------- */
async function openDetail(row: RouteRow) {
  openRoute.value = row;
  versions.value = [];
  try {
    const payload = await apiRequest<{ items?: RecordValue[] } | RecordValue[]>(
      `/routing/routes/${row.id}/versions`,
    );
    versions.value = Array.isArray(payload) ? payload : (payload?.items ?? []);
  } catch {
    // History is context, not the point of the panel. A route with no version
    // table yet must still open.
    versions.value = [];
  }
}

async function runAction(row: RouteRow, action: 'validate' | 'archive') {
  if (!canManage.value) return;
  busyId.value = row.id;
  actionError.value = '';
  try {
    if (action === 'validate') {
      await apiRequest(`/routes/${row.id}/validate`, { method: 'POST', body: '{}' });
      notice.value = `${row.name} validated.`;
    } else {
      await apiRequest(`/routing/routes/${row.id}`, { method: 'DELETE' });
      notice.value = `${row.name} archived.`;
      openRoute.value = null;
      await load();
    }
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : 'The action failed.';
  } finally {
    busyId.value = '';
  }
}

onMounted(async () => {
  await load();
  await resolveNow();
});
onBeforeUnmount(() => clearTimeout(resolveTimer));

/* --- the route editor ---------------------------------------------------
 *
 * A SIDE PANEL IN FOUR STEPS, NOT A CENTRE DIALOG.
 *
 * The old Create route was a 620px dialog with Name, Target SMSC,
 * Destination prefix, Sender ID and Fallback laid out in two uneven columns,
 * and a sentence of policy text at the bottom. Edit was the same shape plus
 * seven stacked day checkboxes. Neither said what a route would DO once
 * saved, neither warned about a priority already in use, and the Create
 * button sat disabled without saying what was missing.
 *
 * The four steps are the four decisions: what the route is, which messages it
 * takes, where they go, and when it applies. Numbered because they genuinely
 * are a sequence — you cannot sensibly choose a fallback before a primary.
 */
interface RouteDraft {
  id: string | null;
  name: string;
  priority: number;
  enabled: boolean;
  matchKind: 'prefix' | 'patterns';
  destinationPrefix: string;
  sender: string;
  targetSmscId: string;
  fallbackSmscId: string;
  strategy: 'priority' | 'weighted' | 'round-robin';
  cost: string;
  applies: 'always' | 'window';
  windowStart: string;
  windowEnd: string;
  days: number[];
  changeReason: string;
}

const editorOpen = ref(false);
const draft = ref<RouteDraft>(blankDraft());
const saving = ref(false);

function blankDraft(): RouteDraft {
  return {
    id: null,
    name: '',
    // One past the highest in use, so the default does not collide.
    priority: 10,
    enabled: true,
    matchKind: 'prefix',
    destinationPrefix: '',
    sender: '',
    targetSmscId: '',
    fallbackSmscId: '',
    strategy: 'priority',
    cost: '',
    applies: 'always',
    windowStart: '',
    windowEnd: '',
    days: [],
    changeReason: '',
  };
}

const prioritiesInUse = computed(() =>
  rows.value
    .filter((row) => row.id !== draft.value.id)
    .map((row) => row.priority)
    .sort((a, b) => a - b),
);
const priorityTaken = computed(() => prioritiesInUse.value.includes(draft.value.priority));

const STRATEGIES = ['priority', 'weighted', 'round-robin'] as const;
const STRATEGY_LABEL: Record<string, string> = {
  priority: 'Priority',
  weighted: 'Weighted',
  'round-robin': 'Round-robin',
};
/** Everything except the primary: a route cannot fall back to itself. */
const fallbackChoices = computed(() =>
  smscs.value.filter((entry) => entry.id !== draft.value.targetSmscId),
);

const STRATEGY_NOTE: Record<string, string> = {
  priority: 'Always the primary; the fallback is used only on failure.',
  weighted: 'Messages are split between targets by weight.',
  'round-robin': 'Each message goes to the next target in turn.',
};

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];
function toggleDay(value: number) {
  const next = new Set(draft.value.days);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  draft.value.days = [...next].sort();
}

/**
 * What is still missing, named.
 *
 * A disabled Save with no explanation makes the operator hunt for the field
 * they have not filled. The button says it instead.
 */
const missing = computed(() => {
  const gaps: string[] = [];
  if (!draft.value.name.trim()) gaps.push('a name');
  if (!draft.value.targetSmscId) gaps.push('a primary SMSC');
  if (draft.value.applies === 'window' && !draft.value.windowStart && !draft.value.windowEnd) {
    gaps.push('a time window');
  }
  if (draft.value.id && !draft.value.changeReason.trim()) gaps.push('a change reason');
  return gaps;
});

/** A sentence describing what this route will do, from the draft itself. */
const draftSentence = computed(() => {
  const d = draft.value;
  const target = smscName(d.targetSmscId) || 'an SMSC you have not chosen yet';
  const match = d.destinationPrefix.trim()
    ? `destinations starting +${d.destinationPrefix.replace(/^\+/, '')}`
    : 'every destination';
  const from = d.sender.trim() ? ` from sender ${d.sender.trim()}` : '';
  const when =
    d.applies === 'window'
      ? ` between ${d.windowStart || '00:00'} and ${d.windowEnd || '24:00'}`
      : '';
  const fallback = d.fallbackSmscId
    ? `, falling back to ${smscName(d.fallbackSmscId)}`
    : ', and queue on that SMSC if it fails';
  return `Send ${match}${from}${when} via ${target}${fallback}.`;
});

function openEditor(row?: RouteRow) {
  if (row) {
    draft.value = {
      id: row.id,
      name: row.name,
      priority: row.priority,
      enabled: row.enabled,
      matchKind: row.routeType === 'wildcard' ? 'patterns' : 'prefix',
      destinationPrefix: row.matchPrefix ?? row.destinationPrefix ?? '',
      sender: row.sender ?? '',
      targetSmscId: row.targetSmscId ?? '',
      fallbackSmscId: row.fallbackSmscId ?? '',
      strategy: (row.strategy as RouteDraft['strategy']) ?? 'priority',
      cost: row.cost === null ? '' : String(row.cost),
      applies: row.window?.start || row.window?.end ? 'window' : 'always',
      windowStart: row.window?.start ?? '',
      windowEnd: row.window?.end ?? '',
      days: Array.isArray(row.window?.days) ? [...(row.window?.days ?? [])] : [],
      changeReason: '',
    };
  } else {
    const next = blankDraft();
    const highest = rows.value.reduce((max, row) => Math.max(max, row.priority), 0);
    next.priority = highest + 10;
    draft.value = next;
  }
  openRoute.value = null;
  editorOpen.value = true;
}

async function saveDraft() {
  if (missing.value.length || saving.value) return;
  saving.value = true;
  actionError.value = '';
  const d = draft.value;
  const body: RecordValue = {
    name: d.name.trim(),
    priority: d.priority,
    enabled: d.enabled,
    routeType: d.matchKind === 'patterns' ? 'wildcard' : 'prefix',
    strategy: d.strategy,
    matchPrefix: d.destinationPrefix.trim() || null,
    sender: d.sender.trim() || null,
    targetSmscId: d.targetSmscId,
    fallbackSmscId: d.fallbackSmscId || null,
    cost: d.cost.trim() ? Number(d.cost) : null,
    window:
      d.applies === 'window'
        ? {
            start: d.windowStart || null,
            end: d.windowEnd || null,
            days: d.days.length ? d.days : null,
          }
        : { start: null, end: null, days: null },
  };
  if (d.id) body.changeReason = d.changeReason.trim();
  try {
    if (d.id) {
      await apiRequest(`/routing/routes/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      notice.value = `${body.name} saved as a new version. Deploy it to go live.`;
    } else {
      await apiRequest('/routing/routes', { method: 'POST', body: JSON.stringify(body) });
      notice.value = `${body.name} created and dry-run. Deploy it to go live.`;
    }
    editorOpen.value = false;
    await load();
    await resolveNow();
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : 'The route could not be saved.';
  } finally {
    saving.value = false;
  }
}

defineExpose({ shortenPattern });
</script>

<template>
  <div data-testid="routing-view">
    <header class="screen-head">
      <div class="screen-actions">
        <RouterLink
          v-if="!advanced"
          class="secondary-button"
          to="/routing-advanced"
          data-testid="routing-advanced-link"
        >
          Advanced routing
        </RouterLink>
        <RouterLink v-else class="secondary-button" to="/routing" data-testid="routing-basic-link">
          Routing
        </RouterLink>
        <button
          v-if="canManage"
          class="primary-button"
          type="button"
          data-testid="routing-new"
          @click="openEditor()"
        >
          New route
        </button>
      </div>
    </header>

    <!-- SUMMARY STRIP ----------------------------------------------------- -->
    <section class="stat-strip" data-testid="routing-summary">
      <article>
        <p class="stat-label">Live routes</p>
        <b class="stat-figure">{{ liveCount }} of {{ rows.length }}</b>
        <p class="stat-caption">Enabled, with a target</p>
      </article>
      <article>
        <p class="stat-label">With a fallback</p>
        <!-- Amber when any route has none: a route with no fallback queues
             its messages when its SMSC goes down rather than re-routing. -->
        <b class="stat-figure" :class="{ 'is-warn': withFallback < rows.length }">
          {{ withFallback }} of {{ rows.length }}
        </b>
        <p class="stat-caption">{{ rows.length - withFallback }} would queue on failure</p>
      </article>
      <article>
        <p class="stat-label">Awaiting a target</p>
        <b class="stat-figure">{{ noTarget }}</b>
        <p class="stat-caption">Enabled but pointing nowhere</p>
      </article>
      <article>
        <p class="stat-label">Queued now</p>
        <b class="stat-figure">{{ throughput }}</b>
        <p class="stat-caption">Across every targeted SMSC</p>
      </article>
    </section>

    <!-- TESTER ------------------------------------------------------------ -->
    <section class="panel tester" data-testid="routing-tester">
      <div class="tester-input">
        <h2>{{ advanced ? 'Resolve preview' : 'Test a destination' }}</h2>
        <p class="source-note">
          Updates as you type. Preview only: nothing is sent and no counter moves.
        </p>
        <div class="field-grid">
          <label>
            <span>Destination MSISDN</span>
            <input v-model="destination" data-testid="tester-msisdn" placeholder="+256700000000" />
          </label>
          <label>
            <span>Sender ID</span>
            <input v-model="sender" data-testid="tester-sender" placeholder="Any sender" />
          </label>
        </div>
        <!--
          Operator and rotation are always out on Advanced and behind a link
          on Routing: they only matter to a weighted or operator route, and on
          the basic screen two extra inputs would be two more things to read
          past to reach the answer.
        -->
        <button
          v-if="!advanced"
          class="text-link disclosure"
          type="button"
          data-testid="tester-more"
          @click="showOperator = !showOperator"
        >
          {{ showOperator ? 'Hide operator & rotation' : 'Operator & rotation…' }}
        </button>
        <div v-if="advanced || showOperator" class="field-grid">
          <label>
            <span>Operator</span>
            <input v-model="operator" data-testid="tester-operator" placeholder="Any" />
          </label>
          <label>
            <span>Rotation</span>
            <input v-model.number="rotation" type="number" min="0" data-testid="tester-rotation" />
          </label>
        </div>
        <p v-if="advanced || showOperator" class="source-note">
          Rotation is the round-robin counter. Increase it to see which target a weighted route
          picks next.
        </p>
      </div>

      <div class="tester-result">
        <p class="result-eyebrow">Result</p>
        <template v-if="resolveError">
          <p class="form-alert is-error" role="alert">{{ resolveError }}</p>
        </template>
        <template v-else-if="resolution">
          <h3 v-if="resolution.smscId">Sent via {{ smscName(resolution.smscId) }}</h3>
          <h3 v-else class="is-unrouted">Not routed</h3>
          <p class="result-route">
            <template v-if="resolution.routeName">
              Route {{ resolution.routeName }} · priority {{ resolvedRoute?.priority ?? '—' }} ·
              {{ resolution.strategy }}
            </template>
            <template v-else>{{ resolution.reason }}</template>
          </p>

          <!-- The failover answer, stated rather than implied. -->
          <div v-if="resolution.smscId" class="failover-row">
            <span class="pill">{{ smscName(resolution.smscId) }} · primary</span>
            <span class="failover-arrow">if it fails →</span>
            <span v-if="resolvedRoute?.fallbackSmscId" class="pill is-ok">
              {{ smscName(resolvedRoute.fallbackSmscId) }}
            </span>
            <span v-else class="pill is-warn">No fallback, messages queue</span>
          </div>

          <!--
            Every route, in priority order, with the engine's own reason. This
            is the part that makes the panel worth trusting: the reasons come
            from `selectRoute`, not from the browser re-deciding what matches.
          -->
          <ul v-if="resolution.candidates?.length" class="verdicts" data-testid="tester-verdicts">
            <li v-for="candidate in resolution.candidates" :key="candidate.routeId">
              <span class="verdict-priority mono">{{ candidate.priority }}</span>
              <span class="verdict-body">
                <strong>{{ candidate.name }}</strong>
                <span>{{ candidate.reason }}</span>
              </span>
              <span
                class="pill"
                :class="{
                  'is-ok': candidate.verdict === 'selected',
                  'is-muted': candidate.verdict !== 'selected',
                }"
              >
                {{
                  candidate.verdict === 'selected'
                    ? 'Selected'
                    : candidate.verdict === 'outranked'
                      ? 'Outranked'
                      : 'No match'
                }}
              </span>
            </li>
          </ul>
        </template>
        <p v-else class="source-note">Enter a destination to see which SMSC would carry it.</p>
      </div>
    </section>

    <p v-if="notice" class="notice" role="status" data-testid="routing-notice">{{ notice }}</p>
    <p v-if="actionError" class="form-alert is-error" role="alert" data-testid="routing-error">
      {{ actionError }}
    </p>

    <!-- ROUTE TABLE ------------------------------------------------------- -->
    <section class="panel routing-panel">
      <div class="tab-bar">
        <div class="tab-row" role="group" aria-label="Route status">
          <button
            v-for="entry in TABS"
            :key="entry.id"
            type="button"
            class="tab"
            :class="{ 'is-active': tab === entry.id }"
            :data-testid="`routing-tab-${entry.id}`"
            @click="tab = entry.id"
          >
            {{ entry.label }} <span class="tab-count">{{ tabCount(entry.id) }}</span>
          </button>
        </div>
        <!--
          `filters`, which is what it is: two independent switches over the
          view, not two fields of one record. The layout audit excludes that
          class from its inline-label rule for exactly this reason, and the
          design shows these with no visible caption at all.
        -->
        <div class="tab-filters filters">
          <label class="filter-search">
            <span class="sr-only">Search routes</span>
            <input
              v-model="search"
              type="search"
              placeholder="Name, prefix, sender"
              data-testid="routing-search"
            />
          </label>
          <label class="filter-select">
            <span class="sr-only">Target SMSC</span>
            <select v-model="smscFilter" data-testid="routing-smsc-filter">
              <option value="">All SMSCs</option>
              <option v-for="smsc in smscs" :key="smsc.id" :value="smsc.id">{{ smsc.name }}</option>
            </select>
          </label>
        </div>
      </div>

      <DataState
        :state="state"
        subject="routes"
        skeleton="table"
        :skeleton-rows="4"
        :detail="state === 'error' ? error : undefined"
        permission="routes.view"
        testid="routing-state"
        :on-retry="load"
      >
        <div class="table-wrap">
          <table data-testid="routing-table">
            <thead>
              <tr>
                <!-- Sortable by click, as the design shows; priority is the
                     only order that means anything on this table. -->
                <th scope="col">
                  <button
                    class="sort-head"
                    type="button"
                    data-testid="routing-sort"
                    @click="sortAsc = !sortAsc"
                  >
                    Priority {{ sortAsc ? '↑' : '↓' }} · Route
                  </button>
                </th>
                <th scope="col">Matches</th>
                <th scope="col">Target → fallback</th>
                <th v-if="advanced" scope="col">Weighted targets</th>
                <th v-if="advanced" scope="col">Window · cost</th>
                <th v-else scope="col">Load</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in visible"
                :key="row.id"
                class="selectable"
                :data-testid="`route-row-${row.id}`"
                tabindex="0"
                @click="openDetail(row)"
                @keydown.enter="openDetail(row)"
              >
                <td>
                  <span class="route-identity">
                    <span class="route-priority mono">{{ row.priority }}</span>
                    <span>
                      <strong>{{ row.name }}</strong>
                      <small class="row-id">{{ row.routeType }} · {{ row.strategy }}</small>
                    </span>
                  </span>
                </td>
                <td>
                  <span class="mono">{{ matchesText(row) }}</span>
                  <small v-if="row.sender" class="row-id">sender {{ row.sender }}</small>
                </td>
                <td>
                  <strong>{{ smscName(row.targetSmscId) || '—' }}</strong>
                  <small v-if="row.fallbackSmscId" class="row-id"
                    >→ {{ smscName(row.fallbackSmscId) }}</small
                  >
                  <small v-else class="row-id is-warn-text">No fallback</small>
                </td>
                <td v-if="advanced">
                  <template v-if="row.targets.length">
                    <span class="split-bar" aria-hidden="true">
                      <span
                        v-for="(target, index) in row.targets"
                        :key="index"
                        :style="{
                          flex: String(target.weight ?? 1),
                        }"
                      ></span>
                    </span>
                    <small class="row-id">{{ row.targets.length }} weighted</small>
                  </template>
                  <small v-else class="row-id">— priority only</small>
                </td>
                <td v-if="advanced">
                  <span>{{ windowText(row) }}</span>
                  <small class="row-id mono">{{
                    row.cost === null ? 'no cost set' : `${row.cost} / msg`
                  }}</small>
                </td>
                <td v-else>
                  <span class="mono"
                    >{{ smscOf(row.targetSmscId)?.queued ?? 0 }} /
                    {{ smscOf(row.targetSmscId)?.tps ?? '—' }}/s</span
                  >
                  <span class="load-bar" aria-hidden="true">
                    <span
                      :style="{
                        width:
                          Math.min(
                            100,
                            ((smscOf(row.targetSmscId)?.queued ?? 0) /
                              Math.max(1, smscOf(row.targetSmscId)?.tps ?? 1)) *
                              100,
                          ) + '%',
                      }"
                    ></span>
                  </span>
                </td>
                <td>
                  <span class="status-badge" :class="statusOf(row).tone">{{
                    statusOf(row).word
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <footer class="table-foot">
        <span class="foot-count">{{ visible.length }} of {{ rows.length }} routes</span>
        <p class="foot-help">Click a route for its failover chain, version history and actions.</p>
      </footer>
    </section>

    <!-- ROUTE DETAIL PANEL ------------------------------------------------ -->
    <DetailDrawer
      :open="Boolean(openRoute)"
      :eyebrow="openRoute ? `priority ${openRoute.priority}` : ''"
      :title="openRoute?.name ?? 'Route'"
      @close="openRoute = null"
    >
      <template v-if="openRoute">
        <div class="panel-actions">
          <button
            v-if="canManage"
            class="primary-button"
            type="button"
            data-testid="route-edit"
            @click="openEditor(openRoute)"
          >
            Edit
          </button>
          <button
            v-if="canManage"
            class="secondary-button"
            type="button"
            :disabled="busyId === openRoute.id"
            data-testid="route-validate"
            @click="runAction(openRoute, 'validate')"
          >
            Validate
          </button>
          <button
            v-if="canManage"
            class="secondary-button danger-button"
            type="button"
            :disabled="busyId === openRoute.id"
            data-testid="route-archive"
            @click="runAction(openRoute, 'archive')"
          >
            Archive
          </button>
        </div>

        <!-- WHAT HAPPENS IF THE TARGET FAILS, as a chain rather than a field. -->
        <section class="panel-block">
          <h3>If the target fails</h3>
          <div class="chain">
            <span class="pill">{{ smscName(openRoute.targetSmscId) || 'no target' }}</span>
            <span class="failover-arrow">→</span>
            <span v-if="openRoute.fallbackSmscId" class="pill is-ok">{{
              smscName(openRoute.fallbackSmscId)
            }}</span>
            <span v-else class="pill is-warn">Messages queue on the primary</span>
          </div>
        </section>

        <dl class="panel-fields">
          <dt>Matches</dt>
          <dd class="mono">{{ matchesText(openRoute) }}</dd>
          <dt>Sender</dt>
          <dd>{{ openRoute.sender ?? 'any sender' }}</dd>
          <dt>Type</dt>
          <dd>{{ openRoute.routeType }}</dd>
          <dt>Strategy</dt>
          <dd>{{ openRoute.strategy }}</dd>
          <dt>Window</dt>
          <dd>{{ windowText(openRoute) }}</dd>
          <dt>Cost</dt>
          <dd class="mono">
            {{ openRoute.cost === null ? 'no cost set' : `${openRoute.cost} / msg` }}
          </dd>
          <dt>Updated</dt>
          <dd>{{ agoWhen(openRoute.updatedAt) || '—' }}</dd>
          <dt>Route id</dt>
          <dd class="mono">{{ openRoute.id }}</dd>
        </dl>

        <section class="panel-block">
          <h3>Version history</h3>
          <ol v-if="versions.length" class="version-list">
            <li v-for="(version, index) in versions" :key="index">
              <span class="mono">v{{ version.version ?? index + 1 }}</span>
              <span>{{ shortWhen(version.createdAt ?? version.created_at) || '—' }}</span>
              <small class="row-id">{{
                version.changeReason ?? version.change_reason ?? 'no reason recorded'
              }}</small>
            </li>
          </ol>
          <p v-else class="source-note">No earlier versions are recorded for this route.</p>
        </section>
      </template>
    </DetailDrawer>

    <!-- ROUTE EDITOR ------------------------------------------------------
      Four numbered steps, because they genuinely are a sequence: you cannot
      sensibly choose a fallback before a primary.

      This replaces a 620px centre dialog that laid Name, Target SMSC,
      Destination prefix, Sender ID and Fallback across two uneven columns,
      never said what the route would DO once saved, never warned that a
      priority was already taken, and left Save disabled without saying why.
    -->
    <DetailDrawer
      :open="editorOpen"
      :title="draft.id ? `Edit ${draft.name}` : 'New route'"
      :subtitle="
        draft.id
          ? 'Saving creates a new version and runs a dry-run. It goes live when you deploy.'
          : 'Validated and dry-run on create. Nothing goes live until you deploy.'
      "
      wide
      @close="editorOpen = false"
    >
      <form class="editor" @submit.prevent="saveDraft">
        <fieldset class="step">
          <legend>1 &middot; Route</legend>
          <label class="stacked">
            <span>Name</span>
            <input v-model="draft.name" data-testid="editor-name" placeholder="MTN Uganda" />
          </label>
          <div class="step-row">
            <label class="stacked">
              <span>Priority</span>
              <input
                v-model.number="draft.priority"
                type="number"
                min="0"
                data-testid="editor-priority"
              />
            </label>
            <label class="toggle-field">
              <span>Enabled</span>
              <input v-model="draft.enabled" type="checkbox" data-testid="editor-enabled" />
            </label>
          </div>
          <!--
            The priorities already taken, listed. A duplicate is rejected by
            the API, and finding that out on save is finding it out too late.
          -->
          <p class="step-hint" :class="{ 'is-warn-text': priorityTaken }">
            <template v-if="priorityTaken">
              Priority {{ draft.priority }} is already in use. Lower runs first; in use:
              {{ prioritiesInUse.join(', ') || 'none' }}
            </template>
            <template v-else>
              Lower runs first. In use: {{ prioritiesInUse.join(', ') || 'none' }}
            </template>
          </p>
        </fieldset>

        <fieldset class="step">
          <legend>2 &middot; Which messages</legend>
          <div class="segmented" role="group" aria-label="Match type">
            <button
              type="button"
              :class="{ 'is-active': draft.matchKind === 'prefix' }"
              data-testid="editor-match-prefix"
              @click="draft.matchKind = 'prefix'"
            >
              Prefix
            </button>
            <button
              type="button"
              :class="{ 'is-active': draft.matchKind === 'patterns' }"
              data-testid="editor-match-patterns"
              @click="draft.matchKind = 'patterns'"
            >
              Patterns
            </button>
          </div>
          <div class="step-row">
            <label class="stacked">
              <span>{{ draft.matchKind === 'patterns' ? 'Pattern' : 'Destination prefix' }}</span>
              <input
                v-model="draft.destinationPrefix"
                data-testid="editor-prefix"
                :placeholder="draft.matchKind === 'patterns' ? '25677*|25678*' : '+256'"
              />
            </label>
            <label class="stacked">
              <span>Sender ID</span>
              <input v-model="draft.sender" data-testid="editor-sender" placeholder="Any sender" />
            </label>
          </div>
        </fieldset>

        <fieldset class="step">
          <legend>3 &middot; Where they go</legend>
          <div class="step-row">
            <label class="stacked">
              <span>Primary SMSC</span>
              <select v-model="draft.targetSmscId" data-testid="editor-target">
                <option value="">Choose SMSC</option>
                <!-- Capacity on the option, because choosing a 10/s bind for a
                     high-volume prefix is the mistake this field invites. -->
                <option v-for="smsc in smscs" :key="smsc.id" :value="smsc.id">
                  {{ smsc.name }} ({{ smsc.engineId }}) &middot; {{ smsc.tps ?? '-' }}/s
                </option>
              </select>
            </label>
            <label class="stacked">
              <span>Fallback SMSC</span>
              <select v-model="draft.fallbackSmscId" data-testid="editor-fallback">
                <option value="">None</option>
                <option v-for="smsc in fallbackChoices" :key="smsc.id" :value="smsc.id">
                  {{ smsc.name }} ({{ smsc.engineId }}) &middot; {{ smsc.tps ?? '-' }}/s
                </option>
              </select>
            </label>
          </div>
          <p
            v-if="!draft.fallbackSmscId"
            class="step-hint is-warn-text"
            data-testid="editor-no-fallback"
          >
            With no fallback, messages queue on the primary when it fails rather than re-routing.
          </p>

          <div class="segmented" role="group" aria-label="Selection strategy">
            <button
              v-for="option in STRATEGIES"
              :key="option"
              type="button"
              :class="{ 'is-active': draft.strategy === option }"
              :data-testid="`editor-strategy-${option}`"
              @click="draft.strategy = option"
            >
              {{ STRATEGY_LABEL[option] }}
            </button>
          </div>
          <p class="step-hint">{{ STRATEGY_NOTE[draft.strategy] }}</p>

          <label class="stacked narrow">
            <span>Cost per message</span>
            <input
              v-model="draft.cost"
              data-testid="editor-cost"
              placeholder="Optional, e.g. 0.012"
            />
          </label>
        </fieldset>

        <fieldset class="step">
          <legend>4 &middot; When it applies</legend>
          <div class="segmented" role="group" aria-label="When it applies">
            <button
              type="button"
              :class="{ 'is-active': draft.applies === 'always' }"
              data-testid="editor-applies-always"
              @click="draft.applies = 'always'"
            >
              Always
            </button>
            <button
              type="button"
              :class="{ 'is-active': draft.applies === 'window' }"
              data-testid="editor-applies-window"
              @click="draft.applies = 'window'"
            >
              Time window
            </button>
          </div>
          <template v-if="draft.applies === 'window'">
            <div class="step-row">
              <label class="stacked">
                <span>From</span>
                <input v-model="draft.windowStart" type="time" data-testid="editor-window-start" />
              </label>
              <label class="stacked">
                <span>Until</span>
                <input v-model="draft.windowEnd" type="time" data-testid="editor-window-end" />
              </label>
            </div>
            <!-- Days are toggle BUTTONS, not seven stacked checkboxes: it is
                 one choice made seven times, and a column of them made the
                 old dialog taller than the screen. -->
            <p class="step-label">Days</p>
            <div class="day-row" role="group" aria-label="Active days">
              <button
                v-for="day in DAYS"
                :key="day.value"
                type="button"
                :class="{ 'is-active': draft.days.includes(day.value) }"
                :data-testid="`editor-day-${day.value}`"
                @click="toggleDay(day.value)"
              >
                {{ day.label }}
              </button>
            </div>
            <p class="step-hint">No day selected means every day.</p>
          </template>
        </fieldset>

        <fieldset v-if="draft.id" class="step">
          <legend>5 &middot; Change reason</legend>
          <label class="stacked">
            <span class="sr-only">Change reason</span>
            <input
              v-model="draft.changeReason"
              data-testid="editor-reason"
              placeholder="Required. Recorded in the audit log and version history."
            />
          </label>
        </fieldset>

        <!-- What this route will actually do, in a sentence, from the draft. -->
        <p class="draft-sentence" data-testid="editor-sentence">{{ draftSentence }}</p>
      </form>

      <template #footer>
        <div class="button-row">
          <button class="secondary-button" type="button" @click="editorOpen = false">Cancel</button>
          <!-- The button names what is missing rather than sitting disabled
               and leaving the operator to hunt for the empty field. -->
          <button
            class="primary-button"
            type="button"
            :disabled="Boolean(missing.length) || saving"
            data-testid="editor-save"
            @click="saveDraft"
          >
            <template v-if="saving">Saving...</template>
            <template v-else-if="missing.length">Needs {{ missing.join(', ') }}</template>
            <template v-else>{{ draft.id ? 'Save route' : 'Create route' }}</template>
          </button>
        </div>
      </template>
    </DetailDrawer>
  </div>
</template>

<style scoped>
.screen-head {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.screen-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat-figure.is-warn {
  color: var(--warn-strong, var(--warn, #9a6700));
}

/* The tester: input on the left, the answer on the right, divided. */
.tester {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 0;
  padding: 0;
  overflow: hidden;
}
@media (max-width: 1050px) {
  .tester {
    grid-template-columns: 1fr;
  }
}
.tester-input {
  padding: 16px 20px;
}
.tester-result {
  padding: 16px 20px;
  border-left: 1px solid var(--border);
  background: var(--surface-2);
  min-width: 0;
}
@media (max-width: 1050px) {
  .tester-result {
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
.tester h2 {
  margin: 0 0 2px;
  font-size: 15px;
}
.result-eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.tester-result h3 {
  margin: 0;
  font-size: 17px;
}
.tester-result h3.is-unrouted {
  color: var(--warn-strong, var(--warn, #9a6700));
}
.result-route {
  margin: 2px 0 12px;
  color: var(--muted);
  font-size: 12.5px;
}
.disclosure {
  display: inline-block;
  padding: 0;
  margin: 6px 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
}

.failover-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.failover-arrow {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.chain {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
/* A pill keeps its text on one line and moves as a whole when it will not
   fit, rather than wrapping inside its own border. */
.pill {
  display: inline-block;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--surface);
  font-size: 12.5px;
  white-space: nowrap;
}
.pill.is-ok {
  border-color: var(--ok, #1a7f37);
  background: var(--ok-soft, #e6f4ea);
  color: var(--ok-strong, var(--ok, #1a7f37));
}
.pill.is-warn {
  border-color: var(--warn, #9a6700);
  background: var(--warn-soft, #fbf0d8);
  color: var(--warn-strong, var(--warn, #9a6700));
}
.pill.is-muted {
  color: var(--muted);
}

.verdicts {
  list-style: none;
  margin: 0;
  padding: 0;
}
.verdicts li {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.verdicts li:last-child {
  border-bottom: none;
}
.verdict-priority {
  color: var(--muted);
  font-size: 12px;
}
.verdict-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.verdict-body strong {
  font-size: 13px;
}
.verdict-body span {
  color: var(--muted);
  font-size: 12px;
}

.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.tab-row {
  display: flex;
  gap: 2px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 13px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}
.tab.is-active {
  color: var(--text-strong);
  border-bottom-color: var(--brand);
  font-weight: 500;
}
.tab-count {
  padding: 1px 7px;
  border-radius: 20px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.tab.is-active .tab-count {
  background: var(--brand-soft);
  color: var(--brand);
}
/* Search and the SMSC filter drop to their own line rather than squeezing
   the tabs until one of them clips. */
.tab-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 6px;
}
.filter-search input {
  min-width: 180px;
}

.sort-head {
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;
}
.route-identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.route-priority {
  color: var(--muted);
  font-size: 12.5px;
}
.load-bar {
  display: block;
  height: 3px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}
.load-bar > span {
  display: block;
  height: 100%;
  background: var(--brand);
}
.split-bar {
  display: flex;
  height: 5px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-2);
}
.split-bar > span {
  background: var(--brand);
  border-right: 1px solid var(--surface);
}

.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.foot-count,
.foot-help {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.panel-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
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
.panel-fields {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  row-gap: 10px;
  column-gap: 12px;
  margin: 0 0 20px;
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
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12.5px;
}
.version-list li {
  display: grid;
  grid-template-columns: 50px 1fr;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
.version-list li .row-id {
  grid-column: 2;
}
</style>
<style src="./workspace-extras.css"></style>
