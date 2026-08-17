import { describe, expect, it } from 'vitest';
import {
  bindWord,
  formatCeiling,
  formatRate,
  formatUtilisation,
  healthExplanation,
  mapWithConcurrency,
  utilisationTone,
} from '../src/utils/connectivity';

describe('formatUtilisation', () => {
  it('says the word "unknown" rather than a plausible percentage', () => {
    // The whole point: 0% reads as "idle" and 100% as "saturated", and both are
    // assertions about traffic nobody measured.
    expect(formatUtilisation(null)).toBe('unknown');
    expect(formatUtilisation(undefined)).toBe('unknown');
    expect(formatUtilisation(Number.NaN)).toBe('unknown');
  });

  it('renders a measured ratio as a percentage', () => {
    expect(formatUtilisation(0)).toBe('0%');
    expect(formatUtilisation(0.204)).toBe('20%');
    expect(formatUtilisation(1)).toBe('100%');
    expect(formatUtilisation(1.4)).toBe('140%');
  });

  it('falls back to an em dash while the figure is untrustworthy', () => {
    // During `loading` there is no reading at all — not even an unknown one.
    expect(formatUtilisation(0.5, 'loading')).toBe('—');
    expect(formatUtilisation(0.5, 'error')).toBe('—');
    expect(formatUtilisation(0.5, 'permission-denied')).toBe('—');
    // Stale and partial have a real measurement behind them.
    expect(formatUtilisation(0.5, 'stale')).toBe('50%');
    expect(formatUtilisation(0.5, 'partial')).toBe('50%');
  });
});

describe('utilisationTone', () => {
  it('never calls an unmeasured utilisation good', () => {
    expect(utilisationTone(null)).toBe('muted');
    expect(utilisationTone(0.5)).toBe('good');
    expect(utilisationTone(0.85)).toBe('warn');
    expect(utilisationTone(1.1)).toBe('bad');
  });
});

describe('formatCeiling', () => {
  it('spells out the per-connection multiplication when there is more than one', () => {
    expect(
      formatCeiling({
        perConnectionTps: 50,
        connections: 3,
        effectiveTps: 150,
        observedTps: null,
        utilisation: null,
        note: '',
      }),
    ).toBe('150/s (50/s × 3 connections)');
  });

  it('keeps a single connection simple, and says when nothing is configured', () => {
    expect(
      formatCeiling({
        perConnectionTps: 50,
        connections: 1,
        effectiveTps: 50,
        observedTps: null,
        utilisation: null,
        note: '',
      }),
    ).toBe('50/s');
    expect(
      formatCeiling({
        perConnectionTps: null,
        connections: 1,
        effectiveTps: null,
        observedTps: null,
        utilisation: null,
        note: '',
      }),
    ).toBe('no ceiling configured');
    expect(formatCeiling(null)).toBe('no ceiling configured');
  });
});

describe('formatRate', () => {
  it('distinguishes a measured zero from an absent reading', () => {
    expect(formatRate(0)).toBe('0/s');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0, 'loading')).toBe('—');
  });
});

describe('bindWord', () => {
  it('reports an unobserved bind as unobserved, not as disconnected', () => {
    expect(bindWord(null)).toBe('never observed');
    expect(bindWord('')).toBe('never observed');
    expect(bindWord('disconnected')).toBe('disconnected');
    expect(bindWord('bound')).toBe('bound');
  });
});

describe('healthExplanation', () => {
  const base = { smscCount: 2, bindsTotal: 2, bindsHealthy: 2, bindsUnobserved: 0 };

  it('never lets "unknown" read as "probably fine"', () => {
    expect(
      healthExplanation({
        ...base,
        health: 'unknown',
        smscCount: 0,
        bindsTotal: 0,
        bindsHealthy: 0,
      }),
    ).toContain('nothing to be healthy');
    expect(
      healthExplanation({
        ...base,
        health: 'unknown',
        bindsUnobserved: 2,
        bindsHealthy: 0,
      }),
    ).toContain('Unknown is not healthy');
  });

  it('names the numbers behind degraded and critical', () => {
    expect(healthExplanation({ ...base, health: 'critical', bindsHealthy: 0 })).toContain(
      '0 of 2 bound',
    );
    expect(healthExplanation({ ...base, health: 'degraded', bindsHealthy: 1 })).toContain('1 of 2');
  });

  it('says why an all-up carrier is still only degraded when a bind is unseen', () => {
    expect(
      healthExplanation({
        smscCount: 3,
        bindsTotal: 3,
        bindsHealthy: 2,
        bindsUnobserved: 1,
        health: 'degraded',
      }),
    ).toContain('never been observed');
  });
});

describe('mapWithConcurrency', () => {
  it('keeps results in input order while bounding the work in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    expect(results).toEqual(items.map((item) => item * 2));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list without starting a worker', async () => {
    const worker = (item: number) => Promise.resolve(item);
    expect(await mapWithConcurrency([], 6, worker)).toEqual([]);
  });
});
