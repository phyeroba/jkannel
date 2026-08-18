import {
  DEFAULT_DEDUPE_WINDOW_SECONDS,
  MAX_DEDUPE_WINDOW_SECONDS,
  dedupeKey,
  describeDuplicate,
  isReferenceKey,
  normalizeWindowSeconds,
  type DedupeSubject,
} from './mt-dedupe';

const subject = (overrides: Partial<DedupeSubject> = {}): DedupeSubject => ({
  tenantId: '1',
  sender: 'URASMS',
  recipient: '256772000118',
  text: 'Your OTP is 448120',
  ...overrides,
});

describe('the key', () => {
  it('is stable for identical submissions', () => {
    expect(dedupeKey(subject())).toBe(dedupeKey(subject()));
  });

  it('differs for a different recipient, sender or body', () => {
    const base = dedupeKey(subject());
    expect(dedupeKey(subject({ recipient: '256700123456' }))).not.toBe(base);
    expect(dedupeKey(subject({ sender: 'OTHER' }))).not.toBe(base);
    expect(dedupeKey(subject({ text: 'Your OTP is 448121' }))).not.toBe(base);
  });

  it('differs across tenants for identical traffic', () => {
    // A shared key would have one tenant silently suppressing another's sends.
    expect(dedupeKey(subject({ tenantId: '2' }))).not.toBe(dedupeKey(subject({ tenantId: '1' })));
  });

  it('cannot be collided by shifting a boundary between fields', () => {
    // `sender="A", recipient="BC"` must not hash the same as
    // `sender="AB", recipient="C"`.
    expect(dedupeKey(subject({ sender: 'A', recipient: 'BC', text: '' }))).not.toBe(
      dedupeKey(subject({ sender: 'AB', recipient: 'C', text: '' })),
    );
  });

  it('discloses nothing: it is a hash, not the message', () => {
    // This table would otherwise be a second, unmasked copy of every body,
    // sitting outside every Phase 6 masked read path.
    const key = dedupeKey(subject());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('448120');
    expect(key).not.toContain('256772');
  });
});

describe('an explicit client reference wins over content', () => {
  it('makes two different references two different messages', () => {
    // A client that gives two submissions two references is telling us they are
    // two messages, and it knows better than a content hash does.
    expect(dedupeKey(subject({ foreignId: 'ref-1' }))).not.toBe(
      dedupeKey(subject({ foreignId: 'ref-2' })),
    );
  });

  it('makes one reference one message even when the body changed', () => {
    // A retry with a corrected body is still one message; sending both is the
    // bug this prevents.
    expect(dedupeKey(subject({ foreignId: 'ref-1', text: 'first' }))).toBe(
      dedupeKey(subject({ foreignId: 'ref-1', text: 'second' })),
    );
  });

  it('ignores a blank reference and falls back to content', () => {
    expect(dedupeKey(subject({ foreignId: '   ' }))).toBe(dedupeKey(subject()));
    expect(isReferenceKey(subject({ foreignId: '  ' }))).toBe(false);
    expect(isReferenceKey(subject({ foreignId: 'ref-1' }))).toBe(true);
  });
});

describe('normalizeWindowSeconds', () => {
  it('honours 0 as "suppression off" rather than substituting the default', () => {
    // The correct setting for a tenant whose traffic is legitimately repetitive.
    expect(normalizeWindowSeconds(0)).toBe(0);
  });

  it('clamps to what the schema accepts', () => {
    expect(normalizeWindowSeconds(99999)).toBe(MAX_DEDUPE_WINDOW_SECONDS);
    expect(normalizeWindowSeconds(-5)).toBe(0);
    expect(normalizeWindowSeconds(30.9)).toBe(30);
  });

  it('falls back to the default rather than passing NaN to an interval cast', () => {
    expect(normalizeWindowSeconds('not a number')).toBe(DEFAULT_DEDUPE_WINDOW_SECONDS);
    expect(normalizeWindowSeconds(undefined)).toBe(DEFAULT_DEDUPE_WINDOW_SECONDS);
  });
});

describe('describeDuplicate', () => {
  it('tells the caller how to send it anyway', () => {
    // A refusal that reads as a generic error trains clients to retry harder,
    // which is the opposite of what this is for.
    const verdict = describeDuplicate(subject(), 60, '4231');
    expect(verdict.duplicate).toBe(true);
    expect(verdict.detail).toContain('within the last 60s');
    expect(verdict.detail).toContain('message 4231');
    expect(verdict.detail).toContain('distinct foreignId');
  });

  it('names the reference when that is what matched', () => {
    const verdict = describeDuplicate(subject({ foreignId: 'ref-1' }), 60, null);
    expect(verdict.detail).toContain('"ref-1"');
    expect(verdict.detail).toContain('Use a different reference');
  });

  it('omits the origin when the first submission is not known', () => {
    expect(describeDuplicate(subject(), 60, null).detail).not.toContain('The first one is');
  });
});
