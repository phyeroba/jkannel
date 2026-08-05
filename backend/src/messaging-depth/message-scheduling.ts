import { BadRequestException } from '@nestjs/common';
import { parseInstant } from './message-filters';

/**
 * THE scheduling contract: "send later" and "give up after".
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO JKANNEL-SIDE SCHEDULER
 * ---------------------------------------------------------------------------
 * Kannel already carries both concepts end to end, and duplicating them here
 * would mean two clocks, two retry stories and a spool JKANNEL has to babysit.
 * The engine path, verified against the SQLBox and Kannel sources rather than
 * assumed:
 *
 *   1. `send_sms.deferred` / `send_sms.validity` are bigint columns holding
 *      RELATIVE MINUTES. NULL means "not set".
 *   2. sqlbox reads the row and converts them to absolute instants at the
 *      moment it picks the row up (addons/sqlbox/gw/sqlbox.c, sql_to_bearerbox):
 *          msg->sms.validity = time(NULL) + msg->sms.validity * 60;
 *          msg->sms.deferred = time(NULL) + msg->sms.deferred * 60;
 *      SMS_PARAM_UNDEFINED (-1) — which is what a NULL column decodes to —
 *      is left alone, so an unset column is genuinely "no preference".
 *   3. The SMPP driver turns them into PDU fields (gw/smsc/smsc_smpp.c):
 *          deferred -> submit_sm.schedule_delivery_time
 *          validity -> submit_sm.validity_period
 *
 * ---------------------------------------------------------------------------
 * WHAT THAT DOES AND DOES NOT GUARANTEE — READ THIS BEFORE PROMISING A USER
 * ---------------------------------------------------------------------------
 * `deferred` is a REQUEST TO THE CARRIER, not a hold. Nothing between the
 * console and the SMSC keeps the message back: JKANNEL inserts it immediately,
 * sqlbox forwards it immediately, bearerbox submits it immediately, and the
 * SMSC is the only party that is asked to sit on it until
 * `schedule_delivery_time`. Therefore:
 *
 *   - On an SMPP bind whose carrier honours scheduled delivery, it works.
 *   - Many carriers reject a submit_sm carrying schedule_delivery_time outright
 *     (Kannel's own documentation warns the parameter "is hated by the SMSC in
 *     99% of the cases"). A scheduled send can therefore FAIL where the same
 *     message sent immediately would succeed. Confirm with the carrier first.
 *   - On the `smsc = fake` bind this deployment currently runs
 *     (infrastructure/kannel/kamex.conf), it does NOTHING. gw/smsc/smsc_fake.c
 *     contains no reference to `deferred` or `validity` at all: the fake bearer
 *     delivers the message at once. Scheduling against a fake bind is recorded
 *     faithfully in `send_sms` and then ignored by the bearer.
 *
 * The columns are written correctly and honestly; whether the message is
 * actually held is the bearer's decision, and on this stack today it is not.
 *
 * ---------------------------------------------------------------------------
 * TIME BASE
 * ---------------------------------------------------------------------------
 * Because sqlbox anchors the offset to ITS pickup time and not to our insert
 * time, the offset is computed as late as possible — at the moment of the
 * `send_sms` INSERT — and never at request-parse time. sqlbox drains the spool
 * in well under a second, so the residual skew is sub-minute; the offset is
 * rounded UP so a message is never released early.
 */

/** Kannel's SMS_PARAM_UNDEFINED. A NULL column decodes to this. */
export const SMS_PARAM_UNDEFINED = -1;

/**
 * Upper bound on both offsets: 365 days in minutes. The column is a bigint and
 * would take anything, but SMPP renders these as a two-digit year, and an
 * operator who typed an extra zero should get a 400 rather than a message the
 * carrier holds until 2098.
 */
export const MAX_SCHEDULE_MINUTES = 365 * 24 * 60;

/**
 * Tolerance on "is this in the past".
 *
 * A browser `datetime-local` picker truncates to the minute, so a time the
 * operator means as "now" arrives as up to 59 seconds ago, and the request
 * itself spends time in flight. Rejecting that would refuse a perfectly
 * sensible send over a rounding artefact. Anything inside the window resolves
 * to a 0-minute deferral — i.e. send immediately — which is exactly what the
 * operator asked for; anything outside it is a genuine mistake and is refused.
 */
export const SCHEDULE_PAST_GRACE_MS = 60_000;

export interface MessageSchedule {
  /**
   * Absolute instant the caller asked for delivery at, in epoch MILLISECONDS,
   * or null for "as soon as possible". Stored absolute (not as an offset) so a
   * campaign dispatched minutes after it was created still targets the instant
   * the operator picked.
   */
  scheduledAtMs: number | null;
  /** Relative validity period in minutes, or null for "the carrier's default". */
  validityMinutes: number | null;
}

