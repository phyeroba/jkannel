<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;

interface Option {
  value: string;
  label: string;
}
interface EngineSummary {
  status?: string;
  version?: string;
  uptimeSeconds?: number | null;
  smsQueuedOut?: number | null;
  smsQueuedIn?: number | null;
  dlrQueued?: number | null;
  storeSize?: number | null;
}
interface BindSnapshot {
  engineId?: string;
  name?: string;
  status?: string;
  queued?: number | null;
  failed?: number | null;
  sent?: number | null;
  received?: number | null;
  outboundRate?: number[];
  inboundRate?: number[];
  known?: boolean;
  smscId?: string | null;
  smscName?: string | null;
}
interface SpoolSummary {
  queued?: number | null;
  oldestEpoch?: number | null;
  bySmsc?: Array<{ smscId?: string; count?: number }>;
}
interface LiveSnapshot {
  observedAt?: string;
  engine?: EngineSummary;
  binds?: BindSnapshot[];
  spool?: SpoolSummary;
  source?: { status?: string; detail?: string };
}
interface RerouteResult {
  requested?: number;
  rerouted?: number;
  skipped?: number;
  targetSmscId?: string;
  results?: SpoolResultRow[];
}
interface CancelResult {
  requested?: number;
  cancelled?: number;
  skipped?: number;
  results?: SpoolResultRow[];
}
interface ResendResultRow {
  id?: string;
  sqlId?: string;
  code?: string;
  error?: string;
  originalSmscId?: string | null;
}
interface ResendResult {
  requested?: number;
  resent?: number;
  skipped?: number;
  results?: ResendResultRow[];
}
/** Per-id spool outcome: `{ sqlId, rerouted|cancelled, code?, reason? }`. */
interface SpoolResultRow {
  sqlId?: number | string;
  rerouted?: boolean;
  cancelled?: boolean;
  code?: string;
  reason?: string;
}

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
/** Seconds → compact human duration ("2h 5m", "45s"). */
function duration(seconds: unknown, fallback = '—') {
  const total = Math.floor(num(seconds));
  if (!Number.isFinite(total) || total < 0) return fallback;
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function ageFromEpoch(epoch: unknown, fallback = '—') {
  const seconds = num(epoch);
  if (!seconds) return fallback;
  return duration(Math.max(0, Math.floor(Date.now() / 1000) - seconds), fallback);
}
/**
 * Status → existing badge tone. Delivered/online read as success, failures and
 * rejections as danger, anything still in flight as warning; everything else
 * (including `unknown` and receipts) stays the muted default.
 */
function badgeTone(status: string) {
  const value = status.toLowerCase();
  if (['online', 'running', 'delivered', 'ok', 'available', 'sent'].includes(value)) return 'good';
  if (['connecting', 'pending', 'queued', 'degraded', 'buffered', 'accepted'].includes(value))
    return 'warn';
  if (['dead', 'failed', 'rejected', 'stopped', 'unavailable', 'error'].includes(value))
    return 'bad';
  return '';
}

const canOperate = computed(() => canAccess(session.value, 'messages.send'));
const canManageBinds = computed(() => canAccess(session.value, 'smsc.manage'));

// --- Live snapshot ----------------------------------------------------------
const live = ref<LiveSnapshot | null>(null);
const liveState = ref<'loading' | 'ok' | 'error'>('loading');
const liveError = ref('');
const liveMissing = ref(false);
const lastRefreshedAt = ref('');

const engine = computed<EngineSummary>(() => live.value?.engine ?? {});
const binds = computed<BindSnapshot[]>(() =>
  Array.isArray(live.value?.binds) ? (live.value?.binds as BindSnapshot[]) : [],
);
const spoolSummary = computed<SpoolSummary>(() => live.value?.spool ?? {});
const sourceStatus = computed(() => String(live.value?.source?.status ?? 'ok').toLowerCase());
const sourceDetail = computed(() => text(live.value?.source?.detail, ''));
const runtimeDegraded = computed(
  () => liveState.value === 'ok' && sourceStatus.value !== 'ok' && sourceStatus.value !== '',
);

async function loadLive() {
  try {
    const data = await apiRequest<LiveSnapshot>('/queue-console/live');
    live.value = data && typeof data === 'object' ? data : {};
    liveError.value = '';
    liveMissing.value = false;
    liveState.value = 'ok';
    lastRefreshedAt.value = new Date().toLocaleTimeString();
  } catch (reason) {
    liveMissing.value = isMissing(reason);
    liveError.value = messageFrom(reason, 'The live queue snapshot could not be loaded.');
    liveState.value = 'error';
  }
}

// --- Target bind options (value = engine id, as the API expects) ------------
const smscOptions = ref<Option[]>([]);
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
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value = messageFrom(reason, 'SMSC connections could not be loaded.');
  }
}

/** Tenant SMSCs first, plus any live bind the engine reports that is not in the list. */
const bindOptions = computed<Option[]>(() => {
  const options = new Map<string, string>();
  for (const option of smscOptions.value) options.set(option.value, option.label);
  for (const bind of binds.value) {
    const engineId = text(bind.engineId, '');
    if (!engineId || engineId === '—' || options.has(engineId)) continue;
    options.set(engineId, `${text(bind.smscName ?? bind.name, engineId)} (${engineId})`);
  }
  return [...options.entries()].map(([value, label]) => ({ value, label }));
});

