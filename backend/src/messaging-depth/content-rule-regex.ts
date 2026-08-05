import { BadRequestException } from '@nestjs/common';

/**
 * REGEX SAFETY FOR THE SEND PATH.
 *
 * A content-filter rule may carry an operator-supplied regular expression, and
 * that expression is executed on EVERY outbound message. JavaScript's regex
 * engine is a backtracking engine with no interrupt: once `RegExp.test()` is
 * running there is no way to stop it. So a pattern such as `(a+)+$` against a
 * 40-character body does not return in any useful time, and because the send
 * path is single-threaded that one bad rule is a denial of service against the
 * whole platform — self-inflicted, by an operator typing a plausible-looking
 * pattern into an admin form.
 *
 * There is no `re2` dependency available here (no new dependencies), so safety
 * is built from three independent layers. Each one alone is insufficient; the
 * three together mean a pathological pattern is either refused at write time or
 * survives at most one bounded execution.
 *
 *   LAYER 1 — STATIC REJECTION AT WRITE TIME ({@link assertSafeRegexPattern}).
 *     The pattern is scanned and refused if it contains the structures that
 *     make backtracking blow up: a quantifier applied to a group that itself
 *     contains a quantifier or an alternation (`(a+)+`, `(a|b)*`, `(?:x*)+`),
 *     a backreference, a lookbehind, a repetition bound above
 *     {@link MAX_REPEAT_BOUND}, more than {@link MAX_UNBOUNDED_QUANTIFIERS}
 *     unbounded quantifiers (which is what bounds the POLYNOMIAL cases such as
 *     `.*.*.*x`), more than {@link MAX_QUANTIFIERS} quantifiers in total, or a
 *     pattern longer than {@link MAX_PATTERN_LENGTH}. This is deliberately
 *     CONSERVATIVE: it refuses some patterns that would in fact have been fine.
 *     Refusing a usable rule is an inconvenience; accepting an unusable one is
 *     an outage.
 *
 *   LAYER 2 — BOUNDED INPUT ({@link boundRegexInput}).
 *     Regex matching only ever sees the first {@link maxRegexInputLength}
 *     characters of the subject. Backtracking cost is a function of subject
 *     length, so bounding the subject bounds the blow-up. With the layer-1 cap
 *     of 3 unbounded quantifiers and a 1024-character subject the worst
 *     surviving case is polynomial of degree 3, not exponential. Substring /
 *     exact / prefix matching is linear and is NOT truncated.
 *
 *   LAYER 3 — RUNTIME BUDGET AND QUARANTINE ({@link runBoundedRegex}).
 *     Every execution is timed. A rule that exceeds {@link regexBudgetMs} is
 *     reported back to the caller, which quarantines it: the rule is disabled
 *     in the database, evicted from the cache and never executed again until an
 *     operator re-enables it. The execution that discovered the problem has
 *     already cost its (bounded) time; no further send pays it.
 *
 *     Quarantine means that ONE send may be evaluated as though that rule did
 *     not match. That is a deliberate trade, stated rather than hidden: a
 *     filter that can hang the sender is worse than a filter that misses one
 *     message and then shouts about it. The quarantine is audited and the rule
 *     is visibly disabled, so the operator finds out.
 */

/** Longest pattern an operator may store. */
export const MAX_PATTERN_LENGTH = 256;
/** Largest `{n,m}` bound accepted. */
export const MAX_REPEAT_BOUND = 100;
/** Total quantifiers (`*`, `+`, `?`, `{n,m}`) accepted in one pattern. */
export const MAX_QUANTIFIERS = 12;
/**
 * Unbounded quantifiers (`*`, `+`, `{n,}`) accepted in one pattern. This is the
 * bound on POLYNOMIAL backtracking: k unbounded quantifiers over a subject of
 * length n cost O(n^k) in the worst case, so k must stay small.
 */
export const MAX_UNBOUNDED_QUANTIFIERS = 3;

/** Default subject truncation for regex matching. */
const DEFAULT_MAX_REGEX_INPUT = 1024;
/** Default per-execution budget before a rule is quarantined. */
const DEFAULT_REGEX_BUDGET_MS = 25;

/** Configured subject truncation, bounded so it cannot be set to something unsafe. */
export function maxRegexInputLength(): number {
  const parsed = Number(process.env.CONTENT_FILTER_REGEX_MAX_INPUT ?? DEFAULT_MAX_REGEX_INPUT);
  if (!Number.isFinite(parsed) || parsed < 32) return DEFAULT_MAX_REGEX_INPUT;
  return Math.min(Math.floor(parsed), 4096);
}

