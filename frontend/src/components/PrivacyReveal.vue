<script setup lang="ts">
/**
 * The masking notice, and the control that asks to see through it (§10, §18).
 *
 * The screen it sits on does not decide whether data is masked — the API does,
 * and says so. This component renders that statement and, where the operator
 * holds `messages.reveal`, offers a reasoned, time-limited window.
 *
 * Deliberately NOT dismissible. An operator who dismissed the notice and then
 * copied `+2567••••••18` into a carrier ticket is the exact failure it exists
 * to prevent.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { apiRequest } from '../api';
import {
  REVEAL_DEFAULT_MINUTES,
  REVEAL_MAX_MINUTES,
  clampMinutes,
  describeReasonProblem,
  describeRemaining,
  grantIsLive,
  reasonIsUsable,
  revealStatus,
  type PrivacyState,
  type RevealGrant,
} from '../utils/privacy';

const props = withDefaults(
  defineProps<{
    /** The `privacy` block from the payload. Null when the read carries no PII. */
    privacy: PrivacyState | null;
    /** Whether this operator holds `messages.reveal`. */
    canReveal?: boolean;
    /** Narrows the grant to one message, when the screen is about one message. */
    messageRef?: string | null;
    testid?: string;
  }>(),
  { canReveal: false, messageRef: null, testid: 'privacy-reveal' },
);

/** Emitted when the grant state changes, so the parent can re-fetch its rows. */
const emit = defineEmits<{ (event: 'changed', revealing: boolean): void }>();

/**
 * The masking policy, fetched the first time somebody opens the disclosure.
 *
 * `GET /privacy/policy` is readable without the reveal grant by design — it
 * describes the rules rather than exposing anything — and it is the answer to
 * the question this notice provokes. Read lazily because most people who see
 * the notice already know what it means, and it would otherwise be a request on
 * every screen that masks anything.
 */
const policy = ref<Record<string, unknown> | null>(null);
const policyError = ref('');

async function loadPolicy(event: Event) {
  if (!(event.target as HTMLDetailsElement)?.open || policy.value) return;
  try {
    policy.value = await apiRequest<Record<string, unknown>>('/privacy/policy');
    policyError.value = '';
  } catch {
    policyError.value =
      'The masking policy could not be read. The notice above still applies — what you can see is what the API returned.';
  }
}

/** Coerced: the policy is free-form JSON and must not crash the notice. */
const maskedFields = computed<string[]>(() => {
  const fields = policy.value?.maskedFields;
  return Array.isArray(fields) ? fields.map((field) => String(field)) : [];
});

const grant = ref<RevealGrant | null>(null);
const asking = ref(false);
const reason = ref('');
const minutes = ref(REVEAL_DEFAULT_MINUTES);
const busy = ref(false);
const failure = ref<string | null>(null);

/**
 * Ticks the countdown.
 *
 * A window that has visibly expired but still reads "14m left" would invite an
 * operator to believe they are still authorised, so the display is driven by a
 * clock rather than only by the last response.
 */
const now = ref(Date.now());
const timer = window.setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => window.clearInterval(timer));

const status = computed(() => revealStatus(props.privacy, grant.value, props.canReveal, now.value));
const live = computed(() => grantIsLive(grant.value, now.value));
const countdown = computed(() => describeRemaining(grant.value, now.value));
const reasonProblem = computed(() => (reason.value ? describeReasonProblem(reason.value) : null));

/**
 * When a window lapses on screen, the rows on display are still the revealed
 * ones. Telling the parent lets it re-fetch, so what is shown matches what the
 * operator is currently authorised to see rather than what they were.
 */
watch(live, (isLive, wasLive) => {
  if (wasLive && !isLive) {
    grant.value = null;
    emit('changed', false);
  }
});

async function loadGrant() {
  if (!props.canReveal) return;
  try {
    const answer = await apiRequest<{ grant: RevealGrant | null }>('/privacy/reveal');
    grant.value = answer.grant;
    // A window opened on another screen is still open here. Telling the parent
    // lets it ask for the unmasked rows, so the same operator does not have to
    // request a second grant to see what they are already authorised to see.
    if (grantIsLive(grant.value, Date.now())) emit('changed', true);
  } catch {
    // A failure to read the current grant is not a failure of the screen; the
    // data is masked either way, which is the safe state.
    grant.value = null;
  }
}
void loadGrant();

async function request() {
  if (!reasonIsUsable(reason.value)) {
    failure.value = describeReasonProblem(reason.value);
    return;
  }
  busy.value = true;
  failure.value = null;
  try {
    grant.value = await apiRequest<RevealGrant>('/privacy/reveal', {
      method: 'POST',
      body: JSON.stringify({
        reason: reason.value.trim(),
        minutes: clampMinutes(minutes.value),
        messageRef: props.messageRef,
      }),
    });
    asking.value = false;
    reason.value = '';
    emit('changed', true);
  } catch (error) {
    failure.value = error instanceof Error ? error.message : 'The reveal could not be requested.';
  } finally {
    busy.value = false;
  }
}

