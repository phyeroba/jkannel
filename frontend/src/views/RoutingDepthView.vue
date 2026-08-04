<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

interface Option {
  value: string;
  label: string;
}
interface TargetDraft {
  smscId: string;
  weight: number;
  cost: string;
  enabled: boolean;
}
interface ResolveResult {
  msisdn?: string;
  smscId?: string | null;
  routeId?: string | null;
  routeName?: string | null;
  strategy?: string | null;
  fallbackUsed?: boolean;
  reason?: string;
  trace?: string[];
  candidatesConsidered?: number;
}

/** Mirrors ROUTE_TYPES / STRATEGIES in routing-depth.controller.ts. */
const ROUTE_TYPES = ['static', 'prefix', 'country', 'operator', 'weighted'];
const STRATEGIES = ['priority', 'least-cost', 'load-balance', 'round-robin', 'time-based'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SORT_FIELDS = ['priority', 'name', 'routeType', 'strategy', 'createdAt'];
const PAGE_SIZE = 25;

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}
function prettyJson(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2);
  } catch {
    return String(value);
  }
}

// Reads are routes.view (the route guard); mutations are routes.manage.
const canManage = computed(() => canAccess(session.value, 'routes.manage'));

// --- SMSC options (targetSmscId / fallbackSmscId are SMSC UUIDs) -------------
const smscOptions = ref<Option[]>([]);
const smscOptionsError = ref('');
const smscNames = computed(() => {
  const names = new Map<string, string>();
  for (const option of smscOptions.value) names.set(option.value, option.label);
  return names;
});
function smscLabel(id: unknown): string {
  const key = text(id, '');
  if (!key || key === '—') return '—';
  return smscNames.value.get(key) ?? key;
}

async function loadSmscOptions() {
  smscOptionsError.value = '';
  try {
    smscOptions.value = asItems(await apiRequest<unknown>('/smscs?limit=500&offset=0'))
      .map((row) => ({
        value: text(row.id, ''),
        label: `${text(row.name)} (${text(row.engine_id ?? row.engineId)})`,
      }))
      .filter((option) => option.value && option.value !== '—');
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value = messageFrom(reason, 'SMSC connections could not be loaded.');
  }
}

// --- Route grid --------------------------------------------------------------
const routes = ref<RecordValue[]>([]);
const routeState = ref<LoadState>('loading');
const routeError = ref('');
const routeMissing = ref(false);
const notice = ref('');
const total = ref(0);
const offset = ref(0);
const search = ref('');
const filterType = ref('');
const filterStrategy = ref('');
const filterEnabled = ref('');
const sortField = ref('priority');
const sortDirection = ref<'asc' | 'desc'>('asc');
const busy = ref(false);

const rangeLabel = computed(() => {
  if (!total.value || !routes.value.length) return 'Showing 0 of 0';
  return `Showing ${offset.value + 1}–${offset.value + routes.value.length} of ${total.value}`;
});

function targetsOf(route: RecordValue): RecordValue[] {
  return Array.isArray(route.targets) ? (route.targets as RecordValue[]) : [];
}
function windowOf(route: RecordValue): RecordValue {
  const value = route.window;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
/** The match expression an operator reads to answer "why did this route win?". */
function describeMatch(route: RecordValue): string {
  const parts: string[] = [];
  const type = text(route.routeType, 'static');
  if (route.matchPrefix) parts.push(`prefix ${route.matchPrefix}`);
  if (route.countryCode) parts.push(`country +${route.countryCode}`);
  if (route.operator) parts.push(`operator ${route.operator}`);
  if (route.destinationPrefix) parts.push(`destination ${route.destinationPrefix}`);
  if (route.sender) parts.push(`sender ${route.sender}`);
  if (!parts.length) return type === 'static' ? 'any destination' : `${type} (no criteria set)`;
  return parts.join(' · ');
}
function describeWindow(route: RecordValue): string {
  const window = windowOf(route);
  const start = text(window.start, '');
  const end = text(window.end, '');
  if (!start || start === '—' || !end || end === '—') return 'always';
  const days = Array.isArray(window.days) ? (window.days as unknown[]).map(Number) : [];
  const dayText = days.length
    ? days
        .filter((day) => day >= 0 && day <= 6)
        .map((day) => DAY_LABELS[day])
        .join(',')
    : 'all days';
  return `${start}–${end} ${dayText}`;
}
function describeTargets(route: RecordValue): string {
  const targets = targetsOf(route);
  if (!targets.length) return '—';
  return targets
    .map(
      (target) =>
        `${smscLabel(target.smscId)} ×${text(target.weight, '1')}${target.enabled === false ? ' (off)' : ''}`,
    )
    .join(' · ');
}

async function loadRoutes() {
  routeState.value = 'loading';
  routeMissing.value = false;
  const params = new URLSearchParams();
  if (search.value.trim()) params.set('search', search.value.trim());
  if (filterType.value) params.set('filter.routeType', filterType.value);
  if (filterStrategy.value) params.set('filter.strategy', filterStrategy.value);
  if (filterEnabled.value) params.set('filter.enabled', filterEnabled.value);
  params.set('sort', `${sortDirection.value === 'desc' ? '-' : ''}${sortField.value}`);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset.value));
  try {
    const payload = await apiRequest<RecordValue>(`/routing/routes?${params.toString()}`);
    routes.value = asItems(payload);
    total.value = typeof payload.total === 'number' ? payload.total : routes.value.length;
    routeError.value = '';
    routeState.value = 'ok';
  } catch (reason) {
    routes.value = [];
    total.value = 0;
    routeMissing.value = isMissing(reason);
    routeError.value = messageFrom(reason, 'Advanced routes could not be loaded.');
    routeState.value = 'error';
  }
}