/** Configured per-execution budget in milliseconds. */
export function regexBudgetMs(): number {
  const parsed = Number(process.env.CONTENT_FILTER_REGEX_BUDGET_MS ?? DEFAULT_REGEX_BUDGET_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REGEX_BUDGET_MS;
  return Math.min(Math.floor(parsed), 1000);
}

/** Why a pattern was refused. Machine-readable so a UI can explain it. */
export type RegexRejection =
  | 'empty'
  | 'too_long'
  | 'invalid_syntax'
  | 'backreference'
  | 'lookbehind'
  | 'nested_quantifier'
  | 'repeat_bound_too_large'
  | 'too_many_quantifiers'
  | 'too_many_unbounded_quantifiers';

export class UnsafeRegexError extends Error {
  constructor(
    readonly rejection: RegexRejection,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

interface ScanState {
  quantifiers: number;
  unbounded: number;
}

interface GroupSummary {
  /** Index just past the closing ')' (or the end of the pattern). */
  next: number;
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

const fail = (rejection: RegexRejection, message: string): never => {
  throw new UnsafeRegexError(rejection, message);
};

/**
 * Reads a quantifier at `i`, if there is one. Returns its width and whether it
 * is unbounded; width 0 means there was no quantifier here.
 */
function readQuantifier(pattern: string, i: number): { width: number; unbounded: boolean } {
  const char = pattern[i];
  if (char === '*' || char === '+') {
    // A trailing '?' only makes it lazy; laziness does not remove backtracking.
    const lazy = pattern[i + 1] === '?' || pattern[i + 1] === '+';
    return { width: lazy ? 2 : 1, unbounded: true };
  }
  if (char === '?') {
    const lazy = pattern[i + 1] === '?' || pattern[i + 1] === '+';
    return { width: lazy ? 2 : 1, unbounded: false };
  }
  if (char !== '{') return { width: 0, unbounded: false };
  const close = pattern.indexOf('}', i);
  if (close < 0) return { width: 0, unbounded: false };
  const body = pattern.slice(i + 1, close);
  const match = /^(\d+)(,(\d*)?)?$/.exec(body);
  // `{foo}` is a literal brace sequence in JS regex, not a quantifier.
  if (!match) return { width: 0, unbounded: false };
  const min = Number(match[1]);
  const hasComma = match[2] !== undefined;
  const maxText = match[3];
  const max = hasComma ? (maxText ? Number(maxText) : Number.POSITIVE_INFINITY) : min;
  if (min > MAX_REPEAT_BOUND || (Number.isFinite(max) && max > MAX_REPEAT_BOUND))
    fail(
      'repeat_bound_too_large',
      `repetition {${body}} exceeds the maximum bound of ${MAX_REPEAT_BOUND}`,
    );
  const lazy = pattern[close + 1] === '?' || pattern[close + 1] === '+';
  return { width: close + 1 - i + (lazy ? 1 : 0), unbounded: !Number.isFinite(max) };
}

/** Skips a `[...]` character class, returning the index just past its `]`. */
function skipCharClass(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i += 1;
  if (pattern[i] === ']') i += 1; // A leading ']' is a literal.
  while (i < pattern.length) {
    if (pattern[i] === '\\') {
      i += 2;
      continue;
    }
    if (pattern[i] === ']') return i + 1;
    i += 1;
  }
  return pattern.length;
}

/**
 * Scans one alternation body, from `start` until an unmatched `)` or the end,
 * accumulating counts and rejecting the dangerous shapes as it goes.
 */
function scanBody(pattern: string, start: number, state: ScanState): GroupSummary {
  let i = start;
  let hasQuantifier = false;
  let hasAlternation = false;

  const countQuantifier = (unbounded: boolean) => {
    hasQuantifier = true;
    state.quantifiers += 1;
    if (unbounded) state.unbounded += 1;
    if (state.quantifiers > MAX_QUANTIFIERS)
      fail(
        'too_many_quantifiers',
        `pattern uses more than ${MAX_QUANTIFIERS} quantifiers; simplify it or split it into several rules`,
      );
    if (state.unbounded > MAX_UNBOUNDED_QUANTIFIERS)
      fail(
        'too_many_unbounded_quantifiers',
        `pattern uses more than ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (* + {n,}); ` +
          'unbounded repetition multiplies backtracking cost and is capped for that reason',
      );
  };

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next))
        fail(
          'backreference',
          'backreferences (\\1, \\2, ...) are not accepted: they force the engine to re-scan and are a common source of catastrophic backtracking',
        );
      if (next === 'k') fail('backreference', 'named backreferences (\\k<name>) are not accepted');
      i += 2;
      const quantifier = readQuantifier(pattern, i);
      if (quantifier.width) {
        countQuantifier(quantifier.unbounded);
        i += quantifier.width;
      }
      continue;
    }

    if (char === '[') {
      i = skipCharClass(pattern, i);
      const quantifier = readQuantifier(pattern, i);
      if (quantifier.width) {
        countQuantifier(quantifier.unbounded);
        i += quantifier.width;
      }
      continue;
    }

    if (char === '(') {
      if (pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i))
        fail(
          'lookbehind',
          'lookbehind assertions ((?<=...), (?<!...)) are not accepted on the send path',
        );
      const inner = scanBody(pattern, groupBodyStart(pattern, i), state);
      i = inner.next;
      const quantifier = readQuantifier(pattern, i);
      if (quantifier.width) {
        // THE core check. A quantified group whose body can match the same text
        // in more than one way is exactly the exponential-backtracking shape.
        if (inner.hasQuantifier || inner.hasAlternation)
          fail(
            'nested_quantifier',
            'a quantifier applied to a group that itself contains a quantifier or an alternation ' +
              '(for example (a+)+ or (a|b)*) can backtrack exponentially and is not accepted',
          );
        countQuantifier(quantifier.unbounded);
        i += quantifier.width;
      }
      // A nested group's shape propagates outward: (?:(a+)) is still a group
      // containing a quantifier, so quantifying IT must also be refused.
      if (inner.hasQuantifier || quantifier.width) hasQuantifier = true;
      if (inner.hasAlternation) hasAlternation = true;
      continue;
    }

    if (char === ')') return { next: i + 1, hasQuantifier, hasAlternation };

    if (char === '|') {
      hasAlternation = true;
      i += 1;
      continue;
    }

    // Ordinary atom (literal, '.', anchor, ...) optionally quantified.
    i += 1;
    const quantifier = readQuantifier(pattern, i);
    if (quantifier.width) {
      countQuantifier(quantifier.unbounded);
      i += quantifier.width;
    }
  }

  return { next: i, hasQuantifier, hasAlternation };
}

