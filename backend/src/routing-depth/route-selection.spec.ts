import { CandidateRoute, SelectionContext, isWithinWindow, selectRoute } from './route-selection';

/** Build a candidate route with sensible defaults for the field under test. */
function route(overrides: Partial<CandidateRoute>): CandidateRoute {
  return {
    id: overrides.id ?? 'r-1',
    name: overrides.name ?? 'route',
    priority: overrides.priority ?? 10,
    enabled: overrides.enabled ?? true,
    routeType: overrides.routeType ?? 'static',
    strategy: overrides.strategy ?? 'priority',
    targetSmscId: overrides.targetSmscId ?? 'smsc-primary',
    ...overrides,
  };
}

const ctx = (overrides: Partial<SelectionContext> & { msisdn: string }): SelectionContext =>
  overrides;

describe('selectRoute — matching', () => {
  it('returns no match when the destination has no digits', () => {
    const result = selectRoute([route({})], ctx({ msisdn: 'abc' }));
    expect(result.smscId).toBeNull();
    expect(result.reason).toContain('no dialable digits');
  });

  it('returns no match when nothing matches', () => {
    const routes = [route({ routeType: 'prefix', matchPrefix: '999' })];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000' }));
    expect(result.smscId).toBeNull();
    expect(result.routeId).toBeNull();
  });

  it('skips disabled routes', () => {
    const routes = [
      route({ id: 'off', enabled: false, targetSmscId: 'smsc-off' }),
      route({ id: 'on', priority: 20, targetSmscId: 'smsc-on' }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '256700000000' }));
    expect(result.routeId).toBe('on');
    expect(result.smscId).toBe('smsc-on');
  });

  it('treats a static route with no prefix as a catch-all', () => {
    const result = selectRoute([route({ targetSmscId: 'smsc-any' })], ctx({ msisdn: '123456' }));
    expect(result.smscId).toBe('smsc-any');
  });

  it('honours an exact sender constraint', () => {
    const routes = [route({ sender: 'BANK', targetSmscId: 'smsc-bank' })];
    expect(selectRoute(routes, ctx({ msisdn: '256700', sender: 'BANK' })).smscId).toBe('smsc-bank');
    expect(selectRoute(routes, ctx({ msisdn: '256700', sender: 'OTHER' })).smscId).toBeNull();
  });
});