// --- Message log (sent_sms history) + resend — the primary operator flow ----
const logRows = ref<RecordValue[]>([]);
const logState = ref<'loading' | 'ok' | 'error'>('loading');
const logError = ref('');
const logMissing = ref(false);
const logStatus = ref('resendable');
const logQuery = ref('');
const logSmscFilter = ref('');
const logSelection = ref<string[]>([]);
const resendTarget = ref('');
const resendNotice = ref('');
const resendError = ref('');
const resendResults = ref<ResendResultRow[]>([]);
const actionBusy = ref(false);
/** Counts for the whole filtered scope, as returned by /queue-console/history. */
const scopeCounts = ref<Record<string, number> | null>(null);
const historyFallback = ref(false);
const LOG_LIMIT = 100;
const DELIVERY_STATUSES = [
  'delivered',
  'failed',
  'rejected',
  'buffered',
  'accepted',
  'pending',
  'unknown',
];

function rawOf(row: RecordValue): RecordValue {
  const raw = row.raw;
  return raw && typeof raw === 'object' ? (raw as RecordValue) : {};
}
function bodyText(row: RecordValue): string {
  return text(row.text ?? row.msgdata ?? rawOf(row).msgdata);
}

/** Convenience groupings the backend also understands as one-click filters. */
const STATUS_GROUPS: Record<string, string[]> = {
  resendable: ['failed', 'rejected'],
  inflight: ['pending', 'buffered'],
};

function isReceipt(row: RecordValue): boolean {
  const raw = rawOf(row);
  return (
    String(row.status ?? '').toLowerCase() === 'delivery_report' ||
    String(row.direction ?? row.momt ?? raw.momt ?? '').toUpperCase() === 'DLR'
  );
}

/**
 * Fallback for stores that do not yet emit `deliveryStatus`: the outcome then
 * only exists on the receipt, encoded in the DLR mask (Kannel: 1 delivered,
 * 2 failed, 4 buffered, 8 SMSC accepted, 16 SMSC rejected).
 */
function derivedStatus(row: RecordValue): string {
  const raw = rawOf(row);
  const base = String(row.status ?? '').toLowerCase();
  if (base === 'queued' || base === 'pending') return 'pending';
  if (!isReceipt(row)) return base || 'sent';
  const mask = Number(row.dlrMask ?? row.dlr_mask ?? raw.dlr_mask);
  if (mask === 1) return 'delivered';
  if (mask === 2) return 'failed';
  if (mask === 16) return 'rejected';
  if (mask === 4) return 'buffered';
  if (mask === 8) return 'accepted';
  const body = String(row.text ?? row.msgdata ?? raw.msgdata ?? '').toLowerCase();
  if (/reject/.test(body)) return 'rejected';
  if (/undeliver|fail|expire|absent/.test(body)) return 'failed';
  if (/deliver|success/.test(body)) return 'delivered';
  return 'unknown';
}

/** `deliveryStatus` is authoritative when the store provides it. */
function effectiveStatus(row: RecordValue): string {
  const supplied = String(row.deliveryStatus ?? row.delivery_status ?? '')
    .trim()
    .toLowerCase();
  return supplied || derivedStatus(row);
}

const hasDeliveryStatus = computed(() =>
  logRows.value.some((row) => (row.deliveryStatus ?? row.delivery_status) !== undefined),
);

function logId(row: RecordValue): string {
  return text(row.id ?? row.sqlId ?? row.sql_id ?? rawOf(row).sql_id, '');
}

/**
 * Identifier posted to /queue-console/resend. Receipts are not resendable, but
 * a receipt shares its `foreign_id` with the message it reports on, and the
 * backend prefers the real message for that id — so on legacy rows (where the
 * outcome is only readable from the receipt) the correlation id is sent.
 */
function resendId(row: RecordValue): string {
  if (!isReceipt(row)) return logId(row);
  const raw = rawOf(row);
  return text(row.externalRef ?? row.foreignId ?? row.foreign_id ?? raw.foreign_id, '');
}

/** Receipts are excluded once real per-message statuses exist. */
function isSelectable(row: RecordValue): boolean {
  if (!isReceipt(row)) return Boolean(logId(row));
  return !hasDeliveryStatus.value && Boolean(resendId(row));
}

function matchesStatusFilter(row: RecordValue): boolean {
  if (logStatus.value === 'all') return true;
  const status = effectiveStatus(row);
  const group = STATUS_GROUPS[logStatus.value];
  return group ? group.includes(status) : status === logStatus.value;
}

/** Fallback counts over the loaded page, used when the scope counts are absent. */
const pageCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { all: logRows.value.length };
  for (const row of logRows.value) {
    const status = effectiveStatus(row);
    counts[status] = (counts[status] ?? 0) + 1;
    for (const [group, members] of Object.entries(STATUS_GROUPS))
      if (members.includes(status)) counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
});
function statusCount(key: string) {
  const scope = scopeCounts.value;
  if (!scope) return pageCounts.value[key] ?? 0;
  if (key === 'all')
    return DELIVERY_STATUSES.reduce((total, status) => total + (scope[status] ?? 0), 0);
  if (key === 'inflight') return scope.inFlight ?? scope.inflight ?? 0;
  return scope[key] ?? 0;
}

const statusPresets = [
  { value: 'resendable', label: 'Resendable failures' },
  { value: 'inflight', label: 'In flight' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'all', label: 'All' },
];
const statusChoices = [
  { value: 'all', label: 'All' },
  { value: 'resendable', label: 'Resendable failures (failed + rejected)' },
  { value: 'inflight', label: 'In flight (pending + buffered)' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'accepted', label: 'Accepted by SMSC' },
  { value: 'buffered', label: 'Buffered at SMSC' },
  { value: 'pending', label: 'Pending (no report yet)' },
  { value: 'unknown', label: 'Unknown' },
];

function selectPreset(value: string) {
  logStatus.value = value;
  void loadLog();
}

interface HistoryPage {
  items?: RecordValue[];
  nextCursor?: number | string | null;
  total?: number;
  counts?: Record<string, number>;
  appliedStatus?: string | null;
}