/** Index of the first character of a group's body, skipping `(?:`, `(?<name>`, `(?=`... */
function groupBodyStart(pattern: string, open: number): number {
  if (pattern[open + 1] !== '?') return open + 1;
  const third = pattern[open + 2];
  if (third === ':' || third === '=' || third === '!') return open + 3;
  if (third === '<') {
    const close = pattern.indexOf('>', open + 2);
    return close < 0 ? open + 3 : close + 1;
  }
  return open + 2;
}

/**
 * Refuses a pattern that cannot be executed safely on the send path. Throws
 * {@link UnsafeRegexError}; use {@link assertSafeRegexPattern} at an API
 * boundary, where the rejection must be a 400.
 */
export function checkRegexPattern(pattern: string): void {
  if (typeof pattern !== 'string' || !pattern.length) fail('empty', 'pattern is required');
  if (pattern.length > MAX_PATTERN_LENGTH)
    fail(
      'too_long',
      `pattern is longer than ${MAX_PATTERN_LENGTH} characters; a filter that long is unreviewable as well as slow`,
    );
  try {
    // Syntax first: a scan of a malformed pattern would report the wrong reason.
    new RegExp(pattern);
  } catch (error) {
    fail(
      'invalid_syntax',
      `pattern is not a valid regular expression: ${(error as Error).message}`,
    );
  }
  scanBody(pattern, 0, { quantifiers: 0, unbounded: 0 });
}

/** {@link checkRegexPattern} as a 400. */
export function assertSafeRegexPattern(pattern: string): void {
  try {
    checkRegexPattern(pattern);
  } catch (error) {
    if (error instanceof UnsafeRegexError)
      throw new BadRequestException(`Unsafe regex (${error.rejection}): ${error.message}`);
    throw error;
  }
}

/** Compiles a pattern that has already been proven safe. */
export function compileSafeRegex(pattern: string, caseSensitive: boolean): RegExp {
  assertSafeRegexPattern(pattern);
  // No 'g' flag: a global regex carries lastIndex between calls, so a cached
  // compiled rule would silently skip matches on alternate messages.
  return new RegExp(pattern, caseSensitive ? '' : 'i');
}

/** Truncates a subject to the configured regex bound (layer 2). */
export function boundRegexInput(value: string): string {
  const max = maxRegexInputLength();
  return value.length > max ? value.slice(0, max) : value;
}

export interface BoundedRegexResult {
  matched: boolean;
  elapsedMs: number;
  /** True when the execution exceeded the budget and the rule must be quarantined. */
  overBudget: boolean;
}

/**
 * Executes a compiled rule against a bounded subject and times it (layer 3).
 * Never throws: a regex that somehow errors is reported as "did not match" with
 * `overBudget` set, so the caller quarantines it rather than failing the send.
 */
export function runBoundedRegex(regex: RegExp, subject: string): BoundedRegexResult {
  const bounded = boundRegexInput(subject);
  const started = Date.now();
  let matched = false;
  try {
    matched = regex.test(bounded);
  } catch {
    return { matched: false, elapsedMs: Date.now() - started, overBudget: true };
  }
  const elapsedMs = Date.now() - started;
  return { matched, elapsedMs, overBudget: elapsedMs > regexBudgetMs() };
}
