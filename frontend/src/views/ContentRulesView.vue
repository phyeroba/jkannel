<script setup lang="ts">
/**
 * CONTENT FILTERING — the screen that answers "why didn't this send?".
 *
 * Backend contract: `backend/src/messaging-depth/content-filter.controller.ts`
 * (`@Controller('messaging/content-rules')`), `content-filter.service.ts`
 * (`CONTENT_RULE_GRID`) and `content-rule-regex.ts`.
 *
 *   GET    /messaging/content-rules          shared grid vocabulary
 *   GET    /messaging/content-rules/policy   precedence, caps, cache window
 *   POST   /messaging/content-rules/preview  outcome + every match, shadow-flagged
 *   POST   /messaging/content-rules          create        (messages.send)
 *   PATCH  /messaging/content-rules/:id      partial update (messages.send)
 *   DELETE /messaging/content-rules/:id      delete         (messages.send)
 *
 * Three things this screen exists to make visible, because getting them wrong
 * is how an operator ends up trusting a rule that is not protecting them:
 *
 * 1. ORDER. Evaluation is first-match-wins over (priority, created_at, id).
 *    Exactly one rule decides every message. The default listing therefore
 *    sends NO `sort` parameter at all — an explicit `sort=priority` replaces
 *    the backend's whole ORDER BY and drops the created_at/id tiebreakers, so
 *    it would look like evaluation order without being it. Every other sort is
 *    banner-flagged as not being evaluation order.
 * 2. SHADOWING. The preview flags a matching rule that an earlier rule always
 *    beats. A shadowed rule can never decide anything.
 * 3. QUARANTINE. A regex that blows the runtime budget is disabled in the
 *    database mid-send. The rule the operator wrote is no longer running.
 *
 * Grid controls here are limited to what CONTENT_RULE_GRID actually whitelists;
 * `caseSensitive`, `pattern` and `expiresAt` are not filterable and carry no
 * control (pattern is searchable, and the footnote says so).
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import ModalDialog from '../components/ModalDialog.vue';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

interface Option {
  value: string;
  label: string;
}
interface RuleMatch {
  ruleId?: string;
  ruleName?: string;
  action?: string;
  field?: string;
  matchType?: string;
  pattern?: string;
  priority?: number;
  matchedOn?: string;
  reason?: string | null;
  shadowed?: boolean;
}
interface PreviewResult {
  allowed?: boolean;
  outcome?: string;
  reason?: string;
  decidedBy?: RuleMatch | null;
  matches?: RuleMatch[];
  rulesInScope?: number;
  rulesOutOfScope?: number;
  rulesLoaded?: number;
  evaluationPoint?: string;
  quarantined?: string[];
}
interface Policy {
  precedence?: string;
  order?: string;
  defaultOutcome?: string;
  explanation?: string;
  matchFields?: string[];
  matchTypes?: string[];
  maxRules?: number;
  maxRegexRules?: number;
  cacheTtlMs?: number;
  cacheNote?: string;
}

/** Mirrors CONTENT_MATCH_FIELDS / CONTENT_MATCH_TYPES / CONTENT_RULE_ACTIONS. */
const MATCH_FIELDS = ['body', 'sender', 'recipient', 'any'];
const MATCH_TYPES = ['substring', 'exact', 'prefix', 'regex'];
const ACTIONS = ['block', 'allow'];
/**
 * Exactly CONTENT_RULE_GRID.sortColumns. `''` is the real default: it sends no
 * `sort` at all, which is the only way to get the backend's own evaluation
 * order (priority ASC, created_at ASC, id ASC) rather than a bare priority sort.
 */
const SORT_FIELDS: Option[] = [
  { value: '', label: 'Evaluation order (priority, then age)' },
  { value: 'priority', label: 'priority' },
  { value: 'name', label: 'name' },
  { value: 'action', label: 'action' },
  { value: 'matchField', label: 'matchField' },
  { value: 'matchType', label: 'matchType' },
  { value: 'enabled', label: 'enabled' },
  { value: 'createdAt', label: 'createdAt' },
  { value: 'updatedAt', label: 'updatedAt' },
  { value: 'lastMatchedAt', label: 'lastMatchedAt' },
  { value: 'matchCount', label: 'matchCount' },
];
const PAGE_SIZES = [25, 50, 100, 250, 500];
/** MAX_LITERAL_PATTERN_LENGTH / MAX_PATTERN_LENGTH in the backend. */
const MAX_LITERAL_PATTERN = 512;
const MAX_REGEX_PATTERN = 256;

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

// Reads need messages.view (also the route guard); every mutation on this
// controller requires messages.send — the same permission as sending, because
// these rules decide whether traffic goes out at all.
const canManage = computed(() => canAccess(session.value, 'messages.send'));

// --- Policy ------------------------------------------------------------------
const policy = ref<Policy | null>(null);
const policyError = ref('');

