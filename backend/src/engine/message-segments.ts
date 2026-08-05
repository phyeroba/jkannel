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
 *
 * ---------------------------------------------------------------------------
 * MIRRORING THIS MODULE IN THE BROWSER
 * ---------------------------------------------------------------------------
 * The composer needs a LIVE segment counter as the operator types, and calling
 * `POST /messages/preview` per keystroke would be absurd. The client therefore
 * re-implements the same rules — so this module is written to be mirrored
 * exactly rather than approximated, and everything a mirror needs is exported:
 *
 *   {@link GSM7_BASIC_CHARS}      the default-alphabet character set, verbatim
 *   {@link GSM7_EXTENDED_CHARS}   the extension table (each char costs 2 septets)
 *   {@link SEGMENT_LIMITS}        {gsm7|ucs2|binary} -> {single, multipart}
 *   {@link PAYLOAD_OCTETS} / {@link CONCAT_UDH_OCTETS} / {@link CONCAT_IE_OCTETS}
 *   {@link previewSegments}       the exact function the endpoint returns
 *
 * The three rules a mirror must reproduce, in order:
 *   1. alphabet: coding 0/1/2 wins; else charset; else GSM-7 if every character
 *      is in BASIC|EXTENDED, otherwise UCS-2.
 *   2. cost per character: GSM-7 extension chars = 2 septets, everything else
 *      1; UCS-2 = the character's UTF-16 length (a surrogate pair costs 2);
 *      8-bit = 1 octet per UTF-16 code unit.
 *   3. packing: one segment if the total fits {@link SEGMENT_LIMITS}.single;
 *      otherwise GREEDY packing at .multipart where a 2-unit character is never
 *      split across a boundary. `ceil(length / capacity)` is WRONG for text
 *      with an escape or a surrogate pair landing on a boundary.
 *
 * `message-segments.spec.ts` pins every boundary these rules produce, so a
 * mirror can be validated against the same table.
 */

/**
 * GSM 03.38 default alphabet, verbatim, so a client-side mirror can copy one
 * string rather than retype 128 characters. ESC (0x1B) is deliberately
 * excluded: it is the escape prefix, not a writable character.
 */
export const GSM7_BASIC_CHARS =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  'ÆæßÉ';

/** GSM 03.38 extension table. Each of these costs TWO septets (ESC + code). */
export const GSM7_EXTENDED_CHARS = '\f^{}\\[~]|€';

const GSM7_BASIC = new Set(GSM7_BASIC_CHARS.split(''));

const GSM7_EXTENDED = new Set(GSM7_EXTENDED_CHARS.split(''));

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
  /**
   * Capacity of the segment the text currently ends in: `singleCapacity` for a
   * one-part message, `multipartCapacity` once it has split.
   */
  perSegment: number;
  /**
   * Units still free in that last segment, from the same greedy walk that
   * produced `segments`. Never negative.
   */
  remaining: number;
}

/** Total payload octets in one SMS TPDU. */
export const PAYLOAD_OCTETS = 140;
/** Octets a concatenation IE adds when no UDH exists yet (UDHL + IEI + len + 3). */
export const CONCAT_UDH_OCTETS = 6;
/** Octets it adds to an EXISTING UDH (IEI + len + 3 — the UDHL byte is already there). */
export const CONCAT_IE_OCTETS = 5;

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
 *
 * Returns the part count AND how much of the LAST part is consumed, because the
 * composer's "characters left in this segment" readout must come from the same
 * walk that decided the part count rather than from a second, subtly different
 * calculation.
 */
function pack(costs: number[], capacity: number): { segments: number; used: number } {
  if (capacity <= 0) return { segments: Math.max(1, costs.length), used: 0 };
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > capacity) {
      segments += 1;
      used = cost;
    } else used += cost;
  }
  return { segments, used };
}

/** Septets that fit in the given number of payload octets. */
const septets = (octets: number) => Math.floor((octets * 8) / 7);

/** Units of `alphabet` that fit once `headerOctets` of UDH are deducted. */
function capacityFor(alphabet: MessageAlphabet, headerOctets: number): number {
  const payload = Math.max(0, PAYLOAD_OCTETS - headerOctets);
  if (alphabet === 'gsm7') return septets(payload);
  if (alphabet === 'ucs2') return Math.floor(payload / 2);
  return payload;
}

