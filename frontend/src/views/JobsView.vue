<script setup lang="ts">
/**
 * BACKGROUND JOBS — the asynchronous work this platform runs for itself.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Scheduled sends, MO fan-out, delivery retries, report generation and backups
 * all execute as jobs. Five operations, and none of them had a console surface:
 * a job could be dead-lettered after its retries and nobody would see it unless
 * they noticed the thing it was supposed to do had not happened.
 *
 * This gap was invisible to the coverage tool as well, and worth recording: a
 * single `/${path}` in the API Reference matched every one-segment endpoint, so
 * `GET /jobs` was reported as surfaced. Six false positives found in these
 * tools now, all of the same shape — generous matching quietly reports work as
 * done.
 *
 * THE ONE THING THIS SCREEN INSISTS ON
 * ---------------------------------------------------------------------------
 * Dead-lettered is not failed-and-forgotten. It means the job exhausted its
 * retries and stopped, so the work it represents did NOT happen and nothing
 * will try again. That is the row that matters, so it sorts to the operator's
 * attention rather than sitting between successes.
 *
 * Backend contract:
 *   GET  /jobs?filter.status&filter.type   (system.view)
 *   GET  /jobs/types    what this deployment can actually execute
 *   GET  /jobs/:id
 *   POST /jobs                              (system.manage)
 *   POST /jobs/:id/cancel
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import DetailDrawer from '../components/DetailDrawer.vue';
import { canAccess, session } from '../stores/session';
import { type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';

type RecordValue = Record<string, unknown>;

const canManage = computed(() => canAccess(session.value, 'system.manage'));

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

// --- The queue -------------------------------------------------------------------
const jobs = ref<RecordValue[]>([]);
const listState = ref<State>('loading');
const listError = ref('');
const filterStatus = ref('');
const busy = ref('');
const notice = ref('');
const expanded = ref('');
const detail = ref<RecordValue | null>(null);

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead_lettered', 'cancelled'];

async function loadJobs() {
  listState.value = 'loading';
  const params = new URLSearchParams({ limit: '100', offset: '0', sort: '-createdAt' });
  if (filterStatus.value) params.set('filter.status', filterStatus.value);
  try {
    jobs.value = asItems(await apiRequest(`/jobs?${params.toString()}`));
    listError.value = '';
    listState.value = jobs.value.length ? 'live' : 'empty';
  } catch (cause) {
    jobs.value = [];
    listError.value = messageFrom(cause, 'The job queue could not be read.');
    listState.value =
      cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
  }
}

/**
 * Jobs that stopped without doing their work, counted separately.
 *
 * Dead-lettered and failed both mean the work did not happen; the difference is
 * that a dead-lettered job will not be retried again. Surfacing the count above
 * the grid means an operator who came here for something else still sees it.
 */
const stalled = computed(() =>
  jobs.value.filter((job) =>
    ['dead_lettered', 'failed'].includes(text(job.status, '').toLowerCase()),
  ),
);

function closeJob() {
  expanded.value = '';
  detail.value = null;
}

async function openJob(id: string) {
  // Clicking the open row again closes it, which is how the control's own label
  // reads ("Close") and how the row toggle behaved before this became a sheet.
  if (expanded.value === id) {
    closeJob();
    return;
  }
  expanded.value = id;
  detail.value = null;
  try {
    detail.value = await apiRequest<RecordValue>(`/jobs/${id}`);
  } catch (cause) {
    listError.value = messageFrom(cause, 'That job could not be read.');
  }
}

