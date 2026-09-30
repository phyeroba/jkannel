import { describe, expect, it } from 'vitest';
import { agoWhen, shortWhen, spanOf } from './when';

describe('shortWhen', () => {
  const now = new Date('2026-09-30T12:00:00Z');

  it('drops the year for a timestamp in the current year', () => {
    const out = shortWhen('2026-09-03T07:07:34.298Z', now);
    expect(out).toContain('Sep');
    expect(out).not.toContain('2026');
  });

  // A carried-over incident must not read as one from this week.
  //
  // Mid-year on purpose. The first draft of this test used 31 Dec 2025 23:59Z,
  // which is 1 Jan 2026 in a UTC+3 local zone — so the helper correctly called
  // it the current year and the test was wrong, not the code. A date that
  // cannot cross the boundary in any zone tests the rule instead of the zone.
  it('keeps the year for a timestamp from another year', () => {
    expect(shortWhen('2025-06-15T12:00:00Z', now)).toContain('2025');
  });

  it('is much shorter than the ISO string it replaces', () => {
    const iso = '2026-09-03T07:07:34.298Z';
    expect(shortWhen(iso, now).length).toBeLessThan(iso.length - 6);
  });

  // "Invalid Date" is the one output worse than the raw string.
  it('hands back an unparseable value unchanged', () => {
    expect(shortWhen('not a date', now)).toBe('not a date');
  });

  it.each([null, undefined, ''])('renders %s as empty, not as a date', (value) => {
    expect(shortWhen(value, now)).toBe('');
  });
});

describe('agoWhen', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it.each([
    [3 * 1000, '3s ago'],
    [9 * 60 * 1000, '9m ago'],
    [9 * 3600 * 1000, '9h ago'],
    [34 * 86400 * 1000, '34d ago'],
  ])('renders %sms as %s', (ms, expected) => {
    expect(agoWhen(ago(ms), now)).toBe(expected);
  });

  // A row must never claim to be older than it is.
  it('does not round 23 hours up to a day', () => {
    expect(agoWhen(ago(23 * 3600 * 1000), now)).toBe('23h ago');
  });

  // A future timestamp is a clock disagreement, not a negative age.
  it('reads a future timestamp as "just now" rather than a negative age', () => {
    expect(agoWhen(new Date(now.getTime() + 5000).toISOString(), now)).toBe('just now');
  });

  it.each([null, undefined, ''])('renders %s as empty', (value) => {
    expect(agoWhen(value, now)).toBe('');
  });
});

describe('spanOf', () => {
  it.each([
    [45, '45s'],
    [9 * 60, '9m'],
    [13 * 3600 + 29 * 60, '13h 29m'],
    [34 * 86400 + 18 * 3600, '34d 18h'],
  ])('renders %ss as %s', (seconds, expected) => {
    expect(spanOf(seconds)).toBe(expected);
  });

  // null means "nothing has resolved yet", which is not the same as "0m".
  it.each([null, undefined, Number.NaN])('renders %s as empty, not as zero', (value) => {
    expect(spanOf(value as number | null)).toBe('');
  });
});
