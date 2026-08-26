import { describe, expect, it } from 'vitest';
import { describeWildcard, describeWildcardProblem } from './wildcard';

/*
 * PARITY WITH THE BACKEND.
 *
 * `utils/wildcard.ts` is a mirror of `backend/src/routing-depth/wildcard.ts`,
 * kept because validating a pattern over the network on every keystroke would
 * put a round trip between typing and understanding. A mirror is only safe
 * while it agrees, so these are the same cases the backend's own spec runs. If
 * the two ever disagree, one of these fails and the backend is the one that is
 * right — it refuses the save.
 */
const CASES: { pattern: string; problem: string | null; reading?: string }[] = [
  { pattern: '', problem: 'A pattern is required. Use * to match everything.' },
  { pattern: '   ', problem: 'A pattern is required. Use * to match everything.' },
  { pattern: '*', problem: null, reading: 'anything' },
  { pattern: '25677*', problem: null, reading: 'anything starting with "25677"' },
  { pattern: '*1234', problem: null, reading: 'anything ending with "1234"' },
  { pattern: '256770000000', problem: null, reading: 'exactly "256770000000"' },
  { pattern: '25677#######', problem: null, reading: 'the pattern "25677#######"' },
  {
    pattern: '25677*|25678*',
    problem: null,
    reading: 'anything starting with "25677" or anything starting with "25678"',
  },
];

describe('wildcard mirror', () => {
  for (const testCase of CASES) {
    it(`describes ${JSON.stringify(testCase.pattern)}`, () => {
      expect(describeWildcardProblem(testCase.pattern)).toBe(testCase.problem);
      if (testCase.reading) expect(describeWildcard(testCase.pattern)).toBe(testCase.reading);
    });
  }

  it('accepts spaces around the separator, exactly as the engine does', () => {
    // The readable form. Before both sides trimmed, this silently disabled
    // every branch but the first, and nothing reported a problem.
    expect(describeWildcardProblem('25677* | 25678* | 25676* | 25679*')).toBeNull();
    expect(describeWildcard('25677* | 25678*')).toBe(describeWildcard('25677*|25678*'));
  });

  it('rejects an alternative that is empty once trimmed', () => {
    // An empty alternative matches everything, which for a routing or block
    // rule is the one failure that must never pass quietly.
    expect(describeWildcardProblem('25677*|   |25678*')).toContain('empty alternative');
    expect(describeWildcardProblem('|25677*')).toContain('empty alternative');
    expect(describeWildcardProblem('25677*|')).toContain('empty alternative');
  });

  it('enforces the same ceilings', () => {
    expect(describeWildcardProblem('a'.repeat(513))).toContain('at most 512 characters');
    expect(describeWildcardProblem(Array.from({ length: 65 }, () => 'a').join('|'))).toContain(
      'at most 64 alternatives',
    );
  });
});