async function cancelJob(id: string) {
  busy.value = id;
  listError.value = '';
  notice.value = '';
  try {
    await apiRequest(`/jobs/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cancelled from the console' }),
    });
    notice.value = 'The job was cancelled. Work already in flight is not interrupted.';
    await loadJobs();
  } catch (cause) {
    listError.value = messageFrom(cause, 'The job could not be cancelled.');
    await loadJobs();
  } finally {
    busy.value = '';
  }
}

// --- What this deployment can run -------------------------------------------------
const types = ref<string[]>([]);

async function loadTypes() {
  try {
    const payload = await apiRequest<unknown>('/jobs/types');
    const raw = Array.isArray(payload)
      ? payload
      : ((payload as RecordValue)?.types ?? (payload as RecordValue)?.items);
    types.value = (Array.isArray(raw) ? raw : [])
      .map((entry) =>
        typeof entry === 'string' ? entry : text((entry as RecordValue)?.type ?? entry, ''),
      )
      .filter(Boolean);
  } catch {
    types.value = [];
  }
}

// --- Submit ------------------------------------------------------------------------
const draftType = ref('');
const draftInput = ref('{}');

async function submitJob() {
  if (!draftType.value) {
    listError.value = 'Choose a job type.';
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(draftInput.value || '{}');
  } catch {
    listError.value = 'The input must be valid JSON.';
    return;
  }
  busy.value = 'new';
  listError.value = '';
  notice.value = '';
  try {
    const job = await apiRequest<RecordValue>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ type: draftType.value, input }),
    });
    notice.value = `Job accepted as ${text(job?.id)}. It runs asynchronously — watch its status below.`;
    draftInput.value = '{}';
    await loadJobs();
  } catch (cause) {
    listError.value = messageFrom(cause, 'The job could not be submitted.');
  } finally {
    busy.value = '';
  }
}

function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (value === 'succeeded') return 'good';
  if (value === 'dead_lettered' || value === 'failed') return 'bad';
  if (value === 'running' || value === 'queued') return 'warn';
  return 'muted';
}

onMounted(() => {
  void loadJobs();
  void loadTypes();
});
</script>

<template>
  <div data-testid="jobs-view">
    <!--
      The count that matters, above everything. A dead-lettered job means the
      work did not happen and nothing will try again; without this an operator
      would have to notice the missing outcome instead.
    -->
    <p
      v-if="stalled.length"
      class="panel stale-banner"
      role="status"
      data-testid="jobs-stalled-banner"
    >
      <strong>{{ stalled.length }} job(s) stopped without completing.</strong>
      A dead-lettered job exhausted its retries — the work it represents did not happen, and nothing
      will attempt it again.
    </p>

    <section class="panel" data-testid="jobs-list" aria-labelledby="jobs-heading">
      <header class="panel-header">
        <div>
          <h2 id="jobs-heading">Background jobs</h2>
          <p>
            Scheduled sends, MO fan-out, delivery retries, reports and backups all run here. Newest
            first.
          </p>
        </div>
        <label class="filter-select">
          <span>Status</span>
          <select v-model="filterStatus" data-testid="jobs-filter" @change="loadJobs">
            <option value="">any status</option>
            <option v-for="status in STATUSES" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
      </header>

      <p v-if="notice" class="notice" role="status" data-testid="jobs-notice">{{ notice }}</p>
      <p v-if="listError" class="form-error" role="alert" data-testid="jobs-error">
        {{ listError }}
      </p>

      <DataState
        :state="listState"
        subject="background jobs"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          listState === 'empty'
            ? 'No job matches this filter. An empty queue is the healthy steady state — jobs are created by work arriving, not on a schedule of their own.'
            : undefined
        "
        permission="system.view"
        testid="jobs-state"
        :on-retry="loadJobs"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="job in jobs" :key="text(job.id)">
                <tr
                  class="selectable"
                  :data-testid="`job-${text(job.id)}`"
                  tabindex="0"
                  :aria-label="`Open job ${text(job.type)}`"
                  @click="openJob(text(job.id, ''))"
                  @keydown.enter.prevent="openJob(text(job.id, ''))"
                  @keydown.space.prevent="openJob(text(job.id, ''))"
                >
                  <td class="mono cell-tight">
                    {{ formatMoment(text(job.created_at ?? job.createdAt, '')) }}
                  </td>
                  <td class="mono">{{ text(job.type) }}</td>
                  <td>
                    <span class="status-badge" :class="statusTone(text(job.status, ''))">{{
                      text(job.status)
                    }}</span>
                  </td>
                  <td class="mono">{{ text(job.attempts ?? job.attempt_count, '0') }}</td>
                  <td class="row-actions">
                    <button
                      class="secondary-button"
                      type="button"
                      :data-testid="`job-open-${text(job.id)}`"
                      @click.stop="openJob(text(job.id, ''))"
                    >
                      {{ expanded === text(job.id) ? 'Close' : 'Open' }}
                    </button>
                    <!--
                      Only where cancelling can still change the outcome. A
                      succeeded or dead-lettered job has stopped; offering to
                      cancel it would suggest the outcome is still open.
                    -->
                    <button
                      v-if="
                        canManage &&
                        ['queued', 'running'].includes(text(job.status, '').toLowerCase())
                      "
                      class="secondary-button danger-button"
                      type="button"
                      :disabled="Boolean(busy)"
                      :data-testid="`job-cancel-${text(job.id)}`"
                      @click.stop="cancelJob(text(job.id, ''))"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </DataState>
    </section>

    <!-- THE JOB ITSELF ------------------------------------------------------
         A record opened from a register goes in a sheet, not in an extra table
         row underneath the one that was clicked. The expander pushed every job
         below it down the page, and on a hundred-row queue the detail could
         land off-screen entirely. The queue stays visible behind the sheet. -->
    <DetailDrawer
      :open="Boolean(expanded)"
      title="Job"
      eyebrow="Queue"
      :subtitle="expanded"
      wide
      @close="closeJob"
    >
      <pre v-if="detail" class="json-block" :data-testid="`job-detail-${expanded}`">{{
        JSON.stringify(detail, null, 2)
      }}</pre>
      <p v-else class="source-note">Reading the job…</p>
      <p class="source-note">
        The whole record as <span class="mono">GET /jobs/{{ expanded }}</span> returns it. It is
        shown raw because the job payload has no fixed shape — each job type defines its own input
        and result — so a field list here would have to guess, and would silently drop whatever it
        did not know about.
      </p>
    </DetailDrawer>

    <!-- SUBMIT ------------------------------------------------------------- -->
    <section
      v-if="canManage"
      class="panel"
      data-testid="jobs-submit"
      aria-labelledby="jobs-submit-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="jobs-submit-heading">Run a job</h2>
          <!--
            The type list comes from the server, which rejects at submission
            time any type with no registered executor. Offering a free-text box
            would let somebody queue work that can never run.
          -->
          <p>
            Only the types this deployment has an executor for. Submitting anything else is rejected
            rather than queued forever.
          </p>
        </div>
      </header>

      <div class="field-grid">
        <label class="filter-select">
          <span>Type</span>
          <select v-model="draftType" data-testid="job-type">
            <option value="">choose a type</option>
            <option v-for="type in types" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="filter-select filter-search">
          <span>Input (JSON)</span>
          <input v-model="draftInput" type="text" data-testid="job-input" />
        </label>
        <button
          class="primary-button"
          type="button"
          :disabled="Boolean(busy)"
          data-testid="job-submit"
          @click="submitJob"
        >
          Run it
        </button>
      </div>

      <p v-if="!types.length" class="source-note" data-testid="jobs-no-types">
        This deployment reported no runnable job types, so nothing can be submitted from here. That
        is a deployment fact rather than a permission problem.
      </p>
    </section>
    <p v-else class="panel source-note" data-testid="jobs-readonly">
      Submitting and cancelling jobs needs <span class="mono">system.manage</span>. The queue above
      is readable without it.
    </p>
  </div>
</template>

<style scoped>
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
.cell-tight {
  font-size: 12.5px;
}
</style>
<style src="./workspace-extras.css"></style>
