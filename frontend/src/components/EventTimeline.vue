<script setup lang="ts">
/**
 * The design system's Timeline (`components/data/Timeline.jsx`), ported to Vue.
 *
 * Seven of the designed screens use it — alert lifecycle, bind history, message
 * lifecycle, queue recovery, failover transitions, service restarts and the
 * receipt lifecycle in Test Tools. It exists so a SEQUENCE IS READ RATHER THAN
 * INFERRED: a rail of dots carrying a time, a label and the evidence behind it,
 * in the order things actually happened.
 *
 * The `missing` state is the one that earns its keep. A lifecycle with a step
 * that never arrived — a DLR that was never returned, an acknowledgement nobody
 * sent — has to render as a present-but-hollow step, not as a gap. A gap reads
 * as "nothing happened here", which is indistinguishable from "we did not
 * look". That is the same distinction §17 draws everywhere else in this
 * console, and it is why the dot is outlined-dashed rather than simply absent.
 *
 * The kit inlines its styling. Here it is a scoped stylesheet using the same
 * token values, because inline styles cannot express the `:last-child` rule
 * that drops the connector on the final step.
 */
type TimelineState = 'ok' | 'warn' | 'error' | 'missing' | 'info';

interface TimelineItem {
  /** Clock or stamp, rendered mono in the left rail. */
  at: string;
  label: string;
  detail?: string;
  /** Elapsed since the previous step, e.g. "1.4s". Rendered as "+1.4s". */
  latency?: string;
  state?: TimelineState;
}

withDefaults(defineProps<{ items: TimelineItem[]; dense?: boolean }>(), { dense: false });
</script>

<template>
  <ol class="timeline" :class="{ dense }" data-testid="event-timeline">
    <li v-for="(item, index) in items" :key="`${item.at}-${item.label}-${index}`">
      <span class="timeline-at mono">{{ item.at }}</span>
      <span class="timeline-rail" aria-hidden="true">
        <span class="timeline-dot" :class="item.state || 'info'"></span>
        <span class="timeline-line"></span>
      </span>
      <span class="timeline-body">
        <strong>{{ item.label }}</strong>
        <span v-if="item.detail" class="timeline-detail">{{ item.detail }}</span>
        <span v-if="item.latency" class="timeline-latency mono">+{{ item.latency }}</span>
      </span>
    </li>
  </ol>
</template>

<style scoped>
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
}
.timeline.dense {
  gap: 10px;
}
.timeline li {
  display: grid;
  /* Fixed time rail so every label starts on the same x, whatever the stamp. */
  grid-template-columns: 84px 14px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}
.timeline-at {
  font-size: 11.5px;
  color: var(--muted);
  padding-top: 1px;
}
.timeline-rail {
  display: grid;
  justify-items: center;
  gap: 2px;
  padding-top: 4px;
}
.timeline-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--brand);
}
.timeline-dot.ok {
  background: var(--good);
}
.timeline-dot.warn {
  background: var(--warn);
}
.timeline-dot.error {
  background: var(--bad);
}
.timeline-dot.info {
  background: var(--info);
}
/* Hollow and dashed: a step that was expected and never arrived is present in
   the sequence, and visibly not a step that succeeded. */
.timeline-dot.missing {
  background: transparent;
  outline: 1px dashed var(--muted);
  outline-offset: 2px;
}
.timeline-line {
  width: 1px;
  height: 26px;
  background: var(--border);
}
.timeline.dense .timeline-line {
  height: 18px;
}
/* The rail connects steps; there is nothing after the last one to connect to. */
.timeline li:last-child .timeline-line {
  display: none;
}
.timeline-body strong {
  display: block;
  font-size: 13px;
  color: var(--text-strong);
}
.timeline-detail {
  display: block;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.timeline-latency {
  display: block;
  font-size: 11.5px;
  color: var(--muted);
}
</style>
