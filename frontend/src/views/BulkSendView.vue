<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import { canAccess, session } from '../stores/session';
import MessagePriority from '../components/MessagePriority.vue';
import SegmentCounter from '../components/SegmentCounter.vue';
import SendSchedule from '../components/SendSchedule.vue';
import { describeComposerText } from '../utils/message-segments';
import {
  PRIORITY_BULK_CAVEAT,
  PRIORITY_UNSET,
  priorityCellLabel,
  priorityFields,
  type PriorityChoice,
} from '../utils/message-priority';
import {
  SCHEDULING_SUPPORTED,
  emptySchedule,
  scheduleError,
  scheduledSendFields,
  type ScheduleDraft,
} from '../utils/send-scheduling';

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
/** Status string → the badge tone classes the message log and workspace grids use. */
function badgeTone(value: unknown) {
  const status = String(value ?? '').toLowerCase();
  if (['delivered', 'completed', 'complete', 'submitted', 'ok', 'active'].includes(status))
    return 'good';
  if (['pending', 'queued', 'running', 'scheduled', 'buffered', 'accepted'].includes(status))
    return 'warn';
  if (['failed', 'rejected', 'partial', 'error'].includes(status)) return 'bad';
  return '';
}

const canCreate = computed(() => canAccess(session.value, 'configuration.manage'));

/**
 * BOTH grids speak the shared grid vocabulary defined by
 * `backend/src/platform/list-query.ts` + `cursor.ts` and wired up in
 * `backend/src/messaging-depth/bulk-send.service.ts` (`BULK_JOB_GRID`,
 * `BULK_RECIPIENT_GRID`):
 *
 *   search=…             free text over the grid's search columns
 *   sort=field / -field  whitelisted; see JOB_SORT_FIELDS / RECIPIENT_SORT_FIELDS
 *   filter.<field>=…     whitelisted exact match
 *   limit=…              jobs max 200, recipients max 500
 *   paginate=cursor      keyset pagination; `cursor=<opaque>` for later pages
 *
 * Cursor paging is used unconditionally here rather than offset, because these
 * are precisely the two tables that grow without bound and a deep OFFSET over
 * them degrades into scan-and-discard. The trade the backend documents is that
 * a keyset page does not pay for a `count(*)`, so `total` is null — the pager
 * says "page N" rather than inventing a total it was not given.
 *
 * CSV export is server-side, from the same parameters, at
 *   GET /bulk-send/export.csv
 *   GET /bulk-send/:id/recipients/export.csv
 */
const JOB_PAGE_SIZES = [25, 50, 100, 200];
const RECIPIENT_PAGE_SIZES = [25, 50, 100, 250, 500];

/** `scheduled` is a queued campaign carrying a future `scheduled_at`. */
const JOB_STATUSES = ['queued', 'scheduled', 'running', 'completed', 'partial', 'failed'];
const RECIPIENT_STATUSES = ['pending', 'submitted', 'failed'];

type SortDirection = 'asc' | 'desc';

interface GridColumn {
  key: string;
  label: string;
  value: (raw: RecordValue) => string;
  /** API sort field name; omitted when the column is not sortable server-side. */
  sort?: string;
  /**
   * Why this column has no sort control. Rendered as the header's tooltip so an
   * unsortable heading reads as a deliberate, explained limit rather than a
   * button that failed to render.
   */
  note?: string;
  mono?: boolean;
  badge?: boolean;
  hint?: (raw: RecordValue) => string;
}

/** `sort` query value for a column key + direction. */
function sortParam(field: string, direction: SortDirection) {
  return `${direction === 'desc' ? '-' : ''}${field}`;
}

