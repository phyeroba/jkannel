<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;

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
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}

const canCreate = computed(() => canAccess(session.value, 'configuration.manage'));

// --- Jobs grid --------------------------------------------------------------
const jobsState = ref<'loading' | 'ok' | 'error'>('loading');
const jobsMissing = ref(false);
const jobsError = ref('');
const jobs = ref<RecordValue[]>([]);
const jobsTotal = ref(0);
const notice = ref('');
const busy = ref(false);

async function loadJobs() {
  jobsState.value = 'loading';
  jobsMissing.value = false;
  jobsError.value = '';
  try {
    const data = await apiRequest<{ items?: RecordValue[]; total?: number }>(
      '/bulk-send?limit=50&offset=0',
    );
    jobs.value = Array.isArray(data.items)
      ? data.items.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
      : [];
    jobsTotal.value = num(data.total);
    jobsState.value = 'ok';
  } catch (reason) {
    jobs.value = [];
    jobsTotal.value = 0;
    jobsMissing.value = isMissing(reason);
    jobsError.value = messageFrom(reason, 'Bulk send jobs could not be loaded.');
    jobsState.value = 'error';
  }
}

// --- SMSC options (value = engine id, as the backend validates smscId) -------
const smscOptions = ref<Array<{ value: string; label: string }>>([]);
const smscOptionsError = ref('');

async function loadSmscOptions() {
  smscOptionsError.value = '';
  try {
    const data = await apiRequest<{ items?: RecordValue[] } | RecordValue[]>(
      '/smscs?limit=500&offset=0',
    );
    const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
    smscOptions.value = items
      .map((row) => {
        const engineId = text(row.engine_id ?? row.engineId, '');
        return { value: engineId, label: `${text(row.name)} (${engineId})` };
      })
      .filter((option) => option.value && option.value !== '—');
    if (!smscOptions.value.length)
      smscOptionsError.value = 'No SMSC connections are available for bulk send.';
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value = messageFrom(reason, 'SMSC connections could not be loaded.');
  }
}

// --- Create campaign form ---------------------------------------------------
const campaignName = ref('');
const campaignSmscId = ref('');
const campaignMessage = ref('');
const recipientsRaw = ref('');
const formError = ref('');