function applyLogPage(payload: HistoryPage) {
  logRows.value = Array.isArray(payload.items)
    ? payload.items.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
    : [];
  logError.value = '';
  logState.value = 'ok';
  const visible = new Set(logRows.value.filter(isSelectable).map((row) => resendId(row)));
  logSelection.value = logSelection.value.filter((id) => visible.has(id));
}

/**
 * The classified history endpoint is the primary source: it filters by real
 * delivery outcome, drops receipt rows, and returns counts for the whole
 * filtered scope rather than the current page. Older deployments without it
 * fall back to the plain message list, where counts are page-local.
 */
async function loadLog() {
  logState.value = 'loading';
  logMissing.value = false;
  const params = new URLSearchParams();
  params.set('limit', String(LOG_LIMIT));
  if (logStatus.value !== 'all') params.set('status', logStatus.value);
  if (logQuery.value.trim()) params.set('query', logQuery.value.trim());
  if (logSmscFilter.value) params.set('smscId', logSmscFilter.value);
  try {
    const payload = await apiRequest<HistoryPage>(`/queue-console/history?${params.toString()}`);
    historyFallback.value = false;
    scopeCounts.value = payload.counts ?? null;
    applyLogPage(payload);
    return;
  } catch (reason) {
    if (!isMissing(reason)) {
      logRows.value = [];
      scopeCounts.value = null;
      logError.value = messageFrom(reason, 'The message log could not be loaded.');
      logState.value = 'error';
      return;
    }
  }
  try {
    historyFallback.value = true;
    scopeCounts.value = null;
    applyLogPage(await apiRequest<HistoryPage>(`/messages?${params.toString()}`));
  } catch (reason) {
    logRows.value = [];
    logMissing.value = isMissing(reason);
    logError.value = messageFrom(reason, 'The message log could not be loaded.');
    logState.value = 'error';
  }
}

const visibleLogRows = computed(() => logRows.value.filter(matchesStatusFilter));
const selectableLogRows = computed(() => visibleLogRows.value.filter(isSelectable));
const allLogSelected = computed(
  () =>
    selectableLogRows.value.length > 0 &&
    selectableLogRows.value.every((row) => logSelection.value.includes(resendId(row))),
);
function isLogSelected(row: RecordValue) {
  const id = resendId(row);
  return Boolean(id) && logSelection.value.includes(id);
}
function toggleLogRow(row: RecordValue) {
  const id = resendId(row);
  if (!id || !isSelectable(row)) return;
  logSelection.value = logSelection.value.includes(id)
    ? logSelection.value.filter((entry) => entry !== id)
    : [...logSelection.value, id];
}
function toggleAllLog() {
  logSelection.value = allLogSelected.value
    ? []
    : [...new Set(selectableLogRows.value.map((row) => resendId(row)).filter(Boolean))];
}

async function postResend(body: RecordValue) {
  actionBusy.value = true;
  resendNotice.value = '';
  resendError.value = '';
  resendResults.value = [];
  try {
    const result = await apiRequest<ResendResult>('/queue-console/resend', {
      method: 'POST',
      body: JSON.stringify({ ...body, targetSmscId: resendTarget.value }),
    });
    const skipped = num(result.skipped);
    resendNotice.value =
      `${num(result.resent)} of ${num(result.requested)} message(s) re-queued on ${resendTarget.value}.` +
      (skipped ? ` ${skipped} skipped — see the per-message reasons below.` : '');
    resendResults.value = Array.isArray(result.results) ? result.results : [];
    logSelection.value = [];
    await Promise.all([loadSpool(), loadLive(), loadLog()]);
  } catch (reason) {
    resendError.value = messageFrom(reason, 'The messages could not be resent.');
  } finally {
    actionBusy.value = false;
  }
}

function resendSelected() {
  if (!canOperate.value || !resendTarget.value || !logSelection.value.length) return;
  return postResend({ ids: logSelection.value });
}

/**
 * Resend everything matching the current filter, not just the loaded page. The
 * backend caps a filtered batch at 500 messages.
 */
function resendMatching() {
  if (!canOperate.value || !resendTarget.value || logStatus.value === 'all') return;
  const matching = statusCount(logStatus.value);
  if (!matching) return;
  if (
    !window.confirm(
      `Resend every message matching the “${logStatus.value}” filter (${matching}) to ${resendTarget.value}?\n\nEach one is submitted again as a new message; at most 500 are sent per batch.`,
    )
  )
    return;
  const filter: RecordValue = { status: logStatus.value, limit: 500 };
  if (logQuery.value.trim()) filter.query = logQuery.value.trim();
  if (logSmscFilter.value) filter.smscId = logSmscFilter.value;
  return postResend({ filter });
}

// --- Pending spool grid (usually empty on a healthy engine) -----------------
const spoolRows = ref<RecordValue[]>([]);
const spoolState = ref<'loading' | 'ok' | 'error'>('loading');
const spoolError = ref('');
const spoolMissing = ref(false);
const spoolTotal = ref(0);
const spoolCursor = ref('');
const spoolHistory = ref<string[]>([]);
const spoolNextCursor = ref('');
const spoolSmscFilter = ref('');
const spoolQuery = ref('');
const spoolSelection = ref<string[]>([]);
const spoolNotice = ref('');
const spoolActionError = ref('');
const spoolResults = ref<SpoolResultRow[]>([]);
const rerouteTarget = ref('');
const SPOOL_LIMIT = 100;

/**
 * Field accessors for a pending spool row. The SQLBox repository normalises
 * send_sms rows to { id, sender, receiver, text, smscId, timestamp, externalRef,
 * raw: { sql_id, msgdata, time, smsc_id, foreign_id, … } }; the queue-console
 * contract also documents sqlId/msgdata/time/foreignId, so both shapes are read.
 */