describe('selectRoute — prefix / country / operator (longest match wins)', () => {
  it('prefers the longest matching prefix regardless of priority', () => {
    const routes = [
      route({
        id: 'short',
        routeType: 'prefix',
        matchPrefix: '256',
        priority: 1,
        targetSmscId: 'smsc-short',
      }),
      route({
        id: 'long',
        routeType: 'prefix',
        matchPrefix: '25670',
        priority: 99,
        targetSmscId: 'smsc-long',
      }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000' }));
    expect(result.routeId).toBe('long');
    expect(result.smscId).toBe('smsc-long');
  });

  it('matches by country code and strips the leading +', () => {
    const routes = [
      route({ id: 'ug', routeType: 'country', countryCode: '256', targetSmscId: 'smsc-ug' }),
      route({ id: 'ke', routeType: 'country', countryCode: '254', targetSmscId: 'smsc-ke' }),
    ];
    expect(selectRoute(routes, ctx({ msisdn: '+256700111222' })).smscId).toBe('smsc-ug');
    expect(selectRoute(routes, ctx({ msisdn: '254711000000' })).smscId).toBe('smsc-ke');
  });

  it('matches an operator route against the context operator', () => {
    const routes = [
      route({ id: 'mtn', routeType: 'operator', operator: 'MTN', targetSmscId: 'smsc-mtn' }),
      route({
        id: 'airtel',
        routeType: 'operator',
        operator: 'AIRTEL',
        targetSmscId: 'smsc-airtel',
      }),
    ];
    expect(selectRoute(routes, ctx({ msisdn: '256700', operator: 'AIRTEL' })).smscId).toBe(
      'smsc-airtel',
    );
    expect(selectRoute(routes, ctx({ msisdn: '256700', operator: 'UNKNOWN' })).smscId).toBeNull();
  });

  it('an operator match outranks a shorter prefix match', () => {
    const routes = [
      route({ id: 'prefix', routeType: 'prefix', matchPrefix: '256', targetSmscId: 'smsc-prefix' }),
      route({ id: 'op', routeType: 'operator', operator: 'MTN', targetSmscId: 'smsc-op' }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '256700', operator: 'MTN' }));
    expect(result.routeId).toBe('op');
  });

  it('breaks specificity ties by lowest priority number', () => {
    const routes = [
      route({
        id: 'a',
        routeType: 'prefix',
        matchPrefix: '256',
        priority: 5,
        targetSmscId: 'smsc-a',
      }),
      route({
        id: 'b',
        routeType: 'prefix',
        matchPrefix: '256',
        priority: 2,
        targetSmscId: 'smsc-b',
      }),
    ];
    expect(selectRoute(routes, ctx({ msisdn: '256700' })).routeId).toBe('b');
  });
});

describe('selectRoute — priority strategy with fallback', () => {
  it('uses the primary target when available', () => {
    const routes = [route({ targetSmscId: 'primary', fallbackSmscId: 'backup' })];
    const result = selectRoute(
      routes,
      ctx({ msisdn: '256700', availableSmscIds: ['primary', 'backup'] }),
    );
    expect(result.smscId).toBe('primary');
    expect(result.fallbackUsed).toBe(false);
  });

  it('falls back to the secondary SMSC when the primary is unavailable', () => {
    const routes = [route({ targetSmscId: 'primary', fallbackSmscId: 'backup' })];
    const result = selectRoute(routes, ctx({ msisdn: '256700', availableSmscIds: ['backup'] }));
    expect(result.smscId).toBe('backup');
    expect(result.fallbackUsed).toBe(true);
    expect(result.reason).toContain('fallback');
  });

  it('returns no SMSC when both primary and fallback are down', () => {
    const routes = [route({ targetSmscId: 'primary', fallbackSmscId: 'backup' })];
    const result = selectRoute(routes, ctx({ msisdn: '256700', availableSmscIds: [] }));
    expect(result.smscId).toBeNull();
    expect(result.routeId).toBe('r-1'); // route matched, but nothing available
  });
});

describe('selectRoute — least-cost strategy', () => {
  const controlling = route({
    id: 'lc',
    strategy: 'least-cost',
    routeType: 'prefix',
    matchPrefix: '256',
    targetSmscId: 'smsc-mid',
    cost: 5,
  });

  it('picks the cheapest available SMSC across all matching routes', () => {
    const routes = [
      controlling,
      route({
        id: 'cheap',
        routeType: 'prefix',
        matchPrefix: '256',
        targetSmscId: 'smsc-cheap',
        cost: 1,
      }),
      route({
        id: 'dear',
        routeType: 'prefix',
        matchPrefix: '256',
        targetSmscId: 'smsc-dear',
        cost: 9,
      }),
    ];
    const result = selectRoute(
      routes,
      ctx({ msisdn: '256700', availableSmscIds: ['smsc-mid', 'smsc-cheap', 'smsc-dear'] }),
    );
    expect(result.smscId).toBe('smsc-cheap');
    expect(result.reason).toContain('least-cost');
  });

  it('skips the cheapest SMSC when it is unavailable', () => {
    const routes = [
      controlling,
      route({
        id: 'cheap',
        routeType: 'prefix',
        matchPrefix: '256',
        targetSmscId: 'smsc-cheap',
        cost: 1,
      }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '256700', availableSmscIds: ['smsc-mid'] }));
    expect(result.smscId).toBe('smsc-mid');
  });

  it('uses per-target costs on a weighted least-cost route', () => {
    const routes = [
      route({
        id: 'w',
        strategy: 'least-cost',
        routeType: 'weighted',
        matchPrefix: '256',
        targetSmscId: 'ignored',
        targets: [
          { smscId: 'smsc-hi', weight: 1, cost: 8 },
          { smscId: 'smsc-lo', weight: 1, cost: 2 },
        ],
      }),
    ];
    const result = selectRoute(
      routes,
      ctx({ msisdn: '256700', availableSmscIds: ['smsc-hi', 'smsc-lo'] }),
    );
    expect(result.smscId).toBe('smsc-lo');
  });
});

