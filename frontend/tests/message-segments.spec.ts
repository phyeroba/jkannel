import { describe, expect, it } from 'vitest';
import {
  CONCAT_IE_OCTETS,
  CONCAT_UDH_OCTETS,
  GSM7_BASIC_CHARS,
  GSM7_EXTENDED_CHARS,
  PAYLOAD_OCTETS,
  SEGMENT_LIMITS,
  countSegments,
  describeComposerText,
  describeSegments,
  isGsm7Encodable,
  nonGsm7Characters,
} from '../src/utils/message-segments';

/**
 * These are deliberately the SAME boundaries `backend/src/engine/
 * message-segments.spec.ts` asserts. The composer computes segments
 * client-side (a round trip per keystroke is not an option), so the only thing
 * keeping the two implementations honest is that they are held to one set of
 * numbers. If a case is added on one side, add it on the other.
 */

/** `n` copies of a single-septet GSM-7 character. */
const gsm = (n: number) => 'a'.repeat(n);
/** `n` UCS-2 code units of a character that is NOT in the GSM-7 alphabet. */
const ucs2 = (n: number) => 'あ'.repeat(n);

/**
 * A concatenation UDH: UDHL=5, IEI=0x00 (8-bit reference), IE length 3,
 * reference, total parts, sequence number.
 */
const concatUdh = (total: number, sequence = 1) =>
  [
    '05',
    '00',
    '03',
    'aa',
    total.toString(16).padStart(2, '0'),
    sequence.toString(16).padStart(2, '0'),
  ].join('');

describe('constants mirrored from the backend', () => {
  /**
   * `backend/src/engine/message-segments.ts` exports these specifically so a
   * client-side mirror copies them rather than retyping them. Pin the values
   * here: if the backend's table ever changes, this is the test that should
   * fail first.
   */
  it('publishes the same capacity table the backend does', () => {
    expect(SEGMENT_LIMITS).toEqual({
      gsm7: { single: 160, multipart: 153 },
      ucs2: { single: 70, multipart: 67 },
      binary: { single: 140, multipart: 134 },
    });
    expect(PAYLOAD_OCTETS).toBe(140);
    expect(CONCAT_UDH_OCTETS).toBe(6);
    expect(CONCAT_IE_OCTETS).toBe(5);
  });

  it('carries the GSM 03.38 alphabet verbatim', () => {
    // 128 default-alphabet positions minus ESC, which is not a writable char.
    expect(GSM7_BASIC_CHARS).toHaveLength(127);
    expect(GSM7_EXTENDED_CHARS).toBe('\f^{}\\[~]|€');
    // Spot-check the positions most often mistyped in a hand-copied table.
    for (const character of '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞ¡§¿ÄÖÑÜäöñüàÆæßÉ¤')
      expect(GSM7_BASIC_CHARS).toContain(character);
    expect(GSM7_BASIC_CHARS).toContain('\n');
    expect(GSM7_BASIC_CHARS).toContain('\r');
  });

  it('derives every capacity from the same payload arithmetic', () => {
    // 140 octets - 6 UDH octets = 134 octets = floor(134*8/7) = 153 septets.
    expect(Math.floor(((PAYLOAD_OCTETS - CONCAT_UDH_OCTETS) * 8) / 7)).toBe(
      SEGMENT_LIMITS.gsm7.multipart,
    );
    expect(Math.floor((PAYLOAD_OCTETS - CONCAT_UDH_OCTETS) / 2)).toBe(
      SEGMENT_LIMITS.ucs2.multipart,
    );
  });
});

describe('GSM-7 alphabet detection', () => {
  it('accepts the default alphabet and the extension table', () => {
    expect(isGsm7Encodable('Hello, world! @£$¥ ÄÖÑÜ àäöñü')).toBe(true);
    expect(isGsm7Encodable('^{}[]~|\\€')).toBe(true);
  });
  it('rejects anything the default alphabet cannot carry', () => {
    expect(isGsm7Encodable('あ')).toBe(false);
    expect(isGsm7Encodable('naïve')).toBe(false); // ï is not in GSM 03.38
    expect(isGsm7Encodable('🙂')).toBe(false);
    expect(isGsm7Encodable('it’s')).toBe(false); // curly apostrophe
  });
});

