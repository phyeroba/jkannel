<script setup lang="ts">
/**
 * Send-priority select, shared by the single-message composer, the Bulk Send
 * campaign form and the Live Queue resend. Posts `priority` as an integer 0…3,
 * or omits the field entirely — see `src/utils/message-priority.ts` for the
 * verified contract and for why the default must be genuinely absent.
 *
 * The caveat is part of the control, not decoration: priority reorders a queue
 * and does nothing on an idle bind, and an operator who is not told that will
 * read the control as "send faster" and report its correct behaviour as a bug.
 */
import { computed } from 'vue';
import {
  PRIORITY_CAVEAT,
  PRIORITY_LEVELS,
  PRIORITY_UNSET_NOTE,
  type PriorityChoice,
} from '../utils/message-priority';

const props = defineProps<{
  modelValue: PriorityChoice;
  testid?: string;
  /** Disabled while the caller has a send in flight. */
  busy?: boolean;
  /**
   * Which honest limit to print. Bulk and resend say more, because both create
   * the backlog that makes priority observable in the first place.
   */
  caveat?: string;
  label?: string;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: PriorityChoice): void }>();

const prefix = computed(() => props.testid ?? 'priority');
const caveatText = computed(() => props.caveat ?? PRIORITY_CAVEAT);
const selected = computed(() => PRIORITY_LEVELS.find((level) => level.value === props.modelValue));
</script>

<template>
  <div class="priority-control" :data-testid="`${prefix}-control`">
    <label class="filter-select">
      <span>{{ label ?? 'Send priority' }}</span>
      <select
        :value="modelValue"
        :data-testid="`${prefix}-select`"
        :disabled="busy"
        @change="
          emit('update:modelValue', ($event.target as HTMLSelectElement).value as PriorityChoice)
        "
      >
        <option v-for="level in PRIORITY_LEVELS" :key="level.value || 'unset'" :value="level.value">
          {{ level.label }}
        </option>
      </select>
    </label>

    <p v-if="selected" class="form-hint" :data-testid="`${prefix}-level-hint`">
      {{ selected.hint }}
    </p>
    <p class="form-hint" :data-testid="`${prefix}-unset-note`">{{ PRIORITY_UNSET_NOTE }}</p>

    <p class="warn-notice" role="note" :data-testid="`${prefix}-caveat`">{{ caveatText }}</p>
  </div>
</template>

<style scoped>
.priority-control {
  display: grid;
  gap: 6px;
}
</style>
