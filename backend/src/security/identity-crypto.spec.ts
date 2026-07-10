import {
  decryptSecret,
  encryptSecret,
  normalizeRecoveryCode,
  safeHexEqual,
  sha256Hex,
} from './identity-crypto';

describe('identity-crypto', () => {
  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = 'unit-test-mfa-encryption-key-of-40+bytes!!';
  });

  it('round-trips a secret and never exposes the plaintext', () => {
    const encoded = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(encoded).not.toContain('JBSWY3DPEHPK3PXP');
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(decryptSecret(encoded)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a random IV so ciphertexts differ', () => {
    expect(encryptSecret('abc')).not.toBe(encryptSecret('abc'));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const parts = encryptSecret('secret').split(':');
    parts[3] = Buffer.from('tampered-data').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('falls back to the auth signing key when no dedicated key is set', () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.AUTH_ACCESS_TOKEN_KEY;
    process.env.AUTH_SIGNING_KEY = 'auth-signing-key-that-is-at-least-32-bytes';
    const encoded = encryptSecret('roundtrip');
    expect(decryptSecret(encoded)).toBe('roundtrip');
  });

  it('throws when no key material is configured', () => {
    const saved = {
      mfa: process.env.MFA_ENCRYPTION_KEY,
      access: process.env.AUTH_ACCESS_TOKEN_KEY,
      signing: process.env.AUTH_SIGNING_KEY,
    };
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.AUTH_ACCESS_TOKEN_KEY;
    delete process.env.AUTH_SIGNING_KEY;
    try {
      expect(() => encryptSecret('x')).toThrow(/MFA encryption key/);
    } finally {
      if (saved.mfa) process.env.MFA_ENCRYPTION_KEY = saved.mfa;
      if (saved.access) process.env.AUTH_ACCESS_TOKEN_KEY = saved.access;
      if (saved.signing) process.env.AUTH_SIGNING_KEY = saved.signing;
    }
  });

  it('normalizes recovery-code formatting before hashing', () => {
    expect(normalizeRecoveryCode('AB cd-EF')).toBe('abcdef');
  });

  it('compares digests in constant time', () => {
    expect(safeHexEqual(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(safeHexEqual(sha256Hex('a'), sha256Hex('b'))).toBe(false);
  });
});