describe('selectRoute — weighted load-balance and round-robin', () => {
  const weighted = (strategy: 'load-balance' | 'round-robin'): CandidateRoute =>
    route({
      id: 'w',
      strategy,
      routeType: 'weighted',
      matchPrefix: '256',
      targetSmscId: 'ignored',
      targets: [
        { smscId: 'smsc-a', weight: 3 },
        { smscId: 'smsc-b', weight: 1 },
      ],
    });

  it('round-robin cycles across available targets by rotation', () => {
    const routes = [weighted('round-robin')];
    const at = (rotation: number) =>
      selectRoute(
        routes,
        ctx({ msisdn: '256700', rotation, availableSmscIds: ['smsc-a', 'smsc-b'] }),
      ).smscId;
    expect(at(0)).toBe('smsc-a');
    expect(at(1)).toBe('smsc-b');
    expect(at(2)).toBe('smsc-a');
  });

  it('load-balance distributes proportionally to weight over many rotations', () => {
    const routes = [weighted('load-balance')];
    const counts: Record<string, number> = { 'smsc-a': 0, 'smsc-b': 0 };
    for (let i = 0; i < 40; i += 1) {
      const smsc = selectRoute(
        routes,
        ctx({ msisdn: '256700', rotation: i, availableSmscIds: ['smsc-a', 'smsc-b'] }),
      ).smscId!;
      counts[smsc] += 1;
    }
    // weight 3:1 over 40 sends -> 30 vs 10.
    expect(counts['smsc-a']).toBe(30);
    expect(counts['smsc-b']).toBe(10);
  });

  it('load-balance only considers available targets', () => {
    const routes = [weighted('load-balance')];
    for (let i = 0; i < 5; i += 1) {
      const result = selectRoute(
        routes,
        ctx({ msisdn: '256700', rotation: i, availableSmscIds: ['smsc-b'] }),
      );
      expect(result.smscId).toBe('smsc-b');
    }
  });
});

describe('selectRoute — time-based windows', () => {
  const timed = route({
    id: 't',
    strategy: 'time-based',
    routeType: 'prefix',
    matchPrefix: '256',
    targetSmscId: 'smsc-day',
    window: { start: '09:00', end: '17:00' },
  });

  it('includes the route inside its active window', () => {
    const at = new Date('2026-07-10T10:30:00'); // local time
    const result = selectRoute([timed], ctx({ msisdn: '256700', now: at }));
    expect(result.smscId).toBe('smsc-day');
  });

  it('excludes the route outside its active window', () => {
    const at = new Date('2026-07-10T20:00:00');
    const result = selectRoute([timed], ctx({ msisdn: '256700', now: at }));
    expect(result.smscId).toBeNull();
  });

  it('handles windows that wrap past midnight', () => {
    const night = route({
      id: 'n',
      strategy: 'time-based',
      routeType: 'prefix',
      matchPrefix: '256',
      targetSmscId: 'smsc-night',
      window: { start: '22:00', end: '06:00' },
    });
    expect(
      selectRoute([night], ctx({ msisdn: '256700', now: new Date('2026-07-10T23:30:00') })).smscId,
    ).toBe('smsc-night');
    expect(
      selectRoute([night], ctx({ msisdn: '256700', now: new Date('2026-07-10T02:30:00') })).smscId,
    ).toBe('smsc-night');
    expect(
      selectRoute([night], ctx({ msisdn: '256700', now: new Date('2026-07-10T12:00:00') })).smscId,
    ).toBeNull();
  });

  it('restricts a window to specific weekdays', () => {
    const weekdayOnly = { start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5] };
    // 2026-07-11 is a Saturday (day 6).
    expect(isWithinWindow(weekdayOnly, new Date('2026-07-11T10:00:00'))).toBe(false);
    // 2026-07-10 is a Friday (day 5).
    expect(isWithinWindow(weekdayOnly, new Date('2026-07-10T10:00:00'))).toBe(true);
  });

  it('falls through to a lower-priority always-on route when the timed route is closed', () => {
    const always = route({
      id: 'always',
      priority: 50,
      routeType: 'prefix',
      matchPrefix: '256',
      targetSmscId: 'smsc-always',
    });
    const result = selectRoute(
      [timed, always],
      ctx({ msisdn: '256700', now: new Date('2026-07-10T20:00:00') }),
    );
    expect(result.routeId).toBe('always');
    expect(result.smscId).toBe('smsc-always');
  });
});

