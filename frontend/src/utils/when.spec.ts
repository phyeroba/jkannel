import { describe, expect, it } from 'vitest';
import { shortWhen } from './when';

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
