import { describe, expect, it } from 'vitest';
import {
  REVEAL_MAX_MINUTES,
  clampMinutes,
  describeReasonProblem,
  describeRemaining,
  grantIsLive,
  privacyOf,
  reasonIsUsable,
  remainingMs,
  revealStatus,
  statesPrivacy,
  type RevealGrant,
} from '../src/utils/privacy';

const NOW = Date.parse('2026-08-18T09:00:00.000Z');

const grant = (overrides: Partial<RevealGrant> = {}): RevealGrant => ({
  id: 'g-1',
  reason: 'ticket 4412',
  scopeMessageRef: null,
  grantedAt: '2026-08-18T09:00:00.000Z',
  expiresAt: '2026-08-18T09:15:00.000Z',
  revealCount: 0,
  ...overrides,
});

describe('statesPrivacy', () => {
  it('distinguishes "not applicable" from "unmasked"', () => {
    // A read that carries no subscriber data attaches no privacy block, and its
    // screen must not sprout a masking notice. Absence is not "unmasked".
    expect(statesPrivacy({ items: [] })).toBe(false);
    expect(statesPrivacy(null)).toBe(false);
    expect(statesPrivacy({ privacy: { masked: false, notice: null } })).toBe(true);
    expect(privacyOf({ items: [] })).toBeNull();
  });

  it('reads the block when one is present', () => {
    const state = privacyOf({ privacy: { masked: true, notice: 'masked by default' } });
    expect(state?.masked).toBe(true);
    expect(state?.notice).toBe('masked by default');
  });
});

describe('the reason rule, enforced before the request goes out', () => {
  it('matches the API: at least three characters after trimming', () => {
    expect(reasonIsUsable('  ')).toBe(false);
    expect(reasonIsUsable(' ab ')).toBe(false);
    expect(reasonIsUsable('abc')).toBe(true);
  });

  it('says why, rather than only that it is invalid', () => {
    expect(describeReasonProblem('x')).toContain('recorded against every row');
    expect(describeReasonProblem('ticket 4412')).toBeNull();
  });
});

describe('clampMinutes', () => {
  it('never asks for a window the API would refuse', () => {
    expect(clampMinutes(100000)).toBe(REVEAL_MAX_MINUTES);
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(-5)).toBe(1);
    expect(clampMinutes(7.9)).toBe(7);
  });

  it('falls back to the default rather than sending NaN', () => {
    expect(clampMinutes(Number.NaN)).toBe(15);
  });
});

describe('the countdown', () => {
  it('counts down in seconds, so the window is visibly short', () => {
    expect(describeRemaining(grant(), NOW)).toBe('15m 0s left');
    expect(describeRemaining(grant(), NOW + 14 * 60_000)).toBe('1m 0s left');
    expect(describeRemaining(grant(), NOW + 14 * 60_000 + 45_000)).toBe('15s left');
  });

  it('says "expired" rather than a negative figure', () => {
    expect(describeRemaining(grant(), NOW + 20 * 60_000)).toBe('expired');
    expect(remainingMs(grant(), NOW + 20 * 60_000)).toBe(0);
    expect(grantIsLive(grant(), NOW + 20 * 60_000)).toBe(false);
  });

  it('treats an unparseable expiry as expired, not as unlimited', () => {
    // The failure mode being avoided: a malformed timestamp producing NaN,
    // which compares false everywhere and would read as a window that never
    // closes.
    expect(grantIsLive(grant({ expiresAt: 'not a date' }), NOW)).toBe(false);
  });

  it('has nothing to count when there is no grant', () => {
    expect(describeRemaining(null, NOW)).toBe('expired');
    expect(grantIsLive(null, NOW)).toBe(false);
  });
});

describe('revealStatus', () => {
  const masked = { masked: true, notice: 'Subscriber numbers are masked.' };

  it('renders nothing at all when the payload carries no PII', () => {
    expect(revealStatus(null, null, true, NOW).state).toBe('not-applicable');
  });

  it('offers the control only to an operator who may ask', () => {
    expect(revealStatus(masked, null, true, NOW).state).toBe('maskable');
    const denied = revealStatus(masked, null, false, NOW);
    expect(denied.state).toBe('no-permission');
    // Names the permission, so the operator knows what to ask their admin for.
    expect(denied.detail).toContain('messages.reveal');
  });

  it('renders the API notice verbatim rather than a paraphrase', () => {
    expect(revealStatus(masked, null, true, NOW).detail).toBe(masked.notice);
  });

  it('says the reveal is audited, while it is in force', () => {
    const state = revealStatus({ masked: false, notice: null }, grant(), true, NOW);
    expect(state.state).toBe('unmasked');
    expect(state.detail).toContain('15m 0s left');
    expect(state.detail).toContain('audited');
  });

  it('still says reads are audited when the grant is not in hand', () => {
    // Revealed by a grant this screen never loaded (another tab, say). The
    // audit statement must not depend on having the grant object.
    const state = revealStatus({ masked: false, notice: null }, null, true, NOW);
    expect(state.state).toBe('unmasked');
    expect(state.detail).toContain('audited');
  });
});
