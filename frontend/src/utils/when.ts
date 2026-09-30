/**
 * Short, human timestamps for registers.
 *
 * A register cell that prints `2026-09-03T07:07:34.298Z` spends 246px on a
 * string nobody reads to the millisecond. On the alerts list that single
 * column was most of the reason the table ran past its panel, and the same
 * string appears in the lifecycle list, the incidents panel and the
 * notification inbox.
 *
 * The rule is: show what distinguishes this row from its neighbours, and drop
 * what does not. Seconds, milliseconds and the UTC offset never distinguish
 * anything on a screen that is also showing a duration; the year distinguishes
 * a row only when it is not the current one.
 *
 * The full value is still available — every caller that uses this puts the
 * original in a `title`, so hovering gives the exact instant back.
 */
export function shortWhen(value: unknown, now: Date = new Date()): string {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value);
  const parsed = new Date(raw);
  // Not a date at all — hand back what we were given rather than inventing
  // "Invalid Date", which is the one output that is worse than the raw string.
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: parsed.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
