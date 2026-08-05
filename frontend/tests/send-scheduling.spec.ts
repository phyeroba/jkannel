import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULE_MINUTES,
  SCHEDULE_GRACE_MS,
  SCHEDULING_SUPPORTED,
  deferredMinutesFor,
  emptySchedule,
  localDateTimeNow,
  localDateTimeToIso,
  parseLocalDateTime,
  scheduleError,
  scheduledSendFields,
} from '../src/utils/send-scheduling';

/**
 * These mirror the rules `backend/src/messaging-depth/message-scheduling.ts`
 * enforces (`parseMessageSchedule`), so the console rejects locally exactly
 * what the API would reject with a 400.
 */

/** A `datetime-local` value for `offsetMs` from `base`, in the local zone. */
const localAt = (base: number, offsetMs: number) => localDateTimeNow(base + offsetMs);

describe('send scheduling', () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  const HOUR = 60 * 60 * 1000;

  it('is enabled: both send endpoints accept scheduledAt + validityMinutes', () => {
    expect(SCHEDULING_SUPPORTED).toBe(true);
    // Mirrors MAX_SCHEDULE_MINUTES in message-scheduling.ts.
    expect(MAX_SCHEDULE_MINUTES).toBe(365 * 24 * 60);
  });

  it('reads a datetime-local value in the operator’s own zone and sends UTC', () => {
    const value = localDateTimeNow(now);
    expect(parseLocalDateTime(value)).toBe(new Date(value).getTime());
    expect(localDateTimeToIso(value)).toBe(new Date(parseLocalDateTime(value)).toISOString());
    expect(localDateTimeToIso(value)).toMatch(/Z$/);
    expect(localDateTimeToIso('')).toBe('');
    expect(localDateTimeToIso('not a date')).toBe('');
  });

  it('formats the `min` attribute as a valid datetime-local value', () => {
    expect(localDateTimeNow(now)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('rounds the deferral UP, so rounding can only ever delay a message', () => {
    // 90 seconds ahead truncates to the minute in the picker, but the helper
    // never returns a fraction and never returns a negative.
    expect(deferredMinutesFor(localAt(now, 2 * HOUR), now)).toBe(120);
    expect(deferredMinutesFor(localAt(now, -HOUR), now)).toBe(0);
    expect(deferredMinutesFor('', now)).toBeNull();
  });

  it('requires a time before it will accept a Send later', () => {
    expect(scheduleError(emptySchedule(), now)).toBe('Choose the date and time to send.');
    expect(scheduleError({ sendAtLocal: 'tomorrow', validityMinutes: '' }, now)).toBe(
      'That is not a valid date and time.',
    );
  });

  it('rejects a past datetime before the request is made', () => {
    expect(scheduleError({ sendAtLocal: localAt(now, -HOUR), validityMinutes: '' }, now)).toMatch(
      /in the past/,
    );
  });

  it('accepts a future datetime, and "now" within the grace window', () => {
    expect(scheduleError({ sendAtLocal: localAt(now, HOUR), validityMinutes: '' }, now)).toBe('');
    // localDateTimeNow truncates to the minute, so "now" can read as up to 59s
    // in the past; the grace window is what keeps that from being an error.
    expect(SCHEDULE_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(scheduleError({ sendAtLocal: localDateTimeNow(now), validityMinutes: '' }, now)).toBe(
      '',
    );
  });

  it('rejects a send time more than 365 days ahead', () => {
    const tooFar = localAt(now, 400 * 24 * HOUR);
    expect(scheduleError({ sendAtLocal: tooFar, validityMinutes: '' }, now)).toMatch(
      /more than 365 days/,
    );
  });

  it('rejects a nonsensical validity period', () => {
    const at = localAt(now, HOUR);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '0' }, now)).toMatch(/at least 1/);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '-5' }, now)).toMatch(/at least 1/);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '1.5' }, now)).toMatch(/whole number/);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: 'soon' }, now)).toMatch(
      /whole number/,
    );
    expect(
      scheduleError({ sendAtLocal: at, validityMinutes: String(MAX_SCHEDULE_MINUTES + 1) }, now),
    ).toMatch(/at most/);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '' }, now)).toBe('');
  });

  it('rejects a validity that expires at or before the scheduled delivery', () => {
    // Two hours out is a 120 minute deferral; a 120 minute validity expires the
    // instant the message is due, so the API refuses it and so does this.
    const at = localAt(now, 2 * HOUR);
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '120' }, now)).toMatch(
      /must be longer than the 120 minute wait/,
    );
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '30' }, now)).toMatch(
      /must be longer than/,
    );
    expect(scheduleError({ sendAtLocal: at, validityMinutes: '121' }, now)).toBe('');
  });

  it('converts the draft to the API’s own field names', () => {
    const at = localAt(now, 2 * HOUR);
    expect(scheduledSendFields({ sendAtLocal: at, validityMinutes: '' })).toEqual({
      scheduledAt: localDateTimeToIso(at),
    });
    expect(scheduledSendFields({ sendAtLocal: at, validityMinutes: '240' })).toEqual({
      scheduledAt: localDateTimeToIso(at),
      validityMinutes: 240,
    });
  });
});
