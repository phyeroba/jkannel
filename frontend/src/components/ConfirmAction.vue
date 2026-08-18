<script setup lang="ts">
/**
 * IMPACT BEFORE THE VERB (PLAN.md 5.1, spec §1.1, §16, UC-SMSC-01).
 *
 * UC-SMSC-01's UI requirement is blunt: *"Confirmation dialog must show impact,
 * not just 'Are you sure?'"*. So this dialog does not ask a question. It fetches
 * `GET /control/smscs/:id/impact/:operation`, states the backend's `summary`,
 * lists every `consequence` VERBATIM, shows the queue depth behind the object,
 * and only then offers the verb.
 *
 * Three rules are enforced here rather than left to each caller:
 *
 * 1. **The consequences are the backend's words.** They were computed from live
 *    state — the actual queue depth, the actual route count, the actual number
 *    of parallel connections — inside the same service the API exposes to a
 *    script. Re-wording them in the console would produce a warning that no
 *    longer matches what the system measured, and would leave a direct API
 *    caller with a different (better) explanation than the operator got.
 * 2. **`blockedReason` disables, it does not warn.** A confirm button that is
 *    live next to "this action cannot proceed" is a button an operator presses.
 *    The control stays visible — an absent control is unexplained — but it is
 *    `disabled` and the reason sits above it.
 * 3. **The reason is validated before the request.** The API demands 3–500
 *    characters and answers 400 otherwise; by then the dialog has closed and the
 *    text is gone. Same rule, applied while the operator can still see the box.
 *
 * A caller may supply `impact` directly instead of `smsc-id` — the failover
 * screen does, because there is no impact endpoint for a route. Anything passed
 * that way must be read from an API response, never composed as a warning.
 */
import { computed, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from './DataState.vue';
import { displayValue, type DataState as State } from '../utils/data-state';
import {
  operationVerb,
  reasonIsRecorded,
  reasonProblem,
  type ActionImpact,
} from '../utils/safe-control';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The operation being confirmed. Drives the default verb and the fetch. */
    operation: string;
    /** SMSC UUID. When set, the impact is fetched from the control API. */
    smscId?: string | null;
    /** An impact read from some other endpoint, for callers with no preview. */
    impact?: ActionImpact | null;
    /** Overrides the generated heading. */
    title?: string;
    /** Overrides the generated button label. */
    verb?: string;
    /** True while the confirmed action is in flight. */
    busy?: boolean;
    /** Renders the confirm control as destructive. */
    danger?: boolean;
    testid?: string;
  }>(),
  {
    smscId: null,
    impact: null,
    title: undefined,
    verb: undefined,
    busy: false,
    danger: false,
    testid: 'confirm-action',
  },
);

const emit = defineEmits<{ (event: 'close'): void; (event: 'confirm', reason: string): void }>();

const fetched = ref<ActionImpact | null>(null);
const state = ref<State>('loading');
const error = ref('');
const reason = ref('');
/** Nothing is scolded before it has been typed in. */
const touched = ref(false);

const impact = computed<ActionImpact | null>(() => props.impact ?? fetched.value);
/**
 * The list, defensively. A deployment running an older or newer control API can
 * answer without `consequences`, and the failure mode of reading `.length` off
 * that is a dialog that renders nothing at all — which would leave the confirm
 * button live beside a blank explanation. Missing means "none stated", and the
 * template says so in words.
 */
const consequences = computed<string[]>(() =>
  Array.isArray(impact.value?.consequences) ? impact.value.consequences : [],
);
const heading = computed(
  () => props.title ?? `${operationVerb(props.operation)} ${impact.value?.subject ?? ''}`.trim(),
);
const confirmLabel = computed(() => props.verb ?? operationVerb(props.operation));
const recorded = computed(() => reasonIsRecorded(props.operation));

const problem = computed(() => reasonProblem(reason.value, Boolean(impact.value?.reasonRequired)));
const blocked = computed(() => Boolean(impact.value?.blockedReason));
/**
 * Everything that has to be true before the verb is live. `impact` being absent
 * counts: a dialog that has not yet been told what the action costs has not met
 * UC-SMSC-01 and must not be actionable.
 */
const canConfirm = computed(
  () => Boolean(impact.value) && !blocked.value && !problem.value && !props.busy,
);

async function loadImpact() {
  if (!props.smscId) {
    // Caller-supplied impact: there is nothing to fetch and nothing to wait for.
    state.value = props.impact ? 'live' : 'error';
    error.value = props.impact ? '' : 'No impact was supplied for this action.';
    return;
  }
  state.value = 'loading';
  try {
    fetched.value = await apiRequest<ActionImpact>(
      `/control/smscs/${props.smscId}/impact/${props.operation}`,
    );
    error.value = '';
    state.value = 'live';
  } catch (cause) {
    fetched.value = null;
    error.value =
      cause instanceof Error
        ? cause.message
        : 'The impact of this action could not be established.';
    state.value = cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
  }
}

watch(
  () => [props.open, props.smscId, props.operation] as const,
  ([open]) => {
    if (!open) return;
    reason.value = '';
    touched.value = false;
    fetched.value = null;
    void loadImpact();
  },
  { immediate: true },
);