describe('GSM-7 segment boundaries (160 / 153)', () => {
  it.each([
    [1, 1],
    [159, 1],
    [160, 1],
    [161, 2],
    [306, 2],
    [307, 3],
    [459, 3],
    [460, 4],
  ])('%i GSM-7 septets is %i segment(s)', (length, expected) => {
    expect(countSegments({ text: gsm(length), coding: 0 })).toBe(expected);
  });

  it('reports the capacities it used', () => {
    expect(describeSegments({ text: gsm(200), coding: 0 })).toMatchObject({
      alphabet: 'gsm7',
      length: 200,
      singleCapacity: 160,
      multipartCapacity: 153,
      udhOctets: 0,
      declaredByUdh: false,
      segments: 2,
    });
  });

  it('charges two septets for an extension-table character', () => {
    // 159 plain + one escaped char = 161 septets -> two segments.
    expect(countSegments({ text: `${gsm(159)}€`, coding: 0 })).toBe(2);
    expect(describeSegments({ text: `${gsm(159)}€`, coding: 0 }).length).toBe(161);
    // 158 plain + one escaped char = 160 septets -> still one.
    expect(countSegments({ text: `${gsm(158)}€`, coding: 0 })).toBe(1);
    // The braces are extension-table characters too.
    expect(describeSegments({ text: '{}', coding: 0 }).length).toBe(4);
  });

  it('never splits an escape sequence across a segment boundary', () => {
    // 152 plain septets then an escaped char: the escape pair cannot straddle
    // the 153-septet boundary, so it moves whole into the next segment.
    const text = `${gsm(152)}€${gsm(200)}`;
    const breakdown = describeSegments({ text, coding: 0 });
    expect(breakdown.length).toBe(354);
    expect(breakdown.segments).toBe(3);
    expect(countSegments({ text: `${gsm(152)}€${gsm(153)}`, coding: 0 })).toBe(3);
  });
});

describe('UCS-2 segment boundaries (70 / 67)', () => {
  it.each([
    [1, 1],
    [69, 1],
    [70, 1],
    [71, 2],
    [134, 2],
    [135, 3],
  ])('%i UCS-2 units is %i segment(s)', (length, expected) => {
    expect(countSegments({ text: ucs2(length), coding: 2 })).toBe(expected);
  });

  it('counts UTF-16 code units, so a surrogate pair costs two', () => {
    const breakdown = describeSegments({ text: '🙂'.repeat(35), coding: 2 });
    expect(breakdown.length).toBe(70);
    expect(breakdown.segments).toBe(1);
    expect(countSegments({ text: '🙂'.repeat(36), coding: 2 })).toBe(2);
  });

  it('never splits a surrogate pair across a boundary', () => {
    // 66 units then a 2-unit pair: the pair moves whole past the 67 boundary.
    const text = `${ucs2(66)}🙂${ucs2(100)}`;
    expect(describeSegments({ text, coding: 2 }).length).toBe(168);
    expect(describeSegments({ text, coding: 2 }).segments).toBe(3);
  });

  it('reports the UCS-2 capacities', () => {
    expect(describeSegments({ text: ucs2(100), coding: 2 })).toMatchObject({
      alphabet: 'ucs2',
      singleCapacity: 70,
      multipartCapacity: 67,
      segments: 2,
    });
  });
});

describe('8-bit binary segment boundaries (140 / 134)', () => {
  it.each([
    [140, 1],
    [141, 2],
    [268, 2],
    [269, 3],
  ])('%i octets is %i segment(s)', (length, expected) => {
    expect(countSegments({ text: 'x'.repeat(length), coding: 1 })).toBe(expected);
  });
});

describe('alphabet inference when coding is not declared', () => {
  it('uses GSM-7 for text the default alphabet can carry', () => {
    expect(describeSegments({ text: gsm(161) })).toMatchObject({ alphabet: 'gsm7', segments: 2 });
    expect(describeSegments({ text: gsm(161), coding: -1 }).alphabet).toBe('gsm7');
    expect(describeSegments({ text: gsm(161), coding: null }).alphabet).toBe('gsm7');
  });
  it('falls back to UCS-2 for text it cannot', () => {
    expect(describeSegments({ text: ucs2(71) })).toMatchObject({ alphabet: 'ucs2', segments: 2 });
  });
  it('believes the charset over the text when one is recorded', () => {
    expect(describeSegments({ text: gsm(71), charset: 'UCS-2' })).toMatchObject({
      alphabet: 'ucs2',
      segments: 2,
    });
    expect(describeSegments({ text: gsm(71), charset: 'UTF-16BE' }).alphabet).toBe('ucs2');
  });
  it('lets an explicit coding override the charset and the text', () => {
    expect(describeSegments({ text: ucs2(10), coding: 0, charset: 'UTF-8' }).alphabet).toBe('gsm7');
  });
});

describe('UDH-concatenated messages', () => {
  it('takes the part count the UDH declares, rather than re-deriving it', () => {
    const breakdown = describeSegments({ text: gsm(10), coding: 0, udhData: concatUdh(3, 1) });
    expect(breakdown.segments).toBe(3);
    expect(breakdown.declaredByUdh).toBe(true);
  });

  it('reads a 16-bit reference concatenation IE (IEI 0x08) too', () => {
    expect(countSegments({ text: gsm(10), coding: 0, udhData: '0608040001' + '0402' })).toBe(4);
  });

  it('accepts a raw-octet UDH as well as a hex one', () => {
    const raw = String.fromCharCode(0x05, 0x00, 0x03, 0xaa, 0x02, 0x01);
    expect(countSegments({ text: gsm(10), coding: 0, udhData: raw })).toBe(2);
  });

  it('charges a non-concatenation UDH against every segment', () => {
    const portUdh = '060504' + '0b84' + '0b84';
    const breakdown = describeSegments({ text: gsm(200), coding: 0, udhData: portUdh });
    expect(breakdown.declaredByUdh).toBe(false);
    expect(breakdown.udhOctets).toBe(7);
    expect(breakdown.singleCapacity).toBe(152);
    expect(breakdown.multipartCapacity).toBe(146);
    expect(breakdown.segments).toBe(2);
  });

  it('ignores an empty or unparseable UDH rather than failing', () => {
    expect(countSegments({ text: gsm(10), coding: 0, udhData: '' })).toBe(1);
    expect(countSegments({ text: gsm(10), coding: 0, udhData: '   ' })).toBe(1);
    expect(countSegments({ text: gsm(10), coding: 0, udhData: 'zz' })).toBe(1);
  });
});