function applyFilters() {
  offset.value = 0;
  void loadRoutes();
}
function toggleSortDirection() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  applyFilters();
}
function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * PAGE_SIZE);
  if (direction > 0 && offset.value + PAGE_SIZE >= total.value) return;
  if (next === offset.value) return;
  offset.value = next;
  void loadRoutes();
}

// --- Route editor ------------------------------------------------------------
const showForm = ref(false);
const editingId = ref('');
const formError = ref('');
const draftName = ref('');
const draftPriority = ref(100);
const draftEnabled = ref(true);
const draftType = ref('static');
const draftStrategy = ref('priority');
const draftMatchPrefix = ref('');
const draftCountryCode = ref('');
const draftOperator = ref('');
const draftDestinationPrefix = ref('');
const draftSender = ref('');
const draftCost = ref('');
const draftTarget = ref('');
const draftFallback = ref('');
const draftWindowStart = ref('');
const draftWindowEnd = ref('');
const draftDays = ref<number[]>([]);
const draftTargets = ref<TargetDraft[]>([]);
const draftReason = ref('');

function blankTarget(): TargetDraft {
  return { smscId: '', weight: 1, cost: '', enabled: true };
}

function openForm(route?: RecordValue) {
  showForm.value = true;
  formError.value = '';
  notice.value = '';
  editingId.value = route ? text(route.id, '') : '';
  draftName.value = route ? text(route.name, '') : '';
  draftPriority.value = route ? Number(route.priority ?? 100) : 100;
  draftEnabled.value = route ? route.enabled !== false : true;
  draftType.value = route ? text(route.routeType, 'static') : 'static';
  draftStrategy.value = route ? text(route.strategy, 'priority') : 'priority';
  const value = (field: string) =>
    route && route[field] !== null && route[field] !== undefined ? String(route[field]) : '';
  draftMatchPrefix.value = value('matchPrefix');
  draftCountryCode.value = value('countryCode');
  draftOperator.value = value('operator');
  draftDestinationPrefix.value = value('destinationPrefix');
  draftSender.value = value('sender');
  draftCost.value = value('cost');
  draftTarget.value = value('targetSmscId');
  draftFallback.value = value('fallbackSmscId');
  const window = route ? windowOf(route) : {};
  draftWindowStart.value = window.start ? String(window.start) : '';
  draftWindowEnd.value = window.end ? String(window.end) : '';
  draftDays.value = Array.isArray(window.days) ? (window.days as unknown[]).map(Number) : [];
  draftTargets.value = route
    ? targetsOf(route).map((target) => ({
        smscId: text(target.smscId, ''),
        weight: Number(target.weight ?? 1),
        cost: target.cost === null || target.cost === undefined ? '' : String(target.cost),
        enabled: target.enabled !== false,
      }))
    : [];
  if (draftType.value === 'weighted' && !draftTargets.value.length)
    draftTargets.value = [blankTarget()];
  draftReason.value = '';
}
function closeForm() {
  showForm.value = false;
  editingId.value = '';
  formError.value = '';
}
function addTarget() {
  draftTargets.value = [...draftTargets.value, blankTarget()];
}
// Switching to a weighted route surfaces the target editor with one empty row,
// so the requirement ("at least one target") is visible rather than implicit.
watch(draftType, (type) => {
  if (type === 'weighted' && !draftTargets.value.length) draftTargets.value = [blankTarget()];
});
function removeTarget(index: number) {
  draftTargets.value = draftTargets.value.filter((_, position) => position !== index);
}

