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

/**
 * "34d ago", "9h ago", "3s ago" — the age of something, for a register row.
 *
 * The design asks rows to say how long ago an alert opened rather than when.
 * That is the question being asked: an operator triaging a list wants to know
 * which of these has been going on longest, and converting five ISO
 * timestamps into durations in their head is work the screen should have
 * done. The exact instant stays available, in the cell's `title`.
 *
 * Granularity drops as the value grows, because precision nobody uses is
 * noise: seconds under a minute, then minutes, hours, days. Nothing is
 * rounded up into a unit it has not reached — 23 hours is "23h ago", not
 * "1d ago" — so a row never claims to be older than it is.
 */
export function agoWhen(value: unknown, now: Date = new Date()): string {
  if (value === null || value === undefined || value === '') return '';
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  const seconds = Math.floor((now.getTime() - parsed.getTime()) / 1000);
  // A timestamp in the future is a clock disagreement, not an age. Saying
  // "-4s ago" at least shows what happened rather than hiding it as "0s".
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * "34d 18h", "13h 29m", "45s" — a span, for a duration column or a
 * median-time-to-resolve figure.
 *
 * Two units at most. "34d 18h 12m 6s" is a stopwatch reading; the question
 * the column answers is "how long has this been going on", and the second
 * unit is already below the noise of the first.
 */
export function spanOf(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
