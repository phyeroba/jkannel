import { generateTotp, newTotpSecret, totpUri, verifyTotp } from './identity-totp';

describe('identity-totp', () => {
  it('verifies a freshly generated token', async () => {
    const secret = newTotpSecret();
    const token = generateTotp(secret);
    expect(await verifyTotp(secret, token)).toBe(true);
  });

  it('rejects an incorrect token', async () => {
    const secret = newTotpSecret();
    const token = generateTotp(secret);
    const wrong = token === '000000' ? '111111' : '000000';
    expect(await verifyTotp(secret, wrong)).toBe(false);
  });

  it('rejects malformed (non 6-digit) input without throwing', async () => {
    expect(await verifyTotp(newTotpSecret(), 'abc')).toBe(false);
    expect(await verifyTotp(newTotpSecret(), '')).toBe(false);
  });

  it('builds a scannable otpauth URI', () => {
    const uri = totpUri('operator', newTotpSecret());
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=');
  });
});
