import { describeMsisdnProblem, digitsOnly, normalizeMsisdn, toE164 } from './msisdn';

describe('digitsOnly', () => {
  it('keeps only digits, whatever the formatting', () => {
    expect(digitsOnly('+256 700-000 000')).toBe('256700000000');
    expect(digitsOnly('(256) 700.000.000')).toBe('256700000000');
    expect(digitsOnly(null)).toBe('');
  });
});

describe('normalizeMsisdn', () => {
  it('accepts an already-international address', () => {
    const result = normalizeMsisdn('+256700000000');
    expect(result).toMatchObject({ valid: true, digits: '256700000000', e164: '+256700000000' });
  });

  it('collapses the formatting variants of one subscriber to one number', () => {
    const forms = ['+256700000000', '256700000000', '00256700000000', '+256 700 000 000'];
    const canonical = forms.map((form) => normalizeMsisdn(form).digits);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('256700000000');
  });

  it('expands a national number using the configured country code', () => {
    expect(normalizeMsisdn('0700000000', '256').digits).toBe('256700000000');
    expect(normalizeMsisdn('0700000000', '+256').digits).toBe('256700000000');
  });

  it('refuses to guess a country when none is configured', () => {
    const result = normalizeMsisdn('0700000000', '');
    expect(result.valid).toBe(false);
    expect(result.digits).toBeNull();
  });

  it('does not strip a leading zero from a +-prefixed address', () => {
    // '+0…' is not a valid country code; it must not be silently rewritten.
    expect(normalizeMsisdn('+0700000000', '256').valid).toBe(false);
  });

  it('rejects empty, non-numeric, too-short and too-long addresses', () => {
    expect(normalizeMsisdn('').problem).toBe('empty');
    expect(normalizeMsisdn('   ').problem).toBe('empty');
    expect(normalizeMsisdn('abc').problem).toBe('no_digits');
    expect(normalizeMsisdn('+1234').problem).toBe('too_short');
    expect(normalizeMsisdn('+1234567890123456').problem).toBe('too_long');
  });

  it('describes why an address was rejected', () => {
    expect(describeMsisdnProblem(normalizeMsisdn('+1234'))).toContain('fewer than');
    expect(describeMsisdnProblem(normalizeMsisdn('+256700000000'))).toBe('destination is valid');
  });
});

describe('toE164', () => {
  it('renders the display form or null', () => {
    expect(toE164('256700000000')).toBe('+256700000000');
    expect(toE164('nonsense')).toBeNull();
  });
});