function spoolId(row: RecordValue): string {
  const raw = rawOf(row);
  return text(row.sqlId ?? row.sql_id ?? row.id ?? raw.sql_id, '');
}
function spoolSmscId(row: RecordValue): string {
  return text(row.smscId ?? row.smsc_id ?? rawOf(row).smsc_id, 'unrouted');
}
function spoolEpoch(row: RecordValue): number {
  const raw = rawOf(row);
  const epoch = num(row.time ?? raw.time);
  if (epoch) return epoch;
  const stamp = Date.parse(text(row.timestamp ?? row.created_at, ''));
  return Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0;
}
function spoolForeignId(row: RecordValue): string {
  const raw = rawOf(row);
  return text(row.foreignId ?? row.foreign_id ?? row.externalRef ?? raw.foreign_id);
}
function spoolSender(row: RecordValue): string {
  return text(row.sender ?? rawOf(row).sender);
}
function spoolReceiver(row: RecordValue): string {
  return text(row.receiver ?? rawOf(row).receiver);
}

const allSpoolSelected = computed(
  () =>
    spoolRows.value.length > 0 &&
    spoolRows.value.every((row) => spoolSelection.value.includes(spoolId(row))),
);
function isSpoolSelected(row: RecordValue) {
  return spoolSelection.value.includes(spoolId(row));
}
function toggleSpoolRow(row: RecordValue) {
  const id = spoolId(row);
  if (!id) return;
  spoolSelection.value = spoolSelection.value.includes(id)
    ? spoolSelection.value.filter((entry) => entry !== id)
    : [...spoolSelection.value, id];
}
function toggleAllSpool() {
  spoolSelection.value = allSpoolSelected.value
    ? []
    : spoolRows.value.map((row) => spoolId(row)).filter(Boolean);
}

async function loadSpool() {
  spoolMissing.value = false;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(SPOOL_LIMIT));
    if (spoolCursor.value) params.set('cursor', spoolCursor.value);
    if (spoolSmscFilter.value) params.set('smscId', spoolSmscFilter.value);
    if (spoolQuery.value.trim()) params.set('query', spoolQuery.value.trim());
    const payload = await apiRequest<{
      items?: RecordValue[];
      nextCursor?: string | number | null;
      total?: number;
    }>(`/queue-console/spool?${params.toString()}`);
    spoolRows.value = Array.isArray(payload.items)
      ? payload.items.filter(
          (item): item is RecordValue => Boolean(item) && typeof item === 'object',
        )
      : [];
    spoolNextCursor.value =
      payload.nextCursor === null || payload.nextCursor === undefined
        ? ''
        : String(payload.nextCursor);
    spoolTotal.value = num(payload.total ?? spoolRows.value.length);
    spoolError.value = '';
    spoolState.value = 'ok';
    // Drop selections the engine already collected between two polls.
    const visible = new Set(spoolRows.value.map((row) => spoolId(row)));
    spoolSelection.value = spoolSelection.value.filter((id) => visible.has(id));
  } catch (reason) {
    spoolRows.value = [];
    spoolTotal.value = 0;
    spoolNextCursor.value = '';
    spoolMissing.value = isMissing(reason);
    spoolError.value = messageFrom(reason, 'The pending spool could not be loaded.');
    spoolState.value = 'error';
  }
}

function applySpoolFilters() {
  spoolCursor.value = '';
  spoolHistory.value = [];
  void loadSpool();
}
function turnSpoolPage(direction: number) {
  if (direction > 0) {
    if (!spoolNextCursor.value) return;
    spoolHistory.value = [...spoolHistory.value, spoolCursor.value];
    spoolCursor.value = spoolNextCursor.value;
  } else {
    if (!spoolHistory.value.length) return;
    const history = [...spoolHistory.value];
    spoolCursor.value = history.pop() ?? '';
    spoolHistory.value = history;
  }
  void loadSpool();
}

/** sqlIds travel as numbers where the id is numeric, matching the API contract. */
function idPayload(ids: string[]): Array<number | string> {
  return ids.map((id) => (Number.isFinite(Number(id)) ? Number(id) : id));
}

async function rerouteSelected() {
  if (!canOperate.value || !rerouteTarget.value || !spoolSelection.value.length) return;
  actionBusy.value = true;
  spoolNotice.value = '';
  spoolActionError.value = '';
  spoolResults.value = [];
  try {
    const result = await apiRequest<RerouteResult>('/queue-console/spool/reroute', {
      method: 'POST',
      body: JSON.stringify({
        sqlIds: idPayload(spoolSelection.value),
        targetSmscId: rerouteTarget.value,
      }),
    });
    const skipped = num(result.skipped);
    spoolNotice.value =
      `${num(result.rerouted)} of ${num(result.requested)} pending message(s) rerouted to ` +
      `${text(result.targetSmscId, rerouteTarget.value)}.` +
      (skipped
        ? ` ${skipped} skipped — those were already handed to the engine between loading the grid and clicking reroute. That is expected on a healthy engine (it drains the spool in under a second), not an error. Resend them from the message log instead.`
        : '');
    spoolResults.value = (Array.isArray(result.results) ? result.results : []).filter(
      (entry) => entry.rerouted === false,
    );
    spoolSelection.value = [];
    await Promise.all([loadSpool(), loadLive()]);
  } catch (reason) {
    spoolActionError.value = messageFrom(reason, 'The reroute could not be applied.');
  } finally {
    actionBusy.value = false;
  }
}

