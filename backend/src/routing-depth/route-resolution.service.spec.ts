import { RouteResolutionService } from './route-resolution.service';
import { RoutingDepthRepository } from './routing-depth.repository';

/**
 * Send-path route resolution.
 *
 * These exercise the REAL repository mapping and the REAL pure selector against
 * a fake PoolClient, because the thing that was broken was never the selector —
 * it was that nothing ever fed it deployed routes, live bind health or engine
 * ids. Those three translations are what is under test here.
 */

interface RouteFixture {
  id: string;
  name: string;
  priority?: number;
  enabled?: boolean;
  deployment_state?: string;
  route_type?: string;
  strategy?: string;
  match_prefix?: string | null;
  destination_prefix?: string | null;
  cost?: string | null;
  target_smsc_id: string;
  fallback_smsc_id?: string | null;
}

function routeRow(fixture: RouteFixture) {
  return {
    id: fixture.id,
    tenant_id: '1',
    name: fixture.name,
    priority: fixture.priority ?? 10,
    enabled: fixture.enabled ?? true,
    deployment_state: fixture.deployment_state ?? 'deployed',
    route_type: fixture.route_type ?? 'prefix',
    strategy: fixture.strategy ?? 'priority',
    match_prefix: fixture.match_prefix ?? null,
    country_code: null,
    operator: null,
    destination_prefix: fixture.destination_prefix ?? null,
    sender: null,
    cost: fixture.cost ?? null,
    target_smsc_id: fixture.target_smsc_id,
    fallback_smsc_id: fixture.fallback_smsc_id ?? null,
    window_start: null,
    window_end: null,
    active_days: null,
    created_at: 'now',
    updated_at: 'now',
  };
}

/**
 * `smscs` maps smsc_definitions.id -> { engineId, bindState }. A null bindState
 * means the poller has never observed that bind; when NO smsc has a state the
 * service treats health as unknown and assumes every enabled bind is up.
 */
function makeClient(opts: {
  routes?: ReturnType<typeof routeRow>[];
  smscs?: Array<{ id: string; engineId: string; bindState?: string | null }>;
  customerRoutes?: Array<{ route_id: string | null; smsc_id: string | null }>;
}) {
  const smscs = opts.smscs ?? [
    { id: 'smsc-a', engineId: 'local-fake', bindState: 'bound' },
    { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'bound' },
  ];
  const query = jest.fn(async (sql: string) => {
    // Order matters: the availability query also mentions smsc_definitions.
    if (sql.includes('smsc_bind_state'))
      return {
        rows: smscs.map((s) => ({
          id: s.id,
          engine_id: s.engineId,
          bind_state: s.bindState === undefined ? 'bound' : s.bindState,
        })),
      };
    if (sql.includes('customer_routes')) return { rows: opts.customerRoutes ?? [] };
    if (sql.includes('FROM routing_rules')) {
      const deployedOnly = sql.includes("deployment_state='deployed'");
      const rows = (opts.routes ?? []).filter(
        (row) => row.enabled && (!deployedOnly || row.deployment_state === 'deployed'),
      );
      return { rows: [...rows].sort((a, b) => a.priority - b.priority) };
    }
    if (sql.includes('FROM route_targets')) return { rows: [] };
    return { rows: [] };
  });
  return { query } as never;
}

function makeService() {
  const repository = new RoutingDepthRepository({} as never);
  return new RouteResolutionService(repository);
}

