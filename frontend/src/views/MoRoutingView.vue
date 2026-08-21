<script setup lang="ts">
/**
 * INBOUND (MO) ROUTING — rules, fan-out destinations, ingest and delivery.
 *
 * Backend contract: `backend/src/messaging-depth/mo.controller.ts`
 * (`@Controller('mo')`), `mo-rules.service.ts` (`MO_RULE_GRID`),
 * `mo-inbound.service.ts` (`MO_MESSAGE_GRID`, `MO_DELIVERY_GRID`),
 * `mo-routing.ts` (matching + SSRF validation) and `mo-delivery.service.ts`.
 *
 *   GET/POST/PATCH/DELETE /mo/rules[/:id]
 *   POST   /mo/rules/:id/destinations, DELETE …/destinations/:destinationId
 *   POST   /mo/rules/preview
 *   GET    /mo/ingest/status, POST /mo/ingest/sweep, POST /mo/ingest/polling
 *   GET    /mo/messages[/:id], GET /mo/deliveries, POST /mo/deliveries/:id/retry
 *
 * ON THE INGEST-PATH CLAIM. `GET /mo/ingest/status` returns nine fields and not
 * one of them describes the push path, and the console cannot read the engine's
 * configuration file. So the ingest panel reports the sweep's real state from
 * that endpoint, and for the push path reports OBSERVED EVIDENCE only — the
 * count of `mo_messages` rows with `source=http` versus `source=sqlbox`, which
 * is the only thing this API can prove. It never claims inbound routing is
 * fully wired.
 *
 * MO matching is NOT first-match-wins like content filtering: a rule with
 * `continue_after_match` lets evaluation carry on, so several rules can fan out
 * the same message. The preview reports `stoppedEarly` and how many rules were
 * evaluated, which is what makes that visible.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

interface Option {
  value: string;
  label: string;
}
interface IngestStatus {
  watermark_sql_id?: string;
  polling_enabled?: boolean;
  poll_interval_seconds?: number;
  last_polled_at?: string | null;
  last_error?: string | null;
  ingested_total?: string;
  updated_at?: string;
}
interface SweepResult {
  scanned?: number;
  ingested?: number;
  duplicates?: number;
  deliveries?: number;
  watermark?: string;
  available?: boolean;
  evidence?: string;
}
interface PreviewMatch {
  ruleId?: string;
  ruleName?: string;
  priority?: number;
  matchedOn?: string[];
  destinationCount?: number;
  continueAfterMatch?: boolean;
}
interface PreviewDelivery {
  ruleId?: string;
  ruleName?: string;
  destinationId?: string;
  kind?: string;
  target?: string;
}
interface PreviewResult {
  matches?: PreviewMatch[];
  rulesEvaluated?: number;
  rulesLoaded?: number;
  stoppedEarly?: boolean;
  deliveries?: PreviewDelivery[];
}

/** Mirrors MO_DESTINATION_MATCH_TYPES / MO_KEYWORD_MATCH_TYPES / MO_DELIVERY_KINDS. */
const DESTINATION_MATCH_TYPES = ['any', 'exact', 'prefix'];
const KEYWORD_MATCH_TYPES = ['any', 'first_word', 'substring', 'exact'];
const DELIVERY_KINDS = ['webhook', 'email', 'sms'];
const MESSAGE_STATUSES = ['matched', 'no_match'];
const MESSAGE_SOURCES = ['sqlbox', 'http'];
const DELIVERY_STATUSES = ['pending', 'running', 'delivered', 'failed', 'dead_letter', 'cancelled'];
/** Only these three may be retried — mo-inbound.service.ts `retryDelivery`. */
const RETRYABLE = ['failed', 'dead_letter', 'cancelled'];
/** MAX_DESTINATIONS_PER_RULE in mo-rules.service.ts. */
const MAX_DESTINATIONS = 20;

/** Exactly MO_RULE_GRID.sortColumns; '' sends no sort, i.e. true evaluation order. */
const RULE_SORT_FIELDS: Option[] = [
  { value: '', label: 'Evaluation order (priority, then age)' },
  { value: 'priority', label: 'priority' },
  { value: 'name', label: 'name' },
  { value: 'enabled', label: 'enabled' },
  { value: 'createdAt', label: 'createdAt' },
  { value: 'updatedAt', label: 'updatedAt' },
];
/** Exactly MO_MESSAGE_GRID.sortColumns. */
const MESSAGE_SORT_FIELDS = [
  'receivedAt',
  'createdAt',
  'sender',
  'receiver',
  'status',
  'fanoutCount',
];
/**
 * MO_DELIVERY_GRID.sortColumns minus `deliveredAt`: that column is NULL for
 * every delivery that has not landed, and the shared keyset helper documents
 * that it does not order NULL sort keys. Offset paging is used here, but the
 * option is still left out rather than shipping a sort whose meaning changes
 * with the paging mode.
 */
const DELIVERY_SORT_FIELDS = ['createdAt', 'updatedAt', 'status', 'attempts', 'kind'];
const PAGE_SIZES = [25, 50, 100, 250];

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
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}
function badgeTone(value: unknown) {
  const status = String(value ?? '').toLowerCase();
  if (['delivered', 'matched'].includes(status)) return 'good';
  if (['pending', 'running'].includes(status)) return 'warn';
  if (['failed', 'dead_letter', 'cancelled'].includes(status)) return 'bad';
  return '';
}

// Reads are messages.view (also the route guard). Every mutation here, INCLUDING
// running a sweep, requires messages.send: an ingest can fan out to an `sms`
// destination, so it can cause outbound traffic.
const canManage = computed(() => canAccess(session.value, 'messages.send'));

// --- SMSC options (matchSmscId is the ENGINE id) -----------------------------
const smscOptions = ref<Option[]>([]);

async function loadSmscOptions() {
  try {
    smscOptions.value = asItems(await apiRequest<unknown>('/smscs?limit=500&offset=0'))
      .map((row) => {
        const engineId = text(row.engine_id ?? row.engineId, '');
        return { value: engineId, label: `${text(row.name)} (${engineId})` };
      })
      .filter((option) => option.value && option.value !== '—');
  } catch {
    smscOptions.value = [];
  }
}

// --- Ingest ------------------------------------------------------------------
const ingest = ref<IngestStatus | null>(null);
const ingestState = ref<LoadState>('loading');
const ingestError = ref('');
const ingestMissing = ref(false);
const ingestNotice = ref('');
const sweepResult = ref<SweepResult | null>(null);
const sweepLimit = ref(200);
const pollInterval = ref(30);
const ingestBusy = ref(false);
/** Observed evidence per source; null until counted, so "0" is never guessed. */
const sourceCounts = ref<{ sqlbox: number | null; http: number | null }>({
  sqlbox: null,
  http: null,
});

async function loadIngest() {
  ingestState.value = 'loading';
  ingestMissing.value = false;
  try {
    const status = await apiRequest<IngestStatus>('/mo/ingest/status');
    ingest.value = status;
    if (Number.isInteger(status.poll_interval_seconds))
      pollInterval.value = Number(status.poll_interval_seconds);
    ingestError.value = '';
    ingestState.value = 'ok';
  } catch (reason) {
    ingest.value = null;
    ingestMissing.value = isMissing(reason);
    ingestError.value = messageFrom(reason, 'The MO ingest status could not be loaded.');
    ingestState.value = 'error';
  }
}

/**
 * The only evidence this API can give about which path traffic actually
 * arrived by: `mo_messages.source` is `sqlbox` (engine sweep) or `http` (push),
 * and `source` is in MO_MESSAGE_GRID.filterColumns, so each can be counted with
 * a one-row page and its `total`.
 */
async function countSources() {
  const one = async (source: string) => {
    try {
      const payload = await apiRequest<RecordValue>(
        `/mo/messages?filter.source=${source}&limit=1&offset=0`,
      );
      return typeof payload.total === 'number' ? payload.total : null;
    } catch {
      return null;
    }
  };
  const [sqlbox, http] = await Promise.all([one('sqlbox'), one('http')]);
  sourceCounts.value = { sqlbox, http };
}

