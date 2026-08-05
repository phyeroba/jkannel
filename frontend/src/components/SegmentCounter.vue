<script setup lang="ts">
/**
 * Live SMS cost readout for a message composer: characters, SEGMENTS, the
 * alphabet in force, and how much of the current segment is left.
 *
 * Everything is computed client-side from `src/utils/message-segments.ts` (a
 * faithful port of `backend/src/engine/message-segments.ts`) so it updates on
 * every keystroke without a round trip.
 *
 * Two things get a loud warning rather than a number, because both are
 * discovered from the bill otherwise:
 *  - the text tipping into a second segment;
 *  - one non-GSM character (a curly quote pasted from a document, an emoji)
 *    forcing the whole body to UCS-2 and collapsing the limit 160 → 70.
 */
import { computed } from 'vue';
import { describeComposerText } from '../utils/message-segments';

const props = defineProps<{
  /** The composed body. */
  text: string;
  /** Distinguishes the two composers' test ids. */
  testid?: string;
}>();

const info = computed(() => describeComposerText(props.text));

const prefix = computed(() => props.testid ?? 'segment');

/** The single line an operator reads while typing. */
const summary = computed(() => {
  const i = info.value;
  const segments = `${i.segments} segment${i.segments === 1 ? '' : 's'}`;
  return `${i.characters} character${i.characters === 1 ? '' : 's'} · ${segments} · ${i.alphabetLabel} · ${i.remainingInSegment} left in this segment`;
});

/** Non-GSM characters, rendered so a space or an emoji is still visible. */
const offending = computed(() => info.value.offendingCharacters.join(' '));

const tone = computed(() => {
  if (info.value.forcedUcs2) return 'bad';
  if (info.value.multipart) return 'warn';
  return '';
});
</script>

<template>
  <div class="segment-counter" :data-testid="`${prefix}-counter`">
    <p class="segment-summary" :class="tone" aria-live="polite" :data-testid="`${prefix}-summary`">
      <span :data-testid="`${prefix}-characters`">{{ info.characters }}</span>
      characters ·
      <strong :data-testid="`${prefix}-segments`">{{ info.segments }}</strong>
      segment{{ info.segments === 1 ? '' : 's' }} ·
      <span :data-testid="`${prefix}-alphabet`">{{ info.alphabetLabel }}</span>
      ·
      <span :data-testid="`${prefix}-remaining`">{{ info.remainingInSegment }}</span>
      left in this segment
      <span class="segment-capacity">(limit {{ info.currentCapacity }})</span>
    </p>
    <!-- Screen-reader-only restatement; the spans above are visual. -->
    <span class="sr-only">{{ summary }}</span>

    <p
      v-if="info.forcedUcs2"
      class="segment-alert bad"
      role="status"
      :data-testid="`${prefix}-ucs2-warning`"
    >
      <strong>UCS-2 encoding forced.</strong>
      <template v-if="offending">
        <span class="segment-offenders">{{ offending }}</span>
      </template>
      {{
        info.offendingCharacters.length === 1
          ? 'That character is not in the GSM-7 alphabet, so the whole message is sent as UCS-2'
          : 'Those characters are not in the GSM-7 alphabet, so the whole message is sent as UCS-2'
      }}
      — the limit drops from 160 to 70 per segment (67 once concatenated).
      <template v-if="info.segmentsIfGsm7 !== null && info.segmentsIfGsm7 < info.segments">
        Replacing them with plain GSM-7 equivalents would cost
        <strong>{{ info.segmentsIfGsm7 }}</strong>
        segment{{ info.segmentsIfGsm7 === 1 ? '' : 's' }} instead of
        <strong>{{ info.segments }}</strong
        >.
      </template>
    </p>

    <p
      v-else-if="info.multipart"
      class="segment-alert warn"
      role="status"
      :data-testid="`${prefix}-multipart-warning`"
    >
      <strong>{{ info.segments }} segments.</strong>
      This message is concatenated, so each part carries a 6-octet header and holds
      {{ info.multipartCapacity }} — not {{ info.singleCapacity }} — characters. It is billed as
      {{ info.segments }} messages per recipient.
    </p>
  </div>
</template>
