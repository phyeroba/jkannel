<script setup lang="ts">
/**
 * ROUTE SIMULATOR (PLAN.md 5.4, spec §13, UC-RTE-01).
 *
 * THIS SCREEN TRANSMITS NOTHING, AND SAYS SO BEFORE THE FORM.
 *
 * That is UC-RTE-01's explicit UI requirement and it is not decoration: the
 * screen takes a real MSISDN, runs it through the live routing rules and names
 * a real carrier connection. Everything about the result looks like a send. An
 * operator who has just been paged has to be able to tell, without reading the
 * result, that pressing the button cannot put a message on a carrier's network.
 *
 * The answer comes from `POST /routing/resolve` — the same `selectRoute()` the
 * send path calls, not a second implementation. That matters more than it
 * sounds: the console's older `/routes/simulate` adapter used to compare raw
 * prefix strings and could disagree with production about where a message would
 * go. Both now delegate to one selector, and this screen calls the one that
 * returns the full decision trace.
 *
 * The availability control is the reason to come here rather than read the route
 * table: `availableSmscIds` is a real parameter of the resolve endpoint, so
 * "where would this go if MTN-P1 were down?" is answered by the selector itself
 * rather than by an operator reasoning about fallbacks in their head.
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import { smscOptionsFrom, type ResolveResult, type SmscOption } from '../utils/safe-control';

const msisdn = ref('');
const sender = ref('');
const operator = ref('');
const rotation = ref(0);
/**
 * Empty means "do not constrain" — the endpoint treats a null `availableSmscIds`
 * as unconstrained, and sending `[]` would mean "nothing is available", which is
 * a different question and would resolve to nothing every time.
 */
const assumedAvailable = ref<string[]>([]);
const constrain = ref(false);

const smscs = ref<SmscOption[]>([]);
const smscError = ref('');

const result = ref<ResolveResult | null>(null);
const state = ref<State>('empty');
const error = ref('');
const busy = ref(false);
const resolvedAt = ref('');

const chosen = computed(() => {
  const id = result.value?.smscId;
  if (!id) return null;
  return smscs.value.find((option) => option.id === id) ?? null;
});

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

async function loadSmscs() {
  try {
    const page = await apiRequest<{ items?: unknown[] }>('/smscs?limit=500&offset=0');
    smscs.value = smscOptionsFrom(Array.isArray(page?.items) ? (page.items as never[]) : []);
    smscError.value = '';
  } catch (cause) {
    smscs.value = [];
    smscError.value = messageFrom(
      cause,
      'The SMSC list could not be read, so the chosen connection is shown by id rather than by name.',
    );
  }
}

