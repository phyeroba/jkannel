import { MASKING_NOTICE, maskBody, maskMsisdn, maskRow, maskRows } from './masking';

describe('maskMsisdn', () => {
  it('keeps the country prefix and the last two digits', () => {
    expect(maskMsisdn('+256772000118')).toBe('+2567••••••18');
  });

  it('masks a number written without a plus', () => {
    expect(maskMsisdn('256772000118')).toBe('2567••••••18');
  });

  it('hides every digit between the head and the tail', () => {
    const masked = maskMsisdn('+256772000118')!;
    // The literal proof that nothing identifying survives: no digit of the
    // subscriber part appears in the output.
    expect(masked.slice(5, -2)).toBe('•'.repeat(6));
    expect(masked).not.toContain('7200');
  });

  it('returns a short code unchanged, because it identifies a service', () => {
    expect(maskMsisdn('8000')).toBe('8000');
    expect(maskMsisdn('611')).toBe('611');
  });

  it('returns an alphanumeric sender id unchanged', () => {
    expect(maskMsisdn('JKANNEL')).toBe('JKANNEL');
    expect(maskMsisdn('MTN-UG')).toBe('MTN-UG');
  });

  it('passes null and empty through rather than inventing a value', () => {
    expect(maskMsisdn(null)).toBeNull();
    expect(maskMsisdn(undefined)).toBeNull();
    expect(maskMsisdn('')).toBe('');
  });
});

describe('maskBody', () => {
  it('replaces the content but preserves the length, which is a billing fact', () => {
    expect(maskBody('Your OTP is 448120')).toBe('[18 characters hidden]');
    expect(maskBody('x'.repeat(480))).toBe('[480 characters hidden]');
  });

  it('leaks no character of the original', () => {
    const secret = 'PIN 9931 for account 4455';
    const masked = maskBody(secret)!;
    expect(masked).not.toContain('9931');
    expect(masked).not.toContain('4455');
  });

  it('leaves an empty body empty', () => {
    expect(maskBody('')).toBe('');
    expect(maskBody(null)).toBeNull();
  });
});

describe('maskRow', () => {
  it('masks every PII field this codebase actually uses', () => {
    const row = maskRow({
      sender: 'JKANNEL',
      receiver: '+256772000118',
      destination: '+256700123456',
      sender_digits: '256772000118',
      receiver_digits: '256700123456',
      text: 'hello there',
      msgdata: 'hello there',
      body: 'hello there',
    });
    expect(row.receiver).toBe('+2567••••••18');
    expect(row.destination).toBe('+2567••••••56');
    expect(row.sender_digits).toBe('2567••••••18');
    expect(row.receiver_digits).toBe('2567••••••56');
    expect(row.text).toBe('[11 characters hidden]');
    expect(row.msgdata).toBe('[11 characters hidden]');
    expect(row.body).toBe('[11 characters hidden]');
    // A service sender id stays readable — that is the point of the exception.
    expect(row.sender).toBe('JKANNEL');
  });

  it('leaves non-PII columns exactly as they were', () => {
    const row = maskRow({
      id: 4231,
      smsc_id: 'kololo',
      status: 'delivered',
      dlr_mask: 31,
      receiver: '+256772000118',
    });
    expect(row.id).toBe(4231);
    expect(row.smsc_id).toBe('kololo');
    expect(row.status).toBe('delivered');
    expect(row.dlr_mask).toBe(31);
  });

  it('does not mutate the row it was given', () => {
    const original = { receiver: '+256772000118', text: 'hello' };
    maskRow(original);
    expect(original.receiver).toBe('+256772000118');
    expect(original.text).toBe('hello');
  });

  it('does not invent fields the row did not have', () => {
    const row = maskRow({ id: 1 });
    expect(Object.keys(row)).toEqual(['id']);
  });

  it('masks every row of a page', () => {
    const rows = maskRows([{ receiver: '+256772000118' }, { receiver: '+256700123456' }]);
    expect(rows.map((r) => r.receiver)).toEqual(['+2567••••••18', '+2567••••••56']);
  });
});

describe('MASKING_NOTICE', () => {
  it('warns that a masked value must not be quoted onward', () => {
    // The notice exists so an operator does not paste `+2567••••••18` into a
    // carrier ticket believing it is the number. If it stops saying so, it has
    // stopped doing its job.
    expect(MASKING_NOTICE).toMatch(/do not quote it to a carrier/i);
    expect(MASKING_NOTICE).toContain('messages.reveal');
  });
});
