import {
  CONCAT_IE_OCTETS,
  CONCAT_UDH_OCTETS,
  GSM7_BASIC_CHARS,
  GSM7_EXTENDED_CHARS,
  PAYLOAD_OCTETS,
  SEGMENT_LIMITS,
  countSegments,
  describeSegments,
  isGsm7Encodable,
  previewSegments,
} from './message-segments';

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

describe('GSM-7 alphabet detection', () => {
  it('accepts the default alphabet and the extension table', () => {
    expect(isGsm7Encodable('Hello, world! @£$¥ ÄÖÑÜ àäöñü')).toBe(true);
    expect(isGsm7Encodable('^{}[]~|\\€')).toBe(true);
  });
  it('rejects anything the default alphabet cannot carry', () => {
    expect(isGsm7Encodable('あ')).toBe(false);
    expect(isGsm7Encodable('naïve')).toBe(false); // ï is not in GSM 03.38
    expect(isGsm7Encodable('🙂')).toBe(false);
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
    const breakdown = describeSegments({ text: gsm(200), coding: 0 });
    expect(breakdown).toMatchObject({
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
  });

  it('never splits an escape sequence across a segment boundary', () => {
    // 152 plain septets then an escaped char: the escape pair cannot straddle
    // the 153-septet boundary, so it moves whole into the next segment.
    const text = `${gsm(152)}€${gsm(200)}`;
    const breakdown = describeSegments({ text, coding: 0 });
    expect(breakdown.length).toBe(354);
    // A naive ceil(354/153) would say 3; the pair that cannot be split makes 4.
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
    // coding=0 says GSM-7 even though the text needs UCS-2; the engine's own
    // declaration wins because it is what was actually put on the wire.
    expect(describeSegments({ text: ucs2(10), coding: 0, charset: 'UTF-8' }).alphabet).toBe('gsm7');
  });
});

describe('UDH-concatenated messages', () => {
  it('takes the part count the UDH declares, rather than re-deriving it', () => {
    // One short part of a 3-part message: the text alone would say "1".
    const breakdown = describeSegments({ text: gsm(10), coding: 0, udhData: concatUdh(3, 1) });
    expect(breakdown.segments).toBe(3);
    expect(breakdown.declaredByUdh).toBe(true);
  });

  it('reads a 16-bit reference concatenation IE (IEI 0x08) too', () => {
    // UDHL=6, IEI=08, len=04, ref hi, ref lo, total=04, seq=02
    expect(countSegments({ text: gsm(10), coding: 0, udhData: '0608040001' + '0402' })).toBe(4);
  });

  it('accepts a raw-octet UDH as well as a hex one', () => {
    const raw = String.fromCharCode(0x05, 0x00, 0x03, 0xaa, 0x02, 0x01);
    expect(countSegments({ text: gsm(10), coding: 0, udhData: raw })).toBe(2);
  });

  it('charges a non-concatenation UDH against every segment', () => {
    // Port addressing: UDHL=6, IEI=05, len=04, then 4 octets. 7 UDH octets.
    const portUdh = '060504' + '0b84' + '0b84';
    const breakdown = describeSegments({ text: gsm(200), coding: 0, udhData: portUdh });
    expect(breakdown.declaredByUdh).toBe(false);
    expect(breakdown.udhOctets).toBe(7);
    // 140 - 7 = 133 octets -> 152 septets in a single part.
    expect(breakdown.singleCapacity).toBe(152);
    // Concatenating adds a 5-octet IE (the UDHL byte already exists):
    // 140 - 12 = 128 octets -> 146 septets.
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

/**
 * These pin the contract the CLIENT-SIDE MIRROR is written against. The
 * composer needs a live counter as the operator types and cannot call the API
 * per keystroke, so the browser re-implements these rules; if any constant here
 * changes without the mirror changing, the composer and the message log start
 * disagreeing about what a message costs.
 */
describe('the surface a client-side mirror depends on', () => {
  it('publishes the boundary table both sides must agree on', () => {
    expect(SEGMENT_LIMITS).toEqual({
      gsm7: { single: 160, multipart: 153 },
      ucs2: { single: 70, multipart: 67 },
      binary: { single: 140, multipart: 134 },
    });
  });

  it('derives that table from the octet constants rather than restating it', () => {
    expect(PAYLOAD_OCTETS).toBe(140);
    expect(CONCAT_UDH_OCTETS).toBe(6);
    expect(CONCAT_IE_OCTETS).toBe(5);
    expect(Math.floor((PAYLOAD_OCTETS * 8) / 7)).toBe(SEGMENT_LIMITS.gsm7.single);
    expect(Math.floor(((PAYLOAD_OCTETS - CONCAT_UDH_OCTETS) * 8) / 7)).toBe(
      SEGMENT_LIMITS.gsm7.multipart,
    );
    expect(Math.floor(PAYLOAD_OCTETS / 2)).toBe(SEGMENT_LIMITS.ucs2.single);
    expect(Math.floor((PAYLOAD_OCTETS - CONCAT_UDH_OCTETS) / 2)).toBe(
      SEGMENT_LIMITS.ucs2.multipart,
    );
  });

  it('publishes the two GSM-7 tables verbatim', () => {
    // 128 characters, ESC excluded (it is the escape prefix, not writable).
    expect(GSM7_BASIC_CHARS).toHaveLength(127);
    expect(GSM7_EXTENDED_CHARS).toBe('\f^{}\\[~]|€');
    for (const character of GSM7_BASIC_CHARS) expect(isGsm7Encodable(character)).toBe(true);
    for (const character of GSM7_EXTENDED_CHARS) expect(isGsm7Encodable(character)).toBe(true);
    expect(isGsm7Encodable('あ')).toBe(false);
  });
});

describe('previewSegments', () => {
  it('counts down the remaining room in the current segment', () => {
    expect(previewSegments({ text: gsm(0) })).toMatchObject({
      characters: 0,
      segments: 1,
      perSegment: 160,
      remaining: 160,
    });
    expect(previewSegments({ text: gsm(159) })).toMatchObject({ remaining: 1, segments: 1 });
    expect(previewSegments({ text: gsm(160) })).toMatchObject({ remaining: 0, segments: 1 });
    // The 161st septet tips it into two 153-septet parts: 153 + 8 used.
    expect(previewSegments({ text: gsm(161) })).toMatchObject({
      segments: 2,
      perSegment: 153,
      remaining: 145,
    });
  });

  it('takes the remainder from the same greedy walk that fixed the part count', () => {
    // 152 plain septets then '€' (2 septets): the escape cannot straddle the
    // 153-septet boundary, so part 1 ends at 152 and part 2 opens with it.
    // A naive perSegment*segments - length would say 152 free; the real answer
    // is 151, because one septet of part 1 was stranded.
    const text = `${gsm(152)}€${gsm(7)}`;
    const preview = previewSegments({ text, coding: 0 });
    expect(preview.length).toBe(161);
    expect(preview.segments).toBe(2);
    // Part 1 holds 152 of its 153 septets; part 2 opens with the escape pair
    // and then 7 more, so 144 are free — not 145.
    expect(preview.remaining).toBe(144);
    // Naive arithmetic (perSegment * segments - length) would say 145.
    expect(preview.perSegment * preview.segments - preview.length).toBe(145);
  });

  it('counts code points as characters but alphabet units as length', () => {
    expect(previewSegments({ text: '🙂🙂' })).toMatchObject({
      characters: 2,
      length: 4,
      alphabet: 'ucs2',
    });
    expect(previewSegments({ text: '€' })).toMatchObject({
      characters: 1,
      length: 2,
      alphabet: 'gsm7',
    });
  });

  it('never disagrees with the accounting applied to a stored engine row', () => {
    for (const text of [gsm(1), gsm(160), gsm(161), ucs2(70), ucs2(71), '🙂', `${gsm(70)}€`]) {
      const preview = previewSegments({ text });
      const stored = describeSegments({ text });
      expect(preview.segments).toBe(stored.segments);
      expect(preview.alphabet).toBe(stored.alphabet);
      expect(preview.length).toBe(stored.length);
    }
  });
});