async function saveRoute() {
  if (!canManage.value) return;
  formError.value = '';
  const name = draftName.value.trim();
  if (!name) {
    formError.value = 'A route name is required.';
    return;
  }
  if (!Number.isInteger(draftPriority.value) || draftPriority.value < 0) {
    formError.value = 'Priority must be a non-negative whole number.';
    return;
  }
  if (!draftTarget.value) {
    formError.value = 'A primary target SMSC is required.';
    return;
  }
  if (draftFallback.value && draftFallback.value === draftTarget.value) {
    formError.value = 'The fallback SMSC must differ from the primary target.';
    return;
  }
  if (Boolean(draftWindowStart.value) !== Boolean(draftWindowEnd.value)) {
    formError.value = 'A time window needs both a start and an end, or neither.';
    return;
  }
  const targets = draftTargets.value
    .filter((target) => target.smscId)
    .map((target) => ({
      smscId: target.smscId,
      weight: Number(target.weight),
      ...(target.cost.trim() ? { cost: Number(target.cost) } : {}),
      enabled: target.enabled,
    }));
  if (draftType.value === 'weighted' && !targets.length) {
    formError.value = 'A weighted route needs at least one target SMSC.';
    return;
  }
  if (targets.some((target) => !Number.isInteger(target.weight) || target.weight < 0)) {
    formError.value = 'Every weighted target needs a non-negative whole-number weight.';
    return;
  }

  const body: RecordValue = {
    name,
    priority: draftPriority.value,
    enabled: draftEnabled.value,
    routeType: draftType.value,
    strategy: draftStrategy.value,
    targetSmscId: draftTarget.value,
  };
  const optional: Array<[string, string]> = [
    ['matchPrefix', draftMatchPrefix.value],
    ['countryCode', draftCountryCode.value],
    ['operator', draftOperator.value],
    ['destinationPrefix', draftDestinationPrefix.value],
    ['sender', draftSender.value],
    ['fallbackSmscId', draftFallback.value],
    ['windowStart', draftWindowStart.value],
    ['windowEnd', draftWindowEnd.value],
  ];
  for (const [field, raw] of optional) if (raw.trim()) body[field] = raw.trim();
  if (draftCost.value.trim()) body.cost = Number(draftCost.value);
  if (draftDays.value.length) body.activeDays = [...draftDays.value].sort((a, b) => a - b);
  if (targets.length) body.targets = targets;
  if (draftReason.value.trim()) body.reason = draftReason.value.trim();

  busy.value = true;
  try {
    if (editingId.value)
      await apiRequest(`/routing/routes/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    else await apiRequest('/routing/routes', { method: 'POST', body: JSON.stringify(body) });
    notice.value = `Route “${name}” ${editingId.value ? 'updated' : 'created'}; a new version snapshot was recorded.`;
    closeForm();
    await loadRoutes();
  } catch (reason) {
    formError.value = messageFrom(reason, 'The route could not be saved.');
  } finally {
    busy.value = false;
  }
}

async function archiveRoute(route: RecordValue) {
  if (!canManage.value) return;
  const id = text(route.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Archive the route “${text(route.name, id)}”?\n\nIt is disabled (not deleted) and a version snapshot is recorded. Traffic that matched it will fall through to the next matching route.`,
    )
  )
    return;
  busy.value = true;
  try {
    await apiRequest(`/routing/routes/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Archived from the operator console' }),
    });
    notice.value = `Route “${text(route.name, id)}” archived.`;
    await loadRoutes();
  } catch (reason) {
    routeError.value = messageFrom(reason, 'The route could not be archived.');
  } finally {
    busy.value = false;
  }
}

// --- Version history ---------------------------------------------------------
const versionRouteId = ref('');
const versionRouteName = ref('');
const versions = ref<RecordValue[]>([]);
const versionState = ref<LoadState>('ok');
const versionError = ref('');
const versionDetail = ref<RecordValue | null>(null);

async function openVersions(route: RecordValue) {
  const id = text(route.id, '');
  if (!id) return;
  versionRouteId.value = id;
  versionRouteName.value = text(route.name, id);
  versionDetail.value = null;
  versionState.value = 'loading';
  try {
    versions.value = asItems(await apiRequest<unknown>(`/routing/routes/${id}/versions`));
    versionError.value = '';
    versionState.value = 'ok';
  } catch (reason) {
    versions.value = [];
    versionError.value = messageFrom(reason, 'Route version history could not be loaded.');
    versionState.value = 'error';
  }
}
function closeVersions() {
  versionRouteId.value = '';
  versions.value = [];
  versionDetail.value = null;
}
async function openVersionDetail(version: RecordValue) {
  const number = Number(version.version);
  if (!Number.isInteger(number)) return;
  versionDetail.value = null;
  try {
    versionDetail.value = await apiRequest<RecordValue>(
      `/routing/routes/${versionRouteId.value}/versions/${number}`,
    );
  } catch (reason) {
    versionError.value = messageFrom(reason, 'That route version could not be loaded.');
  }
}

// --- Resolve (explain) preview ----------------------------------------------
const resolveMsisdn = ref('+256700000000');
const resolveSender = ref('');
const resolveOperator = ref('');
const resolveRotation = ref(0);
const resolveBusy = ref(false);
const resolveError = ref('');
const resolveResult = ref<ResolveResult | null>(null);

async function runResolve() {
  const msisdn = resolveMsisdn.value.trim();
  if (!msisdn) {
    resolveError.value = 'A destination MSISDN is required.';
    return;
  }
  resolveBusy.value = true;
  resolveError.value = '';
  resolveResult.value = null;
  try {
    const body: RecordValue = { msisdn, rotation: Number(resolveRotation.value) || 0 };
    if (resolveSender.value.trim()) body.sender = resolveSender.value.trim();
    if (resolveOperator.value.trim()) body.operator = resolveOperator.value.trim();
    resolveResult.value = await apiRequest<ResolveResult>('/routing/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (reason) {
    resolveError.value = messageFrom(reason, 'The route could not be resolved.');
  } finally {
    resolveBusy.value = false;
  }
}

onMounted(() => {
  void loadSmscOptions();
  void loadRoutes();
});
</script>

<template>
  <div data-testid="routing-depth-view">
    <p v-if="!canManage" class="source-note" data-testid="routing-depth-readonly">
      You can review advanced routes, their version history, and the resolve preview. Creating,
      editing and archiving routes requires the routes.manage permission.
    </p>
    <p v-if="notice" class="notice" role="status" data-testid="routing-notice">{{ notice }}</p>
    <p v-if="smscOptionsError" class="source-note" data-testid="routing-smsc-error">
      {{ smscOptionsError }}
    </p>

    <!-- Resolve preview ------------------------------------------------------- -->
    <section class="panel" data-testid="resolve-panel" aria-label="Route resolve preview">
      <header class="panel-header">
        <div>
          <h2>Resolve preview</h2>
          <p>Which SMSC a destination would be sent through right now, and why.</p>
        </div>
      </header>
      <div class="grid-toolbar">
        <label class="filter-select">
          <span>Destination MSISDN</span>
          <input v-model="resolveMsisdn" data-testid="resolve-msisdn" type="text" />
        </label>
        <label class="filter-select">
          <span>Sender</span>
          <input v-model="resolveSender" data-testid="resolve-sender" type="text" />
        </label>
        <label class="filter-select">
          <span>Operator</span>
          <input v-model="resolveOperator" data-testid="resolve-operator" type="text" />
        </label>
        <label class="filter-select">
          <span>Rotation</span>
          <input
            v-model.number="resolveRotation"
            data-testid="resolve-rotation"
            type="number"
            min="0"
          />
        </label>
        <button
          class="primary-button"
          data-testid="resolve-run"
          :disabled="resolveBusy"
          @click="runResolve"
        >
          {{ resolveBusy ? 'Resolving…' : 'Resolve' }}
        </button>
      </div>
      <p class="source-note">
        Rotation is the round-robin / load-balance counter — increment it to see the next target the
        engine would pick. This is a preview only; nothing is sent and no counter is advanced.
      </p>
      <p v-if="resolveError" class="form-error" role="alert" data-testid="resolve-error">
        {{ resolveError }}
      </p>
      <div v-if="resolveResult" class="baseline-info" data-testid="resolve-result">
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="resolve-smsc">{{
              resolveResult.smscId ? smscLabel(resolveResult.smscId) : 'no SMSC'
            }}</strong>
            <small>chosen SMSC</small>
          </div>
          <div class="metric">
            <strong>{{ text(resolveResult.routeName, 'no route matched') }}</strong>
            <small>controlling route</small>
          </div>
          <div class="metric">
            <strong>{{ text(resolveResult.strategy) }}</strong>
            <small>strategy</small>
          </div>
          <div class="metric">
            <strong>{{ resolveResult.fallbackUsed ? 'yes' : 'no' }}</strong>
            <small>fallback used</small>
          </div>
          <div class="metric">
            <strong>{{ text(resolveResult.candidatesConsidered, '0') }}</strong>
            <small>routes considered</small>
          </div>
        </div>
        <p class="source-note" data-testid="resolve-reason">{{ text(resolveResult.reason) }}</p>
        <ul class="sample-list" data-testid="resolve-trace">
          <li v-for="(entry, index) in resolveResult.trace ?? []" :key="index">
            <span class="mono">{{ index + 1 }}</span>
            <span>{{ entry }}</span>
          </li>
          <li v-if="!(resolveResult.trace ?? []).length">
            <span>The selector returned no decision trace.</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- Route grid ------------------------------------------------------------- -->
    <section class="panel" data-testid="routes-panel" aria-label="Advanced routes">
      <header class="panel-header">
        <div>
          <h2>Advanced routes</h2>
          <p aria-live="polite">
            {{ routeState === 'loading' ? 'Loading routes…' : `${routes.length} route(s) shown` }}
          </p>
        </div>
        <button
          v-if="canManage"
          class="primary-button"
          data-testid="route-create"
          :disabled="busy"
          @click="openForm()"
        >
          New route
        </button>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="route-search"
            type="search"
            placeholder="Name, prefix, country, or operator"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select">
          <span>Type</span>
          <select v-model="filterType" data-testid="route-filter-type" @change="applyFilters">
            <option value="">All types</option>
            <option v-for="type in ROUTE_TYPES" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Strategy</span>
          <select
            v-model="filterStrategy"
            data-testid="route-filter-strategy"
            @change="applyFilters"
          >
            <option value="">All strategies</option>
            <option v-for="strategy in STRATEGIES" :key="strategy" :value="strategy">
              {{ strategy }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Enabled</span>
          <select v-model="filterEnabled" data-testid="route-filter-enabled" @change="applyFilters">
            <option value="">Any</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="sortField" data-testid="route-sort" @change="applyFilters">
            <option v-for="field in SORT_FIELDS" :key="field" :value="field">{{ field }}</option>
          </select>
        </label>
        <button
          class="secondary-button"
          data-testid="route-sort-direction"
          @click="toggleSortDirection"
        >
          {{ sortDirection === 'asc' ? 'Ascending' : 'Descending' }}
        </button>
        <button class="secondary-button" data-testid="route-apply" @click="applyFilters">
          Apply
        </button>
      </div>

      <p v-if="routeState === 'error'" class="chart-empty" role="alert" data-testid="route-error">
        {{
          routeMissing
            ? 'The advanced routing API is not available in this deployment.'
            : routeError
        }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Priority</th>
              <th scope="col">Route</th>
              <th scope="col">Type</th>
              <th scope="col">Strategy</th>
              <th scope="col">Matches</th>
              <th scope="col">Primary SMSC</th>
              <th scope="col">Fallback</th>
              <th scope="col">Weighted targets</th>
              <th scope="col">Window</th>
              <th scope="col">Cost</th>
              <th scope="col">Enabled</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="route in routes"
              :key="text(route.id)"
              :data-testid="`route-row-${text(route.id)}`"
            >
              <td class="mono">{{ text(route.priority) }}</td>
              <td>
                <strong>{{ text(route.name) }}</strong>
                <small class="row-id mono">{{ text(route.id) }}</small>
              </td>
              <td>{{ text(route.routeType) }}</td>
              <td>{{ text(route.strategy) }}</td>
              <td>{{ describeMatch(route) }}</td>
              <td>{{ smscLabel(route.targetSmscId) }}</td>
              <td>{{ route.fallbackSmscId ? smscLabel(route.fallbackSmscId) : '—' }}</td>
              <td>{{ describeTargets(route) }}</td>
              <td>{{ describeWindow(route) }}</td>
              <td class="mono">{{ text(route.cost) }}</td>
              <td>
                <span class="status-badge" :class="route.enabled === false ? '' : 'good'">
                  {{ route.enabled === false ? 'disabled' : 'enabled' }}
                </span>
              </td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`route-versions-${text(route.id)}`"
                  @click="openVersions(route)"
                >
                  History
                </button>
                <template v-if="canManage">
                  <button
                    class="secondary-button"
                    :data-testid="`route-edit-${text(route.id)}`"
                    @click="openForm(route)"
                  >
                    Edit
                  </button>
                  <button
                    class="secondary-button danger-button"
                    :data-testid="`route-archive-${text(route.id)}`"
                    :disabled="busy"
                    @click="archiveRoute(route)"
                  >
                    Archive
                  </button>
                </template>
              </td>
            </tr>
            <tr v-if="routeState === 'ok' && !routes.length">
              <td colspan="12" class="empty-cell" data-testid="route-empty">
                No advanced routes match these filters.
              </td>
            </tr>
            <tr v-if="routeState === 'loading'">
              <td colspan="12" class="empty-cell">Loading routes…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="route-range">{{ rangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="route-prev"
            :disabled="offset === 0"
            @click="turnPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="route-next"
            :disabled="offset + routes.length >= total"
            @click="turnPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>

    <!-- Route editor ----------------------------------------------------------- -->
    <section
      v-if="showForm"
      class="panel composer"
      data-testid="route-form"
      aria-label="Route editor"
    >
      <h2>{{ editingId ? 'Edit route' : 'New route' }}</h2>
      <label class="filter-select filter-search">
        <span>Name</span>
        <input v-model="draftName" data-testid="route-name" type="text" />
      </label>
      <label class="filter-select">
        <span>Priority (lower wins)</span>
        <input v-model.number="draftPriority" data-testid="route-priority" type="number" min="0" />
      </label>
      <label class="filter-select">
        <span>Enabled</span>
        <select v-model="draftEnabled" data-testid="route-enabled">
          <option :value="true">Yes</option>
          <option :value="false">No</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Route type</span>
        <select v-model="draftType" data-testid="route-type">
          <option v-for="type in ROUTE_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Selection strategy</span>
        <select v-model="draftStrategy" data-testid="route-strategy">
          <option v-for="strategy in STRATEGIES" :key="strategy" :value="strategy">
            {{ strategy }}
          </option>
        </select>
      </label>

      <label v-if="draftType === 'prefix'" class="filter-select">
        <span>Match prefix</span>
        <input
          v-model="draftMatchPrefix"
          data-testid="route-match-prefix"
          type="text"
          placeholder="25677"
        />
      </label>
      <label v-if="draftType === 'country'" class="filter-select">
        <span>Country code</span>
        <input
          v-model="draftCountryCode"
          data-testid="route-country"
          type="text"
          placeholder="256"
        />
      </label>
      <label v-if="draftType === 'operator'" class="filter-select">
        <span>Operator</span>
        <input
          v-model="draftOperator"
          data-testid="route-operator"
          type="text"
          placeholder="MTN-UG"
        />
      </label>
      <label class="filter-select">
        <span>Destination prefix (legacy match)</span>
        <input
          v-model="draftDestinationPrefix"
          data-testid="route-destination-prefix"
          type="text"
        />
      </label>
      <label class="filter-select">
        <span>Sender match</span>
        <input v-model="draftSender" data-testid="route-sender" type="text" />
      </label>
      <label class="filter-select">
        <span>Cost per message</span>
        <input v-model="draftCost" data-testid="route-cost" type="number" min="0" step="0.0001" />
      </label>
      <label class="filter-select">
        <span>Primary target SMSC</span>
        <select v-model="draftTarget" data-testid="route-target">
          <option value="" disabled>Select an SMSC</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Fallback SMSC</span>
        <select v-model="draftFallback" data-testid="route-fallback">
          <option value="">None</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Window start (HH:MM)</span>
        <input v-model="draftWindowStart" data-testid="route-window-start" type="time" />
      </label>
      <label class="filter-select">
        <span>Window end (HH:MM)</span>
        <input v-model="draftWindowEnd" data-testid="route-window-end" type="time" />
      </label>
      <fieldset class="role-checkboxes" data-testid="route-days">
        <legend>Active days (none = every day)</legend>
        <label
          v-for="(label, day) in DAY_LABELS"
          :key="day"
          class="role-option"
          :data-testid="`route-day-${day}`"
        >
          <input v-model="draftDays" type="checkbox" :value="day" />
          <span class="role-text"
            ><strong>{{ label }}</strong></span
          >
        </label>
      </fieldset>

      <div v-if="draftType === 'weighted'" data-testid="route-targets">
        <h3>Weighted targets</h3>
        <p class="source-note">
          Traffic is split across enabled targets in proportion to their weights. A weight of 0
          removes a target from the split without deleting it.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">SMSC</th>
                <th scope="col">Weight</th>
                <th scope="col">Cost</th>
                <th scope="col">Enabled</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(target, index) in draftTargets"
                :key="index"
                :data-testid="`route-target-${index}`"
              >
                <td>
                  <select v-model="target.smscId" :data-testid="`route-target-smsc-${index}`">
                    <option value="" disabled>Select an SMSC</option>
                    <option v-for="option in smscOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    v-model.number="target.weight"
                    :data-testid="`route-target-weight-${index}`"
                    type="number"
                    min="0"
                  />
                </td>
                <td>
                  <input
                    v-model="target.cost"
                    :data-testid="`route-target-cost-${index}`"
                    type="number"
                    min="0"
                    step="0.0001"
                  />
                </td>
                <td>
                  <input
                    v-model="target.enabled"
                    :data-testid="`route-target-enabled-${index}`"
                    type="checkbox"
                  />
                </td>
                <td class="row-actions">
                  <button
                    class="secondary-button danger-button"
                    :data-testid="`route-target-remove-${index}`"
                    @click="removeTarget(index)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
              <tr v-if="!draftTargets.length">
                <td colspan="5" class="empty-cell">No weighted targets yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="secondary-button" data-testid="route-target-add" @click="addTarget">
          Add target
        </button>
      </div>

      <label class="filter-select filter-search">
        <span>Change reason (audited)</span>
        <input v-model="draftReason" data-testid="route-reason" type="text" />
      </label>
      <p v-if="formError" class="form-error" role="alert" data-testid="route-form-error">
        {{ formError }}
      </p>
      <div class="detail-actions">
        <button
          class="primary-button"
          data-testid="route-save"
          :disabled="busy || !canManage"
          @click="saveRoute"
        >
          {{ busy ? 'Saving…' : 'Save route' }}
        </button>
        <button class="secondary-button" data-testid="route-cancel" @click="closeForm">
          Cancel
        </button>
      </div>
    </section>

    <!-- Version history --------------------------------------------------------- -->
    <section
      v-if="versionRouteId"
      class="panel"
      data-testid="route-version-panel"
      aria-label="Route version history"
    >
      <header class="panel-header">
        <div>
          <h2>Version history — {{ versionRouteName }}</h2>
          <p aria-live="polite">
            {{
              versionState === 'loading'
                ? 'Loading versions…'
                : `${versions.length} snapshot(s) recorded`
            }}
          </p>
        </div>
        <button class="secondary-button" data-testid="route-version-close" @click="closeVersions">
          Close
        </button>
      </header>
      <p v-if="versionError" class="form-error" role="alert" data-testid="route-version-error">
        {{ versionError }}
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Reason</th>
              <th scope="col">By</th>
              <th scope="col">Recorded</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="version in versions"
              :key="text(version.id)"
              :data-testid="`route-version-${text(version.version)}`"
            >
              <td class="mono">v{{ text(version.version) }}</td>
              <td>{{ text(version.reason) }}</td>
              <td class="mono">{{ text(version.created_by ?? version.createdBy) }}</td>
              <td>{{ text(version.created_at ?? version.createdAt) }}</td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`route-version-view-${text(version.version)}`"
                  @click="openVersionDetail(version)"
                >
                  View definition
                </button>
              </td>
            </tr>
            <tr v-if="versionState === 'ok' && !versions.length">
              <td colspan="5" class="empty-cell" data-testid="route-version-empty">
                No version snapshots have been recorded for this route yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre v-if="versionDetail" class="json-block" data-testid="route-version-definition">{{
        prettyJson(versionDetail.definition)
      }}</pre>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