describe('selectRoute — trace/preview output', () => {
  it('produces a human-readable trace of the decision', () => {
    const routes = [route({ routeType: 'prefix', matchPrefix: '256', targetSmscId: 'smsc-x' })];
    const result = selectRoute(routes, ctx({ msisdn: '+256700', availableSmscIds: ['smsc-x'] }));
    expect(result.trace.length).toBeGreaterThan(1);
    expect(result.trace.join(' ')).toContain('controlling route');
    expect(result.strategy).toBe('priority');
  });
});

/**
 * THE REASONS THE CONSOLE SHOWS BESIDE EACH ROUTE.
 *
 * The routing screen lists every route in priority order with a verdict —
 * selected, outranked, or no match and why. Those reasons have to be produced
 * HERE, by the code that actually does the matching. Recomputing the rules in
 * the browser would be a second implementation, and the screen an operator
 * uses to predict where a message will go is the last place that should be
 * able to disagree with the engine.
 */
describe('selectRoute — per-route verdicts', () => {
  const smscUp = { availability: { 'smsc-primary': true, 'smsc-other': true } };

  it('marks exactly one route selected and explains each of the others', () => {
    const routes = [
      route({ id: 'r-mtn', name: 'MTN', priority: 100, routeType: 'prefix', matchPrefix: '25677' }),
      route({
        id: 'r-cpaas',
        name: 'CPAAS',
        priority: 200,
        routeType: 'prefix',
        matchPrefix: '25670',
      }),
      route({ id: 'r-kamex', name: 'KAMEX', priority: 210, sender: 'KAMEX' }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000', sender: '8888', ...smscUp }));

    const selected = result.candidates.filter((c) => c.verdict === 'selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].name).toBe('CPAAS');

    const byName = Object.fromEntries(result.candidates.map((c) => [c.name, c]));
    expect(byName.MTN.verdict).toBe('no-match');
    expect(byName.MTN.reason).toBe('Destination does not start with +25677');
    // A sender constraint is reported as a sender problem, not as a prefix one.
    expect(byName.KAMEX.reason).toBe('Sender must be KAMEX');
  });

  it('lists the verdicts in priority order, so the screen can render them as-is', () => {
    const routes = [
      route({ id: 'c', name: 'C', priority: 30, routeType: 'prefix', matchPrefix: '999' }),
      route({ id: 'a', name: 'A', priority: 10, routeType: 'prefix', matchPrefix: '999' }),
      route({ id: 'b', name: 'B', priority: 20, routeType: 'prefix', matchPrefix: '999' }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000', ...smscUp }));
    expect(result.candidates.map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });

  // Every route the caller passed gets a verdict, including the ones that
  // never even reached the matcher — a disabled route is absent from the
  // result otherwise, and "it is not in the list" is not an explanation.
  it('explains a disabled route rather than omitting it', () => {
    const routes = [
      route({ id: 'on', name: 'On', priority: 10 }),
      route({ id: 'off', name: 'Off', priority: 20, enabled: false }),
    ];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000', ...smscUp }));
    const off = result.candidates.find((c) => c.name === 'Off');
    expect(off?.verdict).toBe('no-match');
    expect(off?.reason).toBe('Route is disabled');
  });

  it('still explains every route when nothing matched at all', () => {
    const routes = [route({ routeType: 'prefix', matchPrefix: '999', name: 'Nope' })];
    const result = selectRoute(routes, ctx({ msisdn: '+256700000000' }));
    expect(result.smscId).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reason).toBe('Destination does not start with +999');
  });
});