// --- Jobs grid --------------------------------------------------------------
const jobColumns: GridColumn[] = [
  {
    key: 'name',
    label: 'Campaign',
    sort: 'name',
    value: (raw) => text(raw.name, ''),
    hint: (raw) => text(raw.detail, ''),
  },
  {
    key: 'status',
    label: 'Status',
    sort: 'status',
    value: (raw) => text(raw.status, ''),
    badge: true,
  },
  { key: 'total', label: 'Total', sort: 'total', value: (raw) => String(num(raw.total)) },
  {
    key: 'submitted',
    label: 'Submitted',
    sort: 'submitted',
    value: (raw) => String(num(raw.submitted)),
  },
  { key: 'failed', label: 'Failed', sort: 'failed', value: (raw) => String(num(raw.failed)) },
  {
    key: 'sender',
    label: 'Sender',
    sort: 'sender',
    value: (raw) => text(raw.sender, ''),
    mono: true,
  },
  // `priority` is selected by JOB_COLUMNS but is in neither BULK_JOB_GRID
  // sortColumns nor filterColumns, so this column carries no sort control. It
  // is also absent from JOB_EXPORT_COLUMNS, which the footnote says out loud.
  {
    key: 'priority',
    label: 'Priority',
    note: 'Not sortable: the API’s bulk-job sort whitelist does not include priority.',
    value: (raw) => priorityCellLabel(raw.priority),
    mono: true,
  },
  {
    key: 'smscId',
    label: 'SMSC',
    sort: 'smscId',
    value: (raw) => text(raw.smsc_id ?? raw.smscId, 'routed'),
    mono: true,
  },
  {
    key: 'scheduledAt',
    label: 'Scheduled for',
    sort: 'scheduledAt',
    value: (raw) => text(raw.scheduled_at ?? raw.scheduledAt, ''),
    hint: (raw) => {
      const validity = raw.validity_minutes ?? raw.validityMinutes;
      return validity === null || validity === undefined || validity === ''
        ? ''
        : `valid ${validity} min`;
    },
  },
  {
    key: 'createdAt',
    label: 'Created',
    sort: 'createdAt',
    value: (raw) => text(raw.created_at ?? raw.createdAt, ''),
  },
];

const jobsState = ref<'loading' | 'ok' | 'error'>('loading');
const jobsMissing = ref(false);
const jobsError = ref('');
const jobs = ref<RecordValue[]>([]);
const jobsLimit = ref(50);
const jobsCursor = ref('');
const jobsNextCursor = ref('');
const jobsCursorHistory = ref<string[]>([]);
const jobsSearch = ref('');
const jobsStatusFilter = ref('');
const jobsSortField = ref('createdAt');
const jobsSortDir = ref<SortDirection>('desc');
const jobsExporting = ref(false);
const notice = ref('');
/** The job the last successful create produced, so the notice can link to it. */
const createdJobId = ref('');
const busy = ref(false);

const jobsPage = computed(() => jobsCursorHistory.value.length + 1);
const jobsFiltered = computed(() => Boolean(jobsSearch.value.trim() || jobsStatusFilter.value));

/**
 * ONE builder for the grid and the export, so both ask the same question.
 *
 * `forExport` drops the paging keys entirely. That matters: `exportJobsCsv`
 * defaults `limit` to the grid's `maxLimit` only when the caller sends none, so
 * passing the screen's page size would silently cap the file at 50 rows.
 */
function jobsQuery(options: { forExport?: boolean } = {}) {
  const params = new URLSearchParams();
  if (jobsSearch.value.trim()) params.set('search', jobsSearch.value.trim());
  if (jobsStatusFilter.value) params.set('filter.status', jobsStatusFilter.value);
  params.set('sort', sortParam(jobsSortField.value, jobsSortDir.value));
  if (options.forExport) return params;
  params.set('limit', String(jobsLimit.value));
  params.set('paginate', 'cursor');
  if (jobsCursor.value) params.set('cursor', jobsCursor.value);
  return params;
}

async function loadJobs() {
  jobsState.value = 'loading';
  jobsMissing.value = false;
  jobsError.value = '';
  try {
    const data = await apiRequest<{ items?: RecordValue[]; nextCursor?: string | null }>(
      `/bulk-send?${jobsQuery().toString()}`,
    );
    jobs.value = Array.isArray(data.items)
      ? data.items.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
      : [];
    jobsNextCursor.value = data.nextCursor ?? '';
    jobsState.value = 'ok';
  } catch (reason) {
    jobs.value = [];
    jobsNextCursor.value = '';
    jobsMissing.value = isMissing(reason);
    // A 400 here is a rejected sort/filter and the API names the field.
    jobsError.value = messageFrom(reason, 'Bulk send jobs could not be loaded.');
    jobsState.value = 'error';
  }
}

