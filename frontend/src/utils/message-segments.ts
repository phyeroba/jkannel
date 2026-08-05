/**
 * SMS segment (multi-part) accounting for the message composers.
 *
 * PORTED FROM — and kept deliberately in step with —
 * `backend/src/engine/message-segments.ts`
 * (tests: `backend/src/engine/message-segments.spec.ts`).
 *
 * The console needs this answer on every keystroke, which rules out asking the
 * API: a round trip per character is both slow and a needless load. So the
 * authoritative implementation is duplicated here rather than approximated,
 * and the unit tests in `tests/message-segments.spec.ts` assert the SAME
 * boundaries the backend spec asserts (160/161, 153, 70/71, 67, an escape
 * character costing two septets, a surrogate pair never being split). If you
 * change the rules in one place, change them in both — the two files reference
 * each other by path precisely so the pair stays findable.
 *
 * The rules are the GSM 03.38 / 23.038 ones:
 *
 * | alphabet | payload octets | single segment | concatenated segment |
 * |----------|----------------|----------------|----------------------|
 * | GSM-7    | 140            | 160 septets    | 153 septets          |
 * | UCS-2    | 140            | 70 units       | 67 units             |
 * | 8-bit    | 140            | 140 octets     | 134 octets           |
 *
 * A concatenated part carries a 6-octet UDH (1 UDHL + a 5-octet 8-bit-reference
 * concatenation IE), which is what turns 160 into 153 and 70 into 67.
 */

/**
 * GSM 03.38 default alphabet, copied VERBATIM from the backend's exported
 * `GSM7_BASIC_CHARS` so the two cannot drift by a typo. ESC (0x1B) is
 * deliberately excluded: it is the escape prefix, not a writable character.
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
  /** The message body. */
  text?: string | null;
  /** Kannel DCS coding: 0 = GSM-7, 1 = 8-bit, 2 = UCS-2, -1/null = undeclared. */
  coding?: number | string | null;
  /** Used to disambiguate when `coding` is undeclared. */
  charset?: string | null;
  /** Raw octets or a hex string; empty/absent means no UDH. */
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
export const PAYLOAD_OCTETS = 140;
/** Octets a concatenation IE adds when no UDH exists yet (UDHL + IEI + len + 3). */
export const CONCAT_UDH_OCTETS = 6;
/** Octets it adds to an EXISTING UDH (IEI + len + 3 — the UDHL byte is already there). */
export const CONCAT_IE_OCTETS = 5;

/** Septets that fit in the given number of payload octets. */
const septets = (octets: number) => Math.floor((octets * 8) / 7);

/** Characters of `alphabet` that fit once `headerOctets` are spent on a UDH. */
function capacityFor(alphabet: MessageAlphabet, headerOctets: number): number {
  const payload = Math.max(0, PAYLOAD_OCTETS - headerOctets);
  if (alphabet === 'gsm7') return septets(payload);
  if (alphabet === 'ucs2') return Math.floor(payload / 2);
  return payload;
}

/**
 * The published per-alphabet capacity table, mirroring the backend's exported
 * `SEGMENT_LIMITS`: 160/153 GSM-7 septets, 70/67 UCS-2 units, 140/134 octets.
 * Derived rather than retyped, exactly as the backend derives it.
 *
 * `single` applies to a message that fits in one part; `multipart` to every
 * part of a concatenated one. A message carrying its own UDH has smaller
 * capacities still — read those from the breakdown, not from this table.
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

/**
 * Every distinct character the GSM 03.38 alphabet cannot carry, in the order
 * they first appear. Backend-side nobody needs this — the coding is already
 * decided by the time a row is stored. In a composer it is the whole point:
 * "one curly quote collapsed your limit from 160 to 70" is only actionable if
 * the console can say WHICH character did it.
 */
