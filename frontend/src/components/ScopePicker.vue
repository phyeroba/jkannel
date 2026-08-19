<script setup lang="ts">
/**
 * Gateway scope selection for an API key.
 *
 * WHY THIS REPLACED A TEXT BOX
 * ---------------------------------------------------------------------------
 * Scopes used to be a free-text, comma-separated field whose placeholder read
 * `messages.read, messages.send`. Neither of those is a scope this gateway
 * enforces — the vocabulary is `sms.send`, `sms.read`, `routing.read` and
 * `audit.read` (backend/src/api-gateway/gateway-scopes.ts). An operator who
 * followed the placeholder created a key that authenticated successfully and
 * was then refused by `PermissionsGuard` on every business route, which
 * presents as "the API key does not work" with nothing pointing at the cause.
 *
 * A typo could not be caught either: the two vocabularies are deliberately
 * separate — a key's scopes must never inherit the human console role
 * catalogue — so `messages.view` is a real console permission and a
 * meaningless key scope, and nothing in the old field could tell them apart.
 *
 * So the choice is now closed, and each option carries what it actually
 * permits, what it does NOT, and the routes it unlocks. Over-granting an API
 * key is a security decision made in a hurry; the cost of explaining it inline
 * is a few lines of copy.
 */
import { computed } from 'vue';
import { GATEWAY_SCOPES } from '../utils/gateway-scopes';

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [string[]] }>();

const selected = computed(() => new Set(props.modelValue));

function toggle(scope: string) {
  const next = new Set(props.modelValue);
  if (next.has(scope)) next.delete(scope);
  else next.add(scope);
  // Emitted in the catalogue's own order, so two keys with the same scopes
  // always serialise identically and a diff of two clients is readable.
  emit(
    'update:modelValue',
    GATEWAY_SCOPES.filter((option) => next.has(option.value)).map((option) => option.value),
  );
}

/** Granting everything to one key is worth saying out loud, not preventing. */
const allSelected = computed(() => props.modelValue.length === GATEWAY_SCOPES.length);
</script>

<template>
  <fieldset class="scope-picker" data-testid="scope-picker">
    <legend>Scopes</legend>
    <p class="scope-intro">
      A key is refused on any route it has no scope for, so grant the least that lets the client do
      its job. Scopes are not console permissions — the two vocabularies are deliberately separate,
      and a console permission code here would grant nothing.
    </p>

    <!-- Scrolls rather than growing: this list is short today and the panel
         should not change height when the catalogue grows. -->
    <div class="scope-list">
      <label
        v-for="option in GATEWAY_SCOPES"
        :key="option.value"
        class="scope-option"
        :class="{ 'scope-selected': selected.has(option.value) }"
        :data-testid="`scope-option-${option.value}`"
      >
        <input
          type="checkbox"
          :checked="selected.has(option.value)"
          :data-testid="`scope-checkbox-${option.value}`"
          @change="toggle(option.value)"
        />
        <span class="scope-text">
          <span class="scope-head">
            <strong>{{ option.label }}</strong>
            <code class="mono">{{ option.value }}</code>
          </span>
          <span class="scope-grants">{{ option.grants }}</span>
          <span class="scope-routes mono">{{ option.routes }}</span>
          <span v-if="option.caution" class="scope-caution">{{ option.caution }}</span>
        </span>
      </label>
    </div>

    <p v-if="allSelected" class="warn-notice" data-testid="scope-all-warning">
      This key would carry every scope the gateway has, including the ability to send at this
      customer’s expense. That is rarely what a single integration needs.
    </p>
    <p v-else-if="!modelValue.length" class="scope-empty" data-testid="scope-none">
      No scope selected. The key will authenticate and then be refused on every business route.
    </p>
  </fieldset>
</template>

<style scoped>
.scope-picker {
  border: 0;
  padding: 0;
  margin: 0 0 14px;
  min-width: 0;
}
.scope-picker legend {
  padding: 0;
  font-size: var(--fs-body-sm);
  font-weight: 500;
  color: var(--text-strong);
}
.scope-intro {
  margin: 4px 0 10px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
  max-width: 72ch;
}
.scope-list {
  display: grid;
  gap: 8px;
  /* Six rows' worth. Beyond that it scrolls, so adding a scope never pushes the
     submit button below the fold. */
  max-height: 340px;
  overflow-y: auto;
  padding: 2px;
}
.scope-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}
.scope-option:hover {
  border-color: var(--brand);
}
.scope-selected {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.scope-option input {
  margin-top: 2px;
}
.scope-text {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.scope-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.scope-head strong {
  color: var(--text-strong);
  font-size: 13.5px;
}
.scope-head code {
  font-size: 12px;
  color: var(--brand);
}
.scope-grants {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}
.scope-routes {
  font-size: 12px;
  color: var(--muted);
}
/* Amber, and always shown rather than revealed on hover: a caution the reader
   has to go looking for is a caution they will not read. */
.scope-caution {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
}
.scope-empty {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--muted);
}
</style>