/** Splits pasted recipients on newlines, commas, semicolons, or whitespace. */
const parsedRecipients = computed(() =>
  recipientsRaw.value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const recipientCount = computed(() => parsedRecipients.value.length);
const canSubmit = computed(
  () =>
    !busy.value &&
    Boolean(campaignName.value.trim()) &&
    Boolean(campaignSmscId.value) &&
    Boolean(campaignMessage.value.trim()) &&
    recipientCount.value > 0,
);

async function submitCampaign() {
  if (!canSubmit.value) return;
  busy.value = true;
  formError.value = '';
  notice.value = '';
  try {
    const job = await apiRequest<RecordValue>('/bulk-send', {
      method: 'POST',
      body: JSON.stringify({
        name: campaignName.value.trim(),
        smscId: campaignSmscId.value,
        message: campaignMessage.value,
        recipients: parsedRecipients.value,
      }),
    });
    notice.value = `Bulk send job “${text(job.name, campaignName.value)}” queued for ${recipientCount.value} recipients.`;
    campaignName.value = '';
    campaignMessage.value = '';
    recipientsRaw.value = '';
    await loadJobs();
  } catch (reason) {
    formError.value = messageFrom(reason, 'The bulk send job could not be created.');
  } finally {
    busy.value = false;
  }
}

// --- Job drill-down ---------------------------------------------------------
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const jobDetail = ref<RecordValue | null>(null);
const recipients = ref<RecordValue[]>([]);

const recipientCounts = computed<Array<{ status: string; count: number }>>(() => {
  const counts = jobDetail.value?.recipientCounts;
  if (!counts || typeof counts !== 'object') return [];
  return Object.entries(counts as Record<string, unknown>).map(([status, count]) => ({
    status,
    count: num(count),
  }));
});

async function openJob(job: RecordValue) {
  const id = text(job.id, '');
  if (!id || id === '—') return;
  detailOpen.value = true;
  detailLoading.value = true;
  detailError.value = '';
  jobDetail.value = null;
  recipients.value = [];
  try {
    const [detail, recipientPage] = await Promise.all([
      apiRequest<RecordValue>(`/bulk-send/${id}`),
      apiRequest<{ items?: RecordValue[] }>(`/bulk-send/${id}/recipients?limit=100&offset=0`),
    ]);
    jobDetail.value = detail;
    recipients.value = Array.isArray(recipientPage.items) ? recipientPage.items : [];
  } catch (reason) {
    detailError.value = messageFrom(reason, 'The job detail could not be loaded.');
  } finally {
    detailLoading.value = false;
  }
}
function closeJob() {
  detailOpen.value = false;
  jobDetail.value = null;
  recipients.value = [];
}

onMounted(() => {
  void loadJobs();
  if (canCreate.value) void loadSmscOptions();
});
</script>

<template>
  <div data-testid="bulk-send-view">
    <div class="dashboard-actions">
      <button
        class="secondary-button"
        data-testid="bulk-send-refresh"
        :disabled="busy"
        @click="loadJobs"
      >
        Refresh jobs
      </button>
    </div>

    <p v-if="notice" class="notice" role="status" data-testid="bulk-send-notice">{{ notice }}</p>

    <!-- Create campaign ---------------------------------------------------- -->
    <section v-if="canCreate" class="panel composer" aria-label="Create bulk send campaign">
      <h2>New bulk send campaign</h2>
      <p class="form-hint">
        One message body is fanned out to every recipient through a single SMSC. Up to 5000
        recipients per job.
      </p>
      <label>
        Campaign name
        <input
          v-model="campaignName"
          data-testid="bulk-name"
          placeholder="e.g. July balance reminder"
        />
      </label>
      <label>
        SMSC connection
        <select v-model="campaignSmscId" data-testid="bulk-smsc" required>
          <option value="" disabled>Select an SMSC connection</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <p v-if="smscOptionsError" class="form-hint" role="alert" data-testid="bulk-smsc-error">
        {{ smscOptionsError }}
      </p>
      <label>
        Message text
        <textarea
          v-model="campaignMessage"
          data-testid="bulk-message"
          rows="3"
          placeholder="Message body sent to every recipient"
        ></textarea>
      </label>
      <label>
        Recipients
        <textarea
          v-model="recipientsRaw"
          data-testid="bulk-recipients"
          rows="5"
          placeholder="One number per line, or comma-separated (e.g. +256700000001)"
        ></textarea>
      </label>
      <p class="form-hint" data-testid="bulk-recipient-count">
        {{ recipientCount }} recipient(s) parsed.
      </p>
      <p v-if="formError" class="form-error" role="alert" data-testid="bulk-form-error">
        {{ formError }}
      </p>
      <div>
        <button
          class="primary-button"
          data-testid="bulk-submit"
          :disabled="!canSubmit"
          @click="submitCampaign"
        >
          {{ busy ? 'Queuing…' : 'Queue campaign' }}
        </button>
      </div>
    </section>

    <!-- Jobs grid ---------------------------------------------------------- -->
    <section class="panel">
      <header class="panel-header">
        <div>
          <h2>Bulk send jobs</h2>
          <p aria-live="polite">
            {{ jobsState === 'loading' ? 'Loading jobs…' : `${jobs.length} of ${jobsTotal} jobs` }}
          </p>
        </div>
      </header>
      <p
        v-if="jobsState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="bulk-jobs-unavailable"
      >
        {{ jobsMissing ? 'Bulk send is not available yet.' : jobsError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Status</th>
              <th scope="col">Total</th>
              <th scope="col">Submitted</th>
              <th scope="col">Failed</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="job in jobs"
              :key="text(job.id)"
              class="clickable-row"
              :data-testid="`bulk-job-${text(job.id)}`"
              @click="openJob(job)"
            >
              <td>
                <strong>{{ text(job.name) }}</strong>
              </td>
              <td>
                <span class="status-badge">{{ text(job.status) }}</span>
              </td>
              <td>{{ text(job.total, '0') }}</td>
              <td>{{ text(job.submitted, '0') }}</td>
              <td>{{ text(job.failed, '0') }}</td>
              <td>{{ text(job.created_at ?? job.createdAt) }}</td>
            </tr>
            <tr v-if="jobsState === 'ok' && !jobs.length">
              <td colspan="6" class="empty-cell" data-testid="bulk-jobs-empty">
                No bulk send jobs yet.
              </td>
            </tr>
            <tr v-if="jobsState === 'loading'">
              <td colspan="6" class="empty-cell">Loading jobs…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="jobsState === 'ok' && jobs.length" class="source-note">
        Select a job to view per-recipient status.
      </p>
    </section>

    <!-- Job drill-down ----------------------------------------------------- -->
    <section
      v-if="detailOpen"
      class="panel detail-panel"
      data-testid="bulk-detail-panel"
      aria-label="Bulk send job detail"
    >
      <header class="panel-header">
        <div>
          <h2>Job detail</h2>
        </div>
        <button class="secondary-button" data-testid="bulk-detail-close" @click="closeJob">
          Close
        </button>
      </header>
      <p v-if="detailLoading" class="chart-empty" data-testid="bulk-detail-loading">Loading…</p>
      <p v-else-if="detailError" class="chart-empty" role="alert" data-testid="bulk-detail-error">
        {{ detailError }}
      </p>
      <template v-else-if="jobDetail">
        <dl class="detail-grid">
          <dt>Campaign</dt>
          <dd>{{ text(jobDetail.name) }}</dd>
          <dt>Status</dt>
          <dd data-testid="bulk-detail-status">{{ text(jobDetail.status) }}</dd>
          <dt>SMSC</dt>
          <dd class="mono">{{ text(jobDetail.smsc_id ?? jobDetail.smscId) }}</dd>
          <dt>Total</dt>
          <dd>{{ text(jobDetail.total, '0') }}</dd>
          <dt>Detail</dt>
          <dd>{{ text(jobDetail.detail) }}</dd>
        </dl>
        <h3>Status counts</h3>
        <div class="summary-strip" data-testid="bulk-status-counts">
          <div v-for="entry in recipientCounts" :key="entry.status" class="metric">
            <strong>{{ entry.count }}</strong>
            <small>{{ entry.status }}</small>
          </div>
          <div v-if="!recipientCounts.length" class="metric">
            <strong>0</strong>
            <small>no recipients</small>
          </div>
        </div>
        <h3>Recipients</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Receiver</th>
                <th scope="col">Status</th>
                <th scope="col">Foreign ID</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(recipient, index) in recipients"
                :key="text(recipient.id, String(index))"
                :data-testid="`bulk-recipient-${index}`"
              >
                <td class="mono">{{ text(recipient.receiver) }}</td>
                <td>{{ text(recipient.status) }}</td>
                <td class="mono">{{ text(recipient.foreign_id ?? recipient.foreignId) }}</td>
                <td>{{ text(recipient.error) }}</td>
              </tr>
              <tr v-if="!recipients.length">
                <td colspan="4" class="empty-cell">No recipients recorded for this job.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
