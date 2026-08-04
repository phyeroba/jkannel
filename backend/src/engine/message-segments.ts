/**
 * SMS segment (multi-part) accounting for engine rows.
 *
 * `sent_sms` / `send_sms` store one row per PDU with the message body in
 * `msgdata`, the data-coding in `coding`, the character set in `charset` and,
 * for a concatenated message, the User Data Header in `udhdata`. None of that
 * was ever surfaced, so the console could not tell an operator that a "long"
 * message actually cost three segments.
 *
 * The rules implemented here are the GSM 03.38 / 23.038 ones:
 *
 * | alphabet | payload octets | single segment | concatenated segment |
 * |----------|----------------|----------------|----------------------|
 * | GSM-7    | 140            | 160 septets    | 153 septets          |
 * | UCS-2    | 140            | 70 units       | 67 units             |
 * | 8-bit    | 140            | 140 octets     | 134 octets           |
 *
 * A concatenated part carries a 6-octet UDH (1 UDHL + a 5-octet 8-bit-reference
 * concatenation IE), which is what turns 160 into 153 and 70 into 67. When the
 * row already carries a UDH for another purpose (port addressing, for example)
 * those octets come off the payload as well, and concatenating such a message
 * costs a further 5 octets for the added IE — the UDHL byte already exists.
 *
 * When the stored UDH itself declares the part count (IEI 0x00 with an 8-bit
 * reference, or IEI 0x08 with a 16-bit one) that declaration is authoritative
 * and is returned verbatim: the engine has already told us how many parts the
 * message was split into, and re-deriving it from one part's text would be
 * guesswork.
 */

/**
 * GSM 03.38 default alphabet. ESC (0x1B) is deliberately excluded: it is the
 * escape prefix, not a writable character.
 */
const GSM7_BASIC = new Set(
  (
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
    ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
    '¿abcdefghijklmnopqrstuvwxyzäöñüà' +
    'ÆæßÉ'
  ).split(''),
);

/** GSM 03.38 extension table. Each of these costs TWO septets (ESC + code). */
const GSM7_EXTENDED = new Set('\f^{}\\[~]|€'.split(''));

export type MessageAlphabet = 'gsm7' | 'ucs2' | 'binary';

export interface SegmentInput {
  /** `msgdata` — the message body as stored by the engine. */
  text?: string | null;
  /** `coding` — Kannel DCS coding: 0 = GSM-7, 1 = 8-bit, 2 = UCS-2, -1/null = undeclared. */
  coding?: number | string | null;
  /** `charset` — used to disambiguate when `coding` is undeclared. */
  charset?: string | null;
  /** `udhdata` — raw octets or a hex string; empty/absent means no UDH. */
  udhData?: string | null;
}

export interface SegmentBreakdown {
  /** Number of SMS parts the message occupies. Never below 1. */
  segments: number;
  alphabet: MessageAlphabet;
  /** Units counted: septets (GSM-7), UTF-16 code units (UCS-2) or octets (8-bit). */
  length: number;
  /** Capacity of a single, unconcatenated segment. */
  singleCapacity: number;
  /** Capacity of each segment once the message is concatenated. */
  multipartCapacity: number;
  /** Octets the stored UDH consumes on every segment (0 when there is none). */
  udhOctets: number;
  /** True when the UDH declared the part count, so `segments` was not derived. */
  declaredByUdh: boolean;
}

/** Total payload octets in one SMS TPDU. */
const PAYLOAD_OCTETS = 140;
/** Octets a concatenation IE adds when no UDH exists yet (UDHL + IEI + len + 3). */
const CONCAT_UDH_OCTETS = 6;
/** Octets it adds to an EXISTING UDH (IEI + len + 3 — the UDHL byte is already there). */
const CONCAT_IE_OCTETS = 5;

/** Decodes `udhdata` into octets. Accepts a hex string or raw 8-bit characters. */
function udhOctetsOf(value: string | null | undefined): number[] {
  if (typeof value !== 'string' || !value.length) return [];
  const trimmed = value.trim();
  if (!trimmed.length) return [];
  if (trimmed.length % 2 === 0 && /^[0-9a-f]+$/i.test(trimmed)) {
    const octets: number[] = [];
    for (let index = 0; index < trimmed.length; index += 2)
      octets.push(parseInt(trimmed.slice(index, index + 2), 16));
    return octets;
  }
  return [...trimmed].map((character) => character.charCodeAt(0) & 0xff);
}

/**
 * Total part count declared by a concatenation information element, or null.
 * IEI 0x00 = 8-bit reference (ref, total, seq); IEI 0x08 = 16-bit (ref hi, ref
 * lo, total, seq).
 */
