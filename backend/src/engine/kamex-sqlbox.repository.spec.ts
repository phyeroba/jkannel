import { parseDeliveryReceipt } from './kamex-sqlbox.repository';

describe('parseDeliveryReceipt', () => {
  it('returns null when the carrier sends no receipt detail', () => {
    // What the live carrier actually sends, url-encoded, for every DLR.
    expect(parseDeliveryReceipt('ACK%2F')).toBeNull();
    expect(parseDeliveryReceipt('')).toBeNull();
    expect(parseDeliveryReceipt(null)).toBeNull();
  });

  it('pulls every field out of a standard SMPP receipt', () => {
    expect(
      parseDeliveryReceipt(
        'id:0B7A2F sub:001 dlvrd:001 submit date:2609030710 done date:2609030711 stat:DELIVRD err:000 text:Hi',
      ),
    ).toEqual({
      messageId: '0B7A2F',
      stat: 'DELIVRD',
      err: '000',
      submitDate: '2609030710',
      doneDate: '2609030711',
      submitted: 1,
      delivered: 1,
    });
  });

  it('decodes a url-encoded body, because that is how it arrives', () => {
    // Without decoding, `submit date:` never matches — the space is %20.
    const parsed = parseDeliveryReceipt(
      'id%3AX1%20submit%20date%3A2609030710%20stat%3AUNDELIV%20err%3A011',
    );
    expect(parsed?.stat).toBe('UNDELIV');
    expect(parsed?.err).toBe('011');
    expect(parsed?.submitDate).toBe('2609030710');
  });

  it('keeps the fields it can read when others are absent', () => {
    // One missing field must not lose the rest.
    expect(parseDeliveryReceipt('stat:EXPIRED')).toEqual({
      messageId: null,
      stat: 'EXPIRED',
      err: null,
      submitDate: null,
      doneDate: null,
      submitted: null,
      delivered: null,
    });
  });
});