describe('degenerate input', () => {
  it('is one segment for an absent or empty body, never zero', () => {
    expect(countSegments({})).toBe(1);
    expect(countSegments({ text: null })).toBe(1);
    expect(countSegments({ text: '' })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The composer view of the same numbers.
// ---------------------------------------------------------------------------

describe('composer counter', () => {
  it('counts down the first GSM-7 segment and flips at 161', () => {
    expect(describeComposerText('')).toMatchObject({
      characters: 0,
      length: 0,
      segments: 1,
      alphabet: 'gsm7',
      alphabetLabel: 'GSM-7',
      currentCapacity: 160,
      remainingInSegment: 160,
      multipart: false,
      forcedUcs2: false,
    });
    expect(describeComposerText(gsm(159))).toMatchObject({
      segments: 1,
      remainingInSegment: 1,
      multipart: false,
    });
    expect(describeComposerText(gsm(160))).toMatchObject({
      segments: 1,
      remainingInSegment: 0,
      multipart: false,
    });
    expect(describeComposerText(gsm(161))).toMatchObject({
      segments: 2,
      currentCapacity: 153,
      // 153 in the first part, 8 in the second.
      remainingInSegment: 145,
      multipart: true,
    });
  });

  it('uses the 153-septet capacity once concatenated', () => {
    expect(describeComposerText(gsm(306))).toMatchObject({
      segments: 2,
      currentCapacity: 153,
      remainingInSegment: 0,
    });
    expect(describeComposerText(gsm(307))).toMatchObject({ segments: 3, remainingInSegment: 152 });
  });

  it('collapses to UCS-2 (70/67) on a single non-GSM character and says which', () => {
    const info = describeComposerText(`${gsm(80)}’`); // a curly apostrophe
    expect(info.alphabet).toBe('ucs2');
    expect(info.alphabetLabel).toBe('UCS-2');
    expect(info.singleCapacity).toBe(70);
    expect(info.multipartCapacity).toBe(67);
    expect(info.forcedUcs2).toBe(true);
    expect(info.offendingCharacters).toEqual(['’']);
    // 81 units of UCS-2 is two parts; the same 81 characters in GSM-7 is one.
    expect(info.segments).toBe(2);
    expect(info.segmentsIfGsm7).toBe(1);
  });

  it('treats an emoji as one character, two units, and never splits the pair', () => {
    const one = describeComposerText('🙂');
    expect(one.characters).toBe(1);
    expect(one.length).toBe(2);
    expect(one.alphabet).toBe('ucs2');
    expect(one.forcedUcs2).toBe(true);
    expect(one.offendingCharacters).toEqual(['🙂']);

    expect(describeComposerText('🙂'.repeat(35))).toMatchObject({
      characters: 35,
      length: 70,
      segments: 1,
      remainingInSegment: 0,
    });
    expect(describeComposerText('🙂'.repeat(36))).toMatchObject({ segments: 2 });

    // 66 UCS-2 units, then a surrogate pair that cannot straddle 67.
    const straddling = describeComposerText(`${ucs2(66)}🙂${ucs2(100)}`);
    expect(straddling.length).toBe(168);
    expect(straddling.segments).toBe(3);
  });

  it('reports UCS-2 boundaries at 70 and 71', () => {
    expect(describeComposerText(ucs2(70))).toMatchObject({
      segments: 1,
      currentCapacity: 70,
      remainingInSegment: 0,
    });
    expect(describeComposerText(ucs2(71))).toMatchObject({
      segments: 2,
      currentCapacity: 67,
      remainingInSegment: 63,
    });
  });

  it('charges an escape character two septets without leaving GSM-7', () => {
    const info = describeComposerText(`${gsm(158)}€`);
    expect(info.alphabet).toBe('gsm7');
    expect(info.characters).toBe(159);
    expect(info.length).toBe(160);
    expect(info.segments).toBe(1);
    expect(info.remainingInSegment).toBe(0);
    expect(info.forcedUcs2).toBe(false);
    expect(describeComposerText(`${gsm(159)}€`).segments).toBe(2);
  });

  it('lists each distinct non-GSM character once, capped', () => {
    expect(nonGsm7Characters('naïve café “quoted”')).toEqual(['ï', '“', '”']);
    expect(nonGsm7Characters('あいうえおかきくけこ')).toHaveLength(6);
  });
});
