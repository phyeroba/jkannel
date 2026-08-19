<script setup lang="ts">
/**
 * A macOS-style terminal window for code and payload samples.
 *
 * WHY IT IS ALWAYS DARK
 * ---------------------------------------------------------------------------
 * Every other surface in this console follows the viewer's theme. This one does
 * not, deliberately. A code sample is a quotation from somewhere else — a
 * terminal, an editor — and keeping it visually separate from the application
 * chrome is what stops a reader mistaking sample data for live data. The window
 * furniture (the three dots, the title strip) says "this is a transcript" before
 * a single word is read. Holding one palette also means the syntax colours only
 * ever have to be legible against one background, instead of two.
 *
 * WHY THE COPY BUTTON REPORTS FAILURE
 * ---------------------------------------------------------------------------
 * `navigator.clipboard` is unavailable on insecure origins and can be denied by
 * permission policy. A copy button that silently does nothing is worse than no
 * button: the reader pastes whatever was in the clipboard before. So a failed
 * write says so, and the text stays selectable as the fallback.
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Window title, shown centred in the title strip. */
    title: string;
    code: string;
    /** Adds a status pill to the right of the title, e.g. `201 Created`. */
    badge?: string;
    /** Colours that pill. */
    badgeTone?: 'good' | 'warn' | 'bad' | 'muted';
    /** Turns off the shell-prompt gutter for payloads that are not commands. */
    prompt?: boolean;
  }>(),
  { badge: '', badgeTone: 'muted', prompt: false },
);

const copied = ref<'idle' | 'done' | 'failed'>('idle');

const lines = computed(() => props.code.split('\n'));

async function copy() {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = 'done';
  } catch {
    copied.value = 'failed';
  }
  window.setTimeout(() => {
    copied.value = 'idle';
  }, 2200);
}
</script>

<template>
  <figure class="code-console" data-testid="code-console">
    <figcaption class="console-bar">
      <!-- Decorative window furniture: aria-hidden so a screen reader is not
           read three meaningless bullets before every sample. -->
      <span class="console-lights" aria-hidden="true">
        <i class="light red"></i><i class="light amber"></i><i class="light green"></i>
      </span>
      <span class="console-title">
        {{ title }}
        <span v-if="badge" class="console-badge" :class="badgeTone">{{ badge }}</span>
      </span>
      <button
        type="button"
        class="console-copy"
        data-testid="code-console-copy"
        :aria-label="`Copy ${title} to the clipboard`"
        @click="copy"
      >
        {{ copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy blocked' : 'Copy' }}
      </button>
    </figcaption>
    <pre class="console-body" :class="{ 'with-prompt': prompt }"><code><span
      v-for="(line, index) in lines"
      :key="index"
      class="console-line"
    >{{ line }}
</span></code></pre>
  </figure>
</template>

<style scoped>
.code-console {
  margin: 10px 0 0;
  border-radius: 12px;
  overflow: hidden;
  background: #14161f;
  border: 1px solid #262a38;
  /* Deeper than the panel shadow: the window should read as sitting on top of
     the page rather than being part of it. */
  box-shadow: 0 10px 30px rgba(4, 6, 14, 0.35);
}
.console-bar {
  display: grid;
  grid-template-columns: 56px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: linear-gradient(#2b3040, #232735);
  border-bottom: 1px solid #12141c;
}
.console-lights {
  display: inline-flex;
  gap: 7px;
}
.light {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  display: inline-block;
}
.red {
  background: #ff5f57;
}
.amber {
  background: #febc2e;
}
.green {
  background: #28c840;
}
.console-title {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  color: #cfd3e1;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.console-badge {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 10.5px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.console-badge.good {
  color: #4ade80;
}
.console-badge.warn {
  color: #fbbf24;
}
.console-badge.bad {
  color: #f87171;
}
.console-badge.muted {
  color: #9aa1b7;
}
.console-copy {
  border: 1px solid #3a4054;
  background: #1b1f2b;
  color: #cfd3e1;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  min-height: 24px;
}
.console-copy:hover {
  background: #232838;
  color: #fff;
}
.console-copy:focus-visible {
  outline: 2px solid #6c8cff;
  outline-offset: 1px;
}
.console-body {
  margin: 0;
  padding: 14px 16px;
  /* Long URLs and JWTs must scroll, not wrap: a wrapped cURL line reads as two
     commands, and a wrapped token cannot be selected cleanly. */
  overflow-x: auto;
  background: #14161f;
  color: #d7dbe8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.65;
  tab-size: 2;
}
.console-line {
  display: block;
  white-space: pre;
}
/* The shell gutter marks the first line as the command and the rest as its
   continuation, which is how a real terminal reads. */
.with-prompt .console-line:first-child::before {
  content: '$ ';
  color: #4ade80;
  font-weight: 700;
}
.with-prompt .console-line:not(:first-child)::before {
  content: '  ';
}
@media (prefers-reduced-motion: reduce) {
  .code-console {
    box-shadow: none;
  }
}
</style>
