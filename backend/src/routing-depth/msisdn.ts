/**
 * Shared E.164 MSISDN normalisation.
 *
 * MSISDN handling was previously ad hoc and inconsistent: `route-selection.ts`
 * stripped everything but digits, `routing/routing.service.ts` compared raw
 * strings with `startsWith` (so a route with prefix `+256` never matched a
 * destination stored as `256…`), the console and bulk-send controllers each
 * validated with their own `/^\+?[0-9]{3,20}$/`, and nothing understood the
 * `00` international prefix or a national `0` trunk code. The same subscriber
 * could therefore be blacklisted, routed and billed as three different numbers.
 *
 * This module is the single normaliser. It is pure and dependency-free so the
 * router, the blocklist, the send path and the API all agree on what a number is.
 *
 * Canonical form is DIGITS ONLY (no leading '+'), which is what SQLBox,
 * `routing_rules.match_prefix` and the blocklist all store. {@link toE164}
 * renders the display form when a '+' is wanted.
 */

/** Widest plausible national number; E.164 caps the total at 15 digits. */
const E164_MAX_DIGITS = 15;
/** Shortest thing that can be a real international subscriber number. */
const E164_MIN_DIGITS = 6;

export interface NormalizedMsisdn {
  /** Whatever the caller passed, untouched. */
  input: string;
  /** Canonical digits-only international form, or null when unusable. */
  digits: string | null;
  /** `+<digits>`, or null when unusable. */
  e164: string | null;
  /** True when the address normalised to a plausible E.164 number. */
  valid: boolean;
  /** Machine-readable rejection code; null when valid. */
  problem: 'empty' | 'no_digits' | 'too_short' | 'too_long' | null;
}

/**
 * Digits of an address, ignoring '+', spaces, dashes, brackets and dots.
 *
 * This is deliberately the SAME lenient behaviour `route-selection.ts` has
 * always used for prefix comparison, so route matching is unchanged by the
 * introduction of this module. Use {@link normalizeMsisdn} for destinations,
 * where the trunk/international prefixes must also be resolved.
 */
export function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9]/g, '');
}

/**
 * The tenant's default country calling code, used to expand a national number
 * (leading `0`) into international form. Unset = national numbers are rejected
 * rather than guessed at, which is the safe default for a multi-country gateway.
 */
function defaultCountryCode(explicit?: string | null): string {
  const raw = explicit ?? process.env.DEFAULT_COUNTRY_CODE ?? '';
  return digitsOnly(raw);
}

/**
 * Normalises an address to canonical international digits.
 *
 * Handled forms, in order:
 *   `+256700000000`  -> 256700000000  (already international)
 *   `00256700000000` -> 256700000000  (ITU international access prefix)
 *   `0700000000`     -> 256700000000  (national trunk code, needs a country code)
 *   `256700000000`   -> 256700000000  (bare international)
 *
 * Never throws; an unusable address comes back with `valid: false` and a
 * `problem` code so the caller can produce a specific error message.
 */
export function normalizeMsisdn(
  value: string | null | undefined,
  countryCode?: string | null,
): NormalizedMsisdn {
  const input = typeof value === 'string' ? value : '';
  const trimmed = input.trim();
  if (!trimmed) return { input, digits: null, e164: null, valid: false, problem: 'empty' };

  const hadPlus = trimmed.startsWith('+');
  let digits = digitsOnly(trimmed);
  if (!digits) return { input, digits: null, e164: null, valid: false, problem: 'no_digits' };

  if (!hadPlus) {
    const cc = defaultCountryCode(countryCode);
    if (digits.startsWith('00')) {
      // ITU international access prefix.
      digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
      // National format: only expandable when a country code is configured.
      // Without one, leave the leading zero in place and let the length checks
      // reject it rather than silently inventing a country.
      if (cc) digits = cc + digits.replace(/^0+/, '');
    }
  }

  if (digits.length < E164_MIN_DIGITS)
    return { input, digits: null, e164: null, valid: false, problem: 'too_short' };
  if (digits.length > E164_MAX_DIGITS)
    return { input, digits: null, e164: null, valid: false, problem: 'too_long' };
  // A canonical international number never begins with 0 (no country code does).
  if (digits.startsWith('0'))
    return { input, digits: null, e164: null, valid: false, problem: 'no_digits' };

  return { input, digits, e164: `+${digits}`, valid: true, problem: null };
}

/** `+<digits>` for a valid address, otherwise null. */
export function toE164(
  value: string | null | undefined,
  countryCode?: string | null,
): string | null {
  return normalizeMsisdn(value, countryCode).e164;
}

/** Human-readable reason an address was rejected. */
export function describeMsisdnProblem(result: NormalizedMsisdn): string {
  switch (result.problem) {
    case 'empty':
      return 'destination is required';
    case 'no_digits':
      return 'destination is not a dialable international number';
    case 'too_short':
      return `destination has fewer than ${E164_MIN_DIGITS} digits`;
    case 'too_long':
      return `destination has more than ${E164_MAX_DIGITS} digits (E.164 maximum)`;
    default:
      return 'destination is valid';
  }
}