async function cancelSelected() {
  if (!canOperate.value || !spoolSelection.value.length) return;
  if (
    !window.confirm(
      `Cancel ${spoolSelection.value.length} pending message(s)? They are removed from the spool and will never be delivered.`,
    )
  )
    return;
  actionBusy.value = true;
  spoolNotice.value = '';
  spoolActionError.value = '';
  spoolResults.value = [];
  try {
    const result = await apiRequest<CancelResult>('/queue-console/spool/cancel', {
      method: 'POST',
      body: JSON.stringify({ sqlIds: idPayload(spoolSelection.value) }),
    });
    const skipped = num(result.skipped);
    spoolNotice.value =
      `${num(result.cancelled)} of ${num(result.requested)} pending message(s) cancelled.` +
      (skipped
        ? ` ${skipped} skipped — already handed to the engine before the cancel landed.`
        : '');
    spoolResults.value = (Array.isArray(result.results) ? result.results : []).filter(
      (entry) => entry.cancelled === false,
    );
    spoolSelection.value = [];
    await Promise.all([loadSpool(), loadLive()]);
  } catch (reason) {
    spoolActionError.value = messageFrom(reason, 'The messages could not be cancelled.');
  } finally {
    actionBusy.value = false;
  }
}

// --- Bind controls ----------------------------------------------------------
const bindBusyId = ref('');
const bindNotice = ref('');
const bindError = ref('');

async function controlBind(bind: BindSnapshot, operation: 'enable' | 'disable' | 'reconnect') {
  const engineId = text(bind.engineId, '');
  if (!canManageBinds.value || !engineId || engineId === '—') return;
  const label = text(bind.name ?? bind.smscName, engineId);
  if (
    operation === 'disable' &&
    !window.confirm(
      `Disable the bind “${label}” (${engineId})?\n\nThis stops ONLY this one SMPP bind. The engine and every other bind keep running. Traffic already queued for this bind stays put until it is enabled again, rerouted, or resent to another bind.`,
    )
  )
    return;
  bindBusyId.value = engineId;
  bindNotice.value = '';
  bindError.value = '';
  try {
    const result = await apiRequest<{ accepted?: boolean; detail?: string }>(
      `/queue-console/binds/${encodeURIComponent(engineId)}/control`,
      { method: 'POST', body: JSON.stringify({ operation }) },
    );
    const detail = text(result.detail, '');
    const outcome = result.accepted === false ? 'was not accepted by the engine' : 'accepted';
    bindNotice.value = `Bind “${label}”: ${operation} ${outcome}${detail ? ` — ${detail}` : ''}.`;
    // The engine needs a moment to reflect the change; the next poll confirms it.
    await loadLive();
  } catch (reason) {
    bindError.value = messageFrom(reason, `The bind could not be ${operation}d.`);
  } finally {
    bindBusyId.value = '';
  }
}

// --- Auto refresh -----------------------------------------------------------
// One poll = live snapshot + spool grid. The shared composable owns the timer,
// the overlap guard, the hidden-tab guard and the unmount cleanup; `pauseWhen`
// holds automatic ticks off while a bulk action is in flight so the grid does
// not reload out from under a selection.
const refreshChoices = [2, 5, 10, 30, 60];
const {
  autoRefresh,
  intervalSeconds: refreshSeconds,
  refreshing,
  refreshNow,
} = useLiveResource(() => Promise.all([loadLive(), loadSpool()]), {
  intervalSeconds: 5,
  immediate: false,
  pauseWhen: () => actionBusy.value,
});

onMounted(() => {
  void loadLive();
  void loadSpool();
  void loadLog();
  void loadSmscOptions();
});
</script>

