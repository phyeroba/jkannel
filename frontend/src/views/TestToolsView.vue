<script setup lang="ts">
/**
 * TEST TOOLS (PLAN.md 5.5, spec §15, UC-TST-01).
 *
 * Four tools, and the screen is explicit about which of them touch a carrier:
 * only the connectivity test does, and it opens a socket rather than sending a
 * message. Nothing here submits an SMS.
 *
 *   1. NUMBER AND PREFIX LOOKUP — `GET /diagnostics/number-lookup`.
 *      The response carries its own `limits`, and they are rendered VERBATIM and
 *      in full. The first one states that JKANNEL has no prefix-to-operator
 *      database, so the mobile network behind a number is NOT identified. That
 *      is precisely the fact this tool would otherwise be assumed to supply, so
 *      there is deliberately **no Network column** here: an empty column would
 *      be read as "no network found" rather than "never determined", and a
 *      populated one would be a guess an operator would route traffic on.
 *
 *   2. ENCODING AND SEGMENT ANALYZER — computed in the browser by
 *      `utils/message-segments.ts`, a faithful port of the engine's own module.
 *      A round trip per keystroke is not worth it, and the port is tested
 *      against the same boundaries the backend spec asserts.
 *
 *   3. CONNECTIVITY TEST — `POST /smscs/:id/actions/test`. The result reports
 *      the VERIFICATION LEVEL, not just pass/fail, because a passed
 *      `tcp_socket` proves only that something is listening.
 *
 *   4. TAGGED TEST SENDS — `GET /diagnostics/test-sends`. The register of
 *      messages an operator marked as test traffic (UC-TST-01). This build has
 *      no console control that tags a send, so this is a read of what other
 *      callers have tagged, and the panel says so rather than implying an empty
 *      list means nobody has ever run a test.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import SegmentCounter from '../components/SegmentCounter.vue';
import TabStrip from '../components/TabStrip.vue';
import EventTimeline from '../components/EventTimeline.vue';
import ConfirmAction from '../components/ConfirmAction.vue';
import { canAccess, session } from '../stores/session';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import { formatStageMoment, type MessageTrace } from '../utils/diagnostics';
import { describeComposerText } from '../utils/message-segments';
import {
  smscOptionsFrom,
  verificationTone,
  verificationWord,
  type ActionImpact,
  type ConnectivityTestResult,
  type NumberLookup,
  type SmscOption,
  type TestSend,
} from '../utils/safe-control';

const canLookup = computed(() => canAccess(session.value, 'routes.view'));
const canReadSends = computed(() => canAccess(session.value, 'messages.view'));
const canTest = computed(() => canAccess(session.value, 'smsc.manage'));
/** `POST /messages` declares configuration.manage, so the button follows it. */
const canSend = computed(() => canAccess(session.value, 'configuration.manage'));

/**
 * The six tools, as tabs.
 *
 * They were previously stacked down one page, which made the transmitting tool
 * and the read-only ones look equally consequential — you scrolled past Test
 * SMS on the way to the encoding analyser. Tabs put one tool in front of the
 * operator at a time, and the scope note above the strip still says which of
 * them touch a carrier.
 */
const TOOL_TABS = [
  { id: 'connectivity', label: 'SMPP connectivity' },
  { id: 'test-sms', label: 'Test SMS' },
  { id: 'dlr', label: 'DLR lookup' },
  { id: 'encoding', label: 'Encoding analyser' },
  { id: 'number', label: 'Number lookup' },
];

const tab = ref('connectivity');

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
function stateFor(cause: unknown): State {
  return cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
}

// --- 1. Number and prefix lookup ----------------------------------------------
const lookupInput = ref('');
const lookup = ref<NumberLookup | null>(null);
const lookupState = ref<State>('empty');
const lookupError = ref('');
const lookupBusy = ref(false);

async function runLookup() {
  const value = lookupInput.value.trim();
  if (!value) {
    lookupError.value = 'Enter a number to look up.';
    lookupState.value = 'error';
    return;
  }
  lookupBusy.value = true;
  lookupState.value = 'loading';
  try {
    lookup.value = await apiRequest<NumberLookup>(
      `/diagnostics/number-lookup?msisdn=${encodeURIComponent(value)}`,
    );
    lookupError.value = '';
    lookupState.value = 'live';
  } catch (cause) {
    lookup.value = null;
    lookupError.value = messageFrom(cause, 'The number could not be looked up.');
    lookupState.value = stateFor(cause);
  } finally {
    lookupBusy.value = false;
  }
}

// --- 2. Encoding and segment analyzer -----------------------------------------
const body = ref('');
const analysis = computed(() => describeComposerText(body.value));

