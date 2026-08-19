<script setup lang="ts">
/**
 * A headline figure with its label, detail line and icon.
 *
 * OPTIONALLY A LINK
 * ---------------------------------------------------------------------------
 * Every tile on the dashboard summarises something that has its own screen —
 * queue depth has Queues, alerts have Alerts. Reading a worrying number and
 * then hunting the sidebar for where to act on it is friction the tile can
 * remove, so passing `to` turns the whole card into a router link.
 *
 * It renders as an `<article>` when there is nowhere to go and a `<RouterLink>`
 * when there is, rather than an article with a click handler: a real link gets
 * keyboard focus, middle-click, open-in-new-tab and a status-bar preview for
 * free, and a div with @click gets none of them.
 */
import AppIcon from './AppIcon.vue';

defineProps<{
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
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'article'"
    :to="to"
    class="metric-card"
    :class="{ 'metric-card-link': to }"
    :aria-label="to ? linkLabel || `${label}: ${value}. Open for detail.` : undefined"
  >
    <div class="metric-top">
      <span>{{ label }}</span
      ><span class="metric-icon" :class="tone || 'primary'"
        ><AppIcon :name="icon || 'chart'" :size="18"
      /></span>
    </div>
    <strong>{{ value }}</strong
    ><small>{{ detail }}</small>
    <!-- Only on a linked card, and decorative: the aria-label above already
         tells a screen reader the card is actionable. -->
    <span v-if="to" class="metric-go" aria-hidden="true">
      <AppIcon name="chevron" :size="14" />
    </span>
  </component>
</template>

<style scoped>
.metric-card-link {
  display: block;
  position: relative;
  text-decoration: none;
  color: inherit;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.metric-card-link:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.1);
}
.metric-card-link:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
/* Sits in the corner and only appears on hover/focus, so the resting card is
   exactly as calm as an unlinked one. */
.metric-go {
  position: absolute;
  right: 14px;
  bottom: 12px;
  color: var(--muted);
  opacity: 0;
  transition: opacity 120ms ease;
}
.metric-card-link:hover .metric-go,
.metric-card-link:focus-visible .metric-go {
  opacity: 1;
}
</style>
