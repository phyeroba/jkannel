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
import { canAccess, session } from '../stores/session';
import { displayValue, type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';
import { describeComposerText } from '../utils/message-segments';
import {
  smscOptionsFrom,
  verificationTone,
  verificationWord,
  type ConnectivityTestResult,
  type NumberLookup,
  type SmscOption,
  type TestSend,
} from '../utils/safe-control';

const canLookup = computed(() => canAccess(session.value, 'routes.view'));
const canReadSends = computed(() => canAccess(session.value, 'messages.view'));
const canTest = computed(() => canAccess(session.value, 'smsc.manage'));

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
        The number lookup and the encoding analyzer are <strong>non-transmitting</strong>: they read
        configuration and count characters. The connectivity test
        <strong>opens a connection to the carrier</strong> and may attempt an SMPP bind — it still
        sends no message. Nothing here submits an SMS; to do that, use
        <router-link class="text-link" to="/bulk-send">Bulk Send</router-link>.
      </p>
    </section>

    <!-- 1. NUMBER AND PREFIX LOOKUP -------------------------------------------- -->
    <section class="panel" data-testid="tools-number" aria-labelledby="tools-number-heading">
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
    <section class="panel" data-testid="tools-encoding" aria-labelledby="tools-encoding-heading">
      <header class="panel-header">
        <div>
          <h2 id="tools-encoding-heading">Encoding and segment analyzer</h2>
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

      <p class="source-note">
        Computed in the browser by the console's port of the engine's own segment module, so it
        keeps up with typing. The authoritative answer for a stored message comes from
        <span class="mono">POST /messages/preview</span>, which runs the same rules server-side.
      </p>
    </section>

    <!-- 3. CONNECTIVITY TEST ---------------------------------------------------- -->
    <section
      class="panel"
      data-testid="tools-connectivity"
      aria-labelledby="tools-connectivity-heading"
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

    <!-- 4. TAGGED TEST SENDS ---------------------------------------------------- -->
    <section class="panel" data-testid="tools-test-sends" aria-labelledby="tools-sends-heading">
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
            ? 'Nothing has been tagged as test traffic. This build has no console control that tags a send — the tag is applied by the API, so an empty list means no caller has used it, not that no test has ever been run.'
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
  </div>
</template>

<style scoped>
.scope-note {
  border-left: 3px solid var(--brand);
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