function declaredParts(octets: number[]): number | null {
  if (octets.length < 2) return null;
  const headerLength = octets[0];
  const end = Math.min(headerLength + 1, octets.length);
  let cursor = 1;
  while (cursor + 1 < end) {
    const iei = octets[cursor];
    const length = octets[cursor + 1];
    const body = octets.slice(cursor + 2, cursor + 2 + length);
    if (iei === 0x00 && body.length >= 2 && body[1] > 0) return body[1];
    if (iei === 0x08 && body.length >= 3 && body[2] > 0) return body[2];
    cursor += 2 + length;
  }
  return null;
}

/** True when every character is representable in the GSM 03.38 alphabet. */
export function isGsm7Encodable(text: string): boolean {
  for (const character of text)
    if (!GSM7_BASIC.has(character) && !GSM7_EXTENDED.has(character)) return false;
  return true;
}

/** Cost of each character in the alphabet's own units, in order. */
function characterCosts(text: string, alphabet: MessageAlphabet): number[] {
  if (alphabet === 'gsm7')
    return [...text].map((character) => (GSM7_EXTENDED.has(character) ? 2 : 1));
  if (alphabet === 'ucs2') return [...text].map((character) => character.length);
  return new Array(text.length).fill(1);
}

/**
 * Greedy packing. A two-unit character (a GSM-7 escape sequence, a UCS-2
 * surrogate pair) is never split across a segment boundary, which is what the
 * GSM specification requires and what a naive `ceil(length / capacity)` gets
 * wrong for text with such characters near a boundary.
 */
function pack(costs: number[], capacity: number): number {
  if (capacity <= 0) return Math.max(1, costs.length);
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > capacity) {
      segments += 1;
      used = cost;
    } else used += cost;
  }
  return segments;
}

/** Septets that fit in the given number of payload octets. */
const septets = (octets: number) => Math.floor((octets * 8) / 7);

function resolveAlphabet(input: SegmentInput, text: string): MessageAlphabet {
  const coding =
    input.coding === null || input.coding === undefined || input.coding === ''
      ? null
      : Number(input.coding);
  if (coding === 0) return 'gsm7';
  if (coding === 1) return 'binary';
  if (coding === 2) return 'ucs2';
  // Undeclared (or Kannel's DC_UNDEF = -1): fall back to the charset, then to
  // what the text itself can actually be encoded as.
  const charset = typeof input.charset === 'string' ? input.charset.trim().toLowerCase() : '';
  if (/ucs-?2|utf-?16/.test(charset)) return 'ucs2';
  if (/binary|octet/.test(charset)) return 'binary';
  return isGsm7Encodable(text) ? 'gsm7' : 'ucs2';
}

/**
 * Full segment accounting for one engine row. Never throws: an unparseable UDH
 * or an absent body degrades to a single-segment answer rather than an error,
 * because this runs while rendering a message grid.
 */
export function describeSegments(input: SegmentInput): SegmentBreakdown {
  const text = typeof input.text === 'string' ? input.text : '';
  const alphabet = resolveAlphabet(input, text);
  const octets = udhOctetsOf(input.udhData);
  const udhOctets = octets.length ? Math.min(octets[0] + 1, PAYLOAD_OCTETS) : 0;
  const concatenatedUdhOctets =
    udhOctets === 0 ? CONCAT_UDH_OCTETS : Math.min(udhOctets + CONCAT_IE_OCTETS, PAYLOAD_OCTETS);

  const capacityFor = (headerOctets: number) => {
    const payload = Math.max(0, PAYLOAD_OCTETS - headerOctets);
    if (alphabet === 'gsm7') return septets(payload);
    if (alphabet === 'ucs2') return Math.floor(payload / 2);
    return payload;
  };
  const singleCapacity = capacityFor(udhOctets);
  const multipartCapacity = capacityFor(concatenatedUdhOctets);

  const costs = characterCosts(text, alphabet);
  const length = costs.reduce((total, cost) => total + cost, 0);

  const declared = declaredParts(octets);
  if (declared !== null)
    return {
      segments: Math.max(1, declared),
      alphabet,
      length,
      singleCapacity,
      multipartCapacity,
      udhOctets,
      declaredByUdh: true,
    };

  const segments = length <= singleCapacity ? 1 : pack(costs, multipartCapacity);
  return {
    segments: Math.max(1, segments),
    alphabet,
    length,
    singleCapacity,
    multipartCapacity,
    udhOctets,
    declaredByUdh: false,
  };
}

/** Convenience wrapper: just the part count. */
export function countSegments(input: SegmentInput): number {
  return describeSegments(input).segments;
}