export function nonGsm7Characters(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  for (const character of text) {
    if (GSM7_BASIC.has(character) || GSM7_EXTENDED.has(character)) continue;
    seen.add(character);
    if (seen.size >= limit) break;
  }
  return [...seen];
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
 * The backend returns only the part count; the composer also needs how full the
 * LAST part is, to say "n characters left in this segment". Same loop, one more
 * value out of it.
 */
function packInto(costs: number[], capacity: number): { segments: number; usedInLast: number } {
  if (capacity <= 0) return { segments: Math.max(1, costs.length), usedInLast: 0 };
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > capacity) {
      segments += 1;
      used = cost;
    } else used += cost;
  }
  return { segments, usedInLast: used };
}

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
 * Full segment accounting for one message. Never throws: an unparseable UDH or
 * an absent body degrades to a single-segment answer rather than an error.
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

  const segments = length <= singleCapacity ? 1 : packInto(costs, multipartCapacity).segments;
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

// ---------------------------------------------------------------------------
// Composer extension. Nothing below changes the accounting above; it only adds
// the things a live counter needs and a stored row does not.
// ---------------------------------------------------------------------------

/** Human label for the alphabet, as an operator reading an SMS bill knows it. */
export const ALPHABET_LABELS: Record<MessageAlphabet, string> = {
  gsm7: 'GSM-7',
  ucs2: 'UCS-2',
  binary: '8-bit',
};

export interface ComposerSegmentInfo extends SegmentBreakdown {
  /** Characters as a human counts them — code points, so an emoji counts once. */
  characters: number;
  /** GSM-7 / UCS-2 / 8-bit. */
  alphabetLabel: string;
  /** Capacity of the segment currently being filled. */
  currentCapacity: number;
  /** Units still free in the current segment. Never negative. */
  remainingInSegment: number;
  /** True once the body no longer fits in one segment. */
  multipart: boolean;
  /**
   * True when the text would have been GSM-7 but for characters the default
   * alphabet cannot carry — the 160→70 collapse that produces surprise bills.
   */
  forcedUcs2: boolean;
  /** The offending characters, so the operator can find and replace them. */
  offendingCharacters: string[];
  /** Segments the same text would cost in GSM-7, when `forcedUcs2`. */
  segmentsIfGsm7: number | null;
}

/**
 * Live per-keystroke accounting for composed text. The composer never declares
 * a coding — the operator types, and the engine picks the alphabet — so this
 * always goes through the inference path, exactly as a submitted message will.
 */
export function describeComposerText(value: string): ComposerSegmentInfo {
  const text = typeof value === 'string' ? value : '';
  const breakdown = describeSegments({ text });
  const costs = characterCosts(text, breakdown.alphabet);
  const currentCapacity =
    breakdown.segments <= 1 ? breakdown.singleCapacity : breakdown.multipartCapacity;
  const usedInLast =
    breakdown.segments <= 1
      ? breakdown.length
      : packInto(costs, breakdown.multipartCapacity).usedInLast;

  const forcedUcs2 = breakdown.alphabet === 'ucs2';
  return {
    ...breakdown,
    characters: [...text].length,
    alphabetLabel: ALPHABET_LABELS[breakdown.alphabet],
    currentCapacity,
    remainingInSegment: Math.max(0, currentCapacity - usedInLast),
    multipart: breakdown.segments > 1,
    forcedUcs2,
    offendingCharacters: forcedUcs2 ? nonGsm7Characters(text) : [],
    // What the operator would pay if those characters were replaced. Only worth
    // computing when UCS-2 was forced, and only meaningful for non-empty text.
    segmentsIfGsm7:
      forcedUcs2 && text.length
        ? describeSegments({ text: stripNonGsm7(text), coding: 0 }).segments
        : null,
  };
}

/**
 * Replaces every non-GSM-7 character with a single-septet placeholder so the
 * "what would this cost in GSM-7" comparison keeps the same character count.
 * A curly quote becomes a straight one in the operator's head; this models that
 * without pretending to be a transliteration table.
 */
function stripNonGsm7(text: string): string {
  let out = '';
  for (const character of text)
    out += GSM7_BASIC.has(character) || GSM7_EXTENDED.has(character) ? character : '?';
  return out;
}
