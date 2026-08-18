import {
  SERVICE_CATALOGUE,
  attributeRootCause,
  dependentsOf,
  summarise,
  type ServiceReading,
  type ServiceState,
} from './service-registry';

const reading = (
  name: string,
  state: ServiceState,
  overrides: Partial<ServiceReading> = {},
): ServiceReading => ({
  name,
  role: 'role',
  state,
  observation: 'probed',
  detail: 'detail',
  dependsOn: [],
  affects: [],
  rootCause: null,
  observedAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

describe('the catalogue', () => {
  it('covers the five components §14 names', () => {
    const names = SERVICE_CATALOGUE.map((entry) => entry.name);
    for (const required of ['bearerbox', 'smsbox', 'sqlbox', 'database', 'metrics-collector'])
      expect(names).toContain(required);
  });

  it('declares no dependency on a component that is not in the register', () => {
    // A dangling dependency would silently never resolve, and the root-cause
    // attribution would then always say "no dependency explains this".
    const names = new Set(SERVICE_CATALOGUE.map((entry) => entry.name));
    for (const entry of SERVICE_CATALOGUE)
      for (const dependency of entry.dependsOn) expect(names.has(dependency)).toBe(true);
  });

  it('has no dependency cycle', () => {
    const edges = new Map(SERVICE_CATALOGUE.map((e) => [e.name, e.dependsOn]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (name: string): boolean => {
      if (visiting.has(name)) return true;
      if (done.has(name)) return false;
      visiting.add(name);
      const cycle = (edges.get(name) ?? []).some(walk);
      visiting.delete(name);
      done.add(name);
      return cycle;
    };
    expect(SERVICE_CATALOGUE.some((entry) => walk(entry.name))).toBe(false);
  });

  it('knows what each component affects', () => {
    // bearerbox failing takes smsbox and sqlbox with it; that is the sentence
    // the restart confirmation has to be able to write.
    expect(dependentsOf('bearerbox').sort()).toEqual(['engine-poller', 'smsbox', 'sqlbox']);
    expect(dependentsOf('cache')).toEqual([]);
  });
});

describe('attributeRootCause', () => {
  const states = new Map<string, ServiceState>([
    ['database', 'critical'],
    ['bearerbox', 'degraded'],
    ['cache', 'healthy'],
  ]);

  it('blames the most severe unhealthy dependency, not the first', () => {
    expect(attributeRootCause('critical', ['bearerbox', 'database'], states)).toBe('database');
  });

  it('says nothing when a healthy component happens to have a sick dependency', () => {
    // Attributing here would send the operator to fix something that is not
    // affecting this component at all.
    expect(attributeRootCause('healthy', ['database'], states)).toBeNull();
  });

  it('returns null when every dependency is fine — this is a root failure', () => {
    expect(attributeRootCause('critical', ['cache'], states)).toBeNull();
    expect(attributeRootCause('critical', [], states)).toBeNull();
  });

  it('treats an unobservable dependency as a possible explanation', () => {
    // "I cannot see it" is a legitimate reason not to blame this component
    // first, and hiding it would present a symptom as a root cause.
    const unknown = new Map<string, ServiceState>([['metrics-collector', 'unknown']]);
    expect(attributeRootCause('degraded', ['metrics-collector'], unknown)).toBe(
      'metrics-collector',
    );
  });
});

describe('summarise', () => {
  it('never folds "not observable" into healthy or unhealthy', () => {
    const summary = summarise([
      reading('a', 'healthy'),
      reading('b', 'unknown'),
      reading('c', 'unknown'),
    ]);
    expect(summary).toMatchObject({ healthy: 1, unknown: 2, degraded: 0, critical: 0 });
    // The failure this prevents: "2 of 3 healthy" while two are merely
    // unwatched, so the more blind spots we have the better the board looks.
    expect(summary.statement).toContain('2 not observable');
    expect(summary.worst).toBe('unknown');
  });

  it('points at the root failures, not at every red row', () => {
    const summary = summarise([
      reading('database', 'critical'),
      reading('bearerbox', 'critical', { rootCause: 'database' }),
      reading('sqlbox', 'critical', { rootCause: 'database' }),
    ]);
    expect(summary.rootFailures).toEqual(['database']);
    expect(summary.statement).toContain('Start with database');
  });

  it('says so when everything red is downstream of something else', () => {
    const summary = summarise([reading('sqlbox', 'degraded', { rootCause: 'bearerbox' })]);
    expect(summary.rootFailures).toEqual([]);
    expect(summary.statement).toContain('explained by a dependency');
  });

  it('states the all-clear as a measurement, not as silence', () => {
    const summary = summarise([reading('a', 'healthy'), reading('b', 'healthy')]);
    expect(summary.worst).toBe('healthy');
    expect(summary.statement).toBe('All 2 components healthy on their last probe.');
  });

  it('ranks critical above degraded above unknown', () => {
    expect(summarise([reading('a', 'degraded'), reading('b', 'critical')]).worst).toBe('critical');
    expect(summarise([reading('a', 'unknown'), reading('b', 'degraded')]).worst).toBe('degraded');
  });
});
