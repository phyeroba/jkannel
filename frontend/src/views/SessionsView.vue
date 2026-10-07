<script setup lang="ts">
/**
 * OPERATOR LOGIN SESSIONS — a security register, in the house shape.
 *
 * It opened on fifty three-line rows with no figure anywhere: 5,187px, and
 * the question an operator actually arrives with — how many sessions are
 * live, and is anything stale — could only be answered by counting rows by
 * eye. Revoked sessions were interleaved with active ones with nothing to
 * separate them.
 *
 * The tabs are **Active** and **All**, not Active/Revoked/All, because the
 * API's `active` parameter is boolean: `active=true` or everything. A
 * "Revoked" tab would have to filter one page in the browser and would then
 * report "3 revoked" while looking at fifty rows of a hundred and ninety-two.
 * Two honest tabs beat three that lie.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import AppIcon from '../components/AppIcon.vue';
import TablePager from '../components/TablePager.vue';
import { agoWhen, shortWhen } from '../utils/when';

type RecordValue = Record<string, unknown>;

interface SessionPage {
  items: RecordValue[];
  total: number;
}

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

const rows = ref<RecordValue[]>([]);
const total = ref(0);
/*
 * 25, not 50. Every row carries three lines — the client, three lifecycle
 * stamps, and the state — so fifty of them was a five-thousand-pixel page.
 */
const limit = ref(25);
const offset = ref(0);
const activeOnly = ref(true);
const userId = ref('');
const search = ref('');
const sortField = ref('createdAt');
const sortDir = ref<'asc' | 'desc'>('desc');
const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const unavailable = ref(false);
const notice = ref('');

/*
 * WHOLE-TABLE COUNTS, NOT THE PAGE'S.
 *
 * Two cheap reads with `limit=1`: the API returns `total` for the filter, so
 * one call counts active sessions and one counts all of them. Deriving these
 * from `rows` would count the page — "12 active" out of fifty rows of a
 * hundred and ninety-two — and a wrong count is worse than none.
 *
 * If either read fails the strip renders nothing rather than zeros, which
 * would report an empty estate.
 */
const activeTotal = ref<number | null>(null);
const allTotal = ref<number | null>(null);
const revokedTotal = computed(() =>
  activeTotal.value === null || allTotal.value === null
    ? null
    : Math.max(0, allTotal.value - activeTotal.value),
);

async function loadTallies() {
  try {
    const base = (extra: string) => {
      const params = new URLSearchParams();
      if (userId.value.trim()) params.set('userId', userId.value.trim());
      if (search.value.trim()) params.set('search', search.value.trim());
      params.set('limit', '1');
      params.set('offset', '0');
      if (extra) params.set('active', extra);
      return params.toString();
    };
    const [active, all] = await Promise.all([
      apiRequest<unknown>(`/sessions?${base('true')}`),
      apiRequest<unknown>(`/sessions?${base('')}`),
    ]);
    activeTotal.value = normalize(active).total;
    allTotal.value = normalize(all).total;
  } catch {
    activeTotal.value = null;
    allTotal.value = null;
  }
}

/** Active or All — the two the API can actually honour. */
const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const activeTab = ref<TabId>('active');
function tabCount(tab: TabId): number | null {
  return tab === 'active' ? activeTotal.value : allTotal.value;
}
function chooseTab(tab: TabId) {
  activeTab.value = tab;
  activeOnly.value = tab === 'active';
  applyFilters();
}

const sortFields = [
  { value: 'createdAt', label: 'Created' },
  { value: 'lastSeenAt', label: 'Last seen' },
  { value: 'expiresAt', label: 'Expires' },
  { value: 'username', label: 'Username' },
];

function buildQuery(overrides: { limit?: number; offset?: number } = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (activeOnly.value) params.set('active', 'true');
  if (userId.value.trim()) params.set('userId', userId.value.trim());
  if (search.value.trim()) params.set('search', search.value.trim());
  params.set('sort', `${sortDir.value === 'desc' ? '-' : ''}${sortField.value}`);
  params.set('limit', String(overrides.limit ?? limit.value));
  params.set('offset', String(overrides.offset ?? offset.value));
  return params;
}

