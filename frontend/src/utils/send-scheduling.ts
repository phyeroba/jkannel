/**
 * Send now / send later for the two message composers.
 *
 * THE CONTRACT, as implemented by
 * `backend/src/messaging-depth/message-scheduling.ts` (`parseMessageSchedule`)
 * and accepted verbatim on both send paths:
 *
 *   POST /api/v1/messages    — console.controllers.ts `ReadModelsController.submit`
 *   POST /api/v1/bulk-send   — messaging-depth/bulk-send.controller.ts `create`
 *
 *   scheduledAt      ISO 8601 instant, must be in the future
 *   validityMinutes  whole minutes, 1 … MAX_SCHEDULE_MINUTES, and strictly
 *                    GREATER than the wait until `scheduledAt` — otherwise the
 *                    message would expire at or before the moment it was meant
 *                    to be delivered, and the API rejects it with a 400.
 *
 * Both map onto the engine's own `send_sms.deferred` / `send_sms.validity`
 * columns (relative minutes). JKANNEL runs no scheduler of its own.
 *
 * Every rule below is enforced server-side as well; it is duplicated here only
 * so an obviously-wrong schedule is caught before the round trip. When the two
 * disagree, the API's 400 is what the operator is shown, verbatim.
 */

/** The API accepts a schedule on both composers' endpoints. */
export const SCHEDULING_SUPPORTED = true;

/** `MAX_SCHEDULE_MINUTES` in message-scheduling.ts: 365 days. */
export const MAX_SCHEDULE_MINUTES = 365 * 24 * 60;

/**
 * What deferral actually buys, stated plainly — the backend module is explicit
 * that this is a request to the carrier and not a hold, and that the `fake`
 * bind ignores it. Promising an operator otherwise would be the dishonest part.
 */
export const SCHEDULING_CAVEAT =
  'Deferred delivery is a request to the carrier (SMPP schedule_delivery_time), not a hold: ' +
  'JKANNEL submits the message immediately and the SMSC decides whether to sit on it. Some ' +
  'carriers reject a scheduled submit outright, and a `fake` bind ignores the schedule and ' +
  'delivers at once. Confirm with the carrier before relying on it.';

export interface ScheduleDraft {
  /** `datetime-local` value, i.e. wall-clock time in the operator's zone. */
  sendAtLocal: string;
  /** Optional validity period in minutes; '' means "the carrier's default". */
  validityMinutes: string;
}

export function emptySchedule(): ScheduleDraft {
  return { sendAtLocal: '', validityMinutes: '' };
}

/**
 * `datetime-local` → epoch milliseconds. The browser gives back a zone-less
 * wall-clock string ("2026-08-09T14:30"); `Date` parses that in the LOCAL zone,
 * which is exactly what the operator meant.
 */
export function parseLocalDateTime(value: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

/** The same instant as an ISO 8601 UTC string, which is what the API takes. */
export function localDateTimeToIso(value: string): string {
  const epoch = parseLocalDateTime(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : '';
}

/**
 * Grace window on "is this in the past". `datetime-local` truncates to the
 * minute, so a time the operator picks as "now" can read as up to 59 seconds
 * ago; rejecting that would be wrong. The API applies its own past check
 * against the instant it receives, which is the authoritative one.
 */
export const SCHEDULE_GRACE_MS = 60_000;

/**
 * Minutes the engine will be asked to defer by, matching
 * `deferredMinutesFor()`: rounded UP so rounding can only ever delay a message.
 */
export function deferredMinutesFor(sendAtLocal: string, now: number = Date.now()): number | null {
  const epoch = parseLocalDateTime(sendAtLocal);
  if (!Number.isFinite(epoch)) return null;
  return Math.max(0, Math.ceil((epoch - now) / 60_000));
}

export function scheduleError(draft: ScheduleDraft, now: number = Date.now()): string {
  if (!draft.sendAtLocal.trim()) return 'Choose the date and time to send.';
  const epoch = parseLocalDateTime(draft.sendAtLocal);
  if (!Number.isFinite(epoch)) return 'That is not a valid date and time.';
  if (epoch < now - SCHEDULE_GRACE_MS)
    return 'The send time is in the past. Choose a future time, or switch to Send now.';

  const deferred = deferredMinutesFor(draft.sendAtLocal, now) ?? 0;
  if (deferred > MAX_SCHEDULE_MINUTES)
    return `The send time is more than 365 days ahead (${deferred} minutes). Choose a nearer time.`;

  if (draft.validityMinutes.trim()) {
    const validity = Number(draft.validityMinutes);
    if (!Number.isInteger(validity) || validity < 1)
      return 'Validity must be a whole number of minutes, at least 1.';
    if (validity > MAX_SCHEDULE_MINUTES)
      return `Validity must be at most ${MAX_SCHEDULE_MINUTES} minutes (365 days).`;
    // Both offsets are anchored to the same submission instant, so a validity
    // no longer than the wait describes a message that expires before it is due.
    if (validity <= deferred)
      return `Validity must be longer than the ${deferred} minute wait until the send time, or the message expires before it is delivered.`;
  }
  return '';
}

/** The request fields for a scheduled send, exactly as the API names them. */
export function scheduledSendFields(draft: ScheduleDraft): Record<string, unknown> {
  const fields: Record<string, unknown> = { scheduledAt: localDateTimeToIso(draft.sendAtLocal) };
  if (draft.validityMinutes.trim()) fields.validityMinutes = Number(draft.validityMinutes);
  return fields;
}

/** `datetime-local`'s `min` attribute: now, in local wall-clock form. */
export function localDateTimeNow(now: number = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
