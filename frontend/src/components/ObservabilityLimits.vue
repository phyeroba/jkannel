<script setup lang="ts">
/**
 * What the engine CANNOT tell us, rendered as first-class content.
 *
 * PLAN.md §0: the specification (§5) asks for per-session identity, bind state
 * in SMPP vocabulary, enquire_link round-trip time, PDU counters and protocol
 * latency percentiles. bearerbox emits none of them, and `instances = N`
 * collapses N real SMPP sessions into a single reported entry.
 *
 * The backend returns that as data (`limits`) rather than leaving the console
 * to guess. This component is the reason it does: an operator has to be able to
 * tell "this bind reported no errors" from "this engine cannot report errors at
 * that level", and a screen with quietly missing columns cannot say which.
 *
 * Deliberately NOT collapsible and NOT dismissible. It is not a footnote.
 */
import { computed } from 'vue';
import type { ObservabilityLimits } from '../utils/connectivity';

const props = withDefaults(
  defineProps<{
    limits: ObservabilityLimits | null;
    /** `smsc` names one connection; `estate` speaks for the whole register. */
    scope?: 'smsc' | 'estate';
    /**
     * Engine ids this particular `reason` covers. The estate register groups
     * connections by reason — an SMSC with `instances = 3` gets a different
     * sentence from a single-connection one — and naming the members is what
     * stops a reason about three connections being read as a statement about
     * all of them.
     */
    appliesTo?: string[];
    testid?: string;
  }>(),
  { scope: 'smsc', appliesTo: undefined, testid: 'observability-limits' },
);

const subject = computed(() => (props.scope === 'estate' ? 'these binds' : 'this SMSC connection'));
const headingId = computed(() => `${props.testid}-heading`);
</script>

<template>
  <section
    v-if="limits"
    class="panel limits-panel"
    :data-testid="testid"
    :aria-labelledby="headingId"
  >
    <h3 :id="headingId">What this engine cannot report about {{ subject }}</h3>

    <p v-if="appliesTo?.length" class="row-id mono" :data-testid="`${testid}-applies-to`">
      Applies to: {{ appliesTo.join(', ') }}
    </p>

    <!--
      Verbatim from the API. Paraphrasing it here would let the console's copy
      drift from the reason the backend actually computed, and the reason
      changes with `instances`.
    -->
    <p class="limits-reason" :data-testid="`${testid}-reason`">{{ limits.reason }}</p>

    <p
      v-if="limits.sessionsCollapsed"
      class="warn-notice"
      role="note"
      :data-testid="`${testid}-collapsed`"
    >
      <strong
        >{{ limits.configuredInstances }} parallel connections are reported here as one.</strong
      >
      This SMSC is configured with
      <span class="mono">instances = {{ limits.configuredInstances }}</span
      >, and the engine gives all {{ limits.configuredInstances }} sessions a single
      <span class="mono">smsc-id</span>. Every figure on this screen is their combined total; none
      of it can be attributed to an individual session, so one failing session is invisible in these
      numbers.
    </p>

    <p>
      The specification asks for the per-session figures below. This engine does not emit them, so
      this screen has no columns for them — an absent column means
      <strong>not observable</strong>, never zero.
    </p>
    <ul class="limits-list" :data-testid="`${testid}-unavailable`">
      <li v-for="field in limits.unavailable" :key="field">{{ field }}</li>
    </ul>

    <p class="source-note">
      Nothing on this screen is filled in with a substitute. Where a figure is missing it was never
      reported, and an em dash is shown rather than a number that would read as a measurement.
    </p>
  </section>
</template>

<style scoped>
.limits-panel {
  border-left: 3px solid var(--warn);
}
.limits-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.limits-reason {
  margin: 0 0 10px;
  color: var(--text-strong);
}
.limits-list {
  margin: 8px 0 10px;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: 13px;
}
</style>
