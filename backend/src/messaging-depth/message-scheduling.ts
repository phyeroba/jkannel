import { BadRequestException } from '@nestjs/common';
import { parseInstant } from './message-filters';

/**
 * THE scheduling contract: "send later" and "give up after".
 *
 * ---------------------------------------------------------------------------
 * WHERE THE HOLD LIVES — JKANNEL, NOT THE CARRIER
 * ---------------------------------------------------------------------------
 * A future `scheduledAt` is held by JKANNEL and released into the normal send
 * path at the scheduled instant. See scheduled-send.service.ts for the
 * mechanism and migration 042 for the table. In short: a held message is a row
 * in `scheduled_messages` plus an `api_jobs` row of type
 * `message.scheduled.release` whose `next_attempt_at` IS the scheduled instant,
 * so the Wave-F queue's `FOR UPDATE SKIP LOCKED` claim releases it exactly
 * once, across any number of replicas, and entitlements are evaluated when the
 * message is actually sent rather than when it was scheduled.
 *
 * This file remains the single place that PARSES and VALIDATES a schedule, and
 * the single place that maps a schedule onto the engine's columns at submit
 * time. What changed is only that a future instant no longer reaches the engine
 * as a deferral: by the time the release happens, `scheduledAtMs` is in the
 * past and {@link deferredMinutesFor} collapses to 0 — send now.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT LEAVE IT TO THE ENGINE — the finding this design answers
 * ---------------------------------------------------------------------------
 * The engine path was verified against the SQLBox and Kannel sources rather
 * than assumed:
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
 * `deferred` is therefore a REQUEST TO THE CARRIER, not a hold. Nothing between
 * the console and the SMSC keeps the message back, and:
 *
 *   - Many carriers reject a submit_sm carrying schedule_delivery_time outright
 *     (Kannel's own documentation warns the parameter "is hated by the SMSC in
 *     99% of the cases"), so a scheduled send could FAIL where the same message
 *     sent immediately would succeed.
 *   - On the `smsc = fake` bind this deployment runs
 *     (infrastructure/kannel/kamex.conf) it does NOTHING at all:
 *     gw/smsc/smsc_fake.c contains no reference to `deferred` or `validity`, so
 *     the fake bearer delivers immediately.
 *
 * That is why "send later" is now held control-plane side. `validity` is a
 * different matter and is NOT reimplemented: real SMPP carriers do honour
 * validity_period, so it stays an engine concern and is written onto the
 * `send_sms` row of the eventual submission exactly as before.
 *
 * ---------------------------------------------------------------------------
 * TIME BASE
 * ---------------------------------------------------------------------------
 * Everything is stored and compared in UTC; the API accepts ISO 8601 with an
 * offset. Because sqlbox anchors any residual offset to ITS pickup time and not
 * to our insert time, {@link engineScheduleColumns} is still evaluated as late
 * as possible — at the moment of the `send_sms` INSERT — and never at
 * request-parse time. The offset is rounded UP so a message is never released
 * early.
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

// ---------------------------------------------------------------------------
// RELEASE POLICY
// ---------------------------------------------------------------------------

/**
 * How late a release may be and still go out.
 *
 * If the platform is down across a scheduled instant, catching up is usually
 * what the operator wants — a reminder released at 09:07 for a 09:00 schedule
 * is fine. Catching up WITHOUT A CEILING is not: an SMS that arrives three days
 * late can be worse than one that never arrives (a one-time code, a "your
 * delivery is arriving today", an event reminder for an event that has ended).
 *
 * Default: 120 minutes. Chosen to cover an ordinary restart, deploy or short
 * outage while still being inside the window where the message plausibly still
 * means what it said. Override with SCHEDULED_SEND_MAX_LATENESS_MINUTES; 0
 * disables catch-up entirely (anything not released within
 * {@link SCHEDULED_SEND_ON_TIME_GRACE_MS} expires).
 *
 * Beyond the ceiling the message is NOT delivered: it is marked `expired` with
 * the lateness recorded, which is a refusal an operator can see rather than a
 * stale delivery they cannot undo.
 */
export const DEFAULT_SCHEDULED_SEND_MAX_LATENESS_MINUTES = 120;

/**
 * Lateness under which a release is still "on time". One minute matches both
 * the worker's default tick and the minute truncation of a `datetime-local`
 * picker, so an ordinary release is never flagged as late.
 */
export const SCHEDULED_SEND_ON_TIME_GRACE_MS = 60_000;

/** The configured staleness ceiling in milliseconds. */
export function scheduledSendMaxLatenessMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const minutes =
    Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_SCHEDULE_MINUTES
      ? parsed
      : DEFAULT_SCHEDULED_SEND_MAX_LATENESS_MINUTES;
  return Math.round(minutes * 60_000);
}

/** What the release path decided to do about a missed window. */
export type MissedWindowVerdict =
  | { action: 'release'; late: false; latenessMs: number; ceilingMs: number }
  | { action: 'release'; late: true; latenessMs: number; ceilingMs: number }
  | { action: 'expire'; late: true; latenessMs: number; ceilingMs: number };

/**
 * The missed-window decision, isolated so it is testable without a database.
 *
 * `latenessMs` is clamped at 0: a release that runs a few milliseconds early
 * (clock skew between the claim and this check) is on time, not negatively
 * late.
 */
export function classifyMissedWindow(
  scheduledAtMs: number,
  now = Date.now(),
  ceilingMs = scheduledSendMaxLatenessMs(),
): MissedWindowVerdict {
  const latenessMs = Math.max(0, now - scheduledAtMs);
  if (latenessMs > ceilingMs && latenessMs > SCHEDULED_SEND_ON_TIME_GRACE_MS)
    return { action: 'expire', late: true, latenessMs, ceilingMs };
  if (latenessMs > SCHEDULED_SEND_ON_TIME_GRACE_MS)
    return { action: 'release', late: true, latenessMs, ceilingMs };
  return { action: 'release', late: false, latenessMs, ceilingMs };
}

/**
 * Does this schedule need to be HELD, or can it be sent straight away?
 *
 * The 60s grace is the same one {@link parseMessageSchedule} applies to a past
 * instant, and for the same reason: a `datetime-local` value the operator means
 * as "now" is up to 59 seconds stale by the time it arrives. Holding such a
 * message for zero seconds would turn an immediate send into a scheduled one
 * and change its response shape for no benefit.
 */
export function requiresHold(
  schedule: MessageSchedule | null | undefined,
  now = Date.now(),
): boolean {
  const at = schedule?.scheduledAtMs;
  return at !== null && at !== undefined && at > now + SCHEDULE_PAST_GRACE_MS;
}

/** Human-readable rendering for an audit reason / export header. */
export function describeSchedule(schedule: MessageSchedule): string | undefined {
  const parts: string[] = [];
  if (schedule.scheduledAtMs !== null)
    parts.push(`scheduledAt=${new Date(schedule.scheduledAtMs).toISOString()}`);
  if (schedule.validityMinutes !== null) parts.push(`validityMinutes=${schedule.validityMinutes}`);
  return parts.length ? parts.join(', ') : undefined;
}