async function revoke() {
  if (!grant.value) return;
  busy.value = true;
  failure.value = null;
  try {
    await apiRequest(`/privacy/reveal/${grant.value.id}`, { method: 'DELETE' });
    grant.value = null;
    emit('changed', false);
  } catch (error) {
    failure.value = error instanceof Error ? error.message : 'The window could not be closed.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    v-if="privacy"
    class="panel privacy-panel"
    :class="{ revealed: !privacy.masked }"
    :data-testid="testid"
    role="note"
  >
    <p class="privacy-head" :data-testid="`${testid}-state`">
      <!-- Never colour alone (§17.1): the state is spelled out in words. -->
      <strong>{{ privacy.masked ? 'Masked' : 'Revealed' }}</strong>
      <span v-if="!privacy.masked && live" class="countdown" :data-testid="`${testid}-countdown`">
        {{ countdown }}
      </span>
    </p>

    <p class="privacy-detail" :data-testid="`${testid}-detail`">{{ status.detail }}</p>

    <p v-if="privacy.refusal" class="warn-notice" :data-testid="`${testid}-refusal`">
      {{ privacy.refusal }}
    </p>

    <!--
      The policy, on demand. "What exactly is masked, and what would revealing
      it entail" is asked at the moment somebody meets the notice, and until now
      the endpoint that answers it had no surface — so the answer lived only in
      the API document.
    -->
    <details :data-testid="`${testid}-policy`" @toggle="loadPolicy">
      <summary>What is masked, and how revealing works</summary>
      <ul v-if="policy" class="policy-list" :data-testid="`${testid}-policy-list`">
        <li>
          Masked fields: <span class="mono">{{ maskedFields.join(', ') }}</span>
        </li>
        <li>
          Revealing needs <span class="mono">{{ policy.revealPermission }}</span
          >, a written reason, and it is recorded against every row read under the window.
        </li>
        <li>
          A window lasts {{ policy.defaultWindowMinutes }} minutes by default and
          {{ policy.maxWindowMinutes }} at most — it expires on its own rather than needing to be
          remembered.
        </li>
      </ul>
      <p v-else class="privacy-detail">{{ policyError || 'Reading the policy…' }}</p>
    </details>

    <div v-if="status.state === 'maskable'" class="privacy-actions">
      <button
        v-if="!asking"
        type="button"
        class="ghost"
        :data-testid="`${testid}-ask`"
        @click="asking = true"
      >
        Reveal real values…
      </button>

      <form v-else class="reveal-form" :data-testid="`${testid}-form`" @submit.prevent="request">
        <label :for="`${testid}-reason`">
          Reason
          <!--
            Required by the API, and recorded against every row read under the
            window. Saying so here is what makes it a considered answer rather
            than a box to get past.
          -->
          <span class="hint">recorded in the audit trail</span>
        </label>
        <input
          :id="`${testid}-reason`"
          v-model="reason"
          type="text"
          maxlength="500"
          placeholder="e.g. ticket 4412 — customer reports the OTP never arrived"
          :data-testid="`${testid}-reason-input`"
        />
        <label :for="`${testid}-minutes`">
          Window
          <span class="hint">minutes, up to {{ REVEAL_MAX_MINUTES }}</span>
        </label>
        <input
          :id="`${testid}-minutes`"
          v-model.number="minutes"
          type="number"
          min="1"
          :max="REVEAL_MAX_MINUTES"
          :data-testid="`${testid}-minutes-input`"
        />
        <p v-if="reasonProblem" class="warn-notice" :data-testid="`${testid}-reason-problem`">
          {{ reasonProblem }}
        </p>
        <div class="reveal-buttons">
          <button
            type="submit"
            class="primary"
            :disabled="busy || !reasonIsUsable(reason)"
            :data-testid="`${testid}-submit`"
          >
            {{ busy ? 'Requesting…' : 'Open the window' }}
          </button>
          <button
            type="button"
            class="ghost"
            :data-testid="`${testid}-cancel`"
            @click="asking = false"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>

    <div v-else-if="status.state === 'unmasked' && live" class="privacy-actions">
      <p class="row-id mono" :data-testid="`${testid}-grant-reason`">
        Reason on record: {{ grant?.reason }}
      </p>
      <button
        type="button"
        class="ghost"
        :disabled="busy"
        :data-testid="`${testid}-revoke`"
        @click="revoke"
      >
        Close the window now
      </button>
    </div>

    <p v-if="failure" class="warn-notice" :data-testid="`${testid}-failure`">{{ failure }}</p>
  </section>
</template>

<style scoped>
.privacy-panel {
  border-left: 3px solid var(--warn);
  display: grid;
  gap: 8px;
}
.privacy-panel.revealed {
  border-left-color: var(--danger, var(--warn));
}
.privacy-head {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.countdown {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  font-size: 13px;
}
.policy-list {
  margin: 8px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  font-size: 13px;
  line-height: 1.6;
}
details summary {
  cursor: pointer;
  color: var(--brand);
  font-size: 13px;
  margin-top: 8px;
}
.privacy-detail {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.privacy-actions {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.reveal-form {
  display: grid;
  gap: 6px;
  width: min(520px, 100%);
}
.reveal-form label {
  font-size: 13px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.hint {
  color: var(--muted);
  font-size: 12px;
}
.reveal-buttons {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
</style>