describe('RouteResolutionService', () => {
  it('selects the matching route and returns an ENGINE id, not a row id', async () => {
    const client = makeClient({
      routes: [
        routeRow({ id: 'r-ug', name: 'Uganda', match_prefix: '256', target_smsc_id: 'smsc-a' }),
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });

    expect(decision.routeId).toBe('r-ug');
    expect(decision.routeName).toBe('Uganda');
    // smsc-a is the smsc_definitions.id; the spool keys on the engine id.
    expect(decision.smscId).toBe('local-fake');
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.candidatesConsidered).toBe(1);
  });

  it('does not select a route that is enabled but NOT deployed', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-draft',
          name: 'Draft',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          deployment_state: 'draft',
        }),
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });
    expect(decision.smscId).toBeNull();
    expect(decision.routeId).toBeNull();
    expect(decision.reason).toContain('no route matched');
  });

  it('does not select a rolled-back route', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-old',
          name: 'Rolled back',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          deployment_state: 'rolled_back',
        }),
      ],
    });
    expect(
      (await makeService().resolveInClient(client, { msisdn: '256700000000' })).smscId,
    ).toBeNull();
  });

  it('does not select a disabled route', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-off',
          name: 'Disabled',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          enabled: false,
        }),
      ],
    });
    expect(
      (await makeService().resolveInClient(client, { msisdn: '256700000000' })).smscId,
    ).toBeNull();
  });

  it('fails over to the fallback bind when the primary is not bound', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-ug',
          name: 'Uganda',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          fallback_smsc_id: 'smsc-b',
        }),
      ],
      smscs: [
        { id: 'smsc-a', engineId: 'local-fake', bindState: 'disconnected' },
        { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'bound' },
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });

    expect(decision.smscId).toBe('local-fake-b');
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.availableSmscIds).toEqual(['local-fake-b']);
    expect(decision.healthAssumed).toBe(false);
  });

  it('reports the route but no bind when primary and fallback are both down', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-ug',
          name: 'Uganda',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          fallback_smsc_id: 'smsc-b',
        }),
      ],
      smscs: [
        { id: 'smsc-a', engineId: 'local-fake', bindState: 'failed' },
        { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'retrying' },
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });
    expect(decision.smscId).toBeNull();
    expect(decision.routeId).toBe('r-ug');
    expect(decision.reason).toContain('no available SMSC');
  });

  it('assumes every enabled bind is available when the poller has observed none', async () => {
    const client = makeClient({
      routes: [
        routeRow({ id: 'r-ug', name: 'Uganda', match_prefix: '256', target_smsc_id: 'smsc-a' }),
      ],
      smscs: [
        { id: 'smsc-a', engineId: 'local-fake', bindState: null },
        { id: 'smsc-b', engineId: 'local-fake-b', bindState: null },
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });
    expect(decision.healthAssumed).toBe(true);
    expect(decision.smscId).toBe('local-fake');
  });

  it('drops a route whose target SMSC is disabled or missing', async () => {
    const client = makeClient({
      routes: [
        routeRow({ id: 'r-gone', name: 'Gone', match_prefix: '256', target_smsc_id: 'smsc-z' }),
      ],
    });
    const decision = await makeService().resolveInClient(client, { msisdn: '256700000000' });
    expect(decision.candidatesConsidered).toBe(0);
    expect(decision.smscId).toBeNull();
  });

  it('restricts a customer to the routes they are bound to', async () => {
    const routes = [
      routeRow({
        id: 'r-cheap',
        name: 'Cheap',
        priority: 1,
        match_prefix: '256',
        target_smsc_id: 'smsc-a',
      }),
      routeRow({
        id: 'r-premium',
        name: 'Premium',
        priority: 2,
        match_prefix: '256',
        target_smsc_id: 'smsc-b',
      }),
    ];
    const bound = await makeService().resolveInClient(
      makeClient({ routes, customerRoutes: [{ route_id: 'r-premium', smsc_id: null }] }),
      { msisdn: '256700000000', customerId: 'cust-1' },
    );
    expect(bound.routeId).toBe('r-premium');
    expect(bound.smscId).toBe('local-fake-b');

    // With no bindings configured the customer is unconstrained (back-compatible).
    const unbound = await makeService().resolveInClient(
      makeClient({ routes, customerRoutes: [] }),
      { msisdn: '256700000000', customerId: 'cust-1' },
    );
    expect(unbound.routeId).toBe('r-cheap');
  });

  it('honours an SMSC-level customer binding', async () => {
    const routes = [
      routeRow({
        id: 'r-a',
        name: 'A',
        priority: 1,
        match_prefix: '256',
        target_smsc_id: 'smsc-a',
      }),
      routeRow({
        id: 'r-b',
        name: 'B',
        priority: 2,
        match_prefix: '256',
        target_smsc_id: 'smsc-b',
      }),
    ];
    const decision = await makeService().resolveInClient(
      makeClient({ routes, customerRoutes: [{ route_id: null, smsc_id: 'smsc-b' }] }),
      { msisdn: '256700000000', customerId: 'cust-1' },
    );
    expect(decision.smscId).toBe('local-fake-b');
  });

  it('carries the controlling route cost so the send can be billed', async () => {
    const client = makeClient({
      routes: [
        routeRow({
          id: 'r-ug',
          name: 'Uganda',
          match_prefix: '256',
          target_smsc_id: 'smsc-a',
          cost: '0.0150',
        }),
      ],
    });
    expect((await makeService().resolveInClient(client, { msisdn: '256700000000' })).cost).toBe(
      0.015,
    );
  });

  it('matches regardless of how the destination was formatted', async () => {
    const routes = [
      routeRow({ id: 'r-ug', name: 'Uganda', match_prefix: '+256', target_smsc_id: 'smsc-a' }),
    ];
    for (const msisdn of ['256700000000', '+256 700 000 000']) {
      const decision = await makeService().resolveInClient(makeClient({ routes }), { msisdn });
      expect(decision.smscId).toBe('local-fake');
    }
  });
});

/**
 * Operator suspension has to reach the SEND PATH, not just the badge.
 *
 * UC-SMSC-02 asks for a hold on new submissions distinct from a carrier-dropped
 * bind. If the filter lived only in the console, "Suspend traffic" would record
 * an event, show a badge and change nothing — the worst kind of control,
 * because an operator would believe traffic had stopped.
 */
describe('send path honours operator suspension', () => {
  it('excludes a suspended SMSC in the availability query itself', async () => {
    const client = makeClient({});
    await makeService().resolveInClient(client, { msisdn: '256700000000' });
    const queries = (client as unknown as { query: jest.Mock }).query.mock.calls;
    const availability = queries
      .map((call: unknown[]) => String(call[0]))
      .find((sql: string) => sql.includes('smsc_bind_state'))!;
    // In the WHERE clause, so a suspended bind is not a candidate at all: it
    // must not be selected, and must not satisfy an explicitly pinned smscId.
    expect(availability).toContain('traffic_suspended_at IS NULL');
    expect(availability).toContain('d.enabled = true');
  });
});