async function loadPolicy() {
  try {
    policy.value = await apiRequest<Policy>('/messaging/content-rules/policy');
    policyError.value = '';
  } catch (reason) {
    policy.value = null;
    policyError.value = messageFrom(reason, 'The filter policy could not be loaded.');
  }
}

const matchFieldOptions = computed(() => policy.value?.matchFields ?? MATCH_FIELDS);
const matchTypeOptions = computed(() => policy.value?.matchTypes ?? MATCH_TYPES);

// --- SMSC options (scope is the ENGINE id, not the SMSC UUID) ----------------
const smscOptions = ref<Option[]>([]);
const smscOptionsError = ref('');

async function loadSmscOptions() {
  try {
    smscOptions.value = asItems(await apiRequest<unknown>('/smscs?limit=500&offset=0'))
      .map((row) => {
        const engineId = text(row.engine_id ?? row.engineId, '');
        return { value: engineId, label: `${text(row.name)} (${engineId})` };
      })
      .filter((option) => option.value && option.value !== '—');
    smscOptionsError.value = '';
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value = messageFrom(reason, 'SMSC connections could not be loaded.');
  }
}

// --- Rule grid ---------------------------------------------------------------
const rules = ref<RecordValue[]>([]);
const gridState = ref<LoadState>('loading');
const gridError = ref('');
const gridMissing = ref(false);
const total = ref(0);
const limit = ref(50);
const offset = ref(0);
const search = ref('');
const filterAction = ref('');
const filterMatchField = ref('');
const filterMatchType = ref('');
const filterEnabled = ref('');
const filterSmscId = ref('');
const sortField = ref('');
const sortDirection = ref<'asc' | 'desc'>('asc');
const notice = ref('');
const busy = ref(false);

/** True only when the listing really is in the order the send path evaluates. */
const inEvaluationOrder = computed(() => sortField.value === '');

const rangeLabel = computed(() => {
  if (!rules.value.length) return 'Showing 0 of 0';
  return `Showing ${offset.value + 1}–${offset.value + rules.value.length} of ${total.value}`;
});

const quarantinedCount = computed(
  () => rules.value.filter((rule) => Boolean(rule.quarantined_at)).length,
);

function isQuarantined(rule: RecordValue) {
  return Boolean(rule.quarantined_at);
}
/** An expired rule is still stored but is never loaded by the send path. */
function isExpired(rule: RecordValue) {
  const expires = rule.expires_at;
  if (!expires) return false;
  const at = Date.parse(String(expires));
  return Number.isFinite(at) && at <= Date.now();
}
function scopeOf(rule: RecordValue): string {
  const parts: string[] = [];
  if (rule.smsc_id) parts.push(`SMSC ${String(rule.smsc_id)}`);
  if (rule.customer_id) parts.push(`customer ${String(rule.customer_id)}`);
  return parts.length ? parts.join(' · ') : 'global';
}
function describeRule(rule: RecordValue): string {
  return `${text(rule.match_type)} on ${text(rule.match_field)} ${
    rule.case_sensitive ? '(case-sensitive)' : '(case-insensitive)'
  }`;
}

async function loadRules() {
  gridState.value = 'loading';
  gridMissing.value = false;
  const params = new URLSearchParams();
  if (search.value.trim()) params.set('search', search.value.trim());
  if (filterAction.value) params.set('filter.action', filterAction.value);
  if (filterMatchField.value) params.set('filter.matchField', filterMatchField.value);
  if (filterMatchType.value) params.set('filter.matchType', filterMatchType.value);
  if (filterEnabled.value) params.set('filter.enabled', filterEnabled.value);
  if (filterSmscId.value) params.set('filter.smscId', filterSmscId.value);
  // Omitted entirely for the default: see SORT_FIELDS.
  if (sortField.value)
    params.set('sort', `${sortDirection.value === 'desc' ? '-' : ''}${sortField.value}`);
  params.set('limit', String(limit.value));
  params.set('offset', String(offset.value));
  try {
    const payload = await apiRequest<RecordValue>(`/messaging/content-rules?${params.toString()}`);
    rules.value = asItems(payload);
    total.value = typeof payload.total === 'number' ? payload.total : rules.value.length;
    gridError.value = '';
    gridState.value = 'ok';
  } catch (reason) {
    rules.value = [];
    total.value = 0;
    gridMissing.value = isMissing(reason);
    // A 400 here is a rejected sort or filter and the API names the field.
    gridError.value = messageFrom(reason, 'Content rules could not be loaded.');
    gridState.value = 'error';
  }
}

function applyFilters() {
  offset.value = 0;
  void loadRules();
}
function toggleSortDirection() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  applyFilters();
}
function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * limit.value);
  if (direction > 0 && offset.value + limit.value >= total.value) return;
  if (next === offset.value) return;
  offset.value = next;
  void loadRules();
}