/**
 * THE boundary table, derived from the octet constants above rather than
 * written out, so there is exactly one definition of truth for both this
 * module and the client-side mirror:
 *
 *   gsm7   160 / 153 septets
 *   ucs2    70 /  67 UTF-16 code units
 *   binary 140 / 134 octets
 *
 * `single` applies to a message that fits in one part; `multipart` to every
 * part of a concatenated one (the 6-octet concatenation UDH comes off the
 * payload). A message carrying its own UDH has smaller capacities still — read
 * them from {@link SegmentBreakdown.singleCapacity} / `.multipartCapacity`
 * rather than from this table.
 */
export const SEGMENT_LIMITS: Readonly<
  Record<MessageAlphabet, { readonly single: number; readonly multipart: number }>
> = {
  gsm7: { single: capacityFor('gsm7', 0), multipart: capacityFor('gsm7', CONCAT_UDH_OCTETS) },
  ucs2: { single: capacityFor('ucs2', 0), multipart: capacityFor('ucs2', CONCAT_UDH_OCTETS) },
  binary: {
    single: capacityFor('binary', 0),
    multipart: capacityFor('binary', CONCAT_UDH_OCTETS),
  },
};

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

  const singleCapacity = capacityFor(alphabet, udhOctets);
  const multipartCapacity = capacityFor(alphabet, concatenatedUdhOctets);

  const costs = characterCosts(text, alphabet);
  const length = costs.reduce((total, cost) => total + cost, 0);

  const declared = declaredParts(octets);
  if (declared !== null) {
    const segments = Math.max(1, declared);
    const perSegment = segments > 1 ? multipartCapacity : singleCapacity;
    return {
      segments,
      alphabet,
      length,
      singleCapacity,
      multipartCapacity,
      udhOctets,
      declaredByUdh: true,
      perSegment,
      // The engine handed us ONE part of a message it already split, so the
      // text we hold is that part's text: what is free is what is free in it.
      remaining: Math.max(0, perSegment - length),
    };
  }

  if (length <= singleCapacity)
    return {
      segments: 1,
      alphabet,
      length,
      singleCapacity,
      multipartCapacity,
      udhOctets,
      declaredByUdh: false,
      perSegment: singleCapacity,
      remaining: singleCapacity - length,
    };

  const packed = pack(costs, multipartCapacity);
  return {
    segments: Math.max(1, packed.segments),
    alphabet,
    length,
    singleCapacity,
    multipartCapacity,
    udhOctets,
    declaredByUdh: false,
    perSegment: multipartCapacity,
    remaining: Math.max(0, multipartCapacity - packed.used),
  };
}

/** Convenience wrapper: just the part count. */
export function countSegments(input: SegmentInput): number {
  return describeSegments(input).segments;
}

/**
 * What a composer needs BEFORE the message is sent, in the shape the segment
 * endpoint returns it.
 */
export interface SegmentPreview {
  /** User-visible characters, counting an astral character (emoji) as one. */
  characters: number;
  segments: number;
  alphabet: MessageAlphabet;
  /** Capacity of the segment the text currently ends in. */
  perSegment: number;
  /** Units still free in that segment. */
  remaining: number;
  /** Units consumed in total (septets / UTF-16 code units / octets). */
  length: number;
  singleCapacity: number;
  multipartCapacity: number;
  udhOctets: number;
  declaredByUdh: boolean;
}

/**
 * Segment accounting for text a caller is about to send. Same rules, same
 * numbers and the same code path as the accounting applied to a stored engine
 * row — a composer that says "2 segments" and a message log that then says "2
 * segments" cannot disagree, because there is only one implementation.
 *
 * Pure and side-effect free: no I/O, no engine call, no allocation beyond the
 * text itself.
 */
export function previewSegments(input: SegmentInput): SegmentPreview {
  const breakdown = describeSegments(input);
  const text = typeof input.text === 'string' ? input.text : '';
  return {
    // Code POINTS, not UTF-16 units: "🙂".length is 2, but the operator typed
    // one character and expects the counter to say so. The billing-relevant
    // number is `length` / `segments`, which stay in the alphabet's own units.
    characters: [...text].length,
    segments: breakdown.segments,
    alphabet: breakdown.alphabet,
    perSegment: breakdown.perSegment,
    remaining: breakdown.remaining,
    length: breakdown.length,
    singleCapacity: breakdown.singleCapacity,
    multipartCapacity: breakdown.multipartCapacity,
    udhOctets: breakdown.udhOctets,
    declaredByUdh: breakdown.declaredByUdh,
  };
}