/** The empty schedule: send now, no explicit validity. */
export const NO_SCHEDULE: MessageSchedule = { scheduledAtMs: null, validityMinutes: null };

/** The query/body parameters {@link parseMessageSchedule} reads. */
export const MESSAGE_SCHEDULE_PARAMS = ['scheduledAt', 'validityMinutes'] as const;

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== '';

/**
 * Minutes to defer a submission being made *now* so it lands at `scheduledAtMs`.
 * Rounded UP so rounding can only ever delay a message, never release it early;
 * a schedule that has already elapsed collapses to 0 (= send immediately)
 * rather than to a negative offset the engine would read as "expired".
 */
export function deferredMinutesFor(scheduledAtMs: number | null, now = Date.now()): number | null {
  if (scheduledAtMs === null) return null;
  return Math.max(0, Math.ceil((scheduledAtMs - now) / 60_000));
}

function parseValidityMinutes(value: unknown): number | null {
  if (!present(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SCHEDULE_MINUTES)
    throw new BadRequestException(
      `validityMinutes must be a whole number of minutes between 1 and ${MAX_SCHEDULE_MINUTES} (365 days); received "${String(value).trim()}"`,
    );
  return parsed;
}

/**
 * Parses and validates `scheduledAt` + `validityMinutes` from a request body or
 * query. Throws a 400 naming the exact problem; never returns a half-applied
 * schedule.
 *
 * `now` is injectable so the bulk path can validate a campaign against the same
 * instant it stamps the job with.
 */
export function parseMessageSchedule(source: any = {}, now = Date.now()): MessageSchedule {
  const input = source ?? {};
  const validityMinutes = parseValidityMinutes(input.validityMinutes);

  if (!present(input.scheduledAt)) return { scheduledAtMs: null, validityMinutes };

  // Same strict ISO 8601 parser the message filters use, so "2026-13-40" and
  // "next tuesday" are rejected here exactly as they are on a date range.
  const epochSeconds = parseInstant(input.scheduledAt, 'scheduledAt')!;
  const scheduledAtMs = epochSeconds * 1000;

  if (scheduledAtMs < now - SCHEDULE_PAST_GRACE_MS)
    throw new BadRequestException(
      `scheduledAt is in the past: ${new Date(scheduledAtMs).toISOString()} is before ${new Date(now).toISOString()}. ` +
        'Supply a future instant, or omit scheduledAt to send immediately.',
    );

  const deferred = deferredMinutesFor(scheduledAtMs, now)!;
  if (deferred > MAX_SCHEDULE_MINUTES)
    throw new BadRequestException(
      `scheduledAt is too far ahead: ${deferred} minutes exceeds the ${MAX_SCHEDULE_MINUTES} minute (365 day) maximum.`,
    );

  // Both offsets are anchored to the same submission instant, so a validity
  // that is not longer than the deferral describes a message which expires at
  // or before the moment it was supposed to be delivered — it could never
  // arrive. Refuse it instead of spooling a guaranteed-dead message.
  if (validityMinutes !== null && validityMinutes <= deferred)
    throw new BadRequestException(
      `validityMinutes (${validityMinutes}) must be greater than the ${deferred} minute wait until scheduledAt ` +
        `(${new Date(scheduledAtMs).toISOString()}); as given, the message would expire at or before its scheduled delivery time.`,
    );

  return { scheduledAtMs, validityMinutes };
}

/**
 * The engine-column pair for a submission being made now. `null` on either side
 * leaves the column NULL, which sqlbox decodes as SMS_PARAM_UNDEFINED.
 */
export interface EngineScheduleColumns {
  deferredMinutes: number | null;
  validityMinutes: number | null;
}

/** Resolves a schedule into the `send_sms` column values, as of `now`. */
export function engineScheduleColumns(
  schedule: MessageSchedule | null | undefined,
  now = Date.now(),
): EngineScheduleColumns {
  return {
    deferredMinutes: deferredMinutesFor(schedule?.scheduledAtMs ?? null, now),
    validityMinutes: schedule?.validityMinutes ?? null,
  };
}

/** Human-readable rendering for an audit reason / export header. */
export function describeSchedule(schedule: MessageSchedule): string | undefined {
  const parts: string[] = [];
  if (schedule.scheduledAtMs !== null)
    parts.push(`scheduledAt=${new Date(schedule.scheduledAtMs).toISOString()}`);
  if (schedule.validityMinutes !== null) parts.push(`validityMinutes=${schedule.validityMinutes}`);
  return parts.length ? parts.join(', ') : undefined;
}
