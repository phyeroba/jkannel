<script setup lang="ts">
/**
 * The pager every long table on this console should use.
 *
 * WHY A COMPONENT AND NOT ANOTHER COPY
 * ---------------------------------------------------------------------------
 * Before this there were two hand-rolled pagers — `.pager` in ModuleWorkspace
 * and `.cursor-pager` in Live Queue — and everything else had none. That is not
 * only duplication: an audit looking for `.cursor-pager` reported ModuleWorkspace's
 * screens as unpaginated and sent a whole night's work at tables that page
 * perfectly well. One component means one thing to look for, one place to fix,
 * and one shape for an operator to learn.
 *
 * IT SUPPORTS BOTH PAGING MODELS, BECAUSE THE BACKEND HAS BOTH
 * ---------------------------------------------------------------------------
 *   offset  a `total` is known, so "1–50 of 312" and a page number are real.
 *   cursor  forward-only keyset; there is NO total, and claiming one would be
 *           a lie. It shows the page number it can actually count — how many
 *           pages you have walked — and nothing more.
 *
 * Passing `total` picks offset mode. Passing `hasNext` picks cursor mode. The
 * component refuses to invent a total it was not given, which is the whole
 * reason the two modes are distinguished rather than blurred.
 */
const props = withDefaults(
  defineProps<{
    /** Rows on the page now. */
    shown: number;
    /** Total matching rows. Omit for a keyset/cursor list, which has none. */
    total?: number | null;
    /** Zero-based offset. Offset mode only. */
    offset?: number;
    /** Rows per page. */
    pageSize?: number;
    /** Cursor mode: is there another page? */
    hasNext?: boolean;
    /** Cursor mode: how many pages have been walked (1-based). */
    page?: number;
    /** Disables both buttons, e.g. while a fetch is in flight. */
    busy?: boolean;
    /** What the rows are, for the range label: "12 alerts". */
    noun?: string;
    testid?: string;
  }>(),
  {
    total: null,
    offset: 0,
    pageSize: 50,
    hasNext: false,
    page: 1,
    busy: false,
    noun: 'row',
    testid: 'table-pager',
  },
);

const emit = defineEmits<{ turn: [direction: number] }>();

const cursorMode = () => props.total === null || props.total === undefined;

/** True when there is genuinely nothing before this page. */
function atStart() {
  return cursorMode() ? props.page <= 1 : props.offset <= 0;
}
function atEnd() {
  if (cursorMode()) return !props.hasNext;
  return props.offset + props.shown >= (props.total ?? 0);
}

/**
 * The label. Deliberately different per mode: an offset list can say where it
 * is in the whole, a keyset list genuinely cannot, and a pager that says
 * "1–50 of 50" on every page of a long list is worse than one that says
 * nothing — it tells the operator they have reached the end when they have not.
 */
function label() {
  const plural = props.shown === 1 ? props.noun : `${props.noun}s`;
  if (cursorMode())
    return props.shown
      ? `Page ${props.page} · ${props.shown} ${plural}`
      : `Page ${props.page} · nothing on this page`;
  const total = props.total ?? 0;
  if (!total) return `No ${props.noun}s`;
  const first = props.offset + 1;
  const last = props.offset + props.shown;
  return `${first}–${last} of ${total} ${plural}`;
}
</script>

<template>
  <footer class="table-pager" :data-testid="testid">
    <span class="source-note" :data-testid="`${testid}-range`">{{ label() }}</span>
    <div class="table-pager-buttons">
      <button
        type="button"
        class="secondary-button"
        :data-testid="`${testid}-prev`"
        :disabled="busy || atStart()"
        @click="emit('turn', -1)"
      >
        Previous
      </button>
      <button
        type="button"
        class="secondary-button"
        :data-testid="`${testid}-next`"
        :disabled="busy || atEnd()"
        @click="emit('turn', 1)"
      >
        Next
      </button>
    </div>
  </footer>
</template>
