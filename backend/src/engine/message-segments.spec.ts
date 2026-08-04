import { countSegments, describeSegments, isGsm7Encodable } from './message-segments';

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
