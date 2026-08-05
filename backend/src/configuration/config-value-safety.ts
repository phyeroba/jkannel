/**
 * Validation for operator-supplied strings that end up inside a generated
 * Kannel/Kamex configuration file.
 *
 * WHY REJECT RATHER THAN ESCAPE
 * ---------------------------------------------------------------------------
 * The generator has two emitters. `quoted` wraps a value in double quotes and
 * escapes `"`. `push` — which carries most operator-settable fields, including
 * `host`, `smsc-username`, `system-type`, `address-range` and `alt-charset` —
 * writes the value verbatim with no quoting at all, because that is the form
 * those directives take in the engine's own configuration files.
 *
 * `push` therefore cannot be made safe by escaping: there are no quotes to
 * escape within. A newline in a value emits a raw newline mid-file, and the
 * remainder of that line is parsed as a fresh directive. Rejecting the input
 * covers both emitters with one rule, changes the rendered output for no value
 * that is currently valid, and reports the problem while the operator is
 * looking at the field rather than at deploy time.
 *
 * WHAT IS REJECTED, AND WHY EACH ONE MATTERS
 * ---------------------------------------------------------------------------
 * - CONTROL CHARACTERS / NEWLINES: directive injection through `push`.
 * - DOUBLE QUOTE and BACKSLASH: inside `quoted`, a `"` is escaped but a
 *   trailing `\` escapes the closing quote itself, so `abc\` renders as
 *   `"abc\"` and the parser reads on into the next line.
 * - A LEADING `#`: parsed as a comment, silently discarding the directive.
 * - THE SUBSTRING `include`, case-insensitively: this is the sharp one.
 *   gwlib/cfg.c detects include directives by substring-searching the RAW
 *   LINE rather than by parsing the key. It then lstat()s the right-hand side
 *   and panics if that fails, and gw_panic() exits. So a host of
 *   `includes.vendor.net`, an smsc-id of `includeme`, or a password containing
 *   the word are each enough to kill bearerbox — and because the file is
 *   already on disk, every subsequent start panics too, until someone edits it
 *   by hand. A text field should not be able to do that.
 *
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * Not a replacement for the native validator. That still runs a real pinned
 * bearerbox parse before anything is written, and remains the backstop. This
 * layer exists because the validator can only say "the configuration failed to
 * parse", long after the operator saved the record and with no indication of
 * which field is at fault.
 */

/** Longest value accepted for any single directive. */
export const MAX_CONFIG_VALUE_LENGTH = 512;

export interface ConfigValueProblem {
  field: string;
  reason: string;
}

/**
 * C0 controls, DEL and the C1 range, tested by code point rather than by a
 * regular expression. A character class for these has to contain either literal
 * control bytes or escapes, and both kept ending up as raw bytes in this source
 * file — which is exactly the sort of thing that should not be invisible in a
 * validator. A loop is unambiguous.
 */
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
};

/**
 * Describes what is wrong with a value, or null when it is safe.
 *
 * Messages name the offending character AND the consequence. "Invalid
 * character" tells an operator nothing they can act on; "contains a line break,
 * so the text after it would be parsed as a new directive" tells them exactly
 * what to change and why it matters.
 */
export function describeConfigValueProblem(
  field: string,
  value: string,
): ConfigValueProblem | null {
  if (value.length > MAX_CONFIG_VALUE_LENGTH)
    return {
      field,
      reason:
        `is ${value.length} characters; the maximum for a configuration value is ` +
        `${MAX_CONFIG_VALUE_LENGTH}`,
    };
  if (hasControlCharacter(value)) {
    const newline = /[\r\n]/.test(value);
    return {
      field,
      reason: newline
        ? 'contains a line break. Most engine directives are written unquoted, so the text ' +
          'after the break would be parsed as a new configuration directive.'
        : 'contains a control character, which cannot be represented in an engine ' +
          'configuration file.',
    };
  }
  if (value.includes('"'))
    return {
      field,
      reason: 'contains a double quote, which would terminate the quoted value early.',
    };
  if (value.includes('\\'))
    return {
      field,
      reason:
        'contains a backslash. The engine unescapes \\" when parsing, so a backslash before ' +
        'the closing quote escapes the quote itself and the parser reads into the next line.',
    };
  if (value.trimStart().startsWith('#'))
    return {
      field,
      reason: 'starts with "#", which the engine parses as a comment, silently discarding it.',
    };
  if (/include/i.test(value))
    return {
      field,
      reason:
        'contains "include". The engine finds include directives by searching the raw line ' +
        'for that word, then aborts if the rest of the line is not a readable path — so this ' +
        'value would stop bearerbox from starting, and it would keep failing on every restart ' +
        'until the generated file was edited by hand.',
    };
  return null;
}

/** Bulk check that does not throw. Returns one problem per offending field. */
export function collectConfigValueProblems(
  entries: Array<[field: string, value: unknown]>,
): ConfigValueProblem[] {
  const problems: ConfigValueProblem[] = [];
  for (const [field, value] of entries) {
    if (typeof value !== 'string' || value === '') continue;
    const problem = describeConfigValueProblem(field, value);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** Formats a problem as a sentence suitable for an API error message. */
export function formatConfigValueProblem(problem: ConfigValueProblem): string {
  return `${problem.field} ${problem.reason}`;
}
