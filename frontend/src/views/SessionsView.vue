<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';

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
const limit = ref(50);
const offset = ref(0);
const activeOnly = ref(false);
const userId = ref('');
const search = ref('');
const sortField = ref('createdAt');
const sortDir = ref<'asc' | 'desc'>('desc');
const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const unavailable = ref(false);
const notice = ref('');

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
}

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

onMounted(() => void load());
</script>

<template>
  <section :aria-busy="loading" data-testid="sessions-view">
    <section class="toolbar panel grid-toolbar">
      <label class="filter-select filter-search">
        <span>Search</span>
        <input
          v-model="search"
          data-testid="sessions-search"
          type="search"
          placeholder="Search username, IP, or agent"
          @input="onSearchInput"
          @keyup.enter="applyFilters"
        />
      </label>
      <label class="filter-select">
        <span>User ID</span>
        <input
          v-model="userId"
          data-testid="sessions-user-filter"
          placeholder="Filter by user ID"
          @change="applyFilters"
          @keyup.enter="applyFilters"
        />
      </label>
      <label class="filter-select">
        <span>Active only</span>
        <select v-model="activeOnly" data-testid="sessions-active-filter" @change="applyFilters">
          <option :value="false">All sessions</option>
          <option :value="true">Active only</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Sort by</span>
        <select v-model="sortField" data-testid="sessions-sort-field" @change="applyFilters">
          <option v-for="field in sortFields" :key="field.value" :value="field.value">
            {{ field.label }}
          </option>
        </select>
      </label>
      <label class="filter-select sort-direction">
        <span>Direction</span>
        <select v-model="sortDir" data-testid="sessions-sort-dir" @change="applyFilters">
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
      <button
        class="primary-button"
        data-testid="sessions-refresh"
        :disabled="loading"
        @click="load()"
      >
        {{ loading ? 'Working…' : 'Refresh' }}
      </button>
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
    </section>

    <p v-if="notice" class="notice" role="status" data-testid="sessions-notice">{{ notice }}</p>

    <section v-if="error" class="panel empty-state" role="alert" data-testid="sessions-error">
      <h2>{{ unavailable ? 'Sessions API not available yet' : 'Unable to load sessions' }}</h2>
      <p>{{ error }}</p>
      <button class="secondary-button" :disabled="loading" @click="load()">Retry</button>
    </section>

    <section v-if="!error" class="panel">
      <header class="panel-header">
        <div>
          <h2>Active sessions</h2>
          <p aria-live="polite">
            {{ loading ? 'Loading sessions…' : `${rows.length} sessions shown` }}
          </p>
        </div>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">IP address</th>
              <th scope="col">User agent</th>
              <th scope="col">Created</th>
              <th scope="col">Last seen</th>
              <th scope="col">Expires</th>
              <th scope="col">Revoked</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="rowId(row)" :data-testid="`session-row-${rowId(row)}`">
              <td>{{ text(row.username) }}</td>
              <td class="mono">{{ text(row.ip_address ?? row.ipAddress) }}</td>
              <td>{{ text(row.user_agent ?? row.userAgent) }}</td>
              <td>{{ text(row.created_at ?? row.createdAt) }}</td>
              <td>{{ text(row.last_seen_at ?? row.lastSeenAt) }}</td>
              <td>{{ text(row.expires_at ?? row.expiresAt) }}</td>
              <td>{{ text(row.revoked_at ?? row.revokedAt) }}</td>
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
              <td colspan="8" class="empty-cell" data-testid="sessions-empty">
                No sessions match these filters.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="sessions-range">Showing {{ rows.length }} of {{ total }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="sessions-prev"
            :disabled="loading || offset === 0"
            @click="turnPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="sessions-next"
            :disabled="loading || offset + limit >= total"
            @click="turnPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  </section>
</template>
