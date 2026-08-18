/**
 * Masking for subscriber identifiers and message content (spec §17, §18).
 *
 * §18's privacy requirement is short: "Mask MSISDN/content; configurable
 * retention; audited reveal/export." §10 adds that content and MSISDN are
 * masked BY DEFAULT and that reveal is privileged, time-limited and audited.
 *
 * Today none of that exists. `GET /messages`, the CSV export, `/queues`,
 * `/reports/delivery` and `/mo/messages` all return `sender`, `receiver` and
 * the full body in the clear to anyone holding `messages.view` — a single
 * binary grant that most operators have, because it is also what lets them see
 * that a message exists at all.
 *
 * WHY MASK RATHER THAN OMIT
 * ---------------------------------------------------------------------------
 * An operator diagnosing a delivery problem needs to recognise the number, not
 * read it: "is this the same subscriber complaining?" and "is this the right
 * country?" are answerable from a masked form. Omitting the field entirely
 * would make the console useless for support work and push people to query the
 * database directly, which is unaudited. So the mask keeps the shape — country
 * prefix and last two digits — and hides the identity.
 */

/** Digits kept at the end of a masked MSISDN, so a support call can be matched. */
const TAIL_DIGITS = 2;
/** Leading digits kept, enough to show the country without identifying anyone. */
const HEAD_DIGITS = 4;

/**
 * `+256772000118` -> `+2567•••••18`.
 *
 * Short numbers (short codes, alphanumeric sender IDs) are returned unchanged:
 * they identify a SERVICE, not a subscriber, and masking `JKANNEL` to `JK•••L`
 * would hide the one thing an operator is actually looking at.
 */
export function maskMsisdn(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return text;

  const digits = text.replace(/[^0-9]/g, '');
  // Not a subscriber number: alphanumeric sender ID or a short code.
  if (digits.length !== text.replace(/^\+/, '').length || digits.length < 8) return text;

  const plus = text.startsWith('+') ? '+' : '';
  const head = digits.slice(0, HEAD_DIGITS);
  const tail = digits.slice(-TAIL_DIGITS);
  const hidden = Math.max(1, digits.length - HEAD_DIGITS - TAIL_DIGITS);
  return `${plus}${head}${'•'.repeat(hidden)}${tail}`;
}

/**
 * Message body. Length and encoding-relevant shape are preserved because they
 * are operationally meaningful — a 480-character body is a 4-part message and
 * that is a billing fact — but no content survives.
 */
export function maskBody(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.length) return text;
  return `[${text.length} characters hidden]`;
}

export interface MaskableRow {
  sender?: unknown;
  receiver?: unknown;
  text?: unknown;
  msgdata?: unknown;
  destination?: unknown;
  body?: unknown;
  sender_digits?: unknown;
  receiver_digits?: unknown;
  [key: string]: unknown;
}

/** Subscriber identifiers, by the column names actually used in this codebase. */
const MSISDN_FIELDS = [
  'sender',
  'receiver',
  'destination',
  // mo_messages keeps normalised digit-only copies for matching. Masking the
  // display field and leaving these would be a mask in name only.
  'sender_digits',
  'receiver_digits',
] as const;

/** Message content. `msgdata` is sqlbox's column; `body` is mo_messages'. */
const CONTENT_FIELDS = ['text', 'msgdata', 'body'] as const;

/**
 * Masks the PII fields of one row, leaving everything else untouched.
 *
 * Field names are matched explicitly rather than by heuristic. A heuristic that
 * masked "anything that looks like a phone number" would eventually mask an
 * engine id, a correlation id or a port, and an operator would be left unable
 * to read their own diagnostics with no way to tell why.
 */
export function maskRow<T extends MaskableRow>(row: T): T {
  const masked: MaskableRow = { ...row };
  for (const field of MSISDN_FIELDS)
    if (field in masked) masked[field] = maskMsisdn(masked[field] as string);
  for (const field of CONTENT_FIELDS)
    if (field in masked) masked[field] = maskBody(masked[field] as string);
  return masked as T;
}

export function maskRows<T extends MaskableRow>(rows: T[]): T[] {
  return rows.map(maskRow);
}

/**
 * The notice attached to every masked payload.
 *
 * Present whether or not the caller could have revealed, so a masked response
 * is never mistaken for the real value — an operator copying `+2567•••••18`
 * into a carrier ticket is a worse outcome than one who knows to ask.
 */
export const MASKING_NOTICE =
  'Subscriber numbers and message bodies are masked by default. A masked value is not the real ' +
  'one — do not quote it to a carrier. Revealing requires the messages.reveal permission, is ' +
  'limited to a short window, and every reveal is recorded in the audit trail.';