function close() {
  if (props.busy) return;
  emit('close');
}

function submit() {
  touched.value = true;
  if (!canConfirm.value) return;
  emit('confirm', reason.value.trim());
}
</script>

<template>
  <div
    v-if="open"
    class="dialog-backdrop"
    :data-testid="`${testid}-backdrop`"
    @click.self="close"
    @keydown.esc="close"
  >
    <section
      class="command-dialog confirm-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`${testid}-heading`"
      :data-testid="testid"
    >
      <header>
        <h2 :id="`${testid}-heading`">{{ heading }}</h2>
        <button class="text-button" type="button" :disabled="busy" @click="close">Close</button>
      </header>

      <DataState
        :state="state"
        subject="the impact of this action"
        skeleton="text"
        :detail="
          state === 'error'
            ? `${error} Nothing has been changed. Until the console can state what this action would do, it will not offer to do it.`
            : undefined
        "
        permission="smsc.view"
        :testid="`${testid}-state`"
        :on-retry="loadImpact"
      >
        <template v-if="impact">
          <!-- The backend's own sentence. Not a question, and not paraphrased. -->
          <p class="confirm-summary" :data-testid="`${testid}-summary`">{{ impact.summary }}</p>

          <p
            v-if="impact.blockedReason"
            class="confirm-blocked"
            role="alert"
            :data-testid="`${testid}-blocked`"
          >
            <strong>This action is blocked and cannot be confirmed.</strong>
            {{ impact.blockedReason }}
          </p>

          <h3 class="confirm-subhead">What this will do</h3>
          <ul
            v-if="consequences.length"
            class="confirm-consequences"
            :data-testid="`${testid}-consequences`"
          >
            <li v-for="(consequence, index) in consequences" :key="index">{{ consequence }}</li>
          </ul>
          <p v-else class="confirm-note" :data-testid="`${testid}-no-consequences`">
            The control API reported no specific consequence for this operation on this connection.
            That is the absence of a computed consequence, not a guarantee that nothing changes.
          </p>

          <dl class="confirm-facts">
            <dt>Queued behind it now</dt>
            <dd class="mono" :data-testid="`${testid}-queued`">
              {{ displayValue(impact.queuedMessages, state) }}
            </dd>
            <dt>Subject</dt>
            <dd class="mono">{{ impact.subject }}</dd>
          </dl>
          <p
            v-if="impact.queuedMessages === null"
            class="confirm-note"
            :data-testid="`${testid}-queue-unknown`"
          >
            The engine reported no queue depth for this connection, so that figure is an em dash. It
            is not zero — nothing was measured.
          </p>

          <label v-if="impact.reasonRequired" class="confirm-reason">
            <span>Reason</span>
            <textarea
              v-model="reason"
              rows="3"
              :maxlength="600"
              :data-testid="`${testid}-reason`"
              placeholder="e.g. Carrier confirmed throttling on this bind; cycling per runbook 4.2"
              @blur="touched = true"
            ></textarea>
          </label>
          <p
            v-if="impact.reasonRequired"
            class="confirm-note"
            :data-testid="`${testid}-reason-note`"
          >
            <template v-if="recorded">
              Recorded in the audit trail and on the operational event this action raises.
            </template>
            <template v-else>
              This build's <span class="mono">/smscs/:id/actions/{{ operation }}</span> endpoint
              accepts no reason, so what you type here is not stored. The control API still requires
              one before the action is offered; treat it as a check on yourself, not as a record.
            </template>
          </p>
          <p
            v-if="touched && problem"
            class="form-error"
            role="alert"
            :data-testid="`${testid}-reason-error`"
          >
            {{ problem }}
          </p>
        </template>
      </DataState>

      <footer class="confirm-footer">
        <button class="secondary-button" type="button" :disabled="busy" @click="close">
          Cancel
        </button>
        <button
          :class="danger ? 'secondary-button danger-button' : 'primary-button'"
          type="button"
          :disabled="!canConfirm"
          :data-testid="`${testid}-confirm`"
          @click="submit"
        >
          {{ busy ? 'Working…' : confirmLabel }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.confirm-dialog {
  width: min(680px, calc(100vw - 30px));
  max-height: 76vh;
  overflow: auto;
}
.confirm-summary {
  margin: 14px 0 0;
  color: var(--text-strong);
  font-size: 14px;
  line-height: 1.6;
}
.confirm-subhead {
  margin: 16px 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.confirm-consequences {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
  font-size: 13.5px;
  line-height: 1.6;
}
.confirm-blocked {
  margin: 12px 0 0;
  padding: 10px 13px;
  border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--border));
  background: color-mix(in srgb, var(--bad) 10%, var(--surface));
  border-radius: 8px;
  color: var(--bad);
  line-height: 1.6;
}
.confirm-facts {
  display: grid;
  grid-template-columns: minmax(150px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 16px 0 0;
}
.confirm-facts dt {
  color: var(--muted);
  font-size: 12.5px;
}
.confirm-facts dd {
  margin: 0;
  color: var(--text-strong);
}
.confirm-reason {
  display: grid;
  gap: 6px;
  margin: 16px 0 0;
}
.confirm-reason textarea {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 8px;
  padding: 10px;
  font: inherit;
}
.confirm-note {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
