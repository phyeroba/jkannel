<script setup lang="ts">
/**
 * A headline figure with its icon chip and caption.
 *
 * LAYOUT COMES FROM THE DESIGN SYSTEM, NOT FROM HERE
 * ---------------------------------------------------------------------------
 * This is `components/core/MetricCard.jsx` in the handed-over design system,
 * ported to Vue: a soft-tint icon chip on the LEFT, then a `.metric-body`
 * holding the figure with its caption underneath. The earlier version of this
 * component stacked the label on top, floated the icon to the top-right and set
 * the figure at 24px — a different card that happened to use the same colours.
 *
 * The class names are load-bearing. `.metric-card`, `.metric-icon` and
 * `.metric-body` are all styled in `design-system/components.css`, which is
 * vendored from the package, so this component deliberately ships almost no
 * geometry of its own: only the link affordance below, which the kit has no
 * equivalent of.
 *
 * `metric-word` is the design system's own escape hatch: a value like
 * "Degraded" must read in full, so it drops to a clamped size rather than
 * being ellipsised at the 19px figure size a number uses.
 *
 * OPTIONALLY A LINK
 * ---------------------------------------------------------------------------
 * Every tile summarises something that has its own screen. It renders as an
 * `<article>` when there is nowhere to go and a `<RouterLink>` when there is,
 * rather than an article with a click handler: a real link gets keyboard focus,
 * middle-click, open-in-new-tab and a status-bar preview for free.
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  label: string;
  value: string;
  detail: string;
  tone?: 'primary' | 'good' | 'warn' | 'bad';
  icon?: string;
  /** Route this figure drills into. Omit for a tile with no destination. */
  to?: string;
  /** Overrides the generated link title, when the destination needs saying. */
  linkLabel?: string;
}>();

/**
 * A value is a "word" when it contains a run of four or more letters — the
 * design system's own test. "Degraded" and "Unavailable" are words; "530/s",
 * "96.8%" and "12 / 14" are figures and keep the full 19px treatment.
 */
const isWord = computed(() => /[a-z]{4,}/i.test(props.value));
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'article'"
    :to="to"
    class="metric-card"
    :class="{ 'metric-card-link': to }"
    :title="detail || undefined"
    :aria-label="to ? linkLabel || `${label}: ${value}. Open for detail.` : undefined"
  >
    <span class="metric-icon" :class="tone && tone !== 'primary' ? tone : undefined">
      <AppIcon :name="icon || 'chart'" :size="17" />
    </span>
    <span class="metric-body">
      <strong :class="{ 'metric-word': isWord }">{{ value }}</strong>
      <small>{{ label }}</small>
      <!--
        A THIRD LINE THE DESIGN SYSTEM'S CARD DOES NOT HAVE, ON PURPOSE.

        The kit's MetricCard passes `detail` to the `title` attribute and shows
        two lines. In this console `detail` is not a nicety — it carries the §17
        data-state sentence that says whether the figure was measured at all:
        "Messages waiting in SQLBox" versus "SQLBox queue not observable". The
        design system's own house rule is that a number is never faked and an
        empty state is never dressed up, and a sentence hidden in a `title`
        attribute is invisible to touch users and to screen readers both.

        So the geometry stays exactly as designed — icon chip, then body — and
        the honesty line is added inside the body rather than the card being
        re-laid-out around it.
      -->
      <small v-if="detail" class="metric-detail">{{ detail }}</small>
    </span>
    <!-- Only on a linked card, and decorative: the aria-label above already
         tells a screen reader the card is actionable. -->
    <span v-if="to" class="metric-go" aria-hidden="true">
      <AppIcon name="chevron" :size="14" />
    </span>
  </component>
</template>

<style scoped>
/* Geometry lives in design-system/components.css. What remains here is only the
   affordance for a card that navigates, which the design system does not cover
   because the UI kit's tiles are click handlers rather than links, and the
   observability line the kit has no slot for. */

/* The vendored `.metric-card small` truncates to one line, which is right for a
   caption like "Queue depth" and wrong for a sentence. This line is allowed to
   wrap, and the card is allowed to grow. */
.metric-detail {
  white-space: normal;
  overflow: visible;
  line-height: 1.4;
  margin-top: 2px;
}
/* With three lines the body no longer centres against a 32px chip — the chip
   should sit with the figure, not float in the middle of the stack. */
.metric-card:has(.metric-detail) {
  align-items: flex-start;
}
.metric-card:has(.metric-detail) .metric-icon {
  margin-top: 1px;
}
.metric-card-link {
  position: relative;
  text-decoration: none;
  color: inherit;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.metric-card-link:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-lg);
}
.metric-card-link:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
/* Sits in the corner and only appears on hover/focus, so the resting card is
   exactly as calm as an unlinked one. */
.metric-go {
  position: absolute;
  right: 12px;
  bottom: 10px;
  color: var(--muted);
  opacity: 0;
  transition: opacity 120ms ease;
}
.metric-card-link:hover .metric-go,
.metric-card-link:focus-visible .metric-go {
  opacity: 1;
}
</style>
