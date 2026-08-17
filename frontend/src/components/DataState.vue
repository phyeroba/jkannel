<script setup lang="ts">
import { computed } from 'vue';
import { describeState, type DataState } from '../utils/data-state';

/**
 * Renders every non-live data state to one recipe (spec §17).
 *
 * Use it in place of the hand-written `v-if="state === 'loading'"` ladders this
 * console had grown: it keeps the wording honest by default, guarantees a
 * `role="alert"` on the states an operator must not miss, and gives `loading` a
 * skeleton instead of a spinner so a table does not collapse and reflow.
 *
 * When the state is `live` it renders NOTHING and the caller's default slot
 * shows — so a screen wraps its content once rather than branching around it.
 */
const props = withDefaults(
  defineProps<{
    state: DataState;
    /** Lower-case plural noun for the content: "alerts", "queued messages". */
    subject: string;
    detail?: string;
    ageSeconds?: number | null;
    permission?: string | null;
    missing?: string[];
    /** Skeleton shape while loading. `table` draws rows, `cards` draws tiles. */
    skeleton?: 'text' | 'table' | 'cards' | 'none';
    skeletonRows?: number;
    /** Shown as a retry control on `error`. */
    onRetry?: (() => void) | null;
    testid?: string;
  }>(),
  { skeleton: 'text', skeletonRows: 4, onRetry: null },
);

const copy = computed(() =>
  describeState(props.state, {
    subject: props.subject,
    detail: props.detail,
    ageSeconds: props.ageSeconds,
    permission: props.permission,
    missing: props.missing,
  }),
);

/**
 * `partial` and `stale` show the banner AND the content: there is a real, usable
 * measurement underneath and hiding it would be the worse failure. Every other
 * non-live state replaces the content, because there is nothing truthful to put
 * in its place.
 */
const showsContent = computed(
  () => props.state === 'live' || props.state === 'stale' || props.state === 'partial',
);
</script>

<template>
  <div
    v-if="state !== 'live'"
    class="data-state"
    :class="[`tone-${copy.tone}`, showsContent ? 'data-state-banner' : 'data-state-block']"
    :role="copy.role"
    :aria-live="copy.role === 'alert' ? 'assertive' : 'polite'"
    :data-testid="testid ?? 'data-state'"
    :data-state="state"
  >
    <template v-if="state === 'loading' && skeleton !== 'none'">
      <span class="sr-only">{{ copy.title }}</span>
      <div v-if="skeleton === 'cards'" class="skeleton-cards" aria-hidden="true">
        <span v-for="index in skeletonRows" :key="index" class="skeleton skeleton-card"></span>
      </div>
      <div v-else-if="skeleton === 'table'" class="skeleton-rows" aria-hidden="true">
        <span v-for="index in skeletonRows" :key="index" class="skeleton skeleton-row"></span>
      </div>
      <div v-else class="skeleton-rows" aria-hidden="true">
        <span class="skeleton skeleton-row short"></span>
      </div>
    </template>
    <template v-else>
      <p class="data-state-title">{{ copy.title }}</p>
      <p v-if="copy.detail" class="data-state-detail">{{ copy.detail }}</p>
      <slot name="action">
        <button v-if="state === 'error' && onRetry" class="ghost-button" @click="onRetry()">
          Retry
        </button>
      </slot>
    </template>
  </div>
  <slot v-if="showsContent"></slot>
</template>
