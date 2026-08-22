<script setup lang="ts">
/**
 * The design system's Dialog (`components/feedback/Dialog.jsx`), ported to Vue.
 *
 * WHEN A DIALOG AND NOT A DRAWER
 * ---------------------------------------------------------------------------
 * The kit uses two overlays and the choice between them is not cosmetic:
 *
 *   Drawer   a record opened FROM a register row. The list stays visible behind
 *            the scrim, so an operator working down forty binds keeps their
 *            place. `DetailDrawer.vue`.
 *   Dialog   a form that creates something, or a decision to confirm. There is
 *            no list position to preserve — the operator is not reading the
 *            register any more, they are filling something in — and a centred
 *            card is where the eye already is.
 *
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 * Seven create forms in this console were inline composers that unfolded
 * underneath the register. That pushes the rest of the list down, loses the
 * operator's position, and on a long register puts the form itself below the
 * fold — you press "Add SMSC" and nothing appears to happen. The kit has no
 * inline expander anywhere, and that is why.
 *
 * WHAT THIS ADDS OVER THE KIT'S VERSION
 * ---------------------------------------------------------------------------
 * The kit closes on Escape and on the backdrop. A real modal also has to handle
 * focus, or a keyboard user tabs out of the open dialog into the register
 * behind it — still focusable, now invisible. So this moves focus in on open,
 * keeps Tab inside while it is open, and returns focus to the control that
 * opened it. Same contract as `DetailDrawer`.
 *
 * All geometry comes from `.dialog-backdrop` / `.command-dialog` in the
 * vendored `components.css`. Nothing is restyled here.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /**
     * Widens the card past the kit's 620px.
     *
     * A create form with two columns of fields does not fit the default, and
     * the kit's own "Add SMSC" dialog is a two-column grid. Opt-in, so a simple
     * confirm stays the size it was designed at.
     */
    wide?: boolean;
    testid?: string;
  }>(),
  { wide: false, testid: 'modal-dialog' },
);

const emit = defineEmits<{ close: [] }>();

const card = ref<HTMLElement | null>(null);
/** The element that had focus when the dialog opened, to hand it back. */
let opener: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  if (!card.value) return [];
  const all = [...card.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  // `offsetParent` skips a field inside a collapsed `v-if` branch — a create
  // form shows different fields per record kind and the trap must not cycle
  // through the ones that are not there. It is a LAYOUT property though, so an
  // environment that does no layout reports every element as hidden. Falling
  // back to the unfiltered list means "if we cannot tell what is visible, do
  // not refuse to focus anything", which is the safe direction: the failure of
  // the filter must not become the failure of the focus trap.
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
  // Wrap at both ends. Without this the dialog is a visual modal and a keyboard
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
      // The first control in the BODY, not the first focusable in the dialog.
      // The header's Close button comes first in document order, so focusing
      // `focusables()[0]` put the caret on Close — and Enter, the most natural
      // key to press on an opening form, would have thrown the form away. The
      // Tab cycle still includes Close; only where focus lands changes.
      const body = card.value?.querySelector<HTMLElement>('.dialog-body');
      const firstField = body?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      (firstField ?? focusables()[0] ?? card.value)?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown);
      opener?.focus?.();
      opener = null;
    }
  },
  // `immediate`, because a dialog can be mounted ALREADY open — behind a
  // `v-if`, or restored from a deep link. Without it the watcher never fires
  // for that first render, so Escape does nothing and focus never enters: a
  // dialog that looks right and traps nothing. Every current caller mounts it
  // closed and flips the prop, which is exactly why this would not have been
  // noticed.
  { immediate: true },
);

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" :data-testid="testid" @click.self="emit('close')">
      <div
        ref="card"
        class="command-dialog"
        :class="{ 'dialog-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header>
          <h2>{{ title }}</h2>
          <button
            class="secondary-button"
            type="button"
            :data-testid="`${testid}-close`"
            @click="emit('close')"
          >
            Close
          </button>
        </header>
        <div class="dialog-body"><slot /></div>
        <div v-if="$slots.footer" class="dialog-foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* The kit's card is sized for a single column of fields. A create form laid out
   as a two-column grid — which is how the kit's own Add SMSC dialog is built —
   needs the width, and wraps into unreadability without it. */
.command-dialog.dialog-wide {
  width: min(900px, calc(100vw - 30px));
}
</style>
