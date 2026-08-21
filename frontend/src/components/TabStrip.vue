<script setup lang="ts">
/**
 * The design system's Tabs (`components/navigation/Tabs.jsx`), ported to Vue.
 *
 * All geometry comes from `.range-select` / `.range-button` in the vendored
 * `components.css` — the same treatment the time-range picker uses, which is
 * deliberate in the design: both are "pick one of these" and both should look
 * it.
 *
 * WHAT THIS ADDS OVER THE KIT'S VERSION
 * ---------------------------------------------------------------------------
 * The kit renders `role="tablist"` and `role="tab"` and stops there, which is
 * an accessibility trap rather than an accessibility feature: once an element
 * claims to be a tab, screen readers and keyboard users expect arrow-key
 * navigation and a single tab stop, and a plain row of buttons gives them
 * neither — every tab lands in the Tab order and the arrow keys do nothing.
 *
 * So this implements the roving tabindex the role promises: Left/Right move
 * between tabs, Home/End jump to the ends, and only the selected tab is in the
 * document's Tab sequence. Panels are labelled by their tab through
 * `aria-controls`, so the relationship is announced rather than merely visual.
 *
 * Named TabStrip and not Tabs because it renders the STRIP only. It holds no
 * panels and no content: the parent owns which panel is visible, which keeps a
 * tab that swaps a whole screen and a tab that swaps one panel the same
 * component.
 */
export interface TabDefinition {
  id: string;
  label: string;
  /** Optional count rendered after the label, e.g. how many rows a tab holds. */
  count?: number | null;
}

const props = defineProps<{
  tabs: TabDefinition[];
  modelValue: string;
  /** Announced as the group's purpose; required for a tablist to make sense. */
  label: string;
  testid?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();

function select(id: string) {
  if (id !== props.modelValue) emit('update:modelValue', id);
}

/**
 * Arrow-key navigation, wrapping at both ends.
 *
 * Selection follows focus, which is the correct pattern here: every tab on this
 * console swaps content that is already loaded, so there is no cost to
 * activating as you arrow past. (Were a tab to trigger a fetch, the pattern
 * would have to change to manual activation with Enter.)
 */
function onKeydown(event: KeyboardEvent, index: number) {
  const last = props.tabs.length - 1;
  let next: number | null = null;
  if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
  else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  if (next === null) return;
  event.preventDefault();
  const target = props.tabs[next];
  if (!target) return;
  select(target.id);
  // The newly selected tab becomes the only tab stop, so focus has to follow
  // it explicitly — otherwise focus is left on an element with tabindex="-1".
  const strip = (event.currentTarget as HTMLElement).parentElement;
  strip?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
}
</script>

<template>
  <div
    class="range-select"
    role="tablist"
    :aria-label="label"
    :data-testid="testid ?? 'tab-strip'"
  >
    <button
      v-for="(tab, index) in tabs"
      :id="`${testid ?? 'tab'}-${tab.id}`"
      :key="tab.id"
      type="button"
      role="tab"
      class="range-button"
      :class="{ active: modelValue === tab.id }"
      :aria-selected="modelValue === tab.id"
      :aria-controls="`${testid ?? 'tab'}-panel-${tab.id}`"
      :tabindex="modelValue === tab.id ? 0 : -1"
      :data-testid="`${testid ?? 'tab'}-${tab.id}`"
      @click="select(tab.id)"
      @keydown="onKeydown($event, index)"
    >
      {{ tab.label }}
      <span v-if="tab.count !== null && tab.count !== undefined" class="figures tab-count">{{
        tab.count
      }}</span>
    </button>
  </div>
</template>

<style scoped>
.tab-count {
  margin-left: 6px;
  opacity: 0.65;
}
</style>