/**
 * The server's own segment count, for the same body.
 *
 * The browser figure is a port of the engine's module and keeps up with typing;
 * this one is the authority, because it is the code the send path runs. They
 * should agree, and the case worth catching is when they do not — one character
 * classified differently is what turns a one-segment message into two on the
 * wire and surprises somebody's bill.
 *
 * POST rather than the GET form: a three-segment UCS-2 body is roughly 200
 * characters of percent-encoded query string, and proxies do impose URL limits.
 */
const serverPreview = ref<Record<string, unknown> | null>(null);
const serverPreviewBusy = ref(false);
const serverPreviewError = ref('');

const serverPreviewAgrees = computed<boolean | null>(() => {
  const server = serverPreview.value;
  if (!server) return null;
  const count = Number(server.segments);
  if (!Number.isFinite(count)) return null;
  return count === analysis.value.segments;
});

async function checkOnServer() {
  serverPreviewBusy.value = true;
  serverPreviewError.value = '';
  serverPreview.value = null;
  try {
    serverPreview.value = await apiRequest<Record<string, unknown>>('/messages/preview', {
      method: 'POST',
      body: JSON.stringify({ text: body.value }),
    });
  } catch (cause) {
    serverPreviewError.value = messageFrom(cause, 'The server preview could not be read.');
  } finally {
    serverPreviewBusy.value = false;
  }
}

// --- 3. Connectivity test ------------------------------------------------------
const smscs = ref<SmscOption[]>([]);
const smscError = ref('');
const testSmscId = ref('');
const testResult = ref<ConnectivityTestResult | null>(null);
const testState = ref<State>('empty');
const testError = ref('');
const testBusy = ref(false);

const testedSmsc = computed(
  () => smscs.value.find((option) => option.id === testSmscId.value) ?? null,
);
const verification = computed(() => testResult.value?.verification ?? null);

async function loadSmscs() {
  try {
    const page = await apiRequest<{ items?: unknown[] }>('/smscs?limit=500&offset=0');
    smscs.value = smscOptionsFrom(Array.isArray(page?.items) ? (page.items as never[]) : []);
    smscError.value = '';
    if (!testSmscId.value && smscs.value.length) testSmscId.value = smscs.value[0].id;
  } catch (cause) {
    smscs.value = [];
    smscError.value = messageFrom(cause, 'The SMSC list could not be read.');
  }
}

