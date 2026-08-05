<script setup lang="ts">
/**
 * Send now / Send later, shared by the single-message composer and the Bulk
 * Send composer. Posts `scheduledAt` (ISO 8601, converted from the operator's
 * local wall-clock time) and an optional `validityMinutes` — see
 * `src/utils/send-scheduling.ts` for the verified contract.
 */
import { computed } from 'vue';
import {
  SCHEDULING_CAVEAT,
  SCHEDULING_SUPPORTED,
  deferredMinutesFor,
  localDateTimeNow,
  localDateTimeToIso,
  scheduleError,
  type ScheduleDraft,
} from '../utils/send-scheduling';

const props = defineProps<{
  /** `false` = send now, `true` = send later. */
  later: boolean;
  draft: ScheduleDraft;
  testid?: string;
  /** Disables the control for reasons of the caller's own (a send in flight). */
  busy?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:later', value: boolean): void;
  (event: 'update:draft', value: ScheduleDraft): void;
}>();

const prefix = computed(() => props.testid ?? 'schedule');
const minimum = computed(() => localDateTimeNow());
/** Only shown once the operator has committed to Send later. */
const error = computed(() => (props.later ? scheduleError(props.draft) : ''));
/** The UTC instant that will actually be sent, echoed so there is no ambiguity. */
const isoPreview = computed(() =>
  props.later && props.draft.sendAtLocal && !error.value
    ? localDateTimeToIso(props.draft.sendAtLocal)
    : '',
);
const waitMinutes = computed(() =>
  props.later && props.draft.sendAtLocal ? deferredMinutesFor(props.draft.sendAtLocal) : null,
);

function choose(later: boolean) {
  if (!SCHEDULING_SUPPORTED && later) return;
  emit('update:later', later);
}
function patch(patchValue: Partial<ScheduleDraft>) {
  emit('update:draft', { ...props.draft, ...patchValue });
}
</script>

<template>
  <div class="schedule-control" :data-testid="`${prefix}-control`">
    <div class="schedule-choice" role="group" aria-label="When to send">
      <button
        type="button"
        class="secondary-button"
        :data-testid="`${prefix}-now`"
        :aria-pressed="!later"
        :disabled="busy"
        @click="choose(false)"
      >
        Send now
      </button>
      <button
        type="button"
        class="secondary-button"
        :data-testid="`${prefix}-later`"
        :aria-pressed="later"
        :disabled="busy || !SCHEDULING_SUPPORTED"
        @click="choose(true)"
      >
        Send later
      </button>
    </div>

    <div v-if="later" class="schedule-fields">
      <label>
        Send at (your local time)
        <input
          type="datetime-local"
          :data-testid="`${prefix}-datetime`"
          :value="draft.sendAtLocal"
          :min="minimum"
          :disabled="busy"
          @input="patch({ sendAtLocal: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label>
        Validity period (minutes, optional)
        <input
          type="number"
          min="1"
          step="1"
          placeholder="Carrier default"
          :data-testid="`${prefix}-validity`"
          :value="draft.validityMinutes"
          :disabled="busy"
          @input="patch({ validityMinutes: ($event.target as HTMLInputElement).value })"
        />
      </label>
    </div>

    <p v-if="isoPreview" class="form-hint" :data-testid="`${prefix}-iso`">
      Sent to the API as <span class="mono">{{ isoPreview }}</span>
      <template v-if="waitMinutes !== null">
        — a {{ waitMinutes }} minute deferral on the engine row.
      </template>
      Validity is how long the SMSC should keep trying before it gives up.
    </p>

    <!--
      Honest about what deferral is. The backend module is explicit that it is a
      carrier request rather than a hold, and that a `fake` bind ignores it; an
      operator scheduling a campaign needs to know that before they rely on it.
    -->
    <p v-if="later" class="warn-notice" role="note" :data-testid="`${prefix}-caveat`">
      {{ SCHEDULING_CAVEAT }}
    </p>

    <p v-if="error" class="form-error" role="alert" :data-testid="`${prefix}-error`">
      {{ error }}
    </p>
  </div>
</template>