/** Any change to the question invalidates the keyset, so paging restarts. */
function applyJobFilters() {
  jobsCursor.value = '';
  jobsCursorHistory.value = [];
  void loadJobs();
}
function sortJobsBy(field: string) {
  if (jobsSortField.value === field)
    jobsSortDir.value = jobsSortDir.value === 'asc' ? 'desc' : 'asc';
  else {
    jobsSortField.value = field;
    jobsSortDir.value = 'asc';
  }
  applyJobFilters();
}
function turnJobsPage(direction: number) {
  if (direction > 0) {
    if (!jobsNextCursor.value) return;
    jobsCursorHistory.value = [...jobsCursorHistory.value, jobsCursor.value];
    jobsCursor.value = jobsNextCursor.value;
  } else {
    if (!jobsCursorHistory.value.length) return;
    const history = [...jobsCursorHistory.value];
    jobsCursor.value = history.pop() ?? '';
    jobsCursorHistory.value = history;
  }
  void loadJobs();
}

async function exportJobs() {
  jobsExporting.value = true;
  jobsError.value = '';
  notice.value = '';
  try {
    // No paging keys: the export is the whole filtered set, not the page in view.
    const exported = await apiDownloadFile(
      `/bulk-send/export.csv?${jobsQuery({ forExport: true }).toString()}`,
    );
    saveDownloadedFile(exported.blob, exported.filename);
    const rows = exported.headers.get('x-jkannel-export-row-count') ?? 'the filtered';
    notice.value = jobsFiltered.value
      ? `Exported ${rows} bulk send jobs matching the active filters.`
      : `Exported ${rows} bulk send jobs.`;
  } catch (reason) {
    jobsError.value = messageFrom(reason, 'The jobs export failed.');
  } finally {
    jobsExporting.value = false;
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
const sendLater = ref(false);
const schedule = ref<ScheduleDraft>(emptySchedule());
/** '' = the key is omitted from the request; see utils/message-priority.ts. */
const campaignPriority = ref<PriorityChoice>(PRIORITY_UNSET);

/** Splits pasted recipients on newlines, commas, semicolons, or whitespace. */
const parsedRecipients = computed(() =>
  recipientsRaw.value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const recipientCount = computed(() => parsedRecipients.value.length);
/** The number the operator is actually billed for: segments × recipients. */
const campaignSegments = computed(() => describeComposerText(campaignMessage.value).segments);
const campaignCost = computed(() => campaignSegments.value * recipientCount.value);
const scheduleInvalid = computed(() => (sendLater.value ? scheduleError(schedule.value) : ''));
const canSubmit = computed(
  () =>
    !busy.value &&
    Boolean(campaignName.value.trim()) &&
    Boolean(campaignSmscId.value) &&
    Boolean(campaignMessage.value.trim()) &&
    recipientCount.value > 0 &&
    !scheduleInvalid.value,
);

async function submitCampaign() {
  if (!canSubmit.value) return;
  busy.value = true;
  formError.value = '';
  notice.value = '';
  createdJobId.value = '';
  const scheduled = sendLater.value && SCHEDULING_SUPPORTED;
  try {
    const body: Record<string, unknown> = {
      name: campaignName.value.trim(),
      smscId: campaignSmscId.value,
      message: campaignMessage.value,
      recipients: parsedRecipients.value,
    };
    // Absent, not 0, when no level was chosen: bulk_send_jobs.priority is
    // nullable with no default and every recipient inherits whatever is stored,
    // so a `?? 0` here would demote the entire campaign.
    Object.assign(body, priorityFields(campaignPriority.value));
    if (scheduled) Object.assign(body, scheduledSendFields(schedule.value));
    const job = await apiRequest<RecordValue>('/bulk-send', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    createdJobId.value = text(job.id, '');
    const when = text(job.scheduled_at ?? job.scheduledAt, '');
    notice.value =
      `Bulk send job “${text(job.name, campaignName.value)}” ${scheduled ? 'scheduled' : 'queued'}: ` +
      `${recipientCount.value} recipient(s) × ${campaignSegments.value} segment(s) = ${campaignCost.value} SMS.` +
      (campaignPriority.value === PRIORITY_UNSET
        ? ' No send priority was requested.'
        : ` Every recipient inherits priority ${campaignPriority.value}, which reorders the bind’s queue only while a backlog exists.`) +
      (scheduled && when !== '—' ? ` Requested delivery ${when}.` : '');
    campaignName.value = '';
    campaignMessage.value = '';
    recipientsRaw.value = '';
    sendLater.value = false;
    schedule.value = emptySchedule();
    campaignPriority.value = PRIORITY_UNSET;
    applyJobFilters();
    if (createdJobId.value) await openJob({ id: createdJobId.value });
  } catch (reason) {
    // The API's 400 is surfaced verbatim: it names the field it rejected, and
    // for a schedule it says exactly why (past instant, validity too short).
    formError.value = messageFrom(reason, 'The bulk send job could not be created.');
  } finally {
    busy.value = false;
  }
}

// --- Job drill-down ---------------------------------------------------------
const recipientColumns: GridColumn[] = [
  {
    key: 'receiver',
    label: 'Receiver',
    sort: 'receiver',
    value: (raw) => text(raw.receiver, ''),
    mono: true,
  },
  {
    key: 'status',
    label: 'Status',
    sort: 'status',
    value: (raw) => text(raw.status, ''),
    badge: true,
  },
  {
    key: 'foreignId',
    label: 'Foreign ID',
    sort: 'foreignId',
    value: (raw) => text(raw.foreign_id ?? raw.foreignId, ''),
    mono: true,
  },
  // `error` is in BULK_RECIPIENT_GRID.searchColumns but not in its sortColumns,
  // so the API would reject `sort=error`. The header therefore carries no sort
  // button — and says why, so it does not read as a broken control.
  {
    key: 'error',
    label: 'Error',
    note: 'Searchable, but not sortable: the API’s recipient sort whitelist does not include the error column.',
    value: (raw) => text(raw.error, ''),
  },
  {
    key: 'createdAt',
    label: 'Created',
    sort: 'createdAt',
    value: (raw) => text(raw.created_at ?? raw.createdAt, ''),
  },
];

const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detailNotice = ref('');
const jobDetail = ref<RecordValue | null>(null);
const currentJobId = ref('');
const recipients = ref<RecordValue[]>([]);
const recipientsLimit = ref(50);
const recipientsCursor = ref('');
const recipientsNextCursor = ref('');
const recipientsCursorHistory = ref<string[]>([]);
const recipientsSearch = ref('');
const recipientsStatusFilter = ref('');
const recipientsSortField = ref('createdAt');
const recipientsSortDir = ref<SortDirection>('asc');
const recipientsExporting = ref(false);

const recipientsPage = computed(() => recipientsCursorHistory.value.length + 1);
const recipientsFiltered = computed(() =>
  Boolean(recipientsSearch.value.trim() || recipientsStatusFilter.value),
);

const recipientCounts = computed<Array<{ status: string; count: number }>>(() => {
  const counts = jobDetail.value?.recipientCounts;
  if (!counts || typeof counts !== 'object') return [];
  return Object.entries(counts as Record<string, unknown>).map(([status, count]) => ({
    status,
    count: num(count),
  }));
});

/** Same shape, and the same `forExport` reasoning, as {@link jobsQuery}. */
function recipientsQuery(options: { forExport?: boolean } = {}) {
  const params = new URLSearchParams();
  if (recipientsSearch.value.trim()) params.set('search', recipientsSearch.value.trim());
  if (recipientsStatusFilter.value) params.set('filter.status', recipientsStatusFilter.value);
  params.set('sort', sortParam(recipientsSortField.value, recipientsSortDir.value));
  if (options.forExport) return params;
  params.set('limit', String(recipientsLimit.value));
  params.set('paginate', 'cursor');
  if (recipientsCursor.value) params.set('cursor', recipientsCursor.value);
  return params;
}

async function loadRecipients() {
  if (!currentJobId.value) return;
  const page = await apiRequest<{ items?: RecordValue[]; nextCursor?: string | null }>(
    `/bulk-send/${currentJobId.value}/recipients?${recipientsQuery().toString()}`,
  );
  recipients.value = Array.isArray(page.items) ? page.items : [];
  recipientsNextCursor.value = page.nextCursor ?? '';
}

async function openJob(job: RecordValue) {
  const id = text(job.id, '');
  if (!id || id === '—') return;
  detailOpen.value = true;
  detailLoading.value = true;
  detailError.value = '';
  detailNotice.value = '';
  jobDetail.value = null;
  currentJobId.value = id;
  recipients.value = [];
  recipientsCursor.value = '';
  recipientsCursorHistory.value = [];
  recipientsSearch.value = '';
  recipientsStatusFilter.value = '';
  try {
    const [detail] = await Promise.all([
      apiRequest<RecordValue>(`/bulk-send/${id}`),
      loadRecipients(),
    ]);
    jobDetail.value = detail;
  } catch (reason) {
    detailError.value = messageFrom(reason, 'The job detail could not be loaded.');
  } finally {
    detailLoading.value = false;
  }
}
function closeJob() {
  detailOpen.value = false;
  jobDetail.value = null;
  currentJobId.value = '';
  recipients.value = [];
}

async function reloadRecipients() {
  detailError.value = '';
  detailLoading.value = true;
  try {
    await loadRecipients();
  } catch (reason) {
    detailError.value = messageFrom(reason, 'The recipients could not be loaded.');
  } finally {
    detailLoading.value = false;
  }
}
function applyRecipientFilters() {
  recipientsCursor.value = '';
  recipientsCursorHistory.value = [];
  void reloadRecipients();
}
function sortRecipientsBy(field: string) {
  if (recipientsSortField.value === field)
    recipientsSortDir.value = recipientsSortDir.value === 'asc' ? 'desc' : 'asc';
  else {
    recipientsSortField.value = field;
    recipientsSortDir.value = 'asc';
  }
  applyRecipientFilters();
}
function turnRecipientsPage(direction: number) {
  if (direction > 0) {
    if (!recipientsNextCursor.value) return;
    recipientsCursorHistory.value = [...recipientsCursorHistory.value, recipientsCursor.value];
    recipientsCursor.value = recipientsNextCursor.value;
  } else {
    if (!recipientsCursorHistory.value.length) return;
    const history = [...recipientsCursorHistory.value];
    recipientsCursor.value = history.pop() ?? '';
    recipientsCursorHistory.value = history;
  }
  void reloadRecipients();
}

async function exportRecipients() {
  if (!currentJobId.value) return;
  recipientsExporting.value = true;
  detailError.value = '';
  detailNotice.value = '';
  try {
    const exported = await apiDownloadFile(
      `/bulk-send/${currentJobId.value}/recipients/export.csv?${recipientsQuery({ forExport: true }).toString()}`,
    );
    saveDownloadedFile(exported.blob, exported.filename);
    const rows = exported.headers.get('x-jkannel-export-row-count') ?? 'the filtered';
    detailNotice.value = recipientsFiltered.value
      ? `Exported ${rows} recipients matching the active filters.`
      : `Exported ${rows} recipients.`;
  } catch (reason) {
    detailError.value = messageFrom(reason, 'The recipients export failed.');
  } finally {
    recipientsExporting.value = false;
  }
}

function ariaSort(active: boolean, direction: SortDirection) {
  if (!active) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}

onMounted(() => {
  void loadJobs();
  if (canCreate.value) void loadSmscOptions();
});
</script>

<template>
  <div class="bulk-send-page" data-testid="bulk-send-view">
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

    <!--
      "I queued a bulk send and it never appeared in the queue." The traffic went
      spool → engine → history in under a second, and the Live Queue spool only
      shows the PENDING tier, so a healthy system shows it empty. Say where the
      traffic actually lands, and link there, instead of leaving the operator to
      go looking — they found it in Delivery Reports eventually, by themselves.
    -->
    <section v-if="notice" class="panel notice-panel" data-testid="bulk-send-notice-panel">
      <p class="notice" role="status" data-testid="bulk-send-notice">{{ notice }}</p>
      <p class="form-hint">
        Dispatched traffic does <strong>not</strong> sit in the Live Queue spool. A healthy engine
        drains the spool in under a second, so it will usually look empty — that is normal, not a
        lost campaign. Follow the campaign here:
      </p>
      <nav class="followup-links" aria-label="Where to follow this campaign">
        <a
          v-if="createdJobId"
          href="#bulk-detail-panel"
          data-testid="followup-job"
          @click.prevent="openJob({ id: createdJobId })"
          >This job’s recipients</a
        >
        <RouterLink to="/messages" data-testid="followup-messages">Message log</RouterLink>
        <RouterLink to="/delivery-reports" data-testid="followup-delivery"
          >Delivery Reports</RouterLink
        >
        <RouterLink to="/live-queue" data-testid="followup-queue">Live Queue</RouterLink>
      </nav>
    </section>

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
      <SegmentCounter :text="campaignMessage" testid="bulk-segment" />
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
        <template v-if="recipientCount">
          This campaign costs
          <strong data-testid="bulk-total-cost">{{ campaignCost }}</strong>
          SMS ({{ recipientCount }} × {{ campaignSegments }} segment(s)).
        </template>
      </p>

      <h3>Send priority</h3>
      <MessagePriority
        v-model="campaignPriority"
        testid="bulk-priority"
        label="Campaign priority (inherited by every recipient)"
        :caveat="PRIORITY_BULK_CAVEAT"
        :busy="busy"
      />

      <h3>When to send</h3>
      <SendSchedule
        v-model:later="sendLater"
        v-model:draft="schedule"
        testid="bulk-schedule"
        :busy="busy"
      />

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
          {{ busy ? 'Queuing…' : sendLater ? 'Schedule campaign' : 'Queue campaign' }}
        </button>
      </div>
    </section>

    <!-- Jobs grid ---------------------------------------------------------- -->
    <section class="panel" data-testid="bulk-jobs-panel">
      <header class="panel-header">
        <div>
          <h2>Bulk send jobs</h2>
          <p aria-live="polite" data-testid="bulk-jobs-range">
            {{
              jobsState === 'loading' ? 'Loading jobs…' : `${jobs.length} job(s) · page ${jobsPage}`
            }}
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="jobsSearch"
            type="search"
            data-testid="bulk-jobs-search"
            placeholder="Campaign, SMSC, sender, or detail"
            @change="applyJobFilters"
            @keyup.enter="applyJobFilters"
          />
        </label>
        <label class="filter-select">
          <span>Status</span>
          <select
            v-model="jobsStatusFilter"
            data-testid="bulk-jobs-status"
            @change="applyJobFilters"
          >
            <option value="">All statuses</option>
            <option v-for="status in JOB_STATUSES" :key="status" :value="status">
              {{ status }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Per page</span>
          <select
            v-model.number="jobsLimit"
            data-testid="bulk-jobs-limit"
            @change="applyJobFilters"
          >
            <option v-for="size in JOB_PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
        <button
          class="secondary-button"
          data-testid="bulk-jobs-export"
          :disabled="jobsExporting || jobsState === 'error'"
          @click="exportJobs"
        >
          {{ jobsExporting ? 'Exporting…' : 'Export CSV' }}
        </button>
        <small class="source-note" data-testid="bulk-jobs-csv-only"
          >CSV only — the API has no PDF route for this export, and its column set does not include
          priority.</small
        >
      </div>

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
              <th
                v-for="column in jobColumns"
                :key="column.key"
                scope="col"
                :aria-sort="
                  column.sort ? ariaSort(jobsSortField === column.sort, jobsSortDir) : undefined
                "
              >
                <button
                  v-if="column.sort"
                  type="button"
                  class="column-sort"
                  :data-testid="`bulk-jobs-sort-${column.key}`"
                  @click="sortJobsBy(column.sort)"
                >
                  {{ column.label }}
                  <span v-if="jobsSortField === column.sort">{{
                    jobsSortDir === 'asc' ? '▲' : '▼'
                  }}</span>
                </button>
                <span v-else class="column-static" :title="column.note">
                  {{ column.label }}
                  <abbr v-if="column.note" title="Not sortable" aria-hidden="true">·</abbr>
                </span>
              </th>
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
              <td v-for="column in jobColumns" :key="column.key" :class="{ mono: column.mono }">
                <span
                  v-if="column.badge"
                  class="status-badge"
                  :class="badgeTone(column.value(job))"
                >
                  {{ column.value(job) || '—' }}
                </span>
                <strong v-else-if="column.key === 'name'">{{ column.value(job) || '—' }}</strong>
                <template v-else>{{ column.value(job) || '—' }}</template>
                <small v-if="column.hint && column.hint(job)" class="row-id">{{
                  column.hint(job)
                }}</small>
              </td>
            </tr>
            <tr v-if="jobsState === 'ok' && !jobs.length">
              <td :colspan="jobColumns.length" class="empty-cell" data-testid="bulk-jobs-empty">
                {{
                  jobsFiltered ? 'No bulk send jobs match these filters.' : 'No bulk send jobs yet.'
                }}
              </td>
            </tr>
            <tr v-if="jobsState === 'loading'">
              <td :colspan="jobColumns.length" class="empty-cell">Loading jobs…</td>
            </tr>
          </tbody>
        </table>
      </div>

      <footer class="pager">
        <span data-testid="bulk-jobs-pager-label">
          Page {{ jobsPage }} · {{ jobs.length }} row(s)
        </span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="bulk-jobs-prev"
            :disabled="!jobsCursorHistory.length || jobsState === 'loading'"
            @click="turnJobsPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="bulk-jobs-next"
            :disabled="!jobsNextCursor || jobsState === 'loading'"
            @click="turnJobsPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
      <p class="source-note">
        Select a job to view per-recipient status. Search, status filter, sort, page size and the
        CSV export are all applied by the API. Paging is keyset (cursor) rather than offset, which
        is what keeps a campaign list that grows without bound from degrading — the cost is that a
        keyset page carries no total row count, so this pager counts pages, not rows.
      </p>
    </section>

    <!-- Job drill-down ----------------------------------------------------- -->
    <section
      v-if="detailOpen"
      id="bulk-detail-panel"
      class="panel detail-panel"
      data-testid="bulk-detail-panel"
      aria-label="Bulk send job detail"
    >
      <header class="panel-header">
        <div>
          <h2>Job details</h2>
        </div>
        <button class="secondary-button" data-testid="bulk-detail-close" @click="closeJob">
          Close
        </button>
      </header>
      <p v-if="detailError" class="form-error" role="alert" data-testid="bulk-detail-error">
        {{ detailError }}
      </p>
      <p v-if="detailNotice" class="notice" role="status" data-testid="bulk-detail-notice">
        {{ detailNotice }}
      </p>
      <p v-if="detailLoading && !jobDetail" class="chart-empty" data-testid="bulk-detail-loading">
        Loading…
      </p>
      <template v-else-if="jobDetail">
        <dl class="detail-grid">
          <dt>Campaign</dt>
          <dd>{{ text(jobDetail.name) }}</dd>
          <dt>Status</dt>
          <dd data-testid="bulk-detail-status">
            <span class="status-badge" :class="badgeTone(jobDetail.status)">{{
              text(jobDetail.status)
            }}</span>
          </dd>
          <dt>SMSC</dt>
          <dd class="mono">{{ text(jobDetail.smsc_id ?? jobDetail.smscId, 'routed') }}</dd>
          <dt>Total</dt>
          <dd>{{ text(jobDetail.total, '0') }}</dd>
          <dt>Priority</dt>
          <dd data-testid="bulk-detail-priority">
            {{ priorityCellLabel(jobDetail.priority) }}
          </dd>
          <dt>Scheduled for</dt>
          <dd data-testid="bulk-detail-scheduled">
            {{ text(jobDetail.scheduled_at ?? jobDetail.scheduledAt, 'immediate') }}
          </dd>
          <dt>Validity</dt>
          <dd>
            {{ text(jobDetail.validity_minutes ?? jobDetail.validityMinutes, 'carrier default') }}
          </dd>
          <dt>Detail</dt>
          <dd>{{ text(jobDetail.detail) }}</dd>
        </dl>

        <p class="form-hint">
          Submitted recipients leave the spool immediately. Trace them in the
          <RouterLink to="/messages">message log</RouterLink> or
          <RouterLink to="/delivery-reports">Delivery Reports</RouterLink> — the Live Queue spool
          shows only messages still waiting to be handed to a bind.
        </p>

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
        <div class="grid-toolbar">
          <label class="filter-select filter-search">
            <span>Search</span>
            <input
              v-model="recipientsSearch"
              type="search"
              data-testid="bulk-recipients-search"
              placeholder="Receiver, foreign ID, or error"
              @change="applyRecipientFilters"
              @keyup.enter="applyRecipientFilters"
            />
          </label>
          <label class="filter-select">
            <span>Status</span>
            <select
              v-model="recipientsStatusFilter"
              data-testid="bulk-recipients-status"
              @change="applyRecipientFilters"
            >
              <option value="">All statuses</option>
              <option v-for="status in RECIPIENT_STATUSES" :key="status" :value="status">
                {{ status }}
              </option>
            </select>
          </label>
          <label class="filter-select">
            <span>Per page</span>
            <select
              v-model.number="recipientsLimit"
              data-testid="bulk-recipients-limit"
              @change="applyRecipientFilters"
            >
              <option v-for="size in RECIPIENT_PAGE_SIZES" :key="size" :value="size">
                {{ size }}
              </option>
            </select>
          </label>
          <button
            class="secondary-button"
            data-testid="bulk-recipients-export"
            :disabled="recipientsExporting"
            @click="exportRecipients"
          >
            {{ recipientsExporting ? 'Exporting…' : 'Export CSV' }}
          </button>
          <small class="source-note" data-testid="bulk-recipients-csv-only"
            >CSV only — the API has no PDF route for this export.</small
          >
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th
                  v-for="column in recipientColumns"
                  :key="column.key"
                  scope="col"
                  :aria-sort="
                    column.sort
                      ? ariaSort(recipientsSortField === column.sort, recipientsSortDir)
                      : undefined
                  "
                >
                  <button
                    v-if="column.sort"
                    type="button"
                    class="column-sort"
                    :data-testid="`bulk-recipients-sort-${column.key}`"
                    @click="sortRecipientsBy(column.sort)"
                  >
                    {{ column.label }}
                    <span v-if="recipientsSortField === column.sort">{{
                      recipientsSortDir === 'asc' ? '▲' : '▼'
                    }}</span>
                  </button>
                  <span v-else class="column-static" :title="column.note">
                    {{ column.label }}
                    <abbr v-if="column.note" title="Not sortable" aria-hidden="true">·</abbr>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(recipient, index) in recipients"
                :key="text(recipient.id, String(index))"
                :data-testid="`bulk-recipient-${index}`"
              >
                <td
                  v-for="column in recipientColumns"
                  :key="column.key"
                  :class="{ mono: column.mono }"
                >
                  <span
                    v-if="column.badge"
                    class="status-badge"
                    :class="badgeTone(column.value(recipient))"
                  >
                    {{ column.value(recipient) || '—' }}
                  </span>
                  <template v-else>{{ column.value(recipient) || '—' }}</template>
                </td>
              </tr>
              <tr v-if="!recipients.length">
                <td :colspan="recipientColumns.length" class="empty-cell">
                  {{
                    recipientsFiltered
                      ? 'No recipients match these filters.'
                      : 'No recipients recorded for this job.'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="pager">
          <span data-testid="bulk-recipients-range">
            Page {{ recipientsPage }} · {{ recipients.length }} row(s)
          </span>
          <div class="pager-buttons">
            <button
              class="secondary-button"
              data-testid="bulk-recipients-prev"
              :disabled="!recipientsCursorHistory.length || detailLoading"
              @click="turnRecipientsPage(-1)"
            >
              Previous
            </button>
            <button
              class="secondary-button"
              data-testid="bulk-recipients-next"
              :disabled="!recipientsNextCursor || detailLoading"
              @click="turnRecipientsPage(1)"
            >
              Next
            </button>
          </div>
        </footer>
        <p class="source-note" data-testid="bulk-recipients-sort-note">
          The API sorts recipients by receiver, status, foreign ID or created time only. Error text
          is searchable — the search box covers receiver, foreign ID and error — but it is not in
          the sort whitelist, so that column has no sort control.
        </p>
      </template>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>

<style scoped>
/*
  Every child here was a bare `.panel` (padding, no margin), so the campaign
  grid ran straight into the jobs panel and the jobs panel into the job-details
  panel with no seam at all. Same defect, and the same fix, as the Reports page:
  one page-level grid supplies the 16px gap for every seam.
*/
.bulk-send-page {
  display: grid;
  /* minmax(0,1fr) rather than the implicit `auto`: an auto column is sized by
     its widest content, which a wide recipients table would push past the
     viewport instead of scrolling inside .table-wrap. */
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
/* Already spaced by its own negative top margin; its bottom margin would double
   up against the grid gap. */
.bulk-send-page > .dashboard-actions {
  margin-bottom: 0;
}
.bulk-send-page > .detail-panel {
  margin-bottom: 0;
}
.notice-panel .notice {
  margin-top: 0;
}
/*
  A column that cannot be sorted server-side must not look like a sort button
  that failed to render. It stays plain heading text; the dotted marker carries
  the "there is a reason" tooltip, and the grid footnote spells the reason out
  for anyone not hovering.
*/
.column-static {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: default;
}
.column-static abbr {
  color: var(--muted);
  border-bottom: 1px dotted var(--muted);
  cursor: help;
  text-decoration: none;
}
</style>