// --- Rule editor -------------------------------------------------------------
const showForm = ref(false);
const editingId = ref('');
const formError = ref('');
const draftName = ref('');
const draftDescription = ref('');
const draftMatchField = ref('body');
const draftMatchType = ref('substring');
const draftPattern = ref('');
const draftCaseSensitive = ref(false);
const draftAction = ref('block');
const draftSmscId = ref('');
const draftCustomerId = ref('');
const draftEnabled = ref(true);
const draftPriority = ref(100);
const draftExpiresAt = ref('');
const draftReason = ref('');

const patternLimit = computed(() =>
  draftMatchType.value === 'regex' ? MAX_REGEX_PATTERN : MAX_LITERAL_PATTERN,
);

function openForm(rule?: RecordValue) {
  showForm.value = true;
  formError.value = '';
  notice.value = '';
  editingId.value = rule ? text(rule.id, '') : '';
  draftName.value = rule ? text(rule.name, '') : '';
  draftDescription.value = rule && rule.description ? String(rule.description) : '';
  draftMatchField.value = rule ? text(rule.match_field, 'body') : 'body';
  draftMatchType.value = rule ? text(rule.match_type, 'substring') : 'substring';
  draftPattern.value = rule ? text(rule.pattern, '') : '';
  draftCaseSensitive.value = rule ? rule.case_sensitive === true : false;
  draftAction.value = rule ? text(rule.action, 'block') : 'block';
  draftSmscId.value = rule && rule.smsc_id ? String(rule.smsc_id) : '';
  draftCustomerId.value = rule && rule.customer_id ? String(rule.customer_id) : '';
  draftEnabled.value = rule ? rule.enabled !== false : true;
  draftPriority.value = rule ? num(rule.priority) : 100;
  // datetime-local wants "YYYY-MM-DDTHH:mm"; the API returns ISO 8601.
  draftExpiresAt.value = rule && rule.expires_at ? String(rule.expires_at).slice(0, 16) : '';
  draftReason.value = rule && rule.reason ? String(rule.reason) : '';
}
function closeForm() {
  showForm.value = false;
  editingId.value = '';
  formError.value = '';
}

async function saveRule() {
  if (!canManage.value) return;
  formError.value = '';
  const name = draftName.value.trim();
  if (!name) {
    formError.value = 'A rule name is required.';
    return;
  }
  if (!draftPattern.value) {
    formError.value = 'A pattern is required.';
    return;
  }
  if (draftPattern.value.length > patternLimit.value) {
    formError.value = `A ${draftMatchType.value} pattern must be at most ${patternLimit.value} characters.`;
    return;
  }
  if (!Number.isInteger(draftPriority.value) || draftPriority.value < 0) {
    formError.value = 'Priority must be a whole number of 0 or more; lower is evaluated first.';
    return;
  }

  // PATCH is a true partial, but every field on this form is always shown, so
  // the whole set is sent on both paths — an omitted key would silently keep
  // an old value the operator can see they have just cleared.
  const body: RecordValue = {
    name,
    description: draftDescription.value.trim() || null,
    matchField: draftMatchField.value,
    matchType: draftMatchType.value,
    pattern: draftPattern.value,
    caseSensitive: draftCaseSensitive.value,
    action: draftAction.value,
    smscId: draftSmscId.value || null,
    customerId: draftCustomerId.value.trim() || null,
    enabled: draftEnabled.value,
    priority: draftPriority.value,
    expiresAt: draftExpiresAt.value ? new Date(draftExpiresAt.value).toISOString() : null,
    reason: draftReason.value.trim() || null,
  };

  busy.value = true;
  try {
    if (editingId.value)
      await apiRequest(`/messaging/content-rules/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    else
      await apiRequest('/messaging/content-rules', { method: 'POST', body: JSON.stringify(body) });
    notice.value =
      `Rule “${name}” ${editingId.value ? 'updated' : 'created'}. It takes effect immediately in ` +
      `this API process and within the cache window (${num(policy.value?.cacheTtlMs)} ms) in every other one.`;
    closeForm();
    await loadRules();
  } catch (reason) {
    // Surfaced verbatim: the API names the field, and for a rejected regex it
    // names the rejection class (nested_quantifier, too_long, …) and why.
    formError.value = messageFrom(reason, 'The content rule could not be saved.');
  } finally {
    busy.value = false;
  }
}

async function removeRule(rule: RecordValue) {
  if (!canManage.value) return;
  const id = text(rule.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Delete the content rule “${text(rule.name, id)}”?\n\nIt is removed, not disabled. Traffic it was blocking will fall through to the next matching rule, or be allowed if none matches.`,
    )
  )
    return;
  busy.value = true;
  try {
    await apiRequest(`/messaging/content-rules/${id}`, { method: 'DELETE' });
    notice.value = `Rule “${text(rule.name, id)}” deleted.`;
    await loadRules();
  } catch (reason) {
    gridError.value = messageFrom(reason, 'The content rule could not be deleted.');
  } finally {
    busy.value = false;
  }
}

