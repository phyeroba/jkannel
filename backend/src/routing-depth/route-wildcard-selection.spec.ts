import { selectRoute, type CandidateRoute } from './route-selection';

/**
 * The wildcard route type, exercised through the REAL selector rather than
 * against the matcher in isolation — the property that matters is that a
 * wildcard route wins or loses against the prefix and static routes already in
 * the table, not that the pattern compiles.
 */

const route = (overrides: Partial<CandidateRoute>): CandidateRoute => ({
  id: 'r-1',
  name: 'route',
  priority: 10,
  enabled: true,
  routeType: 'wildcard',
  strategy: 'priority',
  targetSmscId: 'smsc-a',
  ...overrides,
});

describe('a wildcard route', () => {
  it('replaces the four prefix rules the document writes as one pattern', () => {
    const mtn = route({
      id: 'mtn',
      name: 'MTN Uganda',
      matchPrefix: '25677*|25678*|25676*|25679*',
      targetSmscId: 'mtn-bind',
    });

    for (const msisdn of ['256772000118', '256781234567', '256760000001', '256790000001'])
      expect(selectRoute([mtn], { msisdn }).smscId).toBe('mtn-bind');

    const airtel = selectRoute([mtn], { msisdn: '256700123456' });
    expect(airtel.smscId).toBeNull();
    expect(airtel.reason).toBeTruthy();
  });

  it('matches a destination written with a leading + or spaces', () => {
    const mtn = route({ matchPrefix: '25677*', targetSmscId: 'mtn-bind' });
    expect(selectRoute([mtn], { msisdn: '+256 772 000 118' }).smscId).toBe('mtn-bind');
  });

  it('loses to a more specific pattern', () => {
    const broad = route({ id: 'broad', name: 'catch-all', matchPrefix: '*', targetSmscId: 'default' });
    const narrow = route({
      id: 'narrow',
      name: 'MTN',
      matchPrefix: '25677*',
      targetSmscId: 'mtn-bind',
    });
    expect(selectRoute([broad, narrow], { msisdn: '256772000118' }).routeId).toBe('narrow');
    // And the catch-all still takes everything else.
    expect(selectRoute([broad, narrow], { msisdn: '256700123456' }).routeId).toBe('broad');
  });

  it('is ranked by its WIDEST alternative, not its narrowest', () => {
    // `25677*|*` matches everything, so it must not outrank a genuinely narrow
    // rule on the strength of its first branch. A pattern is only as specific
    // as its loosest option.
    const sneaky = route({ id: 'sneaky', matchPrefix: '25677*|*', targetSmscId: 'wrong' });
    const honest = route({ id: 'honest', matchPrefix: '2567*', targetSmscId: 'right' });
    expect(selectRoute([sneaky, honest], { msisdn: '256772000118' }).routeId).toBe('honest');
  });

  it('does not match when the pattern is blank, rather than matching everything', () => {
    const blank = route({ matchPrefix: '   ' });
    expect(selectRoute([blank], { msisdn: '256772000118' }).smscId).toBeNull();
  });

  it('is skipped when disabled, like every other route type', () => {
    const disabled = route({ matchPrefix: '*', enabled: false });
    expect(selectRoute([disabled], { msisdn: '256772000118' }).smscId).toBeNull();
  });

  it('honours a fallback when the primary bind is down', () => {
    const mtn = route({
      matchPrefix: '25677*',
      targetSmscId: 'mtn-primary',
      fallbackSmscId: 'mtn-backup',
    });
    const result = selectRoute([mtn], {
      msisdn: '256772000118',
      availableSmscIds: ['mtn-backup'],
    });
    expect(result.smscId).toBe('mtn-backup');
    expect(result.fallbackUsed).toBe(true);
  });
});

describe('the sender constraint, now matched as a wildcard', () => {
  it('still behaves exactly as an exact match for a pattern with no metacharacter', () => {
    // Every rule written before the grammar existed means "equals this", and
    // must keep meaning it.
    const rule = route({ routeType: 'static', matchPrefix: '', sender: 'URASMS' });
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'URASMS' }).smscId).toBe('smsc-a');
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'URAOTP' }).smscId).toBeNull();
    // Including the case where the message has no sender at all.
    expect(selectRoute([rule], { msisdn: '256772000118' }).smscId).toBeNull();
  });

  it('accepts a pattern across several sender ids', () => {
    const rule = route({ routeType: 'static', matchPrefix: '', sender: 'URASMS|URAOTP' });
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'URAOTP' }).smscId).toBe('smsc-a');
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'MTNADS' }).smscId).toBeNull();
  });

  it('accepts a prefixed family of sender ids', () => {
    const rule = route({ routeType: 'static', matchPrefix: '', sender: 'URA*' });
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'URABILLING' }).smscId).toBe(
      'smsc-a',
    );
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'NWSC' }).smscId).toBeNull();
  });

  it('constrains a wildcard destination route too', () => {
    const rule = route({ matchPrefix: '25677*', sender: 'URA*', targetSmscId: 'ura-mtn' });
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'URASMS' }).smscId).toBe('ura-mtn');
    expect(selectRoute([rule], { msisdn: '256772000118', sender: 'MTNADS' }).smscId).toBeNull();
  });
});
