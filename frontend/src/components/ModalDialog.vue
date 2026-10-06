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
     * One line under the title saying what the dialog is for.
     *
     * Added because every create form in this console opened with a bare noun
     * — "New carrier" — and then asked for a network code, an operational
     * status and a country, with the explanation crammed into the field labels
     * ("Name (required, up to 120 characters)"). The label should name the
     * field; the dialog should say what it is for; the hint under a control
     * should carry the rule.
     */
    subtitle?: string;
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
  { wide: false, subtitle: '', testid: 'modal-dialog' },
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
        <!--
          The close control is an icon, not a full secondary button.

          A 72px "Close" button sat level with the title and competed with it
          for the eye, and on a dialog whose footer already has Cancel it was
          the same action offered twice at equal weight. The icon keeps the
          affordance, gives the title the header, and leaves Cancel as the one
          worded way out. It keeps its accessible name.
        -->
        <header class="dialog-head">
          <div class="dialog-heading">
            <h2>{{ title }}</h2>
            <p v-if="subtitle" class="dialog-subtitle">{{ subtitle }}</p>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label="Close"
            :data-testid="`${testid}-close`"
            @click="emit('close')"
          >
            <span aria-hidden="true">×</span>
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

.dialog-head {
  align-items: flex-start;
}
.dialog-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dialog-subtitle {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.45;
  max-width: 62ch;
}
.dialog-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-md, 8px);
  background: none;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.dialog-close:hover {
  background: var(--surface-2);
  color: var(--text-strong);
}
.dialog-close:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

/* A long form must scroll its BODY, not the whole card: the footer holds the
   only way to commit, and pushing it off-screen is how a dialog ends up with an
   invisible Save. `.dialog-body` already scrolls in the kit; this pins the
   header and footer either side of it. */
.command-dialog {
  display: flex;
  flex-direction: column;
  /*
   * THE CAP HAS TO ALLOW FOR THE BACKDROP'S OWN PADDING.
   *
   * `.dialog-backdrop` places dialogs at `12vh` from the top — a deliberate
   * choice, so a short dialog sits where the eye already is. The card was
   * then capped at `100vh - 60px`, which on a 1000px viewport is 120px of
   * padding plus a 940px card: 60px past the bottom edge, and what fell off
   * was the footer. Every dialog tall enough to need the cap had its commit
   * row clipped by exactly the padding above it.
   *
   * 12vh above, 24px of backdrop padding below, and 24px of air.
   */
  max-height: calc(88vh - 48px);
}
.dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.dialog-head,
.dialog-foot {
  flex-shrink: 0;
}
</style>