<template>
  <div data-testid="live-queue-view">
    <!-- Refresh controls ---------------------------------------------------- -->
    <section class="toolbar panel grid-toolbar" aria-label="Live queue refresh controls">
      <label class="filter-select">
        <span>Auto refresh</span>
        <select v-model="autoRefresh" data-testid="live-auto-toggle">
          <option :value="true">On</option>
          <option :value="false">Off</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Every</span>
        <select v-model.number="refreshSeconds" data-testid="live-interval">
          <option v-for="choice in refreshChoices" :key="choice" :value="choice">
            {{ choice }}s
          </option>
        </select>
      </label>
      <button
        class="primary-button"
        data-testid="live-refresh"
        :disabled="refreshing"
        @click="refreshNow(true)"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh' }}
      </button>
      <span class="source-note" data-testid="live-last-refreshed">
        {{
          lastRefreshedAt
            ? `Last updated ${lastRefreshedAt}${autoRefresh ? '' : ' — auto refresh is off'}`
            : 'Waiting for the first snapshot…'
        }}
      </span>
    </section>

    <!-- Engine header strip -------------------------------------------------- -->
    <section class="panel" data-testid="engine-strip" aria-label="Engine runtime">
      <header class="panel-header">
        <div>
          <h2>Engine</h2>
          <p aria-live="polite">
            {{
              liveState === 'loading'
                ? 'Loading the live snapshot…'
                : liveState === 'error'
                  ? 'Live snapshot unavailable'
                  : `Observed ${text(live?.observedAt)}`
            }}
          </p>
        </div>
        <span class="status-badge" :class="badgeTone(text(engine.status, 'unknown'))">
          {{ text(engine.status, 'unknown') }}
        </span>
      </header>

      <p v-if="liveState === 'error'" class="chart-empty" role="alert" data-testid="live-error">
        {{ liveMissing ? 'The live queue console API is not available yet.' : liveError }}
      </p>

      <template v-else>
        <p v-if="runtimeDegraded" class="warn-notice" role="alert" data-testid="live-source-banner">
          Engine runtime {{ sourceStatus === 'unavailable' ? 'unreachable' : 'degraded' }} — the
          engine and per-bind counters below are not live and must not be read as real zeros. Spool
          and message data are still live, read straight from the message store.
          <span v-if="sourceDetail" class="mono">{{ sourceDetail }}</span>
        </p>
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="engine-queued-out">{{ num(engine.smsQueuedOut) }}</strong>
            <small>SMS queued out</small>
          </div>
          <div class="metric">
            <strong data-testid="engine-queued-in">{{ num(engine.smsQueuedIn) }}</strong>
            <small>SMS queued in</small>
          </div>
          <div class="metric">
            <strong data-testid="engine-dlr-queued">{{ num(engine.dlrQueued) }}</strong>
            <small>DLR queued</small>
          </div>
          <div class="metric">
            <strong data-testid="engine-spool-queued">{{ num(spoolSummary.queued) }}</strong>
            <small>Pending in spool</small>
          </div>
          <div class="metric">
            <strong>{{ ageFromEpoch(spoolSummary.oldestEpoch) }}</strong>
            <small>Oldest pending</small>
          </div>
          <div class="metric">
            <strong>{{ duration(engine.uptimeSeconds) }}</strong>
            <small>Uptime</small>
          </div>
          <div class="metric">
            <strong>{{ text(engine.version) }}</strong>
            <small>Version</small>
          </div>
        </div>
        <p class="source-note">
          Source: {{ text(live?.source?.status, 'ok')
          }}<span v-if="sourceDetail"> — {{ sourceDetail }}</span>
        </p>
      </template>
    </section>

    <!-- Per-bind cards ------------------------------------------------------- -->
    <section class="panel" data-testid="bind-panel" aria-label="SMPP binds">
      <header class="panel-header">
        <div>
          <h2>Binds</h2>
          <p aria-live="polite">
            {{
              liveState === 'loading'
                ? 'Loading binds…'
                : `${binds.length} bind(s) reported by the engine`
            }}
          </p>
        </div>
      </header>
      <p v-if="bindNotice" class="notice" role="status" data-testid="bind-notice">
        {{ bindNotice }}
      </p>
      <p v-if="bindError" class="form-error" role="alert" data-testid="bind-error">
        {{ bindError }}
      </p>
      <p v-if="liveState === 'ok' && !binds.length" class="chart-empty" data-testid="binds-empty">
        The engine reports no binds. Add an SMSC connection to start delivering traffic.
      </p>
      <div v-else class="container-grid">
        <article
          v-for="bind in binds"
          :key="text(bind.engineId)"
          class="container-card"
          :data-testid="`bind-card-${text(bind.engineId)}`"
        >
          <header>
            <strong>{{ text(bind.name ?? bind.smscName, text(bind.engineId)) }}</strong>
            <span
              class="status-badge"
              :class="badgeTone(text(bind.status, 'unknown'))"
              :data-testid="`bind-status-${text(bind.engineId)}`"
            >
              {{ text(bind.status, 'unknown') }}
            </span>
          </header>
          <p class="row-id mono">{{ text(bind.engineId) }}</p>
          <div class="summary-strip">
            <div class="metric">
              <strong :data-testid="`bind-queued-${text(bind.engineId)}`">
                {{ num(bind.queued) }}
              </strong>
              <small>queued on this bind</small>
            </div>
          </div>
          <dl>
            <dt>Failed</dt>
            <dd>{{ num(bind.failed) }}</dd>
            <dt>Sent</dt>
            <dd>{{ num(bind.sent) }}</dd>
            <dt>Received</dt>
            <dd>{{ num(bind.received) }}</dd>
            <dt>Outbound rate</dt>
            <dd>{{ (bind.outboundRate ?? []).map((rate) => num(rate)).join(' / ') || '—' }}</dd>
            <dt>Known SMSC</dt>
            <dd>{{ bind.known === false ? 'not configured in console' : text(bind.smscName) }}</dd>
          </dl>
          <div v-if="canManageBinds" class="detail-actions">
            <button
              class="secondary-button"
              :data-testid="`bind-enable-${text(bind.engineId)}`"
              :disabled="bindBusyId === text(bind.engineId)"
              @click="controlBind(bind, 'enable')"
            >
              Enable
            </button>
            <button
              class="secondary-button"
              :data-testid="`bind-reconnect-${text(bind.engineId)}`"
              :disabled="bindBusyId === text(bind.engineId)"
              @click="controlBind(bind, 'reconnect')"
            >
              Reconnect
            </button>
            <button
              class="secondary-button danger-button"
              :data-testid="`bind-disable-${text(bind.engineId)}`"
              :disabled="bindBusyId === text(bind.engineId)"
              @click="controlBind(bind, 'disable')"
            >
              Disable this bind
            </button>
          </div>
          <p v-else class="source-note">Bind control requires the smsc.manage permission.</p>
        </article>
      </div>
      <p v-if="canManageBinds && binds.length" class="source-note">
        Enable / disable / reconnect act on a single SMPP bind. The engine and every other bind keep
        running. After disabling a sick bind, filter the message log below to failed and resend that
        traffic to a healthy bind.
      </p>
    </section>

    <!-- Message log + resend (primary operator flow) -------------------------- -->
    <section class="panel" data-testid="log-panel" aria-label="Message log and resend">
      <header class="panel-header">
        <div>
          <h2>Message log &amp; resend</h2>
          <p aria-live="polite">
            {{
              logState === 'loading'
                ? 'Loading message history…'
                : `${visibleLogRows.length} of ${logRows.length} loaded message(s) shown${
                    logSelection.length ? ` · ${logSelection.length} selected` : ''
                  }`
            }}
          </p>
        </div>
        <button class="secondary-button" data-testid="log-refresh" @click="loadLog">Refresh</button>
      </header>

      <div class="status-presets" data-testid="log-status-presets">
        <button
          v-for="preset in statusPresets"
          :key="preset.value"
          class="secondary-button"
          :class="{ 'preset-active': logStatus === preset.value }"
          :data-testid="`log-preset-${preset.value}`"
          :aria-pressed="logStatus === preset.value"
          @click="selectPreset(preset.value)"
        >
          {{ preset.label }}
          <span class="preset-count">{{ statusCount(preset.value) }}</span>
        </button>
      </div>

      <div class="grid-toolbar">
        <label class="filter-select">
          <span>Status</span>
          <select v-model="logStatus" data-testid="log-status-filter" @change="loadLog">
            <option v-for="choice in statusChoices" :key="choice.value" :value="choice.value">
              {{ choice.label }} ({{ statusCount(choice.value) }})
            </option>
          </select>
        </label>
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="logQuery"
            data-testid="log-search"
            type="search"
            placeholder="Sender, receiver, reference, or text"
            @keyup.enter="loadLog"
          />
        </label>
        <label class="filter-select">
          <span>Bind</span>
          <select v-model="logSmscFilter" data-testid="log-smsc-filter" @change="loadLog">
            <option value="">All binds</option>
            <option v-for="option in bindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button class="secondary-button" data-testid="log-apply" @click="loadLog">
          Apply filters
        </button>
      </div>

      <div v-if="canOperate" class="grid-toolbar" data-testid="log-bulk-actions">
        <label class="filter-select">
          <span>Resend to bind</span>
          <select v-model="resendTarget" data-testid="log-resend-target">
            <option value="" disabled>Select a target bind</option>
            <option v-for="option in bindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button
          class="primary-button"
          data-testid="log-resend"
          :disabled="actionBusy || !resendTarget || !logSelection.length"
          @click="resendSelected"
        >
          {{ actionBusy ? 'Working…' : `Resend ${logSelection.length} selected` }}
        </button>
        <button
          v-if="logStatus !== 'all'"
          class="secondary-button"
          data-testid="log-resend-matching"
          :disabled="actionBusy || !resendTarget || !statusCount(logStatus)"
          @click="resendMatching"
        >
          Resend all {{ statusCount(logStatus) }} matching
        </button>
        <span class="source-note">
          Resending re-queues a fresh copy of each message on the chosen bind; the original history
          row is left untouched.
        </span>
      </div>
      <p v-else class="source-note" data-testid="log-readonly">
        Resending messages requires the messages.send permission.
      </p>

      <p v-if="smscOptionsError" class="source-note" data-testid="bind-options-error">
        {{ smscOptionsError }}
      </p>
      <p v-if="resendNotice" class="notice" role="status" data-testid="log-resend-notice">
        {{ resendNotice }}
      </p>
      <p v-if="resendError" class="form-error" role="alert" data-testid="log-resend-error">
        {{ resendError }}
      </p>
      <ul v-if="resendResults.length" class="sample-list" data-testid="log-resend-results">
        <li v-for="(result, index) in resendResults" :key="`${text(result.id)}-${index}`">
          <span class="mono">{{ text(result.id) }}</span>
          <span v-if="result.error" class="status-badge bad">{{ result.error }}</span>
          <span v-else class="status-badge good">re-queued as {{ text(result.sqlId) }}</span>
          <small v-if="result.code" class="mono">{{ result.code }}</small>
        </li>
      </ul>

      <p v-if="logStatus === 'pending'" class="source-note" data-testid="log-pending-hint">
        Pending messages have been submitted but have no delivery report yet. Messages not even
        handed to a bind are in the pending spool panel below.
      </p>
      <p
        v-if="(!hasDeliveryStatus || historyFallback) && logState === 'ok' && logRows.length"
        class="source-note"
        data-testid="log-derived-note"
      >
        This deployment does not classify messages by delivery outcome yet, so statuses here are
        derived from the delivery receipts themselves and counts cover only the loaded page;
        resending a receipt row resends the message it reports on.
      </p>

      <p v-if="logState === 'error'" class="chart-empty" role="alert" data-testid="log-unavailable">
        {{ logMissing ? 'The message history API is not available yet.' : logError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  data-testid="log-select-all"
                  aria-label="Select all resendable messages"
                  :checked="allLogSelected"
                  :disabled="!selectableLogRows.length"
                  @change="toggleAllLog"
                />
              </th>
              <th scope="col">Status</th>
              <th scope="col">Sender</th>
              <th scope="col">Receiver</th>
              <th scope="col">Text</th>
              <th scope="col">Bind</th>
              <th scope="col">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in visibleLogRows"
              :key="logId(row) || String(index)"
              :data-testid="`log-row-${logId(row)}`"
            >
              <td>
                <input
                  type="checkbox"
                  :data-testid="`log-select-${logId(row)}`"
                  :aria-label="`Select message ${logId(row)}`"
                  :checked="isLogSelected(row)"
                  :disabled="!isSelectable(row)"
                  :title="
                    isSelectable(row)
                      ? undefined
                      : 'Delivery receipts are records of an outcome, not sendable messages.'
                  "
                  @change="toggleLogRow(row)"
                />
              </td>
              <td>
                <span class="status-badge" :class="badgeTone(effectiveStatus(row))">
                  {{ effectiveStatus(row) }}
                </span>
                <span v-if="isReceipt(row)" class="row-id">receipt</span>
              </td>
              <td class="mono">{{ text(row.sender) }}</td>
              <td class="mono">{{ text(row.receiver) }}</td>
              <td>{{ bodyText(row) }}</td>
              <td class="mono">{{ text(row.smscId ?? row.smsc_id) }}</td>
              <td>{{ text(row.timestamp) }}</td>
            </tr>
            <tr v-if="logState === 'ok' && !visibleLogRows.length">
              <td colspan="7" class="empty-cell" data-testid="log-empty">
                No messages match this filter.
              </td>
            </tr>
            <tr v-if="logState === 'loading'">
              <td colspan="7" class="empty-cell">Loading message history…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="source-note" data-testid="log-counts-note">
        Resendable failures are the operator entry point: filter here, select the rows, then resend
        them to a healthy bind.
        {{
          scopeCounts
            ? 'Counts cover every message in the current search/bind scope, not just this page.'
            : `Counts reflect the ${logRows.length} message(s) loaded on this page.`
        }}
      </p>
    </section>

    <!-- Pending spool grid ---------------------------------------------------- -->
    <section class="panel" data-testid="spool-panel" aria-label="Pending spool">
      <header class="panel-header">
        <div>
          <h2>Pending spool</h2>
          <p aria-live="polite">
            {{
              spoolState === 'loading'
                ? 'Loading pending messages…'
                : `${spoolRows.length} pending message(s) shown${
                    spoolSelection.length ? ` · ${spoolSelection.length} selected` : ''
                  }`
            }}
          </p>
        </div>
      </header>
      <p class="source-note">
        Messages that have been accepted but not yet handed to a bind. A healthy engine drains this
        in under a second, so an empty grid here is the normal, healthy state.
      </p>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="spoolQuery"
            data-testid="spool-search"
            type="search"
            placeholder="Sender, receiver, or message text"
            @keyup.enter="applySpoolFilters"
          />
        </label>
        <label class="filter-select">
          <span>Target bind</span>
          <select
            v-model="spoolSmscFilter"
            data-testid="spool-smsc-filter"
            @change="applySpoolFilters"
          >
            <option value="">All binds</option>
            <option v-for="option in bindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button class="secondary-button" data-testid="spool-apply" @click="applySpoolFilters">
          Apply filters
        </button>
      </div>

      <div v-if="canOperate" class="grid-toolbar" data-testid="spool-bulk-actions">
        <label class="filter-select">
          <span>Reroute to bind</span>
          <select v-model="rerouteTarget" data-testid="spool-reroute-target">
            <option value="" disabled>Select a target bind</option>
            <option v-for="option in bindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button
          class="primary-button"
          data-testid="spool-reroute"
          :disabled="actionBusy || !rerouteTarget || !spoolSelection.length"
          @click="rerouteSelected"
        >
          {{ actionBusy ? 'Working…' : `Reroute ${spoolSelection.length} selected` }}
        </button>
        <button
          class="secondary-button danger-button"
          data-testid="spool-cancel"
          :disabled="actionBusy || !spoolSelection.length"
          @click="cancelSelected"
        >
          Cancel selected
        </button>
      </div>
      <p v-else class="source-note" data-testid="spool-readonly">
        Rerouting and cancelling pending messages requires the messages.send permission.
      </p>

      <p v-if="spoolNotice" class="notice" role="status" data-testid="spool-notice">
        {{ spoolNotice }}
      </p>
      <p v-if="spoolActionError" class="form-error" role="alert" data-testid="spool-action-error">
        {{ spoolActionError }}
      </p>
      <ul v-if="spoolResults.length" class="sample-list" data-testid="spool-skip-results">
        <li v-for="(result, index) in spoolResults" :key="`${text(result.sqlId)}-${index}`">
          <span class="mono">{{ text(result.sqlId) }}</span>
          <span>{{ text(result.reason, 'skipped') }}</span>
          <small class="mono">{{ text(result.code) }}</small>
        </li>
      </ul>

      <p
        v-if="spoolState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="spool-unavailable"
      >
        {{ spoolMissing ? 'The queue console spool API is not available yet.' : spoolError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  data-testid="spool-select-all"
                  aria-label="Select all pending messages"
                  :checked="allSpoolSelected"
                  :disabled="!spoolRows.length"
                  @change="toggleAllSpool"
                />
              </th>
              <th scope="col">Sender</th>
              <th scope="col">Receiver</th>
              <th scope="col">Text</th>
              <th scope="col">Target bind</th>
              <th scope="col">Age</th>
              <th scope="col">SQL ID</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in spoolRows"
              :key="spoolId(row) || String(index)"
              :data-testid="`spool-row-${spoolId(row)}`"
            >
              <td>
                <input
                  type="checkbox"
                  :data-testid="`spool-select-${spoolId(row)}`"
                  :aria-label="`Select pending message ${spoolId(row)}`"
                  :checked="isSpoolSelected(row)"
                  @change="toggleSpoolRow(row)"
                />
              </td>
              <td class="mono">{{ spoolSender(row) }}</td>
              <td class="mono">{{ spoolReceiver(row) }}</td>
              <td>{{ bodyText(row) }}</td>
              <td class="mono">{{ spoolSmscId(row) }}</td>
              <td>{{ ageFromEpoch(spoolEpoch(row)) }}</td>
              <td class="mono">
                {{ spoolId(row) }}
                <span v-if="spoolForeignId(row) !== '—'" class="row-id">
                  {{ spoolForeignId(row) }}
                </span>
              </td>
            </tr>
            <tr v-if="spoolState === 'ok' && !spoolRows.length">
              <td colspan="7" class="empty-cell" data-testid="spool-empty">
                Spool is empty — the engine is accepting messages as fast as they arrive. Messages
                appear here only when submissions outpace the engine or a bind is paused.
              </td>
            </tr>
            <tr v-if="spoolState === 'loading'">
              <td colspan="7" class="empty-cell">Loading pending messages…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="cursor-pager">
        <span class="source-note" data-testid="spool-total">{{ spoolTotal }} loaded</span>
        <button
          class="secondary-button"
          data-testid="spool-prev"
          :disabled="!spoolHistory.length"
          @click="turnSpoolPage(-1)"
        >
          Previous
        </button>
        <button
          class="secondary-button"
          data-testid="spool-next"
          :disabled="!spoolNextCursor"
          @click="turnSpoolPage(1)"
        >
          Load more
        </button>
      </footer>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
