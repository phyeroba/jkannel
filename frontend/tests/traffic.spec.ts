import { describe, expect, it } from 'vitest';
import {
  describeCoverage,
  describeDrain,
  engineStatusTone,
  engineStatusWord,
  formatAge,
  formatDuration,
  formatShare,
  formatSignedRate,
  growthTone,
  rateAt,
} from '../src/utils/traffic';

const destination = (over: Record<string, unknown> = {}) => ({
  depth: 100,
  drainSeconds: 50,
  drainUnavailableReason: null as string | null,
  ...over,
});

/**
 * §7 / UC-QUE-01: "If egress is zero, drain time is displayed as unavailable
 * rather than infinity." The backend distinguishes four causes and this is the
 * only place the distinction can survive to the screen.
 */
describe('describeDrain — the reason is the answer', () => {
  it('renders drainUnavailableReason verbatim, whatever it says', () => {
    for (const reason of [
      'Nothing is leaving this queue, so it will not drain at the current rate.',
      'The engine restarted during this window, so the measured rate is not a reliable basis for an estimate.',
      'Throughput is varying too much across this window for a drain estimate to mean anything.',
      'Only one observation so far; a rate needs at least two to measure against.',
    ]) {
      const view = describeDrain(
        destination({ drainSeconds: null, drainUnavailableReason: reason }),
      );
      expect(view.text).toBe(reason);
      expect(view.estimated).toBe(false);
    }
  });

  it('never prints infinity, a bare zero or a blank when there is no estimate', () => {
    const view = describeDrain(
      destination({ drainSeconds: null, drainUnavailableReason: 'Nothing is leaving this queue.' }),
    );
    expect(view.text).not.toBe('');
    expect(view.text).not.toContain('∞');
    expect(view.text).not.toContain('Infinity');
    expect(view.text).not.toBe('0s');
  });

  it('says so when neither an estimate nor a reason came back', () => {
    const view = describeDrain(destination({ drainSeconds: null, drainUnavailableReason: null }));
    expect(view.estimated).toBe(false);
    expect(view.text).toContain('no reason');
  });

  it('prefers the reason even if a stale estimate is also present', () => {
    const view = describeDrain(
      destination({ drainSeconds: 42, drainUnavailableReason: 'The engine restarted.' }),
    );
    expect(view.text).toBe('The engine restarted.');
    expect(view.estimated).toBe(false);
  });

  it('reads an empty queue as "already empty", not as a zero-second drain', () => {
    const view = describeDrain(destination({ depth: 0, drainSeconds: 0 }));
    expect(view.text).toBe('already empty');
    expect(view.estimated).toBe(true);
  });

  it('gives an estimate when one exists, and blanks it in an untrustworthy state', () => {
    expect(describeDrain(destination()).text).toBe('about 50s');
    expect(describeDrain(destination(), 'loading').text).toBe('—');
    expect(describeDrain(destination(), 'error').estimated).toBe(false);
  });
});

describe('traffic formatters', () => {
  it('never renders a missing figure as a real zero', () => {
    expect(formatShare(null)).toBe('—');
    expect(formatShare(undefined)).toBe('—');
    expect(formatShare(0)).toBe('0.0%');
    expect(formatShare(0.5, 'loading')).toBe('—');
    expect(formatAge(null)).toBe('—');
    expect(formatAge(0)).toBe('under a second');
    expect(formatSignedRate(null)).toBe('—');
    expect(rateAt(undefined, 0)).toBeNull();
    expect(rateAt([1, 2, 3], 5)).toBeNull();
    expect(rateAt([1, 2, 3], 2)).toBe(3);
  });

  it('carries the sign on growth so a filling queue reads differently from a draining one', () => {
    expect(formatSignedRate(2.5)).toBe('+2.5/s');
    expect(formatSignedRate(-2.5)).toBe('−2.5/s');
    expect(formatSignedRate(0)).toBe('0/s');
    expect(growthTone(1)).toBe('warn');
    expect(growthTone(-1)).toBe('good');
    expect(growthTone(null)).toBe('muted');
  });

  it('rounds a sub-second duration up rather than to zero', () => {
    expect(formatDuration(0.4)).toBe('1s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3700)).toBe('1h 1m');
    expect(formatDuration(180_000)).toBe('2d 2h');
  });

  it('states bind health in words, never colour alone', () => {
    expect(engineStatusWord(null)).toBe('unknown');
    expect(engineStatusWord('dead')).toBe('dead');
    expect(engineStatusTone('online')).toBe('good');
    expect(engineStatusTone('re-connecting')).toBe('warn');
    expect(engineStatusTone('dead')).toBe('bad');
    expect(engineStatusTone('something-new')).toBe('muted');
  });

  it('reports how much of the window was actually observed', () => {
    expect(describeCoverage({ samples: 6, windowSeconds: 900, resetsDetected: 0 })).toBe(
      '6 sample(s) · over 15m 0s',
    );
    expect(describeCoverage({ samples: 4, windowSeconds: 600, resetsDetected: 2 })).toContain(
      '2 engine restart(s) discarded',
    );
  });
});
