import {
  DEFAULT_TOLERANCE_SECONDS,
  REDACTED,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  generateWebhookSecret,
  hasSecret,
  openSecret,
  redactSecret,
  sealSecret,
  signBody,
  verifySignature,
} from './webhook-secret';

/**
 * The key is read from the environment at call time, so it is set here rather
 * than in a global setup file — these tests must fail loudly if it is missing,
 * not silently share another suite's key.
 */
const ORIGINAL = process.env.MFA_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(48);
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.MFA_ENCRYPTION_KEY;
  else process.env.MFA_ENCRYPTION_KEY = ORIGINAL;
});

describe('sealing a stored secret', () => {
  it('does not leave the plaintext anywhere in the stored value', () => {
    const sealed = sealSecret({ secret: 'hunter2', method: 'POST' });
    expect(JSON.stringify(sealed)).not.toContain('hunter2');
    expect(sealed.method).toBe('POST');
  });

  it('round-trips back to the original at send time', () => {
    expect(openSecret(sealSecret({ secret: 'hunter2' }))).toBe('hunter2');
  });

  it('is idempotent, so re-saving a record cannot double-encrypt', () => {
    const once = sealSecret({ secret: 'hunter2' });
    const twice = sealSecret(once);
    expect(twice).toEqual(once);
    expect(openSecret(twice)).toBe('hunter2');
  });

  it('drops the key when a caller echoes back a redacted read', () => {
    // The failure this prevents: reading a channel (secret === REDACTED),
    // changing the name, PUTting the whole object back, and overwriting the
    // real secret with the literal string "__redacted__" — after which every
    // webhook is signed with a credential the receiver has never seen.
    const sealed = sealSecret({ secret: REDACTED, name: 'ops' });
    expect(sealed).not.toHaveProperty('secret');
    expect(sealed.name).toBe('ops');
  });

  it('reads a legacy plaintext row so existing destinations keep working', () => {
    expect(openSecret({ secret: 'written-before-encryption-existed' })).toBe(
      'written-before-encryption-existed',
    );
  });

  it('returns null rather than throwing when the value cannot be decrypted', () => {
    // A row encrypted under a key that has since been rotated away. Throwing
    // here would stall the delivery worker on every attempt forever; returning
    // null sends the hook unsigned, which the receiver rejects cleanly.
    expect(openSecret({ secret: 'v1:AAAA:BBBB:CCCC' })).toBeNull();
  });

  it('reports whether a secret is set without revealing it', () => {
    expect(hasSecret({ secret: 'x' })).toBe(true);
    expect(hasSecret({ secret: REDACTED })).toBe(false);
    expect(hasSecret({})).toBe(false);
    expect(redactSecret({ secret: 'x', k: 1 })).toEqual({ secret: REDACTED, k: 1 });
  });
});

describe('signing a webhook body', () => {
  const SECRET = 'shared-with-the-receiver';
  const BODY = '{"event":"delivered","id":"42"}';

  it('never puts the secret on the wire', () => {
    // This is the defect the change exists to fix: the old code sent
    // `x-jkannel-signature: <secret>` verbatim.
    const headers = signBody(SECRET, BODY);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it('produces a signature the receiver can verify', () => {
    const headers = signBody(SECRET, BODY);
    expect(
      verifySignature(SECRET, BODY, headers[SIGNATURE_HEADER], headers[TIMESTAMP_HEADER]),
    ).toEqual({ ok: true });
  });

  it('is different for a different body, so a captured header cannot be reused', () => {
    const at = 1_759_000_000;
    const a = signBody(SECRET, BODY, at);
    const b = signBody(SECRET, '{"event":"delivered","id":"43"}', at);
    expect(a[SIGNATURE_HEADER]).not.toBe(b[SIGNATURE_HEADER]);
  });

  it('rejects a valid signature replayed outside the tolerance window', () => {
    const at = 1_759_000_000;
    const headers = signBody(SECRET, BODY, at);
    const result = verifySignature(
      SECRET,
      BODY,
      headers[SIGNATURE_HEADER],
      headers[TIMESTAMP_HEADER],
      {
        nowSeconds: at + DEFAULT_TOLERANCE_SECONDS + 1,
      },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('tolerance') });
  });

  it('rejects a body altered after signing', () => {
    const headers = signBody(SECRET, BODY);
    const result = verifySignature(
      SECRET,
      '{"event":"failed","id":"42"}',
      headers[SIGNATURE_HEADER],
      headers[TIMESTAMP_HEADER],
    );
    expect(result).toEqual({ ok: false, reason: 'signature does not match' });
  });

  it('rejects the wrong secret', () => {
    const headers = signBody(SECRET, BODY);
    expect(
      verifySignature('not-the-secret', BODY, headers[SIGNATURE_HEADER], headers[TIMESTAMP_HEADER]),
    ).toEqual({ ok: false, reason: 'signature does not match' });
  });

  it('names which header is missing rather than failing vaguely', () => {
    expect(verifySignature(SECRET, BODY, undefined, '1')).toEqual({
      ok: false,
      reason: `missing ${SIGNATURE_HEADER}`,
    });
    expect(verifySignature(SECRET, BODY, 'v1=aa', undefined)).toEqual({
      ok: false,
      reason: `missing ${TIMESTAMP_HEADER}`,
    });
  });

  it('does not throw when the presented signature is a different length', () => {
    // timingSafeEqual throws on a length mismatch; that must be caught rather
    // than surfacing as a 500 that tells an attacker their guess was the wrong
    // SHAPE, which is itself a signal.
    expect(() =>
      verifySignature(SECRET, BODY, 'v1=abcd', String(Math.floor(Date.now() / 1000))),
    ).not.toThrow();
  });

  it('sends nothing at all when no secret is configured', () => {
    expect(signBody(null, BODY)).toEqual({});
  });

  it('generates secrets that differ', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    expect(generateWebhookSecret().length).toBeGreaterThan(32);
  });
});