function normalize(payload: unknown): SessionPage {
  if (payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)) {
    const record = payload as RecordValue;
    const items = (record.items as unknown[]).filter(
      (item): item is RecordValue => Boolean(item) && typeof item === 'object',
    );
    return { items, total: typeof record.total === 'number' ? record.total : items.length };
  }
  const items = Array.isArray(payload)
    ? payload.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
    : [];
  return { items, total: items.length };
}

function rowId(row: RecordValue): string {
  return text(row.id ?? row.session_id ?? row.sessionId, '');
}

async function load(preserveNotice = false) {
  loading.value = true;
  error.value = '';
  unavailable.value = false;
  if (!preserveNotice) notice.value = '';
  try {
    const page = normalize(await apiRequest<unknown>(`/sessions?${buildQuery().toString()}`));
    rows.value = page.items;
    total.value = page.total;
  } catch (reason) {
    rows.value = [];
    total.value = 0;
    unavailable.value =
      reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
    error.value = reason instanceof Error ? reason.message : 'The service could not be reached.';
  } finally {
    loading.value = false;
  }
  // The tallies ride with the list, so the tab counts and the rows beneath
  // them are never a refresh apart.
  await loadTallies();
  lastReadAt.value = new Date();
  sinceRead.value = 0;
}

/* --- the live line -------------------------------------------------------
   One line stating one idea. Sessions is a security register: an operator
   watching for an unexpected login wants it to re-read itself, and it never
   did — Refresh was a full-weight button in a toolbar of five filters. */
const REFRESH_SECONDS = 60;
const paused = ref(false);
const lastReadAt = ref<Date | null>(null);
const sinceRead = ref(0);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const refreshedLabel = computed(() =>
  lastReadAt.value ? `updated ${sinceRead.value}s ago` : 'not yet read',
);

function applyFilters() {
  offset.value = 0;
  void load();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    applyFilters();
  }, 300);
}
onBeforeUnmount(() => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  if (searchTimer) clearTimeout(searchTimer);
});

async function exportSessions(format: 'csv' | 'pdf') {
  exporting.value = true;
  error.value = '';
  notice.value = '';
  try {
    const params = buildQuery({ limit: 500, offset: 0 });
    const exported = await apiDownloadFile(`/sessions/export.${format}?${params.toString()}`);
    saveDownloadedFile(exported.blob, exported.filename);
    notice.value = `Exported ${
      exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'
    } sessions as ${format.toUpperCase()}.`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The export failed.';
  } finally {
    exporting.value = false;
  }
}

function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * limit.value);
  if (direction > 0 && offset.value + limit.value >= total.value) return;
  if (next === offset.value) return;
  offset.value = next;
  void load();
}

async function revoke(row: RecordValue) {
  const id = rowId(row);
  if (!id) return;
  if (!window.confirm(`Revoke the session for ${text(row.username, id)}? The user is signed out.`))
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/sessions/${id}/revoke`, { method: 'POST', body: '{}' });
    notice.value = `Session ${id} revoked.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The session could not be revoked.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  refreshTimer = setInterval(() => {
    if (!paused.value && !loading.value) void load(true);
  }, REFRESH_SECONDS * 1000);
  tickTimer = setInterval(() => {
    if (lastReadAt.value)
      sinceRead.value = Math.floor((Date.now() - lastReadAt.value.getTime()) / 1000);
  }, 1000);
});
</script>

