import {
  applyRouteRule,
  describeEffectProblem,
  describeOverrides,
  type OutboundMessage,
} from './route-overrides';

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  sender: 'URASMS',
  recipient: '256772000118',
  text: 'Your OTP is 448120',
  ...overrides,
});

describe('the sender-id failover the document describes', () => {
  it('rewrites the sender and records both values', () => {
    // "Ordinal 2 Rule is set and ENABLED to act as a failover for MTN traffic
    // ... SenderID overwrites to 7077 for all MTN traffic."
    const result = applyRouteRule(message(), { action: 'route', overrideSender: '7077' }, 'UraMtn-failover');
    expect(result.decision).toBe('send');
    if (result.decision !== 'send') throw new Error('unreachable');

    expect(result.message.sender).toBe('7077');
    // Both values, because six months from now the question is "the customer
    // says URASMS, the subscriber saw 7077 — what happened".
    expect(result.overrides.sender).toEqual({ from: 'URASMS', to: '7077' });
    expect(result.summary).toContain('UraMtn-failover rewrote sender URASMS → 7077');
  });

  it('does not mutate the message it was given', () => {
    const original = message();
    applyRouteRule(original, { action: 'route', overrideSender: '7077' });
    expect(original.sender).toBe('URASMS');
  });

  it('records nothing when the override equals the current value', () => {
    // A no-op override must not fill the audit trail with changes that were not
    // changes; otherwise a real rewrite is buried among them.
    const result = applyRouteRule(message(), { action: 'route', overrideSender: 'URASMS' });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.overrides).toEqual({});
    expect(result.summary).toBeNull();
  });

  it('treats a blank override as no override at all', () => {
    const result = applyRouteRule(message(), { action: 'route', overrideSender: '   ' });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.message.sender).toBe('URASMS');
    expect(result.overrides).toEqual({});
  });

  it('trims a padded override rather than sending the padding', () => {
    const result = applyRouteRule(message(), { action: 'route', overrideSender: '  7077 ' });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.message.sender).toBe('7077');
  });

  it('handles a message that had no sender at all', () => {
    const result = applyRouteRule(message({ sender: null }), {
      action: 'route',
      overrideSender: '7077',
    });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.overrides.sender).toEqual({ from: null, to: '7077' });
    expect(describeOverrides(result.overrides)).toContain('(none) → 7077');
  });
});

describe('recipient and body overrides', () => {
  it('rewrites the recipient, recording the original', () => {
    const result = applyRouteRule(message(), { action: 'route', overrideRecipient: '256700111222' });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.message.recipient).toBe('256700111222');
    expect(result.overrides.recipient).toEqual({ from: '256772000118', to: '256700111222' });
  });

  it('records only the LENGTH of a replaced body, never the body', () => {
    // The decision row is not a masked read path and lands in exports.
    // Copying subscriber content into it would route around Phase 6 entirely.
    const result = applyRouteRule(message(), {
      action: 'route',
      overrideText: 'Service notice',
    });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(result.overrides.text).toEqual({ from: '18 characters', to: 'Service notice' });
    expect(JSON.stringify(result.overrides)).not.toContain('448120');
  });

  it('applies several overrides in one pass', () => {
    const result = applyRouteRule(message(), {
      action: 'route',
      overrideSender: '7077',
      overrideRecipient: '256700111222',
    });
    if (result.decision !== 'send') throw new Error('unreachable');
    expect(Object.keys(result.overrides).sort()).toEqual(['recipient', 'sender']);
  });
});

describe('dropping traffic', () => {
  it('refuses the message and carries the reason', () => {
    // "Ordinal 1 : Unknown is dropping all traffic of unknown networks."
    const result = applyRouteRule(
      message(),
      { action: 'drop', dropReason: 'Unknown network prefix' },
      'Unknown',
    );
    expect(result.decision).toBe('drop');
    if (result.decision !== 'drop') throw new Error('unreachable');
    expect(result.reason).toBe('Unknown network prefix');
    expect(result.summary).toBe('Dropped by Unknown: Unknown network prefix.');
  });

  it('says "no reason recorded" rather than inventing a plausible one', () => {
    // A rule written before migration 052, or by a direct SQL edit, can still
    // arrive without a reason.
    const result = applyRouteRule(message(), { action: 'drop' });
    if (result.decision !== 'drop') throw new Error('unreachable');
    expect(result.reason).toBe('No reason recorded on the rule.');
  });
});

describe('describeEffectProblem', () => {
  it('demands a reason for a drop', () => {
    expect(describeEffectProblem({ action: 'drop' })).toContain('must state why');
    expect(describeEffectProblem({ action: 'drop', dropReason: 'ab' })).toContain('must state why');
    expect(describeEffectProblem({ action: 'drop', dropReason: 'Unknown network' })).toBeNull();
  });

  it('refuses a drop that also carries overrides', () => {
    // Incoherent: nothing is sent, so there is nothing to rewrite. A rule whose
    // author believed it did two things must not silently do one.
    expect(
      describeEffectProblem({ action: 'drop', dropReason: 'Unknown', overrideSender: '7077' }),
    ).toContain('nothing to rewrite');
  });

  it('refuses a blank override that would erase the field', () => {
    expect(describeEffectProblem({ action: 'route', overrideSender: '' })).toContain(
      'would erase the field',
    );
    expect(describeEffectProblem({ action: 'route', overrideRecipient: '  ' })).toContain(
      'overrideRecipient',
    );
  });

  it('accepts an omitted override, which simply means no override', () => {
    expect(describeEffectProblem({ action: 'route' })).toBeNull();
    expect(describeEffectProblem({ action: 'route', overrideSender: null })).toBeNull();
    expect(describeEffectProblem({})).toBeNull();
  });

  it('refuses an action it does not know', () => {
    expect(describeEffectProblem({ action: 'delete' as never })).toContain('must be "route"');
  });
});