async function runSweep() {
  if (!canManage.value) return;
  ingestBusy.value = true;
  ingestNotice.value = '';
  ingestError.value = '';
  sweepResult.value = null;
  try {
    const result = await apiRequest<SweepResult>('/mo/ingest/sweep', {
      method: 'POST',
      body: JSON.stringify({ limit: sweepLimit.value }),
    });
    sweepResult.value = result;
    ingestNotice.value = result.available
      ? `Swept ${num(result.scanned)} engine row(s): ${num(result.ingested)} ingested, ${num(
          result.duplicates,
        )} already seen, ${num(result.deliveries)} fan-out job(s) queued.`
      : 'The engine message store was not reachable, so nothing was swept.';
    await Promise.all([loadIngest(), countSources(), loadMessages(), loadDeliveries()]);
  } catch (reason) {
    ingestError.value = messageFrom(reason, 'The sweep could not be run.');
  } finally {
    ingestBusy.value = false;
  }
}

async function setPolling(enabled: boolean) {
  if (!canManage.value) return;
  ingestBusy.value = true;
  ingestNotice.value = '';
  ingestError.value = '';
  try {
    const body: RecordValue = { enabled };
    if (enabled) body.pollIntervalSeconds = pollInterval.value;
    ingest.value = await apiRequest<IngestStatus>('/mo/ingest/polling', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    ingestNotice.value = enabled
      ? `Continuous sweeping enabled, every ${pollInterval.value} second(s). The job queue is the timer; disabling it does not cancel a sweep already running.`
      : 'Continuous sweeping disabled. A sweep already in flight finishes; no further one is scheduled.';
  } catch (reason) {
    ingestError.value = messageFrom(reason, 'The polling setting could not be changed.');
  } finally {
    ingestBusy.value = false;
  }
}

/** '' when the last sweep succeeded; the backend writes `last_error` on every sweep. */
const lastSweepError = computed(() => text(ingest.value?.last_error, ''));

// --- Rules -------------------------------------------------------------------
const rules = ref<RecordValue[]>([]);
const ruleState = ref<LoadState>('loading');
const ruleError = ref('');
const ruleMissing = ref(false);
const ruleTotal = ref(0);
const ruleLimit = ref(50);
const ruleOffset = ref(0);
const ruleSearch = ref('');
const ruleFilterEnabled = ref('');
const ruleFilterSmscId = ref('');
const ruleFilterKeywordType = ref('');
const ruleSortField = ref('');
const ruleSortDirection = ref<'asc' | 'desc'>('asc');
const ruleNotice = ref('');
const ruleBusy = ref(false);

const rulesInEvaluationOrder = computed(() => ruleSortField.value === '');
const ruleRangeLabel = computed(() =>
  rules.value.length
    ? `Showing ${ruleOffset.value + 1}–${ruleOffset.value + rules.value.length} of ${ruleTotal.value}`
    : 'Showing 0 of 0',
);

function describeRuleMatch(rule: RecordValue): string {
  const parts: string[] = [];
  if (rule.match_smsc_id) parts.push(`SMSC ${String(rule.match_smsc_id)}`);
  if (rule.match_destination_type && rule.match_destination_type !== 'any')
    parts.push(
      `destination ${String(rule.match_destination_type)} ${text(rule.match_destination)}`,
    );
  if (rule.match_sender_prefix) parts.push(`sender prefix ${String(rule.match_sender_prefix)}`);
  if (rule.match_keyword_type && rule.match_keyword_type !== 'any')
    parts.push(`keyword ${String(rule.match_keyword_type)} “${text(rule.match_keyword)}”`);
  return parts.length ? parts.join(' · ') : 'catch-all (no criteria)';
}

async function loadRules() {
  ruleState.value = 'loading';
  ruleMissing.value = false;
  const params = new URLSearchParams();
  if (ruleSearch.value.trim()) params.set('search', ruleSearch.value.trim());
  if (ruleFilterEnabled.value) params.set('filter.enabled', ruleFilterEnabled.value);
  if (ruleFilterSmscId.value) params.set('filter.matchSmscId', ruleFilterSmscId.value);
  if (ruleFilterKeywordType.value)
    params.set('filter.matchKeywordType', ruleFilterKeywordType.value);
  if (ruleSortField.value)
    params.set('sort', `${ruleSortDirection.value === 'desc' ? '-' : ''}${ruleSortField.value}`);
  params.set('limit', String(ruleLimit.value));
  params.set('offset', String(ruleOffset.value));
  try {
    const payload = await apiRequest<RecordValue>(`/mo/rules?${params.toString()}`);
    rules.value = asItems(payload);
    ruleTotal.value = typeof payload.total === 'number' ? payload.total : rules.value.length;
    ruleError.value = '';
    ruleState.value = 'ok';
  } catch (reason) {
    rules.value = [];
    ruleTotal.value = 0;
    ruleMissing.value = isMissing(reason);
    ruleError.value = messageFrom(reason, 'MO routing rules could not be loaded.');
    ruleState.value = 'error';
  }
}

function applyRuleFilters() {
  ruleOffset.value = 0;
  void loadRules();
}
function turnRulePage(direction: number) {
  const next = Math.max(0, ruleOffset.value + direction * ruleLimit.value);
  if (direction > 0 && ruleOffset.value + ruleLimit.value >= ruleTotal.value) return;
  if (next === ruleOffset.value) return;
  ruleOffset.value = next;
  void loadRules();
}

// --- Rule editor -------------------------------------------------------------
const showRuleForm = ref(false);
const editingRuleId = ref('');
const ruleFormError = ref('');
const draftName = ref('');
const draftDescription = ref('');
const draftEnabled = ref(true);
const draftPriority = ref(100);
const draftSmscId = ref('');
const draftDestination = ref('');
const draftDestinationType = ref('any');
const draftSenderPrefix = ref('');
const draftKeyword = ref('');
const draftKeywordType = ref('any');
const draftCaseSensitive = ref(false);
const draftContinue = ref(false);
const draftCustomerId = ref('');

function openRuleForm(rule?: RecordValue) {
  showRuleForm.value = true;
  ruleFormError.value = '';
  ruleNotice.value = '';
  editingRuleId.value = rule ? text(rule.id, '') : '';
  const value = (field: string) =>
    rule && rule[field] !== null && rule[field] !== undefined ? String(rule[field]) : '';
  draftName.value = rule ? text(rule.name, '') : '';
  draftDescription.value = value('description');
  draftEnabled.value = rule ? rule.enabled !== false : true;
  draftPriority.value = rule ? num(rule.priority) : 100;
  draftSmscId.value = value('match_smsc_id');
  draftDestination.value = value('match_destination');
  draftDestinationType.value = rule ? text(rule.match_destination_type, 'any') : 'any';
  draftSenderPrefix.value = value('match_sender_prefix');
  draftKeyword.value = value('match_keyword');
  draftKeywordType.value = rule ? text(rule.match_keyword_type, 'any') : 'any';
  draftCaseSensitive.value = rule ? rule.case_sensitive === true : false;
  draftContinue.value = rule ? rule.continue_after_match === true : false;
  draftCustomerId.value = value('customer_id');
}
function closeRuleForm() {
  showRuleForm.value = false;
  editingRuleId.value = '';
  ruleFormError.value = '';
}

async function saveRule() {
  if (!canManage.value) return;
  ruleFormError.value = '';
  const name = draftName.value.trim();
  if (!name) {
    ruleFormError.value = 'A rule name is required.';
    return;
  }
  // Caught here rather than by a 400, because the pairing is not obvious from
  // the two controls sitting side by side.
  if (draftDestinationType.value !== 'any' && !draftDestination.value.trim()) {
    ruleFormError.value =
      'A destination value is required when the destination match is not “any”.';
    return;
  }
  if (draftKeywordType.value !== 'any' && !draftKeyword.value.trim()) {
    ruleFormError.value = 'A keyword is required when the keyword match is not “any”.';
    return;
  }
  if (!Number.isInteger(draftPriority.value) || draftPriority.value < 0) {
    ruleFormError.value = 'Priority must be a whole number of 0 or more; lower is evaluated first.';
    return;
  }
  const body: RecordValue = {
    name,
    description: draftDescription.value.trim() || null,
    enabled: draftEnabled.value,
    priority: draftPriority.value,
    matchSmscId: draftSmscId.value || null,
    matchDestination: draftDestination.value.trim() || null,
    matchDestinationType: draftDestinationType.value,
    matchSenderPrefix: draftSenderPrefix.value.trim() || null,
    matchKeyword: draftKeyword.value.trim() || null,
    matchKeywordType: draftKeywordType.value,
    caseSensitive: draftCaseSensitive.value,
    continueAfterMatch: draftContinue.value,
    customerId: draftCustomerId.value.trim() || null,
  };
  ruleBusy.value = true;
  try {
    const saved = editingRuleId.value
      ? await apiRequest<RecordValue>(`/mo/rules/${editingRuleId.value}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      : await apiRequest<RecordValue>('/mo/rules', { method: 'POST', body: JSON.stringify(body) });
    ruleNotice.value = editingRuleId.value
      ? `Rule “${name}” updated.`
      : `Rule “${name}” created. It fans out nothing until you add at least one destination.`;
    const savedId = text(saved.id, editingRuleId.value);
    closeRuleForm();
    await loadRules();
    if (savedId && savedId !== '—') await openRuleDetail(savedId);
  } catch (reason) {
    ruleFormError.value = messageFrom(reason, 'The MO routing rule could not be saved.');
  } finally {
    ruleBusy.value = false;
  }
}

async function removeRule(rule: RecordValue) {
  if (!canManage.value) return;
  const id = text(rule.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Delete the MO routing rule “${text(rule.name, id)}”?\n\nIts destinations go with it. Deliveries already recorded keep the rule's name but lose the link to it.`,
    )
  )
    return;
  ruleBusy.value = true;
  try {
    await apiRequest(`/mo/rules/${id}`, { method: 'DELETE' });
    ruleNotice.value = `Rule “${text(rule.name, id)}” deleted.`;
    if (detailRuleId.value === id) closeRuleDetail();
    await loadRules();
  } catch (reason) {
    ruleError.value = messageFrom(reason, 'The rule could not be deleted.');
  } finally {
    ruleBusy.value = false;
  }
}

// --- Rule detail + destinations ----------------------------------------------
const detailRuleId = ref('');
const detailRule = ref<RecordValue | null>(null);
const detailError = ref('');
const detailNotice = ref('');
const detailLoading = ref(false);
const destKind = ref('webhook');
const destTarget = ref('');
const destMaxAttempts = ref(5);
const destSubject = ref('');
const destMethod = ref('POST');
const destSecret = ref('');
const destSender = ref('');

const destinations = computed<RecordValue[]>(() =>
  Array.isArray(detailRule.value?.destinations)
    ? (detailRule.value?.destinations as RecordValue[])
    : [],
);
const destinationsFull = computed(() => destinations.value.length >= MAX_DESTINATIONS);

async function openRuleDetail(id: string) {
  if (!id) return;
  detailRuleId.value = id;
  detailLoading.value = true;
  detailError.value = '';
  detailNotice.value = '';
  try {
    detailRule.value = await apiRequest<RecordValue>(`/mo/rules/${id}`);
  } catch (reason) {
    detailRule.value = null;
    detailError.value = messageFrom(reason, 'The rule detail could not be loaded.');
  } finally {
    detailLoading.value = false;
  }
}
function closeRuleDetail() {
  detailRuleId.value = '';
  detailRule.value = null;
}

async function addDestination() {
  if (!canManage.value || !detailRuleId.value) return;
  detailError.value = '';
  detailNotice.value = '';
  if (!destTarget.value.trim()) {
    detailError.value = 'A destination target is required.';
    return;
  }
  const config: RecordValue = {};
  if (destKind.value === 'webhook') {
    config.method = destMethod.value;
    if (destSecret.value.trim()) config.secret = destSecret.value.trim();
  }
  if (destKind.value === 'email' && destSubject.value.trim())
    config.subject = destSubject.value.trim();
  if (destKind.value === 'sms' && destSender.value.trim()) config.sender = destSender.value.trim();
  detailLoading.value = true;
  try {
    await apiRequest(`/mo/rules/${detailRuleId.value}/destinations`, {
      method: 'POST',
      body: JSON.stringify({
        kind: destKind.value,
        target: destTarget.value.trim(),
        enabled: true,
        config,
        maxAttempts: destMaxAttempts.value,
      }),
    });
    detailNotice.value =
      'Destination saved. Posting the same kind and target again edits that destination rather than adding a second one.';
    destTarget.value = '';
    destSecret.value = '';
    destSubject.value = '';
    destSender.value = '';
    await openRuleDetail(detailRuleId.value);
  } catch (reason) {
    /*
      Surfaced verbatim, and this is the whole reason the field exists: a
      rejected webhook URL comes back naming the host and why it was refused
      ("…is a loopback, link-local or private address…"), which a generic
      "Bad request" would throw away.
    */
    detailError.value = messageFrom(reason, 'The destination could not be added.');
  } finally {
    detailLoading.value = false;
  }
}

async function removeDestination(destination: RecordValue) {
  if (!canManage.value || !detailRuleId.value) return;
  const id = text(destination.id, '');
  if (!id) return;
  detailLoading.value = true;
  detailError.value = '';
  try {
    await apiRequest(`/mo/rules/${detailRuleId.value}/destinations/${id}`, { method: 'DELETE' });
    detailNotice.value = 'Destination removed.';
    await openRuleDetail(detailRuleId.value);
  } catch (reason) {
    detailError.value = messageFrom(reason, 'The destination could not be removed.');
  } finally {
    detailLoading.value = false;
  }
}

// --- Preview -----------------------------------------------------------------
const previewSender = ref('');
const previewReceiver = ref('');
const previewBody = ref('');
const previewSmscId = ref('');
const previewBusy = ref(false);
const previewError = ref('');
const preview = ref<PreviewResult | null>(null);

const previewMatches = computed(() => preview.value?.matches ?? []);
const previewDeliveries = computed(() => preview.value?.deliveries ?? []);
/** Rules never reached, because a terminal rule stopped evaluation first. */
const previewUnreached = computed(() =>
  Math.max(0, num(preview.value?.rulesLoaded) - num(preview.value?.rulesEvaluated)),
);

async function runPreview() {
  if (!previewSender.value.trim() || !previewReceiver.value.trim()) {
    previewError.value =
      'Both a sender and a receiver are required — the API rejects either blank.';
    return;
  }
  previewBusy.value = true;
  previewError.value = '';
  preview.value = null;
  try {
    const body: RecordValue = {
      sender: previewSender.value.trim(),
      receiver: previewReceiver.value.trim(),
      text: previewBody.value,
    };
    if (previewSmscId.value) body.smscId = previewSmscId.value;
    preview.value = await apiRequest<PreviewResult>('/mo/rules/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (reason) {
    previewError.value = messageFrom(reason, 'The preview could not be run.');
  } finally {
    previewBusy.value = false;
  }
}

// --- Inbound messages ---------------------------------------------------------
const messages = ref<RecordValue[]>([]);
const messageState = ref<LoadState>('loading');
const messageError = ref('');
/** Result of a re-dispatch — a success that still matched nothing is news. */
const messageNotice = ref('');
const messageTotal = ref(0);
const messageLimit = ref(25);
const messageOffset = ref(0);
const messageSearch = ref('');
const messageStatusFilter = ref('');
const messageSourceFilter = ref('');
const messageSort = ref('receivedAt');
const messageSortDirection = ref<'asc' | 'desc'>('desc');

const messageRangeLabel = computed(() =>
  messages.value.length
    ? `Showing ${messageOffset.value + 1}–${messageOffset.value + messages.value.length} of ${messageTotal.value}`
    : 'Showing 0 of 0',
);

async function loadMessages() {
  messageState.value = 'loading';
  const params = new URLSearchParams();
  if (messageSearch.value.trim()) params.set('search', messageSearch.value.trim());
  if (messageStatusFilter.value) params.set('filter.status', messageStatusFilter.value);
  if (messageSourceFilter.value) params.set('filter.source', messageSourceFilter.value);
  params.set('sort', `${messageSortDirection.value === 'desc' ? '-' : ''}${messageSort.value}`);
  params.set('limit', String(messageLimit.value));
  params.set('offset', String(messageOffset.value));
  try {
    const payload = await apiRequest<RecordValue>(`/mo/messages?${params.toString()}`);
    messages.value = asItems(payload);
    messageTotal.value = typeof payload.total === 'number' ? payload.total : messages.value.length;
    messageError.value = '';
    messageState.value = 'ok';
  } catch (reason) {
    messages.value = [];
    messageTotal.value = 0;
    messageError.value = messageFrom(reason, 'Inbound messages could not be loaded.');
    messageState.value = 'error';
  }
}
/* --- ONE INBOUND MESSAGE ------------------------------------------------------
 *
 * `GET /mo/messages/:id` reads one message with its own privacy grant — scoped
 * to that message, so investigating one complaint does not silently unmask the
 * whole grid.
 *
 * `POST /mo/messages/:id/redispatch` re-runs matching and fan-out. It is the
 * remedy for the commonest MO support case: a message sitting in `no_match`
 * because the rule that should have caught it did not exist yet. Without it the
 * only fix was asking the subscriber to text again.
 */
const openMessageId = ref('');
const openMessage_ = ref<RecordValue | null>(null);
const redispatchBusy = ref('');

async function openMessage(id: string) {
  if (openMessageId.value === id) {
    openMessageId.value = '';
    openMessage_.value = null;
    return;
  }
  openMessageId.value = id;
  openMessage_.value = null;
  try {
    openMessage_.value = await apiRequest<RecordValue>(`/mo/messages/${id}`);
  } catch (reason) {
    messageError.value = messageFrom(reason, 'That message could not be read.');
  }
}

async function redispatchMessage(id: string) {
  redispatchBusy.value = id;
  messageError.value = '';
  try {
    const result = await apiRequest<RecordValue>(`/mo/messages/${id}/redispatch`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // The fan-out count is the answer. "Matched 0 rules" means the rule that
    // should catch this still does not exist — which is a result, not a
    // failure, and sends the operator back to the rule list rather than to a
    // retry.
    const fanout = Number(result?.fanoutCount ?? result?.fanout_count ?? 0);
    messageNotice.value = fanout
      ? `Re-run complete: matched and fanned out to ${fanout} destination(s).`
      : 'Re-run complete, but no rule matched this message. The rule that should catch it still does not exist or is disabled.';
    await loadMessages();
  } catch (reason) {
    messageError.value = messageFrom(reason, 'The message could not be re-dispatched.');
  } finally {
    redispatchBusy.value = '';
  }
}

function applyMessageFilters() {
  messageOffset.value = 0;
  void loadMessages();
}
function turnMessagePage(direction: number) {
  const next = Math.max(0, messageOffset.value + direction * messageLimit.value);
  if (direction > 0 && messageOffset.value + messageLimit.value >= messageTotal.value) return;
  if (next === messageOffset.value) return;
  messageOffset.value = next;
  void loadMessages();
}

// --- Deliveries ----------------------------------------------------------------
const deliveries = ref<RecordValue[]>([]);
const deliveryState = ref<LoadState>('loading');
const deliveryError = ref('');
const deliveryNotice = ref('');
const deliveryTotal = ref(0);
const deliveryLimit = ref(25);
const deliveryOffset = ref(0);
const deliverySearch = ref('');
const deliveryStatusFilter = ref('');
const deliveryKindFilter = ref('');
const deliverySort = ref('createdAt');
const deliverySortDirection = ref<'asc' | 'desc'>('desc');
const deliveryBusy = ref('');

const deliveryRangeLabel = computed(() =>
  deliveries.value.length
    ? `Showing ${deliveryOffset.value + 1}–${deliveryOffset.value + deliveries.value.length} of ${deliveryTotal.value}`
    : 'Showing 0 of 0',
);

function canRetry(delivery: RecordValue) {
  return RETRYABLE.includes(String(delivery.status ?? ''));
}

async function loadDeliveries() {
  deliveryState.value = 'loading';
  const params = new URLSearchParams();
  if (deliverySearch.value.trim()) params.set('search', deliverySearch.value.trim());
  if (deliveryStatusFilter.value) params.set('filter.status', deliveryStatusFilter.value);
  if (deliveryKindFilter.value) params.set('filter.kind', deliveryKindFilter.value);
  params.set('sort', `${deliverySortDirection.value === 'desc' ? '-' : ''}${deliverySort.value}`);
  params.set('limit', String(deliveryLimit.value));
  params.set('offset', String(deliveryOffset.value));
  try {
    const payload = await apiRequest<RecordValue>(`/mo/deliveries?${params.toString()}`);
    deliveries.value = asItems(payload);
    deliveryTotal.value =
      typeof payload.total === 'number' ? payload.total : deliveries.value.length;
    deliveryError.value = '';
    deliveryState.value = 'ok';
  } catch (reason) {
    deliveries.value = [];
    deliveryTotal.value = 0;
    deliveryError.value = messageFrom(reason, 'Fan-out deliveries could not be loaded.');
    deliveryState.value = 'error';
  }
}
function applyDeliveryFilters() {
  deliveryOffset.value = 0;
  void loadDeliveries();
}
function turnDeliveryPage(direction: number) {
  const next = Math.max(0, deliveryOffset.value + direction * deliveryLimit.value);
  if (direction > 0 && deliveryOffset.value + deliveryLimit.value >= deliveryTotal.value) return;
  if (next === deliveryOffset.value) return;
  deliveryOffset.value = next;
  void loadDeliveries();
}

async function retryDelivery(delivery: RecordValue) {
  if (!canManage.value) return;
  const id = text(delivery.id, '');
  if (!id || !canRetry(delivery)) return;
  deliveryBusy.value = id;
  deliveryError.value = '';
  deliveryNotice.value = '';
  try {
    await apiRequest(`/mo/deliveries/${id}/retry`, { method: 'POST', body: '{}' });
    deliveryNotice.value =
      'Delivery re-queued. Its attempt counter is reset to zero, so it gets the full attempt budget again; only the manual-retry counter records that a human intervened.';
    await loadDeliveries();
  } catch (reason) {
    deliveryError.value = messageFrom(reason, 'The delivery could not be retried.');
  } finally {
    deliveryBusy.value = '';
  }
}

onMounted(() => {
  void loadSmscOptions();
  void loadIngest();
  void countSources();
  void loadRules();
  void loadMessages();
  void loadDeliveries();
});
</script>

<template>
  <div data-testid="mo-routing-view">
    <p v-if="!canManage" class="source-note" data-testid="mo-readonly">
      You can review rules, destinations, inbound messages and delivery attempts. Creating rules,
      running a sweep, changing polling and retrying a delivery all require the messages.send
      permission — an ingest can fan out to an SMS destination, so it can cause outbound traffic.
    </p>

    <!-- Ingest ---------------------------------------------------------------- -->
    <section class="panel" data-testid="mo-ingest-panel" aria-label="Inbound ingest">
      <header class="panel-header">
        <div>
          <h2>Ingest</h2>
          <p aria-live="polite">
            {{
              ingestState === 'loading'
                ? 'Loading ingest state…'
                : ingest?.polling_enabled
                  ? `Continuous sweeping is ON, every ${num(ingest?.poll_interval_seconds)}s`
                  : 'Continuous sweeping is OFF'
            }}
          </p>
        </div>
      </header>

      <!--
        THE HONEST STATEMENT. `GET /mo/ingest/status` describes the sweep and
        nothing else; the console cannot read the engine's config file, so the
        push path is reported as observed evidence, never as configuration.
      -->
      <div class="baseline-info" data-testid="mo-ingest-paths">
        <h3>Which ingest path is active</h3>
        <p data-testid="mo-ingest-sweep-claim">
          <strong>Engine sweep — the path that works on the topology deployed today.</strong>
          It reads inbound rows straight out of the engine’s own message store (<span class="mono"
            >sent_sms</span
          >
          where <span class="mono">momt='MO'</span>) and needs no Kannel change at all. Its real
          state is the numbers below:
          {{
            ingest?.polling_enabled
              ? 'polling is on'
              : 'polling is off, so it only runs when you press Sweep now'
          }}, watermark <span class="mono">{{ text(ingest?.watermark_sql_id, '0') }}</span
          >, last swept {{ text(ingest?.last_polled_at, 'never') }},
          {{
            lastSweepError
              ? `last sweep FAILED: ${lastSweepError}`
              : 'last sweep reported no error'
          }}.
        </p>
        <p data-testid="mo-ingest-push-claim">
          <strong
            >Push (<span class="mono">POST /mo/inbound</span>) — cannot be confirmed from
            here.</strong
          >
          This is the endpoint a Kannel <span class="mono">sms-service</span> with a
          <span class="mono">post-url</span> would call. The ingest-status endpoint returns nine
          fields and none of them describes the push path, and this console cannot read the engine’s
          configuration file — so it will not tell you the path is wired. What it can show is what
          actually arrived:
          <span class="mono" data-testid="mo-source-http">{{
            sourceCounts.http === null ? 'unknown' : sourceCounts.http
          }}</span>
          inbound message(s) recorded by push and
          <span class="mono" data-testid="mo-source-sqlbox">{{
            sourceCounts.sqlbox === null ? 'unknown' : sourceCounts.sqlbox
          }}</span>
          by sweep. Zero by push means either nothing has been received that way or it is not wired
          at all; these counts cannot tell those two apart.
        </p>
        <p class="warn-notice" role="note" data-testid="mo-ingest-shipped-default">
          As shipped, the generated Kannel configuration emits one
          <span class="mono">sms-service</span> group with
          <span class="mono">keyword = default</span> and
          <span class="mono">text = "No service specified"</span> and no callback URL, so Kannel
          answers an inbound message with that fixed string and forwards nothing to JKANNEL. Unless
          your deployment has changed that, the sweep is the only path that will ever fire, and the
          push counter above will stay at zero.
        </p>
      </div>

      <p
        v-if="ingestState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="mo-ingest-error"
      >
        {{ ingestMissing ? 'The MO ingest API is not available in this deployment.' : ingestError }}
      </p>
      <template v-else>
        <div class="summary-strip">
          <div class="metric">
            <strong class="mono" data-testid="mo-watermark">{{
              text(ingest?.watermark_sql_id, '0')
            }}</strong>
            <small>sweep watermark (engine sql_id)</small>
          </div>
          <div class="metric">
            <strong data-testid="mo-ingested-total">{{ text(ingest?.ingested_total, '0') }}</strong>
            <small>messages ingested in total</small>
          </div>
          <div class="metric">
            <strong>{{ text(ingest?.last_polled_at, 'never') }}</strong>
            <small>last sweep</small>
          </div>
          <div class="metric">
            <strong :class="lastSweepError ? 'status-badge bad' : 'status-badge good'">{{
              lastSweepError ? 'failed' : 'ok'
            }}</strong>
            <small>last sweep outcome</small>
          </div>
        </div>
        <p v-if="lastSweepError" class="form-error" role="alert" data-testid="mo-last-error">
          {{ lastSweepError }}
        </p>

        <div v-if="canManage" class="grid-toolbar" data-testid="mo-ingest-controls">
          <label class="filter-select">
            <span>Rows per sweep</span>
            <input
              v-model.number="sweepLimit"
              data-testid="mo-sweep-limit"
              type="number"
              min="1"
              max="500"
            />
          </label>
          <button
            class="primary-button"
            data-testid="mo-sweep-run"
            :disabled="ingestBusy"
            @click="runSweep"
          >
            {{ ingestBusy ? 'Working…' : 'Sweep now' }}
          </button>
          <label class="filter-select">
            <span>Poll every (seconds)</span>
            <input
              v-model.number="pollInterval"
              data-testid="mo-poll-interval"
              type="number"
              min="5"
              max="3600"
            />
          </label>
          <button
            class="secondary-button"
            data-testid="mo-polling-on"
            :disabled="ingestBusy"
            @click="setPolling(true)"
          >
            Enable continuous sweeping
          </button>
          <button
            class="secondary-button"
            data-testid="mo-polling-off"
            :disabled="ingestBusy"
            @click="setPolling(false)"
          >
            Disable
          </button>
        </div>

        <p v-if="ingestNotice" class="notice" role="status" data-testid="mo-ingest-notice">
          {{ ingestNotice }}
        </p>
        <div v-if="sweepResult" class="summary-strip" data-testid="mo-sweep-result">
          <div class="metric">
            <strong>{{ num(sweepResult.scanned) }}</strong>
            <small>scanned</small>
          </div>
          <div class="metric">
            <strong>{{ num(sweepResult.ingested) }}</strong>
            <small>ingested</small>
          </div>
          <div class="metric">
            <strong>{{ num(sweepResult.duplicates) }}</strong>
            <small>already seen</small>
          </div>
          <div class="metric">
            <strong>{{ num(sweepResult.deliveries) }}</strong>
            <small>fan-out jobs queued</small>
          </div>
        </div>
        <p v-if="sweepResult?.evidence" class="warn-notice" data-testid="mo-sweep-evidence">
          {{ sweepResult.evidence }}
        </p>
        <p
          v-if="sweepResult && sweepResult.available !== false && !sweepResult.scanned"
          class="source-note"
          data-testid="mo-sweep-empty-note"
        >
          Nothing new above the watermark. A sweep that scans zero rows and a tenant with no SMSC
          definitions produce the same body, so check the last-sweep error above to tell them apart.
        </p>
      </template>
    </section>

    <!-- Preview ---------------------------------------------------------------- -->
    <section class="panel" data-testid="mo-preview-panel" aria-label="Inbound routing preview">
      <header class="panel-header">
        <div>
          <h2>What would happen to this inbound message?</h2>
          <p>The same matcher the ingest uses, against the enabled rule set.</p>
        </div>
      </header>
      <div class="grid-toolbar">
        <label class="filter-select">
          <span>Sender</span>
          <input v-model="previewSender" data-testid="mo-preview-sender" type="text" />
        </label>
        <label class="filter-select">
          <span>Receiver (shortcode)</span>
          <input v-model="previewReceiver" data-testid="mo-preview-receiver" type="text" />
        </label>
        <label class="filter-select filter-search">
          <span>Message body</span>
          <input v-model="previewBody" data-testid="mo-preview-body" type="text" />
        </label>
        <label class="filter-select">
          <span>SMSC</span>
          <select v-model="previewSmscId" data-testid="mo-preview-smsc">
            <option value="">Any</option>
            <option v-for="option in smscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button
          class="primary-button"
          data-testid="mo-preview-run"
          :disabled="previewBusy"
          @click="runPreview"
        >
          {{ previewBusy ? 'Evaluating…' : 'Evaluate' }}
        </button>
      </div>
      <p v-if="previewError" class="form-error" role="alert" data-testid="mo-preview-error">
        {{ previewError }}
      </p>
      <div v-if="preview" class="baseline-info" data-testid="mo-preview-result">
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="mo-preview-match-count">{{ previewMatches.length }}</strong>
            <small>rules matched</small>
          </div>
          <div class="metric">
            <strong data-testid="mo-preview-delivery-count">{{ previewDeliveries.length }}</strong>
            <small>destinations that would fire</small>
          </div>
          <div class="metric">
            <strong>{{ num(preview.rulesEvaluated) }} / {{ num(preview.rulesLoaded) }}</strong>
            <small>rules evaluated</small>
          </div>
          <div class="metric">
            <strong>{{ preview.stoppedEarly ? 'yes' : 'no' }}</strong>
            <small>stopped early</small>
          </div>
        </div>
        <p
          v-if="preview.stoppedEarly && previewUnreached"
          class="warn-notice"
          role="note"
          data-testid="mo-preview-stopped-early"
        >
          Matching stopped at a terminal rule with {{ previewUnreached }} rule(s) never evaluated.
          Those rules could not have fired for this message. The API does not name them — turn on
          “continue after match” on the rule that stopped evaluation if later rules were meant to
          run too.
        </p>
        <p v-if="!previewMatches.length" class="source-note" data-testid="mo-preview-no-match">
          No rule matched. An inbound message like this is still recorded, with status
          <span class="mono">no_match</span> and no fan-out. Only enabled rules and enabled
          destinations are considered by the preview.
        </p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Priority</th>
                <th scope="col">Matched on</th>
                <th scope="col">Destinations</th>
                <th scope="col">Continues</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(match, index) in previewMatches"
                :key="`${text(match.ruleId)}-${index}`"
                :data-testid="`mo-preview-match-${index}`"
              >
                <td>
                  <strong>{{ text(match.ruleName) }}</strong>
                  <small class="row-id mono">{{ text(match.ruleId) }}</small>
                </td>
                <td class="mono">{{ text(match.priority) }}</td>
                <td>{{ (match.matchedOn ?? []).join(' · ') || '—' }}</td>
                <td>
                  {{ num(match.destinationCount) }}
                  <small v-if="!num(match.destinationCount)" class="row-id"
                    >matches but fans out nowhere</small
                  >
                </td>
                <td>{{ match.continueAfterMatch ? 'yes' : 'no — terminal' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul v-if="previewDeliveries.length" class="sample-list" data-testid="mo-preview-deliveries">
          <li v-for="(delivery, index) in previewDeliveries" :key="index">
            <span class="status-badge">{{ text(delivery.kind) }}</span>
            <span class="mono">{{ text(delivery.target) }}</span>
            <small>via {{ text(delivery.ruleName) }}</small>
          </li>
        </ul>
      </div>
    </section>

    <!-- Rules ------------------------------------------------------------------ -->
    <section class="panel" data-testid="mo-rules-panel" aria-label="MO routing rules">
      <header class="panel-header">
        <div>
          <h2>Inbound routing rules</h2>
          <p aria-live="polite">
            {{
              ruleState === 'loading' ? 'Loading rules…' : `${rules.length} rule(s) on this page`
            }}
          </p>
        </div>
        <button
          v-if="canManage"
          class="primary-button"
          data-testid="mo-rule-create"
          :disabled="ruleBusy"
          @click="openRuleForm()"
        >
          New rule
        </button>
      </header>
      <p v-if="ruleNotice" class="notice" role="status" data-testid="mo-rule-notice">
        {{ ruleNotice }}
      </p>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="ruleSearch"
            data-testid="mo-rule-search"
            type="search"
            placeholder="Name, description, keyword, destination, or author"
            @keyup.enter="applyRuleFilters"
          />
        </label>
        <label class="filter-select">
          <span>Enabled</span>
          <select
            v-model="ruleFilterEnabled"
            data-testid="mo-rule-filter-enabled"
            @change="applyRuleFilters"
          >
            <option value="">Any</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <label class="filter-select">
          <span>SMSC</span>
          <select
            v-model="ruleFilterSmscId"
            data-testid="mo-rule-filter-smsc"
            @change="applyRuleFilters"
          >
            <option value="">Any SMSC</option>
            <option v-for="option in smscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Keyword match</span>
          <select
            v-model="ruleFilterKeywordType"
            data-testid="mo-rule-filter-keyword-type"
            @change="applyRuleFilters"
          >
            <option value="">Any</option>
            <option v-for="type in KEYWORD_MATCH_TYPES" :key="type" :value="type">
              {{ type }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="ruleSortField" data-testid="mo-rule-sort" @change="applyRuleFilters">
            <option
              v-for="field in RULE_SORT_FIELDS"
              :key="field.value || 'default'"
              :value="field.value"
            >
              {{ field.label }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Per page</span>
          <select v-model.number="ruleLimit" data-testid="mo-rule-limit" @change="applyRuleFilters">
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>

      <p
        v-if="!rulesInEvaluationOrder"
        class="warn-notice"
        role="note"
        data-testid="mo-rule-order-warning"
      >
        Sorted by {{ ruleSortField }}, which is not evaluation order, so the position numbers are
        hidden. Switch back to “Evaluation order” to see which rule reaches an inbound message
        first.
      </p>

      <p v-if="ruleState === 'error'" class="chart-empty" role="alert" data-testid="mo-rule-error">
        {{ ruleMissing ? 'The MO routing API is not available in this deployment.' : ruleError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Rule</th>
              <th scope="col">State</th>
              <th scope="col">Priority</th>
              <th scope="col">Matches on</th>
              <th scope="col">After match</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(rule, index) in rules"
              :key="text(rule.id)"
              :data-testid="`mo-rule-${text(rule.id)}`"
            >
              <td class="mono">{{ rulesInEvaluationOrder ? ruleOffset + index + 1 : '·' }}</td>
              <td>
                <strong>{{ text(rule.name) }}</strong>
                <small class="row-id mono">{{ text(rule.id) }}</small>
                <small v-if="rule.description" class="row-id">{{ text(rule.description) }}</small>
              </td>
              <td>
                <span class="status-badge" :class="rule.enabled === false ? '' : 'good'">{{
                  rule.enabled === false ? 'disabled' : 'enabled'
                }}</span>
              </td>
              <td class="mono">{{ text(rule.priority) }}</td>
              <td>{{ describeRuleMatch(rule) }}</td>
              <td>
                {{ rule.continue_after_match ? 'continues to later rules' : 'stops evaluation' }}
              </td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`mo-rule-open-${text(rule.id)}`"
                  @click="openRuleDetail(text(rule.id, ''))"
                >
                  Destinations
                </button>
                <template v-if="canManage">
                  <button
                    class="secondary-button"
                    :data-testid="`mo-rule-edit-${text(rule.id)}`"
                    @click="openRuleForm(rule)"
                  >
                    Edit
                  </button>
                  <button
                    class="secondary-button danger-button"
                    :data-testid="`mo-rule-delete-${text(rule.id)}`"
                    :disabled="ruleBusy"
                    @click="removeRule(rule)"
                  >
                    Delete
                  </button>
                </template>
              </td>
            </tr>
            <tr v-if="ruleState === 'ok' && !rules.length">
              <td colspan="7" class="empty-cell" data-testid="mo-rule-empty">
                No inbound routing rules match these filters. Without a matching rule an inbound
                message is still recorded, but nothing is forwarded.
              </td>
            </tr>
            <tr v-if="ruleState === 'loading'">
              <td colspan="7" class="empty-cell">Loading rules…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="mo-rule-range">{{ ruleRangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="mo-rule-prev"
            :disabled="ruleOffset === 0"
            @click="turnRulePage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="mo-rule-next"
            :disabled="ruleOffset + rules.length >= ruleTotal"
            @click="turnRulePage(1)"
          >
            Next
          </button>
        </div>
      </footer>
      <p class="source-note" data-testid="mo-rule-grid-note">
        Search, filters, sort, page size and paging are applied by the API. The sender prefix and
        the destination value are searchable but not filterable, so neither has a filter control —
        the grid offers only the fields the API’s own whitelist accepts.
      </p>
    </section>

    <!-- Rule editor -------------------------------------------------------------- -->
    <section
      v-if="showRuleForm"
      class="panel composer"
      data-testid="mo-rule-form"
      aria-label="MO rule editor"
    >
      <h2>{{ editingRuleId ? 'Edit inbound rule' : 'New inbound rule' }}</h2>
      <label class="filter-select filter-search">
        <span>Name (unique, up to 200 characters)</span>
        <input v-model="draftName" data-testid="mo-form-name" type="text" />
      </label>
      <label class="filter-select filter-search">
        <span>Description</span>
        <input v-model="draftDescription" data-testid="mo-form-description" type="text" />
      </label>
      <label class="filter-select">
        <span>Priority (lower is evaluated first)</span>
        <input
          v-model.number="draftPriority"
          data-testid="mo-form-priority"
          type="number"
          min="0"
          max="1000000"
        />
      </label>
      <label class="filter-select">
        <span>SMSC the message arrived on</span>
        <select v-model="draftSmscId" data-testid="mo-form-smsc">
          <option value="">Any SMSC</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Destination (shortcode) match</span>
        <select v-model="draftDestinationType" data-testid="mo-form-destination-type">
          <option v-for="type in DESTINATION_MATCH_TYPES" :key="type" :value="type">
            {{ type }}
          </option>
        </select>
      </label>
      <label v-if="draftDestinationType !== 'any'" class="filter-select">
        <span>Destination value</span>
        <input v-model="draftDestination" data-testid="mo-form-destination" type="text" />
      </label>
      <label class="filter-select">
        <span>Sender prefix (digits, + ( ) - and spaces)</span>
        <input v-model="draftSenderPrefix" data-testid="mo-form-sender-prefix" type="text" />
      </label>
      <label class="filter-select">
        <span>Keyword match</span>
        <select v-model="draftKeywordType" data-testid="mo-form-keyword-type">
          <option v-for="type in KEYWORD_MATCH_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label v-if="draftKeywordType !== 'any'" class="filter-select">
        <span>Keyword</span>
        <input v-model="draftKeyword" data-testid="mo-form-keyword" type="text" />
      </label>
      <label class="filter-select">
        <span>Case sensitive</span>
        <select v-model="draftCaseSensitive" data-testid="mo-form-case">
          <option :value="false">No</option>
          <option :value="true">Yes</option>
        </select>
      </label>
      <label class="filter-select">
        <span>After this rule matches</span>
        <select v-model="draftContinue" data-testid="mo-form-continue">
          <option :value="false">Stop — no later rule is consulted</option>
          <option :value="true">Continue — later rules may also fan out</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Enabled</span>
        <select v-model="draftEnabled" data-testid="mo-form-enabled">
          <option :value="true">Yes</option>
          <option :value="false">No</option>
        </select>
      </label>
      <label class="filter-select filter-search">
        <span>Customer scope (UUID, optional)</span>
        <input v-model="draftCustomerId" data-testid="mo-form-customer" type="text" />
      </label>
      <p v-if="ruleFormError" class="form-error" role="alert" data-testid="mo-form-error">
        {{ ruleFormError }}
      </p>
      <div class="detail-actions">
        <button
          class="primary-button"
          data-testid="mo-form-save"
          :disabled="ruleBusy || !canManage"
          @click="saveRule"
        >
          {{ ruleBusy ? 'Saving…' : 'Save rule' }}
        </button>
        <button class="secondary-button" data-testid="mo-form-cancel" @click="closeRuleForm">
          Cancel
        </button>
      </div>
      <p class="source-note">
        A rule is created without destinations; add them below once it exists. There is no way to
        create a rule and its destinations in one call.
      </p>
    </section>

    <!-- Destinations --------------------------------------------------------------- -->
    <section
      v-if="detailRuleId"
      class="panel detail-panel"
      data-testid="mo-destinations-panel"
      aria-label="Rule destinations"
    >
      <header class="panel-header">
        <div>
          <h2>Destinations — {{ text(detailRule?.name, detailRuleId) }}</h2>
          <p aria-live="polite">
            {{ destinations.length }} of {{ MAX_DESTINATIONS }} destination(s). Each one is its own
            job, so they succeed and fail independently.
          </p>
        </div>
        <button
          class="secondary-button"
          data-testid="mo-destinations-close"
          @click="closeRuleDetail"
        >
          Close
        </button>
      </header>
      <p v-if="detailNotice" class="notice" role="status" data-testid="mo-destination-notice">
        {{ detailNotice }}
      </p>
      <p v-if="detailError" class="form-error" role="alert" data-testid="mo-destination-error">
        {{ detailError }}
      </p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Target</th>
              <th scope="col">State</th>
              <th scope="col">Max attempts</th>
              <th scope="col">Added</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="destination in destinations"
              :key="text(destination.id)"
              :data-testid="`mo-destination-${text(destination.id)}`"
            >
              <td>
                <span class="status-badge">{{ text(destination.kind) }}</span>
              </td>
              <td class="mono">{{ text(destination.target) }}</td>
              <td>
                <span class="status-badge" :class="destination.enabled === false ? '' : 'good'">{{
                  destination.enabled === false ? 'disabled' : 'enabled'
                }}</span>
              </td>
              <td class="mono">{{ text(destination.max_attempts, '5') }}</td>
              <td>{{ text(destination.created_at) }}</td>
              <td class="row-actions">
                <button
                  v-if="canManage"
                  class="secondary-button danger-button"
                  :data-testid="`mo-destination-remove-${text(destination.id)}`"
                  :disabled="detailLoading"
                  @click="removeDestination(destination)"
                >
                  Remove
                </button>
              </td>
            </tr>
            <tr v-if="!destinations.length">
              <td colspan="6" class="empty-cell" data-testid="mo-destination-empty">
                This rule has no destinations, so a message that matches it is recorded and then
                forwarded nowhere.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="canManage">
        <h3>Add a destination</h3>
        <div class="grid-toolbar">
          <label class="filter-select">
            <span>Kind</span>
            <select v-model="destKind" data-testid="mo-destination-kind">
              <option v-for="kind in DELIVERY_KINDS" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </label>
          <label class="filter-select filter-search">
            <span>{{
              destKind === 'webhook'
                ? 'Webhook URL'
                : destKind === 'email'
                  ? 'Email address'
                  : 'MSISDN'
            }}</span>
            <input
              v-model="destTarget"
              data-testid="mo-destination-target"
              type="text"
              :placeholder="
                destKind === 'webhook'
                  ? 'https://example.com/hooks/mo'
                  : destKind === 'email'
                    ? 'ops@example.com'
                    : '+256700000000'
              "
            />
          </label>
          <label v-if="destKind === 'webhook'" class="filter-select">
            <span>Method</span>
            <select v-model="destMethod" data-testid="mo-destination-method">
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </label>
          <label v-if="destKind === 'webhook'" class="filter-select">
            <span>Shared secret (optional)</span>
            <input v-model="destSecret" data-testid="mo-destination-secret" type="text" />
          </label>
          <label v-if="destKind === 'email'" class="filter-select">
            <span>Subject (optional)</span>
            <input v-model="destSubject" data-testid="mo-destination-subject" type="text" />
          </label>
          <label v-if="destKind === 'sms'" class="filter-select">
            <span>Sender ID (optional)</span>
            <input v-model="destSender" data-testid="mo-destination-sender" type="text" />
          </label>
          <label class="filter-select">
            <span>Max attempts (1–20)</span>
            <input
              v-model.number="destMaxAttempts"
              data-testid="mo-destination-attempts"
              type="number"
              min="1"
              max="20"
            />
          </label>
          <button
            class="primary-button"
            data-testid="mo-destination-add"
            :disabled="detailLoading || destinationsFull"
            @click="addDestination"
          >
            {{ destinationsFull ? 'Limit reached' : 'Add destination' }}
          </button>
        </div>
        <p
          v-if="destKind === 'webhook'"
          class="warn-notice"
          role="note"
          data-testid="mo-webhook-ssrf-note"
        >
          A webhook URL is checked against SSRF twice: once when it is saved and again on every
          delivery attempt. Loopback, link-local (including
          <span class="mono">169.254.169.254</span>, the cloud metadata address) and RFC1918 private
          addresses are refused, as is any scheme other than http or https. If a URL is rejected the
          API’s own sentence is shown above this form verbatim — it names the host and why. The
          secret is sent as the <span class="mono">x-jkannel-signature</span> header as-is; it is
          not an HMAC of the payload, so treat it as a shared bearer token.
        </p>
        <p class="source-note">
          Re-adding the same kind and target edits that destination instead of creating a second
          one. Destinations have no explicit order — they are listed oldest first and all fire
          together.
        </p>
      </template>
    </section>

    <!-- Inbound messages -------------------------------------------------------- -->
    <section class="panel" data-testid="mo-messages-panel" aria-label="Inbound messages">
      <header class="panel-header">
        <div>
          <h2>Inbound messages</h2>
          <p aria-live="polite">
            {{
              messageState === 'loading'
                ? 'Loading inbound messages…'
                : `${messages.length} message(s) on this page`
            }}
          </p>
        </div>
      </header>
      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="messageSearch"
            data-testid="mo-message-search"
            type="search"
            placeholder="Sender, receiver, body, or reference"
            @keyup.enter="applyMessageFilters"
          />
        </label>
        <label class="filter-select">
          <span>Status</span>
          <select
            v-model="messageStatusFilter"
            data-testid="mo-message-filter-status"
            @change="applyMessageFilters"
          >
            <option value="">Any status</option>
            <option v-for="status in MESSAGE_STATUSES" :key="status" :value="status">
              {{ status }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Arrived by</span>
          <select
            v-model="messageSourceFilter"
            data-testid="mo-message-filter-source"
            @change="applyMessageFilters"
          >
            <option value="">Either path</option>
            <option v-for="source in MESSAGE_SOURCES" :key="source" :value="source">
              {{ source === 'sqlbox' ? 'sqlbox (engine sweep)' : 'http (push)' }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="messageSort" data-testid="mo-message-sort" @change="applyMessageFilters">
            <option v-for="field in MESSAGE_SORT_FIELDS" :key="field" :value="field">
              {{ field }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Per page</span>
          <select
            v-model.number="messageLimit"
            data-testid="mo-message-limit"
            @change="applyMessageFilters"
          >
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>
      <p v-if="messageNotice" class="notice" role="status" data-testid="mo-message-notice">
        {{ messageNotice }}
      </p>
      <p
        v-if="messageState === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="mo-message-error"
      >
        {{ messageError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Body</th>
              <th scope="col">Arrived by</th>
              <th scope="col">Status</th>
              <th scope="col">Fan-out</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="message in messages" :key="text(message.id)">
              <tr :data-testid="`mo-message-${text(message.id)}`">
                <td>{{ text(message.received_at) }}</td>
                <td class="mono">{{ text(message.sender) }}</td>
                <td class="mono">{{ text(message.receiver) }}</td>
                <td>{{ text(message.body) }}</td>
                <td class="mono">{{ text(message.source) }}</td>
                <td>
                  <span class="status-badge" :class="badgeTone(message.status)">{{
                    text(message.status)
                  }}</span>
                </td>
                <td class="mono">{{ text(message.fanout_count, '0') }}</td>
                <td class="row-actions">
                  <button
                    class="secondary-button"
                    type="button"
                    :data-testid="`mo-message-open-${text(message.id)}`"
                    @click="openMessage(text(message.id, ''))"
                  >
                    {{ openMessageId === text(message.id) ? 'Hide' : 'Expand' }}
                  </button>
                  <!--
                    Re-runs matching and fan-out for a message already received.
                    The commonest MO support case is a message sitting in
                    no_match because the rule that should have caught it did not
                    exist yet — before this the only remedy was asking the
                    subscriber to text again.
                  -->
                  <button
                    v-if="canManage"
                    class="secondary-button"
                    type="button"
                    :disabled="Boolean(redispatchBusy)"
                    :data-testid="`mo-message-redispatch-${text(message.id)}`"
                    @click="redispatchMessage(text(message.id, ''))"
                  >
                    Re-run matching
                  </button>
                </td>
              </tr>
              <tr v-if="openMessageId === text(message.id)">
                <td colspan="8">
                  <pre
                    v-if="openMessage_"
                    class="json-block"
                    :data-testid="`mo-message-detail-${text(message.id)}`"
                    >{{ JSON.stringify(openMessage_, null, 2) }}</pre
                  >
                  <p v-else class="source-note">Reading the message…</p>
                </td>
              </tr>
            </template>
            <tr v-if="messageState === 'ok' && !messages.length">
              <td colspan="8" class="empty-cell" data-testid="mo-message-empty">
                No inbound messages recorded. On the shipped Kannel configuration this is the
                expected state until the engine sweep finds MO rows in the message store.
              </td>
            </tr>
            <tr v-if="messageState === 'loading'">
              <td colspan="8" class="empty-cell">Loading inbound messages…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="mo-message-range">{{ messageRangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="mo-message-prev"
            :disabled="messageOffset === 0"
            @click="turnMessagePage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="mo-message-next"
            :disabled="messageOffset + messages.length >= messageTotal"
            @click="turnMessagePage(1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>

    <!-- Deliveries ----------------------------------------------------------------- -->
    <section class="panel" data-testid="mo-deliveries-panel" aria-label="Fan-out deliveries">
      <header class="panel-header">
        <div>
          <h2>Fan-out deliveries</h2>
          <p aria-live="polite">
            {{
              deliveryState === 'loading'
                ? 'Loading deliveries…'
                : `${deliveries.length} delivery attempt(s) on this page`
            }}
          </p>
        </div>
      </header>
      <p v-if="deliveryNotice" class="notice" role="status" data-testid="mo-delivery-notice">
        {{ deliveryNotice }}
      </p>
      <p v-if="deliveryError" class="form-error" role="alert" data-testid="mo-delivery-error">
        {{ deliveryError }}
      </p>
      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="deliverySearch"
            data-testid="mo-delivery-search"
            type="search"
            placeholder="Target, rule name, or error"
            @keyup.enter="applyDeliveryFilters"
          />
        </label>
        <label class="filter-select">
          <span>Status</span>
          <select
            v-model="deliveryStatusFilter"
            data-testid="mo-delivery-filter-status"
            @change="applyDeliveryFilters"
          >
            <option value="">Any status</option>
            <option v-for="status in DELIVERY_STATUSES" :key="status" :value="status">
              {{ status }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Kind</span>
          <select
            v-model="deliveryKindFilter"
            data-testid="mo-delivery-filter-kind"
            @change="applyDeliveryFilters"
          >
            <option value="">Any kind</option>
            <option v-for="kind in DELIVERY_KINDS" :key="kind" :value="kind">{{ kind }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select
            v-model="deliverySort"
            data-testid="mo-delivery-sort"
            @change="applyDeliveryFilters"
          >
            <option v-for="field in DELIVERY_SORT_FIELDS" :key="field" :value="field">
              {{ field }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Per page</span>
          <select
            v-model.number="deliveryLimit"
            data-testid="mo-delivery-limit"
            @change="applyDeliveryFilters"
          >
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Kind</th>
              <th scope="col">Target</th>
              <th scope="col">Rule</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last error</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="delivery in deliveries"
              :key="text(delivery.id)"
              :data-testid="`mo-delivery-${text(delivery.id)}`"
            >
              <td>
                <span class="status-badge" :class="badgeTone(delivery.status)">{{
                  text(delivery.status)
                }}</span>
              </td>
              <td>{{ text(delivery.kind) }}</td>
              <td class="mono">{{ text(delivery.target) }}</td>
              <td>{{ text(delivery.rule_name) }}</td>
              <td class="mono">
                {{ text(delivery.attempts, '0') }} / {{ text(delivery.max_attempts, '5') }}
                <small v-if="num(delivery.manual_retries)" class="row-id"
                  >{{ num(delivery.manual_retries) }} manual retry(s)</small
                >
              </td>
              <td>{{ text(delivery.last_error) }}</td>
              <td class="row-actions">
                <button
                  v-if="canManage"
                  class="secondary-button"
                  :data-testid="`mo-delivery-retry-${text(delivery.id)}`"
                  :disabled="!canRetry(delivery) || deliveryBusy === text(delivery.id)"
                  :title="
                    canRetry(delivery)
                      ? undefined
                      : 'Only a failed, dead-lettered or cancelled delivery can be retried.'
                  "
                  @click="retryDelivery(delivery)"
                >
                  Retry
                </button>
              </td>
            </tr>
            <tr v-if="deliveryState === 'ok' && !deliveries.length">
              <td colspan="7" class="empty-cell" data-testid="mo-delivery-empty">
                No fan-out delivery attempts recorded.
              </td>
            </tr>
            <tr v-if="deliveryState === 'loading'">
              <td colspan="7" class="empty-cell">Loading deliveries…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="mo-delivery-range">{{ deliveryRangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="mo-delivery-prev"
            :disabled="deliveryOffset === 0"
            @click="turnDeliveryPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="mo-delivery-next"
            :disabled="deliveryOffset + deliveries.length >= deliveryTotal"
            @click="turnDeliveryPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
      <p class="source-note" data-testid="mo-delivery-note">
        Retry is offered only for a failed, dead-lettered or cancelled delivery; the API refuses the
        rest. The last-error text is written at delivery time and is worded differently from the
        validation message you get when saving a destination — a webhook refused mid-flight reads
        “refusing to POST to private host …”, not the longer sentence the save form shows. There is
        no sort by delivered time here: that column is null for everything that has not landed, and
        the shared pager does not order null keys.
      </p>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
