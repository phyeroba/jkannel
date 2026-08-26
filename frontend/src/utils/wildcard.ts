/**
 * The wildcard grammar, for telling the operator what they just typed.
 *
 * THIS IS A MIRROR, NOT THE AUTHORITY
 * ---------------------------------------------------------------------------
 * `backend/src/routing-depth/wildcard.ts` is the authority. It validates on
 * save and it is what the send path actually matches with, so a route that
 * saves is a route the engine understands regardless of what this file thinks.
 *
 * The copy exists because the alternative is worse. Asking the API on every
 * keystroke to find out whether a pattern is valid puts a network round trip
 * between typing and understanding, and the whole value of showing the reading
 * is that it appears as the pattern is written. There is no shared package
 * between backend and frontend in this repository to put one copy in.
 *
 * `wildcard.spec.ts` next door runs the same table of cases as the backend's
 * spec, so the two agree or a test fails. If they ever disagree in production,
 * the backend wins: it is the one that refuses the save.
 *
 * Only the two READ-ONLY functions are mirrored — describing a problem, and
 * describing a pattern in words. Compilation and matching are deliberately not
 * here; nothing in the browser should be deciding where a message routes.
 */

/** Ceilings, matching the backend's exported constants. */
export const MAX_PATTERN_LENGTH = 512;
export const MAX_ALTERNATIVES = 64;

/**
 * Splits on `|` and trims each alternative.
 *
 * The trim matters: `25677* | 25678*` written with spaces used to leave the
 * second alternative starting with a literal space, so it matched no MSISDN and
 * nothing reported a problem. The backend trims for the same reason.
 */
function splitAlternatives(pattern: string): string[] {
  return pattern.split('|').map((alternative) => alternative.trim());
}

/** The reason this pattern would be rejected on save, or null. */
export function describeWildcardProblem(pattern: string): string | null {
  const text = String(pattern ?? '');
  if (!text.trim()) return 'A pattern is required. Use * to match everything.';
  if (text.length > MAX_PATTERN_LENGTH)
    return `A pattern may be at most ${MAX_PATTERN_LENGTH} characters; this one is ${text.length}.`;
  const alternatives = splitAlternatives(text);
  if (alternatives.length > MAX_ALTERNATIVES)
    return `A pattern may contain at most ${MAX_ALTERNATIVES} alternatives separated by |; this one has ${alternatives.length}.`;
  if (alternatives.some((alternative) => !alternative.length))
    return 'An empty alternative would match everything. Remove the stray | (or a leading/trailing one).';
  return null;
}

/**
 * The pattern in words.
 *
 * Shown live under the field so an operator can check their intent against the
 * machine's reading before saving a rule that decides where traffic goes.
 */
export function describeWildcard(pattern: string): string {
  const text = String(pattern ?? '').trim();
  if (!text) return 'nothing';
  if (text === '*') return 'anything';
  const parts = splitAlternatives(text).map((alternative) => {
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
