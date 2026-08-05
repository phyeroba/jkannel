import { BadRequestException } from '@nestjs/common';
import {
  MAX_SCHEDULE_MINUTES,
  deferredMinutesFor,
  describeSchedule,
  engineScheduleColumns,
  parseMessageSchedule,
} from './message-scheduling';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

describe('parseMessageSchedule', () => {
  it('treats an absent schedule as "send now, carrier default validity"', () => {
    expect(parseMessageSchedule({}, NOW)).toEqual({ scheduledAtMs: null, validityMinutes: null });
    expect(parseMessageSchedule(undefined, NOW)).toEqual({
      scheduledAtMs: null,
      validityMinutes: null,
    });
    expect(parseMessageSchedule({ scheduledAt: '', validityMinutes: '' }, NOW)).toEqual({
      scheduledAtMs: null,
      validityMinutes: null,
    });
  });

  it('accepts a future ISO 8601 instant', () => {
    expect(parseMessageSchedule({ scheduledAt: at(90) }, NOW)).toEqual({
      scheduledAtMs: NOW + 90 * 60_000,
      validityMinutes: null,
    });
  });

  it('rejects a scheduled time in the past, naming the problem', () => {
    expect(() => parseMessageSchedule({ scheduledAt: at(-2) }, NOW)).toThrow(BadRequestException);
    try {
      parseMessageSchedule({ scheduledAt: at(-60) }, NOW);
      throw new Error('should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).toContain('scheduledAt is in the past');
      // Both instants are named so the caller can see the clock it was judged against.
      expect(String((error as Error).message)).toContain('2026-08-05T11:00:00.000Z');
      expect(String((error as Error).message)).toContain('2026-08-05T12:00:00.000Z');
    }
  });

  it('tolerates the minute-truncation of a date-time picker, and sends immediately', () => {
    // `datetime-local` truncates to the minute, so "now" can arrive as up to 59
    // seconds ago. That is a rounding artefact, not a mistake.
    const almostNow = new Date(NOW - 45_000).toISOString();
    const schedule = parseMessageSchedule({ scheduledAt: almostNow }, NOW);
    expect(deferredMinutesFor(schedule.scheduledAtMs, NOW)).toBe(0);
    // ... but a minute and a half ago is a real error.
    expect(() =>
      parseMessageSchedule({ scheduledAt: new Date(NOW - 90_000).toISOString() }, NOW),
    ).toThrow(BadRequestException);
  });

  it('rejects a validity that would expire before the scheduled time', () => {
    // Delivery in 120 minutes, give up after 60: the message could never arrive.
    expect(() => parseMessageSchedule({ scheduledAt: at(120), validityMinutes: 60 }, NOW)).toThrow(
      BadRequestException,
    );
    try {
      parseMessageSchedule({ scheduledAt: at(120), validityMinutes: 60 }, NOW);
      throw new Error('should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).toContain('would expire at or before');
    }
  });

  it('rejects a validity that expires exactly at the scheduled time', () => {
    // A zero-width delivery window is as dead as a negative one.
    expect(() => parseMessageSchedule({ scheduledAt: at(120), validityMinutes: 120 }, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('accepts a validity that outlives the schedule', () => {
    expect(parseMessageSchedule({ scheduledAt: at(120), validityMinutes: 121 }, NOW)).toEqual({
      scheduledAtMs: NOW + 120 * 60_000,
      validityMinutes: 121,
    });
  });

  it('accepts a validity on its own, with no schedule', () => {
    expect(parseMessageSchedule({ validityMinutes: 30 }, NOW)).toEqual({
      scheduledAtMs: null,
      validityMinutes: 30,
    });
  });

  it('bounds validityMinutes to a whole number of minutes inside a year', () => {
    for (const bad of [0, -5, 1.5, MAX_SCHEDULE_MINUTES + 1, 'soon'])
      expect(() => parseMessageSchedule({ validityMinutes: bad }, NOW)).toThrow(
        BadRequestException,
      );
    expect(
      parseMessageSchedule({ validityMinutes: MAX_SCHEDULE_MINUTES }, NOW).validityMinutes,
    ).toBe(MAX_SCHEDULE_MINUTES);
  });

  it('rejects a schedule more than a year out', () => {
    expect(() => parseMessageSchedule({ scheduledAt: at(MAX_SCHEDULE_MINUTES + 10) }, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-ISO scheduledAt rather than guessing at it', () => {
    for (const bad of ['next tuesday', '2026/08/05', '2026-02-31T00:00:00Z', 5])
      expect(() => parseMessageSchedule({ scheduledAt: bad }, NOW)).toThrow(BadRequestException);
  });
});

describe('deferredMinutesFor', () => {
  it('is null when nothing was scheduled — NULL, not 0', () => {
    // 0 is a real value ("no delay"); NULL is "the caller expressed no
    // preference", which is what sqlbox reads as SMS_PARAM_UNDEFINED.
    expect(deferredMinutesFor(null, NOW)).toBeNull();
  });

  it('rounds UP so rounding can only ever delay, never release early', () => {
    expect(deferredMinutesFor(NOW + 61_000, NOW)).toBe(2);
    expect(deferredMinutesFor(NOW + 60_000, NOW)).toBe(1);
    expect(deferredMinutesFor(NOW + 1, NOW)).toBe(1);
  });

  it('collapses an elapsed schedule to 0 rather than to a negative offset', () => {
    // A negative `deferred` would be read by the engine as an instant in the
    // past; 0 means "now", which is what an elapsed schedule means.
    expect(deferredMinutesFor(NOW - 10 * 60_000, NOW)).toBe(0);
  });
});

describe('engineScheduleColumns', () => {
  it('resolves the schedule against the submission instant, not the parse instant', () => {
    const schedule = parseMessageSchedule({ scheduledAt: at(60), validityMinutes: 180 }, NOW);
    // Parsed at NOW, submitted 45 minutes later: only 15 minutes of wait remain.
    expect(engineScheduleColumns(schedule, NOW + 45 * 60_000)).toEqual({
      deferredMinutes: 15,
      validityMinutes: 180,
    });
  });

  it('writes nulls for an absent schedule', () => {
    expect(engineScheduleColumns(null)).toEqual({ deferredMinutes: null, validityMinutes: null });
    expect(engineScheduleColumns(undefined)).toEqual({
      deferredMinutes: null,
      validityMinutes: null,
    });
  });
});

describe('describeSchedule', () => {
  it('renders only what was actually set', () => {
    expect(describeSchedule({ scheduledAtMs: null, validityMinutes: null })).toBeUndefined();
    expect(describeSchedule({ scheduledAtMs: NOW, validityMinutes: 30 })).toBe(
      'scheduledAt=2026-08-05T12:00:00.000Z, validityMinutes=30',
    );
  });
});
