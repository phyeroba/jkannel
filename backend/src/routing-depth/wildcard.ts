/**
 * The SMS Studio wildcard grammar (SMS STUDIO Features, page 1).
 *
 * ---------------------------------------------------------------------------
 * WHY A FOURTH MATCHING LANGUAGE
 * ---------------------------------------------------------------------------
 * JKANNEL already had `exact`, `prefix`, `substring` and `regex`. None of them
 * expresses the one thing an SMS operator writes constantly:
 *
 *     25677*|25678*|25676*|25679*        "all MTN Uganda MSISDNs"
 *
 * With `prefix` that is four rules to create, four to keep in step, and four to
 * remember to disable together. With `regex` it is one rule in a language where
 * a typo is a catastrophic backtrack and `.` silently means "any character" —
 * the operator wanted a literal dot roughly every time.
 *
 * So this is the grammar the people doing this work already know:
 *
 *   *   any run of characters, including none
 *   #   exactly one DIGIT
 *   $   exactly one LETTER
 *   |   alternation between whole patterns
 *
 * ---------------------------------------------------------------------------
 * IT COMPILES TO A REGEX, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * Everything outside those four characters is escaped, so a pattern cannot
 * become a regex by accident. `.` is a literal dot. `(a+)+b` is a literal
 * string, not the catastrophic backtracker it would be in the `regex` match
 * type. The grammar has no nesting, no backreferences and no unbounded
 * repetition of a group, so the compiled expression is linear — a pattern
 * cannot be written here that hangs the send path.
 *
 * That is a security property, not a convenience: content rules run inside the
 * transaction of every single send.
 */

/** Ceiling on pattern length, so one rule cannot dominate the send path. */
export const MAX_PATTERN_LENGTH = 512;
/** Ceiling on alternatives in one pattern. `|`-separated, so easy to abuse. */
export const MAX_ALTERNATIVES = 64;

export interface WildcardProblem {
  code: 'empty' | 'too-long' | 'too-many-alternatives' | 'empty-alternative';
  message: string;
}

/**
 * Why this pattern would be rejected, or null.
 *
 * Reported at the moment the operator types it rather than at match time,
 * because a rule that silently never matches is the worst outcome here: traffic
 * flows past a block rule nobody notices is broken.
 */
export function describeWildcardProblem(pattern: string): WildcardProblem | null {
  const text = String(pattern ?? '');
  if (!text.trim())
    return { code: 'empty', message: 'A pattern is required. Use * to match everything.' };
  if (text.length > MAX_PATTERN_LENGTH)
    return {
      code: 'too-long',
      message: `A pattern may be at most ${MAX_PATTERN_LENGTH} characters; this one is ${text.length}.`,
    };
  const alternatives = text.split('|');
  if (alternatives.length > MAX_ALTERNATIVES)
    return {
      code: 'too-many-alternatives',
      message: `A pattern may contain at most ${MAX_ALTERNATIVES} alternatives separated by |; this one has ${alternatives.length}.`,
    };
  if (alternatives.some((alternative) => !alternative.length))
    return {
      code: 'empty-alternative',
      message:
        'An empty alternative would match everything. Remove the stray | (or a leading/trailing one).',
    };
  return null;
}

export function isValidWildcard(pattern: string): boolean {
  return describeWildcardProblem(pattern) === null;
}

/** Every character that means something to a regex, escaped to its literal. */
function escapeLiteral(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One alternative to a regex source fragment.
 *
 * Built character by character rather than by a chain of `.replace()` calls.
 * The chain approach is the classic bug here: escaping the literals first turns
 * `*` into `\*`, and escaping the wildcards first means the escape sequences
 * themselves get escaped by the next pass. A single left-to-right walk cannot
 * have that problem.
 */
function compileAlternative(alternative: string): string {
  let source = '';
  for (const character of alternative) {
    if (character === '*') source += '[\\s\\S]*';
    else if (character === '#') source += '[0-9]';
    else if (character === '$') source += '[A-Za-z]';
    else source += escapeLiteral(character);
  }
  return source;
}

/**
 * Compiles a pattern to an anchored regular expression.
 *
 * Anchored on both ends deliberately. `25677*` should mean "starts with 25677",
 * not "contains it somewhere" — an unanchored match would make `77` match every
 * number containing 77, which is a silent over-block.
 */
export function compileWildcard(pattern: string, caseSensitive = false): RegExp {
  const problem = describeWildcardProblem(pattern);
  if (problem) throw new Error(problem.message);
  const source = String(pattern)
    .split('|')
    .map(compileAlternative)
    .join('|');
  return new RegExp(`^(?:${source})$`, caseSensitive ? '' : 'i');
}

/**
 * Does `value` match `pattern`?
 *
 * A null or undefined value never matches — including against `*`. That is a
 * deliberate choice: `*` means "any value", and a message with no sender does
 * not have any value. Letting it match would make an "all senders" rule quietly
 * also catch messages whose sender failed to parse.
 */
export function matchesWildcard(
  value: string | null | undefined,
  pattern: string,
  caseSensitive = false,
): boolean {
  if (value === null || value === undefined) return false;
  try {
    return compileWildcard(pattern, caseSensitive).test(String(value));
  } catch {
    // An invalid pattern matches NOTHING rather than everything. A broken block
    // rule that blocks nothing is bad; one that blocks all traffic is an outage.
    return false;
  }
}

/**
 * The pattern in words, for a confirmation dialog or an audit entry.
 *
 * An operator approving a rule that will drop traffic should be able to read
 * what it does without mentally compiling it.
 */
export function describeWildcard(pattern: string): string {
  const text = String(pattern ?? '').trim();
  if (!text) return 'nothing';
  if (text === '*') return 'anything';
  const parts = text.split('|').map((alternative) => {
    if (alternative === '*') return 'anything';
    if (alternative.endsWith('*') && !alternative.slice(0, -1).match(/[*#$]/))
      return `anything starting with "${alternative.slice(0, -1)}"`;
    if (alternative.startsWith('*') && !alternative.slice(1).match(/[*#$]/))
      return `anything ending with "${alternative.slice(1)}"`;
    if (!alternative.match(/[*#$]/)) return `exactly "${alternative}"`;
    return `the pattern "${alternative}"`;
  });
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}