async function runTest() {
  if (!testSmscId.value) return;
  testBusy.value = true;
  testState.value = 'loading';
  try {
    testResult.value = await apiRequest<ConnectivityTestResult>(
      `/smscs/${testSmscId.value}/actions/test`,
      { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' },
    );
    testError.value = '';
    testState.value = 'live';
  } catch (cause) {
    testResult.value = null;
    testError.value = messageFrom(cause, 'The connectivity test could not be run.');
    testState.value = stateFor(cause);
  } finally {
    testBusy.value = false;
  }
}

// --- 4. Tagged test sends ------------------------------------------------------
const sends = ref<TestSend[]>([]);
const sendState = ref<State>('loading');
const sendError = ref('');
const sendLimit = ref(25);

async function loadSends() {
  if (!canReadSends.value) {
    sendState.value = 'permission-denied';
    return;
  }
  sendState.value = 'loading';
  try {
    const page = await apiRequest<{ items?: TestSend[] }>(
      `/diagnostics/test-sends?limit=${sendLimit.value}`,
    );
    sends.value = Array.isArray(page?.items) ? page.items : [];
    sendError.value = '';
    sendState.value = sends.value.length ? 'live' : 'empty';
  } catch (cause) {
    sends.value = [];
    sendError.value = messageFrom(cause, 'Tagged test sends could not be read.');
    sendState.value = stateFor(cause);
  }
}

/* --- 5. TEST SMS -------------------------------------------------------------
 *
 * Goes through the ordinary send path — `POST /messages`, the same route Bulk
 * Send and the API use — rather than a dedicated test endpoint. A test that
 * takes a different path proves nothing about the path production uses, which
 * is the whole reason for running one.
 *
 * The reference the send returns is then tagged through
 * `POST /diagnostics/test-sends`, so the message can be told apart in traces,
 * events and the message log. Tagging is a SECOND call and is allowed to fail
 * on its own: the message has already gone, and reporting the send as failed
 * because the tag did not stick would have an operator send it again.
 */
const sendTo = ref('');
const sendFrom = ref('JKANNEL');
const sendBody = ref('JKANNEL operational test — please ignore.');
const sendSmscId = ref('');
const sendBusy = ref(false);
const testSendError = ref('');
const confirmingSend = ref(false);
const sentReference = ref('');

/** Matches EventTimeline's item shape, so the states stay a closed set. */
type TraceStep = {
  at: string;
  label: string;
  detail?: string;
  state: 'ok' | 'warn' | 'error' | 'missing' | 'info';
};

const sentTrace = ref<TraceStep[]>([]);

const sendSegments = computed(() => describeComposerText(sendBody.value));

const canSubmitTest = computed(() =>
  Boolean(sendTo.value.trim() && sendFrom.value.trim() && sendBody.value.trim()),
);

/**
 * What the operator is about to do, from measured facts only.
 *
 * Every consequence here is read from something real: the segment count from
 * the same analyser the encoding tab runs, the connection from the register.
 * Nothing is a composed warning — ConfirmAction's contract is that a supplied
 * impact states what the system measured.
 */
const sendImpact = computed<ActionImpact>(() => {
  const pinned = smscs.value.find((option) => option.id === sendSmscId.value);
  const segments = sendSegments.value;
  return {
    operation: 'test-send',
    subject: sendTo.value.trim() || 'no destination',
    summary: `Transmits one real message of ${segments.segments} segment(s) to ${
      sendTo.value.trim() || 'no destination'
    }.`,
    consequences: [
      `The message is billable: ${segments.segments} segment(s) at ${segments.alphabet}.`,
      pinned
        ? `It is pinned to ${pinned.label} and will not be re-routed.`
        : 'No connection is pinned, so the router chooses as it would in production.',
      'It is tagged as operational test traffic and appears in the audit trail.',
      'It reaches a real handset. Confirm the destination is one you control.',
    ],
    // No queue depth: this is a submission, not an operation on a connection
    // that has messages waiting behind it. Null rather than 0 — there is no
    // queue to report, as opposed to a queue that is empty.
    queuedMessages: null,
    reasonRequired: false,
    blockedReason: null,
  };
});

async function runTestSend(reason: string) {
  sendBusy.value = true;
  testSendError.value = '';
  confirmingSend.value = false;
  const at = () => new Date().toLocaleTimeString([], { hour12: false });
  try {
    const result = await apiRequest<Record<string, unknown>>('/messages', {
      method: 'POST',
      body: JSON.stringify({
        sender: sendFrom.value.trim(),
        receiver: sendTo.value.trim(),
        text: sendBody.value,
        ...(sendSmscId.value ? { smscId: sendSmscId.value } : {}),
      }),
    });
    const reference = String(
      result?.externalRef ?? result?.foreignId ?? result?.id ?? result?.messageId ?? '',
    );
    sentReference.value = reference;

    const stages: TraceStep[] = [
      {
        at: at(),
        label: 'accepted',
        detail: `JKANNEL accepted the submission${reference ? ` as ${reference}` : ''}.`,
        state: 'ok',
      },
    ];

    if (reference) {
      try {
        await apiRequest('/diagnostics/test-sends', {
          method: 'POST',
          body: JSON.stringify({
            foreignId: reference,
            smscId: sendSmscId.value || null,
            destination: sendTo.value.trim(),
            reason: reason || 'Operational test from Test Tools',
          }),
        });
        stages.push({
          at: at(),
          label: 'tagged as test traffic',
          detail: 'Recorded so this message can be told apart from production.',
          state: 'ok',
        });
      } catch {
        // The message is already sent. Saying so is more useful than an error
        // that would read as "the send failed" and provoke a second send.
        stages.push({
          at: at(),
          label: 'tagging failed',
          detail:
            'The message WAS sent. Only the test-traffic tag could not be recorded, so it will look like production traffic in traces.',
          state: 'warn',
        });
      }
    }

    // Drawn hollow rather than omitted: a receipt that has not arrived and a
    // step that was never rendered look identical once the step is gone.
    stages.push({
      at: 'not yet',
      label: 'delivery receipt',
      detail:
        'No receipt has arrived yet. Some carriers never send one; the full trace has the engine rows.',
      state: 'missing',
    });

    sentTrace.value = stages;
    void loadSends();
  } catch (cause) {
    sentTrace.value = [];
    testSendError.value = messageFrom(cause, 'The test message could not be sent.');
  } finally {
    sendBusy.value = false;
  }
}

/* --- 6. DLR LOOKUP -----------------------------------------------------------
 *
 * The lifecycle endpoint Message Trace uses, asked the narrower question: what
 * receipts exist for this message. Same endpoint on purpose — a second way of
 * reading a receipt is a second thing that can disagree about one.
 */
const dlrQuery = ref('');
const dlrTrace = ref<MessageTrace | null>(null);
const dlrState = ref<State>('empty');
const dlrError = ref('');

const dlrStages = computed<TraceStep[]>(() =>
  (dlrTrace.value?.lifecycle?.stages ?? []).map((stage) => ({
    at: formatStageMoment(stage.at, stage.status),
    label: stage.label,
    detail: stage.detail,
    // `pending` becomes `missing`, which is the hollow dashed dot: a receipt
    // that has not arrived is a step that is expected and absent, not a step
    // that went wrong.
    state:
      stage.status === 'ok'
        ? 'ok'
        : stage.status === 'failed'
          ? 'error'
          : stage.status === 'warning'
            ? 'warn'
            : 'missing',
  })),
);

async function lookupDlr() {
  const value = dlrQuery.value.trim();
  if (!value) {
    dlrError.value = 'Enter a message id or carrier reference.';
    dlrState.value = 'error';
    return;
  }
  dlrState.value = 'loading';
  dlrError.value = '';
  try {
    const result = await apiRequest<MessageTrace>(
      `/diagnostics/messages/${encodeURIComponent(value)}/lifecycle`,
    );
    const found = Boolean(result?.lifecycle?.stages?.length || result?.events?.length);
    dlrTrace.value = found ? result : null;
    dlrState.value = found ? 'live' : 'empty';
  } catch (cause) {
    dlrTrace.value = null;
    dlrError.value = messageFrom(cause, 'The receipt lifecycle could not be read.');
    dlrState.value = stateFor(cause);
  }
}

onMounted(() => {
  void loadSmscs();
  void loadSends();
});
</script>

<template>
  <div data-testid="test-tools-view">
    <section
      class="panel scope-note"
      data-testid="tools-scope"
      aria-labelledby="tools-scope-heading"
    >
      <h2 id="tools-scope-heading">What on this screen touches a carrier</h2>
      <p>
        The number lookup, the DLR lookup and the encoding analyser are
        <strong>non-transmitting</strong>: they read what is already recorded and count characters.
        The connectivity test <strong>opens a connection to the carrier</strong> and may attempt an
        SMPP bind — it still sends no message. <strong>Test SMS transmits a real message</strong>,
        which costs money and reaches a real handset; it is tagged as operational test traffic so it
        can be told apart in traces and events.
      </p>
    </section>

    <TabStrip
      v-model="tab"
      :tabs="TOOL_TABS"
      label="Diagnostic tools"
      testid="tools-tab"
      class="tools-tabs"
    />

    <!-- 1. NUMBER AND PREFIX LOOKUP -------------------------------------------- -->
    <section
      v-show="tab === 'number'"
      id="tools-tab-panel-number"
      role="tabpanel"
      aria-labelledby="tools-tab-number"
      class="panel"
      data-testid="tools-number"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-number-heading">Number and prefix lookup</h2>
          <p>Normalise a destination and see which configured prefixes would match it.</p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Number</span>
          <input
            v-model="lookupInput"
            data-testid="lookup-input"
            type="text"
            placeholder="0772000118 or +256772000118"
            :disabled="!canLookup"
            @keyup.enter="runLookup"
          />
        </label>
      </div>
      <footer class="detail-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="lookup-run"
          :disabled="lookupBusy || !canLookup"
          @click="runLookup"
        >
          {{ lookupBusy ? 'Looking up…' : 'Look up' }}
        </button>
      </footer>

      <DataState
        :state="canLookup ? lookupState : 'permission-denied'"
        subject="number lookups"
        skeleton="text"
        :detail="
          lookupState === 'empty'
            ? 'Enter a number above. Nothing has been looked up yet.'
            : lookupState === 'error'
              ? lookupError
              : undefined
        "
        permission="routes.view"
        testid="lookup-state"
      >
        <template v-if="lookup">
          <dl class="detail-grid">
            <dt>As entered</dt>
            <dd class="mono" data-testid="lookup-input-echo">{{ lookup.input }}</dd>
            <dt>Normalised</dt>
            <dd class="mono" data-testid="lookup-normalized">
              {{ lookup.normalized ?? 'could not be normalised' }}
            </dd>
            <dt>Digits</dt>
            <dd class="mono">{{ lookup.digits }}</dd>
            <dt>Valid</dt>
            <dd>
              <span class="status-badge" :class="lookup.valid ? 'good' : 'warn'">{{
                lookup.valid ? 'normalised to international form' : 'not normalisable'
              }}</span>
            </dd>
            <dt>Problem</dt>
            <dd class="mono" data-testid="lookup-problem">{{ lookup.problem ?? 'none' }}</dd>
            <dt>Matching prefixes</dt>
            <dd class="mono">{{ displayValue(lookup.matchingPrefixes.length, lookupState) }}</dd>
          </dl>

          <div v-if="lookup.matchingPrefixes.length" class="table-wrap">
            <!--
              Columns are prefix, route, priority, state and target. There is no
              Network column, by design: see the limits block below.
            -->
            <table data-testid="lookup-prefixes">
              <thead>
                <tr>
                  <th scope="col">Prefix</th>
                  <th scope="col">Route</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Enabled</th>
                  <th scope="col">Deployment</th>
                  <th scope="col">Target connection</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(match, index) in lookup.matchingPrefixes"
                  :key="match.id"
                  :data-testid="`lookup-prefix-${index}`"
                >
                  <td class="mono">{{ match.match_prefix }}</td>
                  <td>{{ match.name ?? match.id }}</td>
                  <td class="mono">{{ displayValue(match.priority, lookupState) }}</td>
                  <td>
                    <span class="status-badge" :class="match.enabled ? 'good' : 'muted'">{{
                      match.enabled ? 'enabled' : 'disabled'
                    }}</span>
                  </td>
                  <td class="mono">{{ match.deployment_state ?? 'not recorded' }}</td>
                  <td class="mono">{{ match.target_engine_id ?? 'none' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="chart-empty" data-testid="lookup-no-prefixes">
            No configured prefix matches this number. That means routing would fall through to
            whatever non-prefix rule applies, or fail closed — it does not mean the number is
            invalid.
          </p>

          <!--
            THE LIMITS, VERBATIM. The API returns them as data precisely so the
            console cannot quietly omit them, and the first one is the reason
            this table has no Network column.
          -->
          <section class="limits-block" data-testid="lookup-limits">
            <h3>What this lookup cannot tell you</h3>
            <ul class="limits-list" data-testid="lookup-limits-list">
              <li v-for="(limit, index) in lookup.limits" :key="index">{{ limit }}</li>
            </ul>
            <p class="source-note">
              There is no “Network” column above for exactly that reason. An empty one would read as
              “no network found”, and a filled one would be a guess.
            </p>
          </section>
        </template>
      </DataState>
    </section>

    <!-- 2. ENCODING AND SEGMENT ANALYZER --------------------------------------- -->
    <section
      v-show="tab === 'encoding'"
      id="tools-tab-panel-encoding"
      role="tabpanel"
      aria-labelledby="tools-tab-encoding"
      class="panel"
      data-testid="tools-encoding"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-encoding-heading">Encoding and segment analyser</h2>
          <p>What a body costs on the wire, recomputed as you type. Nothing is sent.</p>
        </div>
      </header>

      <label class="analyzer-field">
        <span>Message body</span>
        <textarea
          v-model="body"
          rows="4"
          data-testid="encoding-input"
          placeholder="Paste the exact text you intend to send, including any punctuation copied from a document."
        ></textarea>
      </label>

      <SegmentCounter :text="body" testid="encoding" />

      <dl class="detail-grid">
        <dt>Alphabet</dt>
        <dd class="mono">{{ analysis.alphabetLabel }}</dd>
        <dt>Characters</dt>
        <dd class="mono">{{ displayValue(analysis.characters, 'live') }}</dd>
        <dt>Units counted</dt>
        <dd class="mono">{{ displayValue(analysis.length, 'live') }}</dd>
        <dt>Single-segment limit</dt>
        <dd class="mono">{{ displayValue(analysis.singleCapacity, 'live') }}</dd>
        <dt>Per segment once split</dt>
        <dd class="mono">{{ displayValue(analysis.multipartCapacity, 'live') }}</dd>
        <dt>Segments</dt>
        <dd class="mono">{{ displayValue(analysis.segments, 'live') }}</dd>
      </dl>

      <!--
        The browser figure keeps up with typing; the server's is authoritative.
        They should agree, and the interesting case is when they do not — a
        character the console classifies differently from the engine is exactly
        what turns a one-segment message into two on the wire and surprises
        somebody's bill.
      -->
      <footer class="detail-actions">
        <button
          class="secondary-button"
          type="button"
          data-testid="encoding-server-check"
          :disabled="serverPreviewBusy"
          @click="checkOnServer"
        >
          {{ serverPreviewBusy ? 'Checking…' : 'Check against the server' }}
        </button>
      </footer>

      <p
        v-if="serverPreview"
        class="notice"
        role="status"
        :class="serverPreviewAgrees === false ? 'disagrees' : ''"
        data-testid="encoding-server-result"
      >
        <strong>{{
          serverPreviewAgrees === false
            ? 'The server disagrees with the browser.'
            : 'The server agrees.'
        }}</strong>
        Server: {{ serverPreview.segments }} segment(s),
        {{ serverPreview.alphabet ?? serverPreview.encoding ?? 'encoding not reported' }}.
        <template v-if="serverPreviewAgrees === false">
          The server is authoritative — it runs the same rules the send path runs. Treat its answer
          as what the message will cost.
        </template>
      </p>
      <p
        v-if="serverPreviewError"
        class="form-error"
        role="alert"
        data-testid="encoding-server-error"
      >
        {{ serverPreviewError }}
      </p>

      <p class="source-note">
        Computed in the browser by the console's port of the engine's own segment module, so it
        keeps up with typing. <span class="mono">POST /messages/preview</span> runs the same rules
        server-side and is the authoritative answer for what a body will actually cost.
      </p>
    </section>

    <!-- 3. CONNECTIVITY TEST ---------------------------------------------------- -->
    <section
      v-show="tab === 'connectivity'"
      id="tools-tab-panel-connectivity"
      role="tabpanel"
      aria-labelledby="tools-tab-connectivity"
      class="panel"
      data-testid="tools-connectivity"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-connectivity-heading">SMPP connectivity test</h2>
          <p>
            Opens a connection to the carrier and, where this container can resolve the credentials,
            attempts a real bind. No message is submitted.
          </p>
        </div>
      </header>

      <p v-if="!canTest" class="warn-notice" role="note" data-testid="connectivity-readonly">
        Running a connectivity test requires the <span class="mono">smsc.manage</span> permission,
        because it opens a connection to the carrier and is recorded as an operation against the
        SMSC.
      </p>
      <p v-if="smscError" class="form-error" role="alert" data-testid="connectivity-smsc-error">
        {{ smscError }}
      </p>

      <div class="grid-toolbar">
        <label class="filter-select">
          <span>Connection</span>
          <select v-model="testSmscId" data-testid="connectivity-smsc" :disabled="!canTest">
            <option v-for="option in smscs" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>
      <footer class="detail-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="connectivity-run"
          :disabled="!canTest || testBusy || !testSmscId"
          @click="runTest"
        >
          {{ testBusy ? 'Testing…' : 'Run connectivity test' }}
        </button>
      </footer>

      <DataState
        :state="testState"
        subject="connectivity results"
        skeleton="text"
        :detail="
          testState === 'empty'
            ? 'No test has been run in this session. That is not a statement about whether this connection works.'
            : testState === 'error'
              ? testError
              : undefined
        "
        permission="smsc.manage"
        testid="connectivity-state"
      >
        <template v-if="testResult">
          <div v-if="verification" class="verification-head">
            <span
              class="status-badge"
              :class="verificationTone(verification.verified, verification.passed)"
              data-testid="connectivity-level"
              >{{ verification.passed ? 'passed' : 'failed' }}: {{ verification.verified }}</span
            >
            <span class="mono row-id">{{ testedSmsc?.label }}</span>
          </div>
          <p v-if="verification" class="source-note" data-testid="connectivity-word">
            {{ verificationWord(verification.verified) }}.
          </p>
          <!-- The backend writes a sentence that names its own level. Verbatim. -->
          <p v-if="verification" class="confirm-detail" data-testid="connectivity-detail">
            {{ verification.detail }}
          </p>
          <dl v-if="verification" class="detail-grid">
            <dt>Socket opened</dt>
            <dd class="mono">{{ verification.reachable ? 'yes' : 'no' }}</dd>
            <dt>Bind attempted</dt>
            <dd class="mono">
              {{
                verification.bound === null
                  ? 'no bind was attempted'
                  : verification.bound
                    ? 'accepted'
                    : 'refused'
              }}
            </dd>
            <dt>Latency</dt>
            <dd class="mono" data-testid="connectivity-latency">
              {{ displayValue(verification.latencyMs, 'live', (value) => `${value} ms`) }}
            </dd>
            <dt>Carrier command status</dt>
            <dd class="mono">
              {{ displayValue(verification.commandStatus, 'live') }}
            </dd>
          </dl>
          <p
            v-if="verification?.bindSkippedReason"
            class="warn-notice"
            role="note"
            data-testid="connectivity-skipped"
          >
            The stronger SMPP bind check was not run: {{ verification.bindSkippedReason }}. A passed
            TCP check proves a listener exists and nothing about the credentials.
          </p>
          <p
            v-if="!verification"
            class="warn-notice"
            role="note"
            data-testid="connectivity-replayed"
          >
            The API returned the record for an earlier attempt (<span class="mono">{{
              testResult.status ?? 'no status'
            }}</span
            >) rather than a fresh verification, so no verification level is shown for this click.
            {{ testResult.detail ?? '' }}
          </p>
        </template>
      </DataState>
    </section>

    <!-- 4. TEST SMS -------------------------------------------------------------
      The only control on this screen that transmits. It goes through the normal
      send path (POST /messages) rather than a special test route, because a
      test that takes a different path proves nothing about the path production
      uses — then tags the resulting reference so the message can be told apart
      downstream.
    -->
    <section
      v-show="tab === 'test-sms'"
      id="tools-tab-panel-test-sms"
      role="tabpanel"
      aria-labelledby="tools-tab-test-sms"
      class="panel"
      data-testid="tools-test-sms"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-test-sms-heading">Test SMS</h2>
          <p>
            Transmits a real message on the connection you pin. It costs money, it reaches a real
            handset, and it is recorded as operational test traffic.
          </p>
        </div>
      </header>

      <p v-if="!canSend" class="warn-notice" role="note" data-testid="test-sms-denied">
        Sending needs the <span class="mono">configuration.manage</span> permission, which your role
        does not hold. The rest of this screen is read-only and remains available.
      </p>

      <template v-else>
        <div class="field-grid">
          <label class="filter-select">
            <span>Destination</span>
            <input
              v-model="sendTo"
              type="text"
              data-testid="test-sms-to"
              placeholder="+256772000118"
            />
          </label>
          <label class="filter-select">
            <span>Sender</span>
            <input
              v-model="sendFrom"
              type="text"
              data-testid="test-sms-from"
              placeholder="JKANNEL"
            />
          </label>
          <label class="filter-select">
            <span>Pin to connection</span>
            <select v-model="sendSmscId" data-testid="test-sms-smsc">
              <option value="">let the router choose</option>
              <option v-for="option in smscs" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="analyzer-field">
          <span>Message body</span>
          <textarea
            v-model="sendBody"
            rows="3"
            data-testid="test-sms-body"
            placeholder="JKANNEL operational test — please ignore."
          ></textarea>
        </label>

        <!--
          The same segment computation the analyser tab runs, shown here because
          what a test costs is part of deciding to send it — and because a test
          that silently becomes three segments teaches the wrong thing about the
          body an operator was checking.
        -->
        <p class="source-note" data-testid="test-sms-cost">
          {{ sendSegments.segments }} segment(s), {{ sendSegments.alphabet }},
          {{ sendSegments.length }} characters.
        </p>

        <footer class="detail-actions">
          <button
            class="primary-button"
            type="button"
            data-testid="test-sms-submit"
            :disabled="!canSubmitTest || sendBusy"
            @click="confirmingSend = true"
          >
            {{ sendBusy ? 'Sending…' : 'Send operational test SMS' }}
          </button>
        </footer>
        <p v-if="!canSubmitTest" class="source-note" data-testid="test-sms-blocked">
          A destination, a sender and a body are all required before this can be sent.
        </p>

        <p v-if="testSendError" class="form-error" role="alert" data-testid="test-sms-error">
          {{ testSendError }}
        </p>
      </template>

      <!-- What actually happened, as the design's Timeline. -->
      <template v-if="sentTrace.length">
        <h3 class="trace-heading">Trace — {{ sentReference }}</h3>
        <EventTimeline dense :items="sentTrace" data-testid="test-sms-trace" />
        <p class="source-note">
          These are the stages JKANNEL recorded, not a carrier's account of the message. The receipt
          step stays hollow until a DLR arrives, and some carriers never send one —
          <RouterLink
            class="text-link"
            :to="`/message-trace?id=${encodeURIComponent(sentReference)}`"
            >open the full trace</RouterLink
          >
          for the engine's own rows.
        </p>
      </template>
    </section>

    <!-- 5. DLR LOOKUP ------------------------------------------------------------ -->
    <section
      v-show="tab === 'dlr'"
      id="tools-tab-panel-dlr"
      role="tabpanel"
      aria-labelledby="tools-tab-dlr"
      class="panel"
      data-testid="tools-dlr"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-dlr-heading">DLR lookup</h2>
          <p>
            Find a receipt by the id JKANNEL issued or the reference the carrier returned. Reads the
            engine store; sends nothing.
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Message or carrier reference</span>
          <input
            v-model="dlrQuery"
            type="search"
            data-testid="dlr-lookup-input"
            placeholder="91021 or 448210-mtn"
            @keyup.enter="lookupDlr"
          />
        </label>
        <button
          class="primary-button"
          type="button"
          data-testid="dlr-lookup-submit"
          :disabled="dlrState === 'loading'"
          @click="lookupDlr"
        >
          {{ dlrState === 'loading' ? 'Reading…' : 'Look up' }}
        </button>
      </div>

      <p v-if="dlrError" class="form-error" role="alert" data-testid="dlr-lookup-error">
        {{ dlrError }}
      </p>

      <template v-if="dlrTrace">
        <h3 class="trace-heading">Receipt lifecycle</h3>
        <p class="source-note">
          Every state recorded for this message, in order. A step that has not happened is drawn
          hollow rather than omitted — a missing receipt and an absent row look identical once the
          row is gone.
        </p>
        <EventTimeline :items="dlrStages" data-testid="dlr-lifecycle" />
        <p v-if="dlrTrace.available === false" class="warn-notice" role="note">
          The engine message store could not be read, so only JKANNEL's own record is above.
        </p>
      </template>
      <p v-else-if="dlrState === 'empty'" class="chart-empty" data-testid="dlr-lookup-empty">
        Nothing is recorded under that identifier. Retention prunes older messages, so this is not
        proof the message never existed.
      </p>
    </section>

    <!-- 6. TAGGED TEST SENDS ---------------------------------------------------- -->
    <section
      v-show="tab === 'test-sms'"
      class="panel"
      data-testid="tools-test-sends"
      aria-labelledby="tools-sends-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="tools-sends-heading">Tagged test sends</h2>
          <p>
            Messages that were marked as operator test traffic, so they can be told apart from
            production in traces and events.
          </p>
        </div>
        <button
          class="secondary-button"
          type="button"
          data-testid="sends-refresh"
          :disabled="!canReadSends"
          @click="loadSends"
        >
          Refresh
        </button>
      </header>

      <DataState
        :state="sendState"
        subject="tagged test sends"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          sendState === 'empty'
            ? 'Nothing has been tagged as test traffic. The Test SMS control above tags every message it sends, so an empty list means no test has been sent from here — and an API caller that submits without tagging will not appear either.'
            : sendState === 'error'
              ? sendError
              : undefined
        "
        permission="messages.view"
        testid="sends-state"
        :on-retry="loadSends"
      >
        <div class="table-wrap">
          <table data-testid="sends-table">
            <thead>
              <tr>
                <th scope="col">Tagged</th>
                <th scope="col">Message reference</th>
                <th scope="col">Destination</th>
                <th scope="col">Connection</th>
                <th scope="col">Reason</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="send in sends" :key="send.id" :data-testid="`send-${send.id}`">
                <td class="mono">{{ formatMoment(send.created_at) }}</td>
                <td class="mono">{{ send.foreign_id }}</td>
                <td class="mono">{{ send.destination ?? 'not recorded' }}</td>
                <td class="mono">{{ send.engine_id ?? 'not recorded' }}</td>
                <td>{{ send.reason ?? 'none recorded' }}</td>
                <td class="mono">{{ send.sent_by ?? 'not recorded' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>
    </section>

    <!--
      The only confirmation on this screen, because Test SMS is the only control
      that costs anything. Its impact is supplied rather than fetched: there is
      no impact endpoint for a send, and every consequence listed is read from a
      real computation — the segment analysis and the pinned connection.
    -->
    <ConfirmAction
      v-if="confirmingSend"
      :open="true"
      operation="test-send"
      :impact="sendImpact"
      title="Send operational test SMS"
      verb="Send it"
      :busy="sendBusy"
      danger
      testid="test-sms-confirm"
      @close="confirmingSend = false"
      @confirm="runTestSend"
    />
  </div>
</template>

<style scoped>
.scope-note {
  border-left: 3px solid var(--brand);
}
/* Not a panel, so it needs the gap explicitly; the token keeps it in step. */
.tools-tabs {
  margin-bottom: var(--gap-panel);
}
.trace-heading {
  margin: 20px 0 8px;
  font-size: 14px;
}
.notice.disagrees {
  border-left: 3px solid var(--warn);
  color: var(--warn);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.scope-note h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.scope-note p {
  margin: 0;
}
.analyzer-field {
  display: grid;
  gap: 6px;
  margin: 14px 0;
}
.analyzer-field textarea {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 8px;
  padding: 10px;
  font: inherit;
}
.limits-block {
  margin-top: 16px;
  padding: 12px 14px;
  border-left: 3px solid var(--warn);
  background: var(--surface-2);
  border-radius: 0 8px 8px 0;
}
.limits-block h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.limits-list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
  font-size: 13px;
  line-height: 1.6;
}
.verification-head {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 14px;
}
.confirm-detail {
  margin: 8px 0 0;
  line-height: 1.6;
  color: var(--text-strong);
}
</style>
<style src="./workspace-extras.css"></style>
