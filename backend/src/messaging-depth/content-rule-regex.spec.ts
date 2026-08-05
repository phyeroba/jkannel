import { BadRequestException } from '@nestjs/common';
import {
  MAX_PATTERN_LENGTH,
  UnsafeRegexError,
  assertSafeRegexPattern,
  boundRegexInput,
  checkRegexPattern,
  compileSafeRegex,
  runBoundedRegex,
} from './content-rule-regex';

function rejection(pattern: string): string {
  try {
    checkRegexPattern(pattern);
  } catch (error) {
    if (error instanceof UnsafeRegexError) return error.rejection;
    throw error;
  }
  return 'accepted';
}

describe('content-rule-regex — write-time rejection (layer 1)', () => {
  it('accepts the patterns an operator actually writes', () => {
    for (const pattern of [
      'loan',
      '^BAL$',
      'win \\d{3,6} now',
      '(?:free|bonus) (?:cash|airtime)',
      '[A-Z]{2,5}-[0-9]{4}',
      '.*urgent.*',
      'https?://bit\\.ly/\\w+',
    ])
      expect(rejection(pattern)).toBe('accepted');
  });

  it('refuses the classic exponential shapes rather than executing them', () => {
    // Every one of these hangs a backtracking engine on a crafted subject.
    expect(rejection('(a+)+$')).toBe('nested_quantifier');
    expect(rejection('(a*)*b')).toBe('nested_quantifier');
    expect(rejection('(?:x+)+y')).toBe('nested_quantifier');
    expect(rejection('(a|a)*$')).toBe('nested_quantifier');
    expect(rejection('(a|ab)+c')).toBe('nested_quantifier');
    expect(rejection('([a-zA-Z]+)*$')).toBe('nested_quantifier');
    // Nesting one level deeper must not slip past: the shape propagates outward.
    expect(rejection('((a+))+')).toBe('nested_quantifier');
  });

  it('bounds the polynomial shapes by capping unbounded quantifiers', () => {
    expect(rejection('.*.*.*x')).toBe('accepted'); // exactly at the cap of 3
    expect(rejection('.*.*.*.*x')).toBe('too_many_unbounded_quantifiers');
    expect(rejection('a+b+c+d+e')).toBe('too_many_unbounded_quantifiers');
  });

  it('refuses backreferences, lookbehind, huge repeats and overlong patterns', () => {
    expect(rejection('(a)\\1')).toBe('backreference');
    expect(rejection('(?<name>a)\\k<name>')).toBe('backreference');
    expect(rejection('(?<=foo)bar')).toBe('lookbehind');
    expect(rejection('(?<!foo)bar')).toBe('lookbehind');
    expect(rejection('a{5000}')).toBe('repeat_bound_too_large');
    expect(rejection('a{1,9999}')).toBe('repeat_bound_too_large');
    expect(rejection('x'.repeat(MAX_PATTERN_LENGTH + 1))).toBe('too_long');
    expect(rejection('a?b?c?d?e?f?g?h?i?j?k?l?m?')).toBe('too_many_quantifiers');
  });

  it('refuses a pattern that is not a regex at all, naming the syntax problem', () => {
    expect(rejection('(unclosed')).toBe('invalid_syntax');
    expect(rejection('')).toBe('empty');
  });

  it('is not fooled by quantifier-like characters inside a character class', () => {
    // `[+*]` is a literal class, not two quantifiers.
    expect(rejection('[+*?]{1,3}')).toBe('accepted');
    // An escaped paren is a literal, so nothing is "quantifying a group".
    expect(rejection('\\(a\\)+')).toBe('accepted');
    // `{foo}` is a literal brace sequence in JS, not a repetition.
    expect(rejection('a{foo}')).toBe('accepted');
  });

  it('surfaces a rejection as a 400 at the API boundary, never a 500', () => {
    expect(() => assertSafeRegexPattern('(a+)+')).toThrow(BadRequestException);
    try {
      assertSafeRegexPattern('(a+)+');
    } catch (error) {
      expect((error as BadRequestException).message).toContain('nested_quantifier');
    }
  });
});

describe('content-rule-regex — bounded execution (layers 2 and 3)', () => {
  afterEach(() => {
    delete process.env.CONTENT_FILTER_REGEX_MAX_INPUT;
    delete process.env.CONTENT_FILTER_REGEX_BUDGET_MS;
  });

  it('truncates the subject so backtracking cost cannot grow with message length', () => {
    process.env.CONTENT_FILTER_REGEX_MAX_INPUT = '64';
    expect(boundRegexInput('x'.repeat(500))).toHaveLength(64);
    // A match beyond the bound is not seen — a deliberate, documented trade.
    const regex = compileSafeRegex('needle', false);
    expect(runBoundedRegex(regex, `${'x'.repeat(200)}needle`).matched).toBe(false);
    expect(runBoundedRegex(regex, `needle${'x'.repeat(200)}`).matched).toBe(true);
  });

  it('compiles case-insensitively by default and without the sticky-state g flag', () => {
    const insensitive = compileSafeRegex('LOAN', false);
    expect(insensitive.flags).toBe('i');
    expect(insensitive.test('cheap loan today')).toBe(true);
    // A 'g' regex carries lastIndex, so a cached rule would skip every other
    // message. Repeating the same test must give the same answer.
    expect(insensitive.test('cheap loan today')).toBe(true);

    const sensitive = compileSafeRegex('LOAN', true);
    expect(sensitive.flags).toBe('');
    expect(sensitive.test('cheap loan today')).toBe(false);
  });

  it('reports an execution that blew its budget so the caller can quarantine it', () => {
    process.env.CONTENT_FILTER_REGEX_BUDGET_MS = '1';
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1050);
    const result = runBoundedRegex(/x/, 'x');
    expect(result.overBudget).toBe(true);
    expect(result.elapsedMs).toBe(50);
    now.mockRestore();
  });

  it('a healthy pattern over a full-length subject stays far inside the budget', () => {
    const regex = compileSafeRegex('(?:free|bonus) (?:cash|airtime)', false);
    const subject = 'a'.repeat(1024);
    const started = Date.now();
    for (let i = 0; i < 200; i += 1) runBoundedRegex(regex, subject);
    // 200 executions over the maximum subject length; if this is not comfortably
    // sub-second the pattern class is not safe to run per send.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never throws out of an execution, even for a regex that errors', () => {
    const exploding = {
      test: () => {
        throw new Error('boom');
      },
    } as unknown as RegExp;
    const result = runBoundedRegex(exploding, 'anything');
    expect(result).toMatchObject({ matched: false, overBudget: true });
  });
});