/**
 * There is no un-quarantine endpoint: the quarantine columns are cleared by the
 * same UPDATE that re-enables the rule, so releasing one is a PATCH that sets
 * `enabled: true` and nothing else.
 */
async function releaseQuarantine(rule: RecordValue) {
  if (!canManage.value) return;
  const id = text(rule.id, '');
  if (!id) return;
  if (
    !window.confirm(
      `Re-enable the quarantined rule “${text(rule.name, id)}”?\n\n` +
        'This clears the quarantine and puts the same pattern back on the send path. If the ' +
        'pattern has not been simplified it will very likely exceed the budget again and be ' +
        'quarantined a second time. Edit the pattern first if you have not already.',
    )
  )
    return;
  busy.value = true;
  try {
    await apiRequest(`/messaging/content-rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    notice.value = `Rule “${text(rule.name, id)}” re-enabled and released from quarantine.`;
    await loadRules();
  } catch (reason) {
    gridError.value = messageFrom(reason, 'The rule could not be re-enabled.');
  } finally {
    busy.value = false;
  }
}

// --- Preview -----------------------------------------------------------------
const previewText = ref('');
const previewSender = ref('');
const previewRecipient = ref('');
const previewSmscId = ref('');
const previewCustomerId = ref('');
const previewBusy = ref(false);
const previewError = ref('');
const preview = ref<PreviewResult | null>(null);

const previewMatches = computed(() => preview.value?.matches ?? []);
const shadowedMatches = computed(() => previewMatches.value.filter((match) => match.shadowed));
const previewQuarantined = computed(() => preview.value?.quarantined ?? []);

async function runPreview() {
  if (!previewText.value) {
    previewError.value = 'A candidate message body is required — that is what the rules match on.';
    return;
  }
  previewBusy.value = true;
  previewError.value = '';
  preview.value = null;
  try {
    const body: RecordValue = { text: previewText.value };
    if (previewSender.value.trim()) body.sender = previewSender.value.trim();
    if (previewRecipient.value.trim()) body.recipient = previewRecipient.value.trim();
    if (previewSmscId.value) body.smscId = previewSmscId.value;
    if (previewCustomerId.value.trim()) body.customerId = previewCustomerId.value.trim();
    preview.value = await apiRequest<PreviewResult>('/messaging/content-rules/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    // A preview runs the real matcher, so it can trip the regex budget and
    // quarantine a rule for real. Reload so the grid shows that immediately.
    if ((preview.value?.quarantined ?? []).length) await loadRules();
  } catch (reason) {
    previewError.value = messageFrom(reason, 'The preview could not be run.');
  } finally {
    previewBusy.value = false;
  }
}

onMounted(() => {
  void loadPolicy();
  void loadSmscOptions();
  void loadRules();
});
</script>

<template>
  <div data-testid="content-rules-view">
    <p v-if="!canManage" class="source-note" data-testid="content-rules-readonly">
      You can review the rule set and run the preview. Creating, editing, deleting and re-enabling
      rules requires the messages.send permission — the same permission as sending, because these
      rules decide whether traffic goes out.
    </p>
    <p v-if="notice" class="notice" role="status" data-testid="content-rules-notice">
      {{ notice }}
    </p>

    <!-- Precedence ---------------------------------------------------------- -->
    <section class="panel" data-testid="content-policy-panel" aria-label="Filter precedence">
      <header class="panel-header">
        <div>
          <h2>How a decision is made</h2>
          <p>{{ text(policy?.precedence, 'first_match_wins') }}</p>
        </div>
      </header>
      <p v-if="policyError" class="source-note" data-testid="content-policy-error">
        {{ policyError }}
      </p>
      <p data-testid="content-policy-explanation">
        {{
          text(
            policy?.explanation,
            'Rules are evaluated in priority order (lowest number first); the first rule that matches decides and no later rule is consulted.',
          )
        }}
      </p>
      <div class="summary-strip">
        <div class="metric">
          <strong class="mono" data-testid="content-policy-order">{{
            text(policy?.order, 'priority ASC, created_at ASC, id ASC')
          }}</strong>
          <small>evaluation order</small>
        </div>
        <div class="metric">
          <strong>{{ text(policy?.defaultOutcome, 'allow') }}</strong>
          <small>outcome when nothing matches</small>
        </div>
        <div class="metric">
          <strong>{{ num(policy?.maxRules) || '—' }}</strong>
          <small>max enabled rules</small>
        </div>
        <div class="metric">
          <strong>{{ num(policy?.maxRegexRules) || '—' }}</strong>
          <small>max enabled regex rules</small>
        </div>
        <div class="metric">
          <strong>{{ num(policy?.cacheTtlMs) }} ms</strong>
          <small>cache window</small>
        </div>
      </div>
      <p class="source-note" data-testid="content-policy-cache">
        {{
          text(
            policy?.cacheNote,
            'A rule change takes effect immediately in the process that made it and within the cache window in every other process.',
          )
        }}
      </p>
      <!--
        The columns exist and are written on every send decision, but no read
        endpoint selects them, so this screen cannot offer a "show me the rule
        that blocked message X" link. Say that rather than leave the operator
        hunting for a control that is not there.
      -->
      <p class="source-note" data-testid="content-trace-gap">
        A blocked send is refused with the deciding rule named in the API’s own error (<span
          class="mono"
          >content rule "…" (id, priority n) blocked this message: …</span
        >), and the same sentence is stored as the reason on the routing decision. There is no grid
        here that filters historic messages by rule id: the
        <span class="mono">message_route_decisions.content_rule_id</span> column is written but no
        REST route returns it yet.
      </p>
    </section>

    <!-- Preview -------------------------------------------------------------- -->
    <section class="panel" data-testid="content-preview-panel" aria-label="Test a message">
      <header class="panel-header">
        <div>
          <h2>Test a message before a rule drops it</h2>
          <p>Runs the same matcher the send path runs, against the live rule set.</p>
        </div>
      </header>
      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Message body</span>
          <input
            v-model="previewText"
            data-testid="content-preview-text"
            type="text"
            placeholder="The candidate message body"
            @keyup.enter="runPreview"
          />
        </label>
        <label class="filter-select">
          <span>Sender</span>
          <input v-model="previewSender" data-testid="content-preview-sender" type="text" />
        </label>
        <label class="filter-select">
          <span>Recipient</span>
          <input v-model="previewRecipient" data-testid="content-preview-recipient" type="text" />
        </label>
        <label class="filter-select">
          <span>SMSC scope</span>
          <select v-model="previewSmscId" data-testid="content-preview-smsc">
            <option value="">Any (unscoped)</option>
            <option v-for="option in smscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Customer id</span>
          <input
            v-model="previewCustomerId"
            data-testid="content-preview-customer"
            type="text"
            placeholder="UUID, optional"
          />
        </label>
        <button
          class="primary-button"
          data-testid="content-preview-run"
          :disabled="previewBusy"
          @click="runPreview"
        >
          {{ previewBusy ? 'Evaluating…' : 'Evaluate' }}
        </button>
      </div>
      <p v-if="previewError" class="form-error" role="alert" data-testid="content-preview-error">
        {{ previewError }}
      </p>

      <div v-if="preview" class="baseline-info" data-testid="content-preview-result">
        <div class="summary-strip">
          <div class="metric">
            <strong
              class="status-badge"
              :class="preview.outcome === 'block' ? 'bad' : 'good'"
              data-testid="content-preview-outcome"
              >{{ text(preview.outcome, 'allow') }}</strong
            >
            <small>outcome</small>
          </div>
          <div class="metric">
            <strong data-testid="content-preview-decided-by">{{
              preview.decidedBy ? text(preview.decidedBy.ruleName) : 'no rule'
            }}</strong>
            <small>deciding rule</small>
          </div>
          <div class="metric">
            <strong>{{ num(preview.rulesInScope) }}</strong>
            <small>rules in scope</small>
          </div>
          <div class="metric">
            <strong>{{ num(preview.rulesOutOfScope) }}</strong>
            <small>skipped, out of scope</small>
          </div>
          <div class="metric">
            <strong data-testid="content-preview-shadowed-count">{{
              shadowedMatches.length
            }}</strong>
            <small>shadowed matches</small>
          </div>
        </div>
        <p class="source-note" data-testid="content-preview-reason">{{ text(preview.reason) }}</p>
        <p
          v-if="!preview.decidedBy"
          class="source-note"
          data-testid="content-preview-default-outcome"
        >
          Nothing matched, so this message is allowed by default — not by a rule. An
          <strong>allow</strong> outcome with no deciding rule means the rule set never had an
          opinion about it.
        </p>

        <!--
          The whole point of the preview. A shadowed rule is one the operator
          believes is protecting them; it can never decide anything, because a
          higher-precedence rule always gets there first.
        -->
        <p
          v-if="shadowedMatches.length"
          class="warn-notice"
          role="alert"
          data-testid="content-preview-shadow-warning"
        >
          {{ shadowedMatches.length }} rule(s) below also matched this message but can never decide
          it: the rule above them always wins first. A shadowed rule is doing nothing — raise its
          precedence (a lower priority number) or narrow the rule that is beating it.
        </p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Rule</th>
                <th scope="col">Effect</th>
                <th scope="col">Action</th>
                <th scope="col">Priority</th>
                <th scope="col">Matched on</th>
                <th scope="col">Pattern</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(match, index) in previewMatches"
                :key="`${text(match.ruleId)}-${index}`"
                :data-testid="`content-preview-match-${index}`"
                :class="{ 'row-shadowed': match.shadowed }"
              >
                <td class="mono">{{ index + 1 }}</td>
                <td>
                  <strong>{{ text(match.ruleName) }}</strong>
                  <small class="row-id mono">{{ text(match.ruleId) }}</small>
                </td>
                <td>
                  <span
                    class="status-badge"
                    :class="match.shadowed ? 'warn' : 'good'"
                    :data-testid="`content-preview-shadowed-${index}`"
                  >
                    {{ match.shadowed ? 'shadowed — never decides' : 'decides this message' }}
                  </span>
                </td>
                <td>
                  <span class="status-badge" :class="match.action === 'block' ? 'bad' : 'good'">{{
                    text(match.action)
                  }}</span>
                </td>
                <td class="mono">{{ text(match.priority) }}</td>
                <td>{{ text(match.matchedOn) }} ({{ text(match.matchType) }})</td>
                <td class="mono">{{ text(match.pattern) }}</td>
              </tr>
              <tr v-if="!previewMatches.length">
                <td colspan="7" class="empty-cell" data-testid="content-preview-no-match">
                  No rule matched this message.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!--
          Preview is not read-only in one specific respect: it runs the real
          regex engine, so a pattern that blows the budget here is quarantined
          here. Hiding that would be a lie about what the button did.
        -->
        <p
          v-if="previewQuarantined.length"
          class="warn-notice"
          role="alert"
          data-testid="content-preview-quarantined"
        >
          This evaluation exceeded the regex time budget for
          {{ previewQuarantined.length }} rule(s), which have now been disabled and quarantined for
          real — the preview runs the same regex engine the send path runs, not a simulation. The
          affected rule ids are <span class="mono">{{ previewQuarantined.join(', ') }}</span
          >.
        </p>
        <p class="source-note">
          Evaluation point: {{ text(preview.evaluationPoint) }} —
          {{
            preview.evaluationPoint === 'after_route_selection'
              ? 'at least one rule is scoped to an SMSC, so filtering happens once a carrier has been chosen.'
              : 'no rule is scoped to an SMSC, so filtering happens before a carrier is chosen.'
          }}
        </p>
      </div>
    </section>

    <!-- Rule grid ------------------------------------------------------------ -->
    <section class="panel" data-testid="content-rules-panel" aria-label="Content rules">
      <header class="panel-header">
        <div>
          <h2>Content rules</h2>
          <p aria-live="polite">
            {{
              gridState === 'loading' ? 'Loading rules…' : `${rules.length} rule(s) on this page`
            }}
          </p>
        </div>
        <button
          v-if="canManage"
          class="primary-button"
          data-testid="content-rule-create"
          :disabled="busy"
          @click="openForm()"
        >
          New rule
        </button>
      </header>

      <p
        v-if="quarantinedCount"
        class="warn-notice"
        role="alert"
        data-testid="content-quarantine-banner"
      >
        {{ quarantinedCount }} rule(s) on this page are QUARANTINED: their regex exceeded the
        send-path time budget, so the platform disabled them in the database and evicted them from
        cache to protect the sender. They are not filtering anything now, and at least one message
        was evaluated as though the rule did not match. Review the pattern before re-enabling.
      </p>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="content-rule-search"
            type="search"
            placeholder="Name, description, pattern, reason, or author"
            @keyup.enter="applyFilters"
          />
        </label>
        <label class="filter-select">
          <span>Action</span>
          <select v-model="filterAction" data-testid="content-filter-action" @change="applyFilters">
            <option value="">Any action</option>
            <option v-for="action in ACTIONS" :key="action" :value="action">{{ action }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Match field</span>
          <select
            v-model="filterMatchField"
            data-testid="content-filter-match-field"
            @change="applyFilters"
          >
            <option value="">Any field</option>
            <option v-for="field in matchFieldOptions" :key="field" :value="field">
              {{ field }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Match type</span>
          <select
            v-model="filterMatchType"
            data-testid="content-filter-match-type"
            @change="applyFilters"
          >
            <option value="">Any type</option>
            <option v-for="type in matchTypeOptions" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Enabled</span>
          <select
            v-model="filterEnabled"
            data-testid="content-filter-enabled"
            @change="applyFilters"
          >
            <option value="">Any</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <label class="filter-select">
          <span>SMSC scope</span>
          <select v-model="filterSmscId" data-testid="content-filter-smsc" @change="applyFilters">
            <option value="">Any scope</option>
            <option v-for="option in smscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Sort</span>
          <select v-model="sortField" data-testid="content-rule-sort" @change="applyFilters">
            <option
              v-for="field in SORT_FIELDS"
              :key="field.value || 'default'"
              :value="field.value"
            >
              {{ field.label }}
            </option>
          </select>
        </label>
        <button
          class="secondary-button"
          data-testid="content-rule-sort-direction"
          :disabled="!sortField"
          @click="toggleSortDirection"
        >
          {{ sortDirection === 'asc' ? 'Ascending' : 'Descending' }}
        </button>
        <label class="filter-select">
          <span>Per page</span>
          <select v-model.number="limit" data-testid="content-rule-limit" @change="applyFilters">
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>

      <p
        v-if="!inEvaluationOrder"
        class="warn-notice"
        role="note"
        data-testid="content-order-warning"
      >
        This listing is sorted by {{ sortField }}, which is <strong>not</strong> evaluation order.
        The position numbers are hidden because they would be misleading. Switch the sort back to
        “Evaluation order” to see which rule reaches a message first.
      </p>

      <p v-if="gridState === 'error'" class="chart-empty" role="alert" data-testid="content-error">
        {{
          gridMissing ? 'The content filtering API is not available in this deployment.' : gridError
        }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col" title="Position in evaluation order">#</th>
              <th scope="col">Rule</th>
              <th scope="col">State</th>
              <th scope="col">Action</th>
              <th scope="col">Priority</th>
              <th scope="col">Match</th>
              <th scope="col">Pattern</th>
              <th scope="col">Scope</th>
              <th scope="col">Matches</th>
              <th scope="col">Last matched</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <!-- The row opens the rule. A content rule's record IS its
                 definition — pattern, scope, action — so "open" and "edit"
                 are the same dialog, and the Edit button stays as the named,
                 discoverable control. Only where the operator may change it:
                 a row that opens a form they cannot submit is a dead end. -->
            <tr
              v-for="(rule, index) in rules"
              :key="text(rule.id)"
              :data-testid="`content-rule-${text(rule.id)}`"
              :class="{ 'row-quarantined': isQuarantined(rule), selectable: canManage }"
              :tabindex="canManage ? 0 : undefined"
              @click="canManage && openForm(rule)"
              @keydown.enter="canManage && openForm(rule)"
              @keydown.space.prevent="canManage && openForm(rule)"
            >
              <td class="mono">{{ inEvaluationOrder ? offset + index + 1 : '·' }}</td>
              <td>
                <strong>{{ text(rule.name) }}</strong>
                <small class="row-id mono">{{ text(rule.id) }}</small>
                <small v-if="rule.description" class="row-id">{{ text(rule.description) }}</small>
              </td>
              <td>
                <span
                  v-if="isQuarantined(rule)"
                  class="status-badge bad"
                  :data-testid="`content-rule-quarantined-${text(rule.id)}`"
                  >quarantined</span
                >
                <span v-else-if="rule.enabled === false" class="status-badge">disabled</span>
                <span
                  v-else-if="isExpired(rule)"
                  class="status-badge warn"
                  :data-testid="`content-rule-expired-${text(rule.id)}`"
                  >expired</span
                >
                <span v-else class="status-badge good">enabled</span>
                <small
                  v-if="isQuarantined(rule)"
                  class="row-id"
                  :data-testid="`content-rule-quarantine-reason-${text(rule.id)}`"
                >
                  {{ text(rule.quarantine_reason) }} Quarantined {{ text(rule.quarantined_at) }}. A
                  message was evaluated as though this rule did not match.
                </small>
              </td>
              <td>
                <span class="status-badge" :class="rule.action === 'block' ? 'bad' : 'good'">{{
                  text(rule.action)
                }}</span>
              </td>
              <td class="mono">{{ text(rule.priority) }}</td>
              <td>{{ describeRule(rule) }}</td>
              <td class="mono">{{ text(rule.pattern) }}</td>
              <td>{{ scopeOf(rule) }}</td>
              <td class="mono">{{ text(rule.match_count, '0') }}</td>
              <td>{{ text(rule.last_matched_at, 'never') }}</td>
              <td class="row-actions">
                <template v-if="canManage">
                  <button
                    class="secondary-button"
                    :data-testid="`content-rule-edit-${text(rule.id)}`"
                    @click.stop="openForm(rule)"
                  >
                    Edit
                  </button>
                  <button
                    v-if="isQuarantined(rule)"
                    class="secondary-button"
                    :data-testid="`content-rule-release-${text(rule.id)}`"
                    :disabled="busy"
                    @click.stop="releaseQuarantine(rule)"
                  >
                    Re-enable
                  </button>
                  <button
                    class="secondary-button danger-button"
                    :data-testid="`content-rule-delete-${text(rule.id)}`"
                    :disabled="busy"
                    @click.stop="removeRule(rule)"
                  >
                    Delete
                  </button>
                </template>
                <span v-else class="source-note">read-only</span>
              </td>
            </tr>
            <tr v-if="gridState === 'ok' && !rules.length">
              <td colspan="11" class="empty-cell" data-testid="content-rule-empty">
                No content rules match these filters. With no matching rule, every message is sent.
              </td>
            </tr>
            <tr v-if="gridState === 'loading'">
              <td colspan="11" class="empty-cell">Loading rules…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="pager">
        <span data-testid="content-rule-range">{{ rangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="content-rule-prev"
            :disabled="offset === 0"
            @click="turnPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="content-rule-next"
            :disabled="offset + rules.length >= total"
            @click="turnPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
      <p class="source-note" data-testid="content-rule-grid-note">
        Search, filters, sort, page size and paging are all applied by the API. The pattern is
        searchable but not filterable, and case sensitivity and the expiry date are neither — the
        grid offers only the fields the API’s own whitelist accepts. Offset paging is used rather
        than cursor paging so the row count and the position numbers are real.
      </p>
      <p v-if="smscOptionsError" class="source-note" data-testid="content-smsc-error">
        {{ smscOptionsError }}
      </p>
    </section>

    <!-- Rule editor ------------------------------------------------------------
         A Dialog, per the design system: a form that makes a record is an
         overlay, never a panel that unfolds below the register it adds to. -->
    <ModalDialog
      :open="showForm"
      :title="editingId ? 'Edit content rule' : 'New content rule'"
      testid="content-rule-form"
      wide
      @close="closeForm"
    >
      <label class="filter-select filter-search">
        <span>Name (unique, up to 200 characters)</span>
        <input v-model="draftName" data-testid="content-form-name" type="text" />
      </label>
      <label class="filter-select filter-search">
        <span>Description</span>
        <input v-model="draftDescription" data-testid="content-form-description" type="text" />
      </label>
      <label class="filter-select">
        <span>Action</span>
        <select v-model="draftAction" data-testid="content-form-action">
          <option v-for="action in ACTIONS" :key="action" :value="action">{{ action }}</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Match field</span>
        <select v-model="draftMatchField" data-testid="content-form-match-field">
          <option v-for="field in matchFieldOptions" :key="field" :value="field">
            {{ field }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Match type</span>
        <select v-model="draftMatchType" data-testid="content-form-match-type">
          <option v-for="type in matchTypeOptions" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="filter-select filter-search">
        <span>Pattern (at most {{ patternLimit }} characters)</span>
        <input v-model="draftPattern" data-testid="content-form-pattern" type="text" />
      </label>
      <p
        v-if="draftMatchType === 'regex'"
        class="warn-notice"
        role="note"
        data-testid="content-form-regex-note"
      >
        A regex is checked three times over. It is rejected at save time if it uses backreferences,
        lookbehind, a nested quantifier, a repeat bound above 100, more than 12 quantifiers or more
        than 3 unbounded ones. At match time the subject is truncated before the pattern runs. And
        if a single execution still exceeds the send-path time budget, the rule is disabled and
        quarantined automatically — which means the message being sent at that moment is evaluated
        as though this rule did not match.
      </p>
      <label class="filter-select">
        <span>Case sensitive</span>
        <select v-model="draftCaseSensitive" data-testid="content-form-case">
          <option :value="false">No</option>
          <option :value="true">Yes</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Priority (lower is evaluated first)</span>
        <input
          v-model.number="draftPriority"
          data-testid="content-form-priority"
          type="number"
          min="0"
          max="1000000"
        />
      </label>
      <p class="form-hint">
        First match wins. To exempt something from a block, give the allow rule a
        <strong>lower</strong> priority number than the block it is meant to override — otherwise
        the block gets there first and the allow rule is shadowed.
      </p>
      <label class="filter-select">
        <span>SMSC scope</span>
        <select v-model="draftSmscId" data-testid="content-form-smsc">
          <option value="">Global (all SMSCs)</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="filter-select filter-search">
        <span>Customer scope (UUID, optional)</span>
        <input v-model="draftCustomerId" data-testid="content-form-customer" type="text" />
      </label>
      <label class="filter-select">
        <span>Enabled</span>
        <select v-model="draftEnabled" data-testid="content-form-enabled">
          <option :value="true">Yes</option>
          <option :value="false">No</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Expires at (optional)</span>
        <input v-model="draftExpiresAt" data-testid="content-form-expires" type="datetime-local" />
      </label>
      <label class="filter-select filter-search">
        <span>Reason shown to the sender when this rule blocks</span>
        <input v-model="draftReason" data-testid="content-form-reason" type="text" />
      </label>
      <p v-if="formError" class="form-error" role="alert" data-testid="content-form-error">
        {{ formError }}
      </p>
      <template #footer>
        <button class="secondary-button" data-testid="content-form-cancel" @click="closeForm">
          Cancel
        </button>
        <button
          class="primary-button"
          data-testid="content-form-save"
          :disabled="busy || !canManage"
          @click="saveRule"
        >
          {{ busy ? 'Saving…' : 'Save rule' }}
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style src="./workspace-extras.css"></style>

<style scoped>
/* A quarantined rule must not read as an ordinary disabled one: it was
   disabled by the platform, mid-send, without anyone asking. */
.row-quarantined {
  background: color-mix(in srgb, var(--danger, #b3261e) 8%, transparent);
}
/* Same reasoning in the preview: a shadowed match is inert, and looking
   identical to the rule that actually decided is the misreading to prevent. */
.row-shadowed {
  opacity: 0.72;
}
</style>