<template>
  <section :aria-busy="loading" data-testid="sessions-view">
    <!-- HEADER BAND -->
    <header class="screen-head">
      <div class="screen-actions">
        <button
          class="secondary-button"
          data-testid="sessions-export-csv"
          :disabled="exporting"
          @click="exportSessions('csv')"
        >
          Export CSV
        </button>
        <button
          class="secondary-button"
          data-testid="sessions-export-pdf"
          :disabled="exporting"
          @click="exportSessions('pdf')"
        >
          Export PDF
        </button>
      </div>
    </header>

    <!-- SUMMARY STRIP -----------------------------------------------------
      Three whole-table figures. The strip is absent, not zeroed, when the
      tally cannot be read — zeros would report an estate with nobody
      logged in, which on a security screen is the worst possible lie.
    -->
    <section
      v-if="activeTotal !== null && allTotal !== null"
      class="stat-strip"
      data-testid="sessions-strip"
    >
      <article>
        <p class="stat-label">Active</p>
        <b class="stat-figure" data-testid="sessions-stat-active">{{ activeTotal }}</b>
        <p class="stat-caption">Sessions that can still be used</p>
      </article>
      <article>
        <p class="stat-label">Revoked or expired</p>
        <b class="stat-figure" data-testid="sessions-stat-revoked">{{ revokedTotal }}</b>
        <p class="stat-caption">Kept as a record; they cannot sign in</p>
      </article>
      <article>
        <p class="stat-label">All recorded</p>
        <b class="stat-figure" data-testid="sessions-stat-total">{{ allTotal }}</b>
        <p class="stat-caption">Every session this tenant has ever opened</p>
      </article>
    </section>

    <p v-if="notice" class="notice" role="status" data-testid="sessions-notice">{{ notice }}</p>

    <section v-if="error" class="panel empty-state" role="alert" data-testid="sessions-error">
      <h2>{{ unavailable ? 'Sessions API not available yet' : 'Unable to load sessions' }}</h2>
      <p>{{ error }}</p>
      <button class="secondary-button" :disabled="loading" @click="load()">Retry</button>
    </section>

    <section v-if="!error" class="panel">
      <!-- TABS + LIVE LINE ------------------------------------------------
        Two tabs, because the API's `active` parameter is boolean. A
        "Revoked" tab would have to filter one page in the browser and would
        then report a count of the page rather than of the table.
      -->
      <div class="tab-bar">
        <div class="tab-row" role="group" aria-label="Session state">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="tab"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-pressed="activeTab === tab.id"
            :data-testid="`sessions-tab-${tab.id}`"
            @click="chooseTab(tab.id)"
          >
            {{ tab.label }}
            <span v-if="tabCount(tab.id) !== null" class="tab-count">{{ tabCount(tab.id) }}</span>
          </button>
        </div>
        <div class="live-line" data-testid="sessions-live">
          <span class="live-dot" :class="{ 'is-paused': paused }" aria-hidden="true"></span>
          <span
            >{{ paused ? 'Paused' : 'Live' }} · {{ refreshedLabel }} · every
            {{ REFRESH_SECONDS }}s</span
          >
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="sessions-pause"
            @click="paused = !paused"
          >
            {{ paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            class="secondary-button is-compact"
            type="button"
            data-testid="sessions-refresh"
            :disabled="loading"
            @click="load()"
          >
            <AppIcon name="refresh" :size="14" />{{ loading ? 'Working…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- FILTER ROW -->
      <div class="filter-row">
        <label class="filter-search">
          <span class="sr-only">Search sessions</span>
          <input
            v-model="search"
            data-testid="sessions-search"
            type="search"
            placeholder="Username, IP, or agent"
            @input="onSearchInput"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select is-compact">
          <span>User ID</span>
          <input
            v-model="userId"
            data-testid="sessions-user-filter"
            placeholder="UUID"
            @change="applyFilters"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select is-compact">
          <span>Sort</span>
          <select v-model="sortField" data-testid="sessions-sort-field" @change="applyFilters">
            <option v-for="field in sortFields" :key="field.value" :value="field.value">
              {{ field.label }}
            </option>
          </select>
        </label>
        <label class="filter-select is-compact">
          <span>Direction</span>
          <select v-model="sortDir" data-testid="sessions-sort-dir" @change="applyFilters">
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <!-- Kept so a deep link or a script that sets it still works, and so
             the two tabs above are not the only way to reach "all". -->
        <label class="filter-select is-compact">
          <span>Scope</span>
          <select
            v-model="activeOnly"
            data-testid="sessions-active-filter"
            @change="
              activeTab = activeOnly ? 'active' : 'all';
              applyFilters();
            "
          >
            <option :value="true">Active only</option>
            <option :value="false">All sessions</option>
          </select>
        </label>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <!--
                FIVE COLUMNS, NOT EIGHT.

                This table ran 541px past its panel, and 835px of that was a
                single user-agent string — a value nobody reads end to end,
                given a column wide enough to. It is now capped with the full
                text in `title`. The three lifecycle timestamps are one answer
                to "is this session still live", so they share a cell and read
                as "30 Sep, 16:03" rather than as ISO instants.
              -->
              <th scope="col">User</th>
              <th scope="col">Client</th>
              <th scope="col">Lifetime</th>
              <th scope="col">State</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="rowId(row)" :data-testid="`session-row-${rowId(row)}`">
              <td>{{ text(row.username) }}</td>
              <td class="cell-clip mono" :title="text(row.user_agent ?? row.userAgent)">
                {{ text(row.ip_address ?? row.ipAddress) }}
                <small class="row-id">{{ text(row.user_agent ?? row.userAgent) }}</small>
              </td>
              <!--
                Ages, with the instant in `title`. Three stacked
                "6 Oct, 16:19" strings answer "when" three times; the question
                this column exists for is "is this still live", and that is a
                duration.
              -->
              <td>
                <span class="metric-stack">
                  <span class="metric-line"
                    ><span
                      class="v mono"
                      :title="shortWhen(row.last_seen_at ?? row.lastSeenAt)"
                      >{{ agoWhen(row.last_seen_at ?? row.lastSeenAt) || '—' }}</span
                    ><span class="k">last seen</span></span
                  >
                  <span class="metric-line"
                    ><span class="v mono" :title="shortWhen(row.created_at ?? row.createdAt)">{{
                      agoWhen(row.created_at ?? row.createdAt) || '—'
                    }}</span
                    ><span class="k">signed in</span></span
                  >
                  <span class="metric-line"
                    ><span class="v mono" :title="shortWhen(row.expires_at ?? row.expiresAt)">{{
                      shortWhen(row.expires_at ?? row.expiresAt) || '—'
                    }}</span
                    ><span class="k">expires</span></span
                  >
                </span>
              </td>
              <td>
                <span
                  class="status-badge"
                  :class="(row.revoked_at ?? row.revokedAt) ? 'bad' : 'good'"
                  >{{ (row.revoked_at ?? row.revokedAt) ? 'revoked' : 'active' }}</span
                >
                <small v-if="row.revoked_at ?? row.revokedAt" class="row-id">{{
                  shortWhen(row.revoked_at ?? row.revokedAt)
                }}</small>
              </td>
              <td class="row-actions">
                <button
                  v-if="!(row.revoked_at ?? row.revokedAt)"
                  class="secondary-button danger-button"
                  :data-testid="`session-revoke-${rowId(row)}`"
                  :disabled="loading"
                  @click="revoke(row)"
                >
                  Revoke
                </button>
                <span v-else class="status-badge">revoked</span>
              </td>
            </tr>
            <tr v-if="!loading && !rows.length">
              <td colspan="5" class="empty-cell" data-testid="sessions-empty">
                No sessions match these filters.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="table-foot">
        <TablePager
          :shown="rows.length"
          :total="total"
          :offset="offset"
          :page-size="limit"
          :busy="loading"
          noun="session"
          testid="sessions-pager"
          @turn="turnPage"
        />
        <p class="foot-help">
          A revoked session is kept as a record and cannot be used to sign in. Revoking does not
          sign the person out of anything else — it invalidates this one session.
        </p>
      </footer>
    </section>
  </section>
</template>
<style src="./workspace-extras.css"></style>
