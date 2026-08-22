<script setup lang="ts">
/**
 * The design system's right-hand detail sheet
 * (`components/feedback/Drawer.jsx`), ported to Vue.
 *
 * WHY A SHEET AND NOT A DIALOG
 * ---------------------------------------------------------------------------
 * This is the pattern the design system uses for a record opened FROM A
 * REGISTER ROW, and the reason is positional: the list stays visible behind the
 * scrim, so an operator working down a table of forty binds keeps their place.
 * A centred modal covers the list and loses it; navigating to a detail page
 * loses it and the scroll position too.
 *
 * All geometry comes from `.drawer-*` in the vendored `components.css`. Nothing
 * is restyled here.
 *
 * WHAT THIS ADDS OVER THE KIT'S VERSION
 * ---------------------------------------------------------------------------
 * The kit closes on Escape and on the scrim. A real sheet also has to handle
 * focus, or a keyboard user tabs straight out of the open sheet into the table
 * behind it — which is still there, still focusable, and now unreachable
 * visually. So this moves focus in on open, restores it to the row that opened
 * it on close, and keeps Tab inside while it is open.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  title: string;
  subtitle?: string;
  /** Small uppercase kicker above the title — the record's type, usually. */
  eyebrow?: string;
  /**
   * Widens the sheet past the design system's 50vw.
   *
   * The 50vw default is sized for a record opened from a register, where seeing
   * the list behind the sheet is the whole point of using a sheet. Content that
   * is itself wide — code samples at 80 columns, a table of a dozen columns —
   * needs the width more than it needs the list, and wraps into unreadability
   * without it. Opt-in, so the default stays as designed.
   */
  wide?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const sheet = ref<HTMLElement | null>(null);
/** The element that had focus when the sheet opened, to hand it back. */
let opener: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  if (!sheet.value) return [];
  const all = [...sheet.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  // See the same note in `ModalDialog.vue`: `offsetParent` correctly skips a
  // control inside a collapsed branch, but it is a layout property, so an
  // environment that does no layout would report the whole sheet as hidden and
  // the trap would have nothing to hold on to. Unfiltered is the safe fallback.
  const visible = all.filter((el) => el.offsetParent !== null);
  return visible.length ? visible : all;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  // Wrap at both ends. Without this the sheet is a visual modal and a keyboard
  // no-op: Tab walks out into the register behind the scrim.
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      opener = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', onKeydown);
      await nextTick();
      // The body first, not the head. The head holds Close and the caller's
      // action slot — which on an SMSC sheet is Disable and Suspend — so
      // `focusables()[0]` would put the caret on a destructive control the
      // moment the sheet opened. The Tab cycle still reaches them.
      const body = sheet.value?.querySelector<HTMLElement>('.drawer-body');
      const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      (first ?? focusables()[0] ?? sheet.value)?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown);
      // Back to the row that opened the sheet, not to the top of the document.
      opener?.focus?.();
      opener = null;
    }
  },
  // `immediate`, because a sheet can be mounted ALREADY open — a deep link
  // that names a record opens one on first render. Without this the watcher
  // never fires for that render and the sheet has no Escape and no focus.
  { immediate: true },
);

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-scrim" data-testid="detail-drawer" @click.self="emit('close')">
      <aside
        ref="sheet"
        class="drawer-sheet"
        :class="{ 'drawer-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="drawer-head">
          <div>
            <div v-if="eyebrow" class="t-caps">{{ eyebrow }}</div>
            <h2>{{ title }}</h2>
            <p v-if="subtitle">{{ subtitle }}</p>
          </div>
          <div class="drawer-head-actions">
            <slot name="actions" />
            <button
              class="secondary-button"
              type="button"
              data-testid="detail-drawer-close"
              @click="emit('close')"
            >
              Close
            </button>
          </div>
        </header>
        <div class="drawer-body"><slot /></div>
        <div v-if="$slots.footer" class="drawer-foot"><slot name="footer" /></div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
/* The eyebrow's only geometry; `.t-caps` from the design system's typography
   layer supplies the size, weight, tracking and colour. */
.t-caps {
  margin-bottom: 4px;
}
</style>