async function resolve() {
  const destination = msisdn.value.trim();
  if (!destination) {
    error.value = 'Enter a destination number to simulate.';
    state.value = 'error';
    return;
  }
  busy.value = true;
  state.value = 'loading';
  try {
    const body: Record<string, unknown> = {
      msisdn: destination,
      rotation: Number(rotation.value) || 0,
    };
    if (sender.value.trim()) body.sender = sender.value.trim();
    if (operator.value.trim()) body.operator = operator.value.trim();
    if (constrain.value) body.availableSmscIds = [...assumedAvailable.value];
    result.value = await apiRequest<ResolveResult>('/routing/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    resolvedAt.value = new Date().toLocaleString();
    error.value = '';
    state.value = 'live';
  } catch (cause) {
    result.value = null;
    error.value = messageFrom(cause, 'The route could not be resolved.');
    state.value = cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
  } finally {
    busy.value = false;
  }
}

onMounted(loadSmscs);
</script>

<template>
  <div data-testid="route-simulator-view">
    <!--
      THE NON-TRANSMITTING STATEMENT.
      First element on the page, above the form, and not a footnote under the
      result where it would be read after the fact.
    -->
    <section
      class="panel non-transmitting"
      role="note"
      data-testid="simulator-non-transmitting"
      aria-labelledby="simulator-scope-heading"
    >
      <h2 id="simulator-scope-heading">This simulator does not send anything</h2>
      <p>
        Nothing on this screen transmits. No message is submitted, no bind is used, no counter
        moves, and nothing appears in Messages, Delivery Reports or a carrier's logs. It answers one
        question — <strong>“where would this destination go right now?”</strong> — by running the
        live routing rules through the same selector the send path uses.
      </p>
      <p>
        To send a real message, use
        <router-link class="text-link" to="/test-tools">Test Tools</router-link> or
        <router-link class="text-link" to="/bulk-send">Bulk Send</router-link>. Those transmit; this
        does not.
      </p>
    </section>

    <section class="panel" data-testid="simulator-form" aria-labelledby="simulator-form-heading">
      <header class="panel-header">
        <div>
          <h2 id="simulator-form-heading">Resolve a destination</h2>
          <p>
            Evaluated by <span class="mono">POST /routing/resolve</span> against the rules deployed
            now — not against a snapshot, and not against the simulator's own copy of them.
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Destination MSISDN</span>
          <input
            v-model="msisdn"
            data-testid="simulator-msisdn"
            type="text"
            placeholder="+256772000118 or 0772000118"
            @keyup.enter="resolve"
          />
        </label>
        <label class="filter-select">
          <span>Sender (optional)</span>
          <input
            v-model="sender"
            data-testid="simulator-sender"
            type="text"
            placeholder="JKANNEL"
          />
        </label>
        <label class="filter-select">
          <span>Operator (optional)</span>
          <input
            v-model="operator"
            data-testid="simulator-operator"
            type="text"
            placeholder="Matched by operator routes only"
          />
        </label>
        <label class="filter-select">
          <span>Rotation</span>
          <input
            v-model.number="rotation"
            data-testid="simulator-rotation"
            type="number"
            min="0"
            step="1"
          />
        </label>
      </div>

      <fieldset class="availability">
        <legend>Assume these connections are available</legend>
        <label class="availability-toggle">
          <input v-model="constrain" type="checkbox" data-testid="simulator-constrain" />
          <span>
            Constrain availability. Left off, the selector uses its own view of which connections
            are usable — which is what production does. Turned on, it considers only what you tick,
            so you can ask what happens when a bind goes down.
          </span>
        </label>
        <div v-if="constrain" class="availability-options" data-testid="simulator-availability">
          <label v-for="option in smscs" :key="option.id" class="availability-option">
            <input
              v-model="assumedAvailable"
              type="checkbox"
              :value="option.id"
              :data-testid="`simulator-available-${option.engineId}`"
            />
            <span>{{ option.label }}</span>
          </label>
          <p v-if="!smscs.length" class="row-id">
            No SMSC connection could be listed, so there is nothing to constrain.
          </p>
        </div>
        <p v-if="constrain && !assumedAvailable.length" class="warn-notice" role="note">
          Nothing is ticked, so this asks the selector what happens when
          <strong>no connection at all</strong> is available. Expect an unroutable answer.
        </p>
      </fieldset>

      <footer class="detail-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="simulator-run"
          :disabled="busy"
          @click="resolve"
        >
          {{ busy ? 'Resolving…' : 'Resolve route (sends nothing)' }}
        </button>
      </footer>

      <p v-if="smscError" class="warn-notice" role="note" data-testid="simulator-smsc-error">
        {{ smscError }}
      </p>
    </section>

    <section
      class="panel"
      data-testid="simulator-result"
      aria-labelledby="simulator-result-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="simulator-result-heading">Decision</h2>
          <p>Which connection this destination would take, and every step that led there.</p>
        </div>
        <span
          v-if="state === 'live' && result"
          class="status-badge"
          :class="result.smscId ? 'good' : 'bad'"
          data-testid="simulator-outcome"
          >{{ result.smscId ? 'routable' : 'no route' }}</span
        >
      </header>

      <DataState
        :state="state"
        subject="routing decisions"
        skeleton="text"
        :detail="
          state === 'empty'
            ? 'Enter a destination above and resolve it. Nothing has been evaluated yet, so no route is shown — that is not the same as “no route matches”.'
            : state === 'error'
              ? error
              : undefined
        "
        permission="routes.view"
        testid="simulator-state"
      >
        <template v-if="result">
          <dl class="detail-grid">
            <dt>Destination</dt>
            <dd class="mono" data-testid="simulator-destination">{{ result.msisdn ?? msisdn }}</dd>
            <dt>Selected connection</dt>
            <dd class="mono" data-testid="simulator-smsc">
              {{
                chosen ? chosen.label : (result.smscId ?? 'none — this destination is unroutable')
              }}
            </dd>
            <dt>Route</dt>
            <dd class="mono" data-testid="simulator-route">
              {{ result.routeName ?? 'no route matched' }}
            </dd>
            <dt>Strategy</dt>
            <dd class="mono">{{ result.strategy ?? 'not applicable' }}</dd>
            <dt>Fallback used</dt>
            <dd class="mono" data-testid="simulator-fallback">
              {{ result.fallbackUsed ? 'yes — the primary target was not available' : 'no' }}
            </dd>
            <dt>Candidates considered</dt>
            <dd class="mono">{{ displayValue(result.candidatesConsidered, state) }}</dd>
            <dt>Resolved at</dt>
            <dd class="mono">{{ resolvedAt }}</dd>
          </dl>

          <p class="source-note" data-testid="simulator-reason">{{ result.reason }}</p>

          <h3 class="trace-heading">How the selector got there</h3>
          <ol class="sample-list" data-testid="simulator-trace">
            <li v-for="(step, index) in result.trace ?? []" :key="index">{{ step }}</li>
          </ol>
          <p v-if="!(result.trace ?? []).length" class="chart-empty">
            The selector returned no trace for this decision.
          </p>

          <p
            v-if="!result.smscId"
            class="warn-notice"
            role="note"
            data-testid="simulator-unroutable"
          >
            This destination resolves to no connection, so a real submission would be refused rather
            than sent somewhere arbitrary. The trace above says at which step it fell out.
          </p>

          <p class="source-note" data-testid="simulator-still-nothing-sent">
            Still nothing has been transmitted. This is the decision the selector would make; it is
            not a message, and no bind was touched to produce it.
          </p>
        </template>
      </DataState>
    </section>
  </div>
</template>

<style scoped>
.non-transmitting {
  border-left: 3px solid var(--brand);
}
.non-transmitting h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.non-transmitting p {
  margin: 0 0 8px;
}
.non-transmitting p:last-child {
  margin-bottom: 0;
}
.availability {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin: 14px 0 0;
}
.availability legend {
  padding: 0 6px;
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.availability-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}
.availability-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px;
  margin-top: 12px;
}
.availability-option {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.trace-heading {
  margin: 16px 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
</style>
<style src="./workspace-extras.css"></style>
