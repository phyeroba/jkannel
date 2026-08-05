import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { GatewayRateLimiter } from '../api-gateway/gateway-rate-limiter';
import { CustomerCreditService } from '../customers-depth/customer-credit.service';
import { CustomerQuotaService } from '../customers-depth/customer-quota.service';
import { CustomerRateLimitService } from '../customers-depth/customer-rate-limit.service';
import { RouteResolutionService } from '../routing-depth/route-resolution.service';
import { RoutingDepthRepository } from '../routing-depth/routing-depth.repository';
import { ContentFilterService } from './content-filter.service';
import { ContentRuleRow } from './content-filter';
import { MessageBlocklistService } from './message-blocklist.service';
import { MessageSendService } from './message-send.service';
import { SendEntitlementsService } from './send-entitlements.service';

const actor = { tenantId: '1', userId: 'u1' };

interface RouteFixture {
  id: string;
  name: string;
  priority?: number;
  enabled?: boolean;
  deployment_state?: string;
  match_prefix?: string | null;
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
    route_type: 'prefix',
    strategy: 'priority',
    match_prefix: fixture.match_prefix ?? '256',
    country_code: null,
    operator: null,
    destination_prefix: null,
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

interface StackFixture {
  routes?: ReturnType<typeof routeRow>[];
  smscs?: Array<{ id: string; engineId: string; bindState?: string | null }>;
  blocklist?: Array<{ list_type: string; msisdn: string; reason?: string | null }>;
  customer?: { status?: string; enabled?: boolean } | null;
  senderIds?: Array<{ sender_id: string; status: string; reason?: string | null }>;
  customerRoutes?: Array<{ route_id: string | null; smsc_id: string | null }>;
  quotas?: Array<{ period: string; limit_count: number; used_count: number }>;
  balance?: number;
  submit?: jest.Mock;
  /** customers.rate_limit_per_min for the fixture customer; null = unlimited. */
  rateLimitPerMin?: number | null;
  /** null models an absent/unreachable Redis, which must FAIL OPEN. */
  redis?: { eval: jest.Mock } | null;
  /** Enabled content-filter rules the send path will load and evaluate. */
  contentRules?: Array<Partial<ContentRuleRow>>;
}

/** A content rule row with every column the compiler reads, defaulted. */
export function contentRuleRow(overrides: Partial<ContentRuleRow> = {}): ContentRuleRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'rule',
    description: null,
    match_field: 'body',
    match_type: 'substring',
    pattern: 'x',
    case_sensitive: false,
    action: 'block',
    smsc_id: null,
    customer_id: null,
    enabled: true,
    priority: 100,
    expires_at: null,
    reason: null,
    match_count: 0,
    last_matched_at: null,
    quarantined_at: null,
    quarantine_reason: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * In-memory stand-in for the Redis the rate limiter uses: the same fixed-window
 * INCR the Lua script performs, so the limiter's own arithmetic is exercised.
 */
function fakeRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    eval: jest.fn(async (_script: string, _numKeys: number, key: string) => {
      const next = (counters.get(String(key)) ?? 0) + 1;
      counters.set(String(key), next);
      return [next, 60];
    }),
  };
}

/**
 * The whole send pipeline, wired with the REAL collaborators (route resolution,
 * the pure selector, the quota and credit transactional cores, the blocklist)
 * over a fake PoolClient. Only SQLBox is a spy — it is a different database.
 *
 * `tenantTransaction` models real transaction semantics: mutable state is
 * snapshotted on entry and RESTORED when the work throws. That is what lets the
 * atomicity test assert that a failed engine submission leaves no debit and no
 * consumed quota behind, rather than merely asserting that some mock was not
 * called.
 */
function makeStack(fixture: StackFixture) {
  const smscs = fixture.smscs ?? [
    { id: 'smsc-a', engineId: 'local-fake', bindState: 'bound' },
    { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'bound' },
  ];
  const state = {
    quotas: (fixture.quotas ?? []).map((q, index) => ({
      id: `quota-${index}`,
      customer_id: 'cust-1',
      period: q.period,
      limit_count: String(q.limit_count),
      used_count: String(q.used_count),
      window_start: new Date().toISOString(),
      created_by: 'u1',
      created_at: 'now',
      updated_at: 'now',
    })),
    balance: fixture.balance ?? 0,
    debits: [] as Array<{ amount: number; balanceAfter: number }>,
    decisions: [] as Array<Record<string, unknown>>,
    audits: [] as string[],
    contentRuleWrites: [] as string[],
  };

  const sql = { log: [] as string[] };
  const client = {
    query: jest.fn(async (text: string, params: any[] = []) => {
      sql.log.push(text);
      // Availability first: its query also names smsc_definitions.
      if (text.includes('smsc_bind_state'))
        return {
          rows: smscs.map((s) => ({
            id: s.id,
            engine_id: s.engineId,
            bind_state: s.bindState === undefined ? 'bound' : s.bindState,
          })),
        };
      if (text.includes('FROM messaging_blocklist')) {
        const destination = params[0] as string;
        return {
          rows: (fixture.blocklist ?? [])
            .filter((e) => e.msisdn === destination || e.list_type === 'whitelist')
            .map((e) => ({ ...e, reason: e.reason ?? null })),
        };
      }
      if (text.includes('FROM routing_rules')) {
        const deployedOnly = text.includes("deployment_state='deployed'");
        return {
          rows: (fixture.routes ?? [])
            .filter((r) => r.enabled && (!deployedOnly || r.deployment_state === 'deployed'))
            .sort((a, b) => a.priority - b.priority),
        };
      }
      if (text.includes('FROM route_targets')) return { rows: [] };
      if (text.includes('FROM customer_routes')) return { rows: fixture.customerRoutes ?? [] };
      if (text.includes('SELECT engine_id FROM smsc_definitions'))
        return { rows: smscs.map((s) => ({ engine_id: s.engineId })) };
      if (text.includes('FROM smsc_definitions')) {
        const found = smscs.find((s) => s.engineId === params[0]);
        return { rows: found ? [{ id: found.id }] : [] };
      }
      if (text.includes('FROM messaging_content_rules'))
        return { rows: (fixture.contentRules ?? []).map((rule) => contentRuleRow(rule)) };
      if (text.startsWith('UPDATE messaging_content_rules')) {
        state.contentRuleWrites.push(text);
        return { rows: [] };
      }
      if (text.includes('rate_limit_per_min FROM customers'))
        return { rows: [{ rate_limit_per_min: fixture.rateLimitPerMin ?? null }] };
      if (text.includes('FROM customers'))
        return {
          rows:
            fixture.customer === null
              ? []
              : [
                  {
                    status: fixture.customer?.status ?? 'active',
                    enabled: fixture.customer?.enabled ?? true,
                  },
                ],
        };
      if (text.includes('FROM sender_ids')) return { rows: fixture.senderIds ?? [] };
      if (text.includes('FROM customer_quotas')) return { rows: state.quotas };
      if (text.startsWith('UPDATE customer_quotas')) {
        const row = state.quotas.find((q) => q.id === params[0])!;
        row.used_count = String(params[2]);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO customer_balances')) return { rows: [] };
      if (text.includes('FROM customer_balances'))
        return { rows: [{ balance: String(state.balance) }] };
      if (text.startsWith('UPDATE customer_balances')) {
        state.balance = Number(params[1]);
        return { rows: [] };
      }
      if (text.includes('INSERT INTO credit_transactions')) {
        state.debits.push({ amount: Number(params[3]), balanceAfter: Number(params[4]) });
        return {
          rows: [
            {
              id: 'tx-1',
              customer_id: 'cust-1',
              direction: params[2],
              amount: params[3],
              balance_after: params[4],
              reason: params[5],
              reference: params[6],
              created_by: params[7],
              created_at: 'now',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO message_route_decisions')) {
        const id = `decision-${state.decisions.length + 1}`;
        state.decisions.push({
          id,
          customerId: params[1],
          messageRef: params[2],
          channel: params[4],
          sender: params[5],
          destination: params[6],
          routeId: params[8],
          routeName: params[9],
          strategy: params[10],
          smscId: params[11],
          requestedSmscId: params[12],
          fallbackUsed: params[13],
          outcome: params[14],
          reason: params[15],
          availableSmscIds: params[16],
          candidatesConsidered: params[17],
          trace: params[18],
          contentRuleId: params[20],
          contentRuleName: params[21],
        });
        return { rows: [{ id }] };
      }
      if (text.startsWith('UPDATE message_route_decisions')) {
        const row = state.decisions.find((d) => d.id === params[0]);
        if (row) row.messageRef = params[1];
        return { rows: [] };
      }
      if (text.includes('INSERT INTO audit_log')) {
        state.audits.push(String(params[2]));
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };

  const database: any = {
    tenantTransaction: async (_tenantId: string, work: any) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await work(client);
      } catch (error) {
        // ROLLBACK: every mutation this transaction made is discarded.
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };

  const sqlbox: any = {
    submit:
      fixture.submit ??
      jest.fn(async () => ({ sqlId: '900', status: 'queued', source: 'kamex-sqlbox' })),
  };

  const redis = fixture.redis === undefined ? fakeRedis() : fixture.redis;
  // A fresh instance per stack: the rule cache is per-process, and one test's
  // rule set must never leak into the next.
  const contentFilter = new ContentFilterService(database);
  const service = new MessageSendService(
    database,
    sqlbox,
    new RouteResolutionService(new RoutingDepthRepository({} as never)),
    new SendEntitlementsService(
      new CustomerQuotaService({} as never),
      new CustomerCreditService({} as never),
    ),
    new MessageBlocklistService(database),
    new CustomerRateLimitService(new GatewayRateLimiter(redis)),
    contentFilter,
  );
  return { service, sqlbox, state, sql, redis, contentFilter };
}

const message = { sender: 'JKANNEL', receiver: '+256700000000', text: 'hello' };

describe('MessageSendService — route selection on the send path (G2)', () => {
  it('chooses the route when smscId is OMITTED and submits to the chosen bind', async () => {
    const { service, sqlbox } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
    });
    const result = await service.send(actor, { ...message, channel: 'console' });

    expect(result.smscId).toBe('local-fake');
    expect(result.routeId).toBe('r-ug');
    expect(result.outcome).toBe('routed');
    expect(sqlbox.submit).toHaveBeenCalledWith(
      expect.objectContaining({ smscId: 'local-fake', receiver: '+256700000000' }),
    );
  });

  /**
   * A validated-then-dropped parameter is worse than an absent one: the caller
   * gets a 200, the value is echoed nowhere, and the campaign that was supposed
   * to sit behind everything else quietly does not. These two tests exist
   * because this service is the single hop between every console/API/bulk
   * submit and `send_sms`, so a missing line here silently disables priority
   * across the whole product while every endpoint still accepts the field.
   */
  it('carries priority through to the engine submission', async () => {
    const { service, sqlbox } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
    });
    await service.send(actor, { ...message, channel: 'console', priority: 3 });
    expect(sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ priority: 3 }));
  });

  it('sends priority 0 as 0 and an unspecified priority as null, never conflating them', async () => {
    const bulk = makeStack({ routes: [routeRow({ id: 'r', name: 'UG', target_smsc_id: 'smsc-a' })] });
    await bulk.service.send(actor, { ...message, channel: 'console', priority: 0 });
    expect(bulk.sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ priority: 0 }));

    const unset = makeStack({ routes: [routeRow({ id: 'r', name: 'UG', target_smsc_id: 'smsc-a' })] });
    await unset.service.send(actor, { ...message, channel: 'console' });
    expect(unset.sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ priority: null }));
  });

  it('still honours an explicit smscId, without consulting the router', async () => {
    const { service, sqlbox, sql } = makeStack({ routes: [] });
    const result = await service.send(actor, {
      ...message,
      smscId: 'local-fake-b',
      channel: 'console',
    });

    expect(result.smscId).toBe('local-fake-b');
    expect(result.outcome).toBe('explicit');
    expect(sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ smscId: 'local-fake-b' }));
    expect(sql.log.some((s) => s.includes('FROM routing_rules'))).toBe(false);
  });

  it('rejects an explicit smscId the tenant does not own', async () => {
    const { service, sqlbox } = makeStack({});
    await expect(
      service.send(actor, { ...message, smscId: 'someone-elses', channel: 'console' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('does NOT select an undeployed route, and refuses rather than guessing a bind', async () => {
    const { service, sqlbox } = makeStack({
      routes: [
        routeRow({
          id: 'r-draft',
          name: 'Draft',
          target_smsc_id: 'smsc-a',
          deployment_state: 'draft',
        }),
      ],
    });
    await expect(service.send(actor, { ...message, channel: 'console' })).rejects.toThrow(
      /No route is available for 256700000000/,
    );
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('does NOT select a disabled route — disabling a route changes traffic', async () => {
    const routes = [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })];
    const enabled = makeStack({ routes });
    expect((await enabled.service.send(actor, { ...message, channel: 'console' })).smscId).toBe(
      'local-fake',
    );

    const disabled = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a', enabled: false })],
    });
    await expect(disabled.service.send(actor, { ...message, channel: 'console' })).rejects.toThrow(
      /No route is available/,
    );
    expect(disabled.sqlbox.submit).not.toHaveBeenCalled();
  });

  it('fails over to the secondary bind when the primary is not bound', async () => {
    const { service, sqlbox } = makeStack({
      routes: [
        routeRow({
          id: 'r-ug',
          name: 'Uganda',
          target_smsc_id: 'smsc-a',
          fallback_smsc_id: 'smsc-b',
        }),
      ],
      smscs: [
        { id: 'smsc-a', engineId: 'local-fake', bindState: 'disconnected' },
        { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'bound' },
      ],
    });
    const result = await service.send(actor, { ...message, channel: 'console' });

    expect(result.smscId).toBe('local-fake-b');
    expect(result.fallbackUsed).toBe(true);
    expect(sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ smscId: 'local-fake-b' }));
  });

  it('re-routes a replay off a bind that is no longer healthy', async () => {
    const { service } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-b' })],
      smscs: [
        { id: 'smsc-a', engineId: 'local-fake', bindState: 'failed' },
        { id: 'smsc-b', engineId: 'local-fake-b', bindState: 'bound' },
      ],
    });
    const result = await service.send(actor, {
      ...message,
      smscId: 'local-fake',
      rerouteIfUnavailable: true,
      channel: 'replay',
    });

    expect(result.smscId).toBe('local-fake-b');
    expect(result.outcome).toBe('rerouted');
    expect(result.reason).toContain('pinned bind local-fake is not bound');
  });

  it('rejects an unusable destination before anything else happens', async () => {
    const { service, sqlbox } = makeStack({});
    await expect(
      service.send(actor, { ...message, receiver: 'not-a-number', channel: 'console' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });
});

describe('MessageSendService — the decision is recorded', () => {
  it('persists the decision, the message reference and the selector trace', async () => {
    const { service, state } = makeStack({
      routes: [
        routeRow({
          id: 'r-ug',
          name: 'Uganda',
          target_smsc_id: 'smsc-a',
          fallback_smsc_id: 'smsc-b',
        }),
      ],
    });
    await service.send(actor, { ...message, channel: 'console' });

    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      messageRef: '900',
      channel: 'console',
      destination: '256700000000',
      routeId: 'r-ug',
      routeName: 'Uganda',
      strategy: 'priority',
      smscId: 'local-fake',
      requestedSmscId: null,
      fallbackUsed: false,
      outcome: 'routed',
    });
    expect(JSON.parse(String(state.decisions[0].trace))).toEqual([
      'destination 256700000000 (digits 256700000000)',
      '1 route(s) matched',
      'controlling route "Uganda" (prefix, priority 10, strategy priority)',
      'selected SMSC local-fake (primary target)',
    ]);
    expect(state.decisions[0].availableSmscIds).toEqual(['local-fake', 'local-fake-b']);
    expect(state.audits).toContain('message.submitted');
  });

  it('records a rejection even though the send transaction rolled back', async () => {
    const { service, state } = makeStack({ routes: [] });
    await expect(service.send(actor, { ...message, channel: 'api' })).rejects.toThrow();

    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({ outcome: 'rejected', messageRef: null });
    expect(String(state.decisions[0].reason)).toContain('refused');
  });

  it('records the explicit override so an operator can see the bypass', async () => {
    const { service, state } = makeStack({});
    await service.send(actor, { ...message, smscId: 'local-fake-b', channel: 'console' });
    expect(state.decisions[0]).toMatchObject({
      outcome: 'explicit',
      requestedSmscId: 'local-fake-b',
      smscId: 'local-fake-b',
    });
  });
});

describe('MessageSendService — customer entitlements (G5)', () => {
  const routed: StackFixture = {
    routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
  };
  const withCustomer = { ...message, channel: 'api' as const, customerId: 'cust-1' };

  it('refuses a send at the quota limit', async () => {
    const { service, sqlbox } = makeStack({
      ...routed,
      quotas: [{ period: 'daily', limit_count: 10, used_count: 10 }],
    });
    await expect(service.send(actor, withCustomer)).rejects.toThrow(/daily quota exceeded/);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('consumes quota when the send is within the cap', async () => {
    const { service, state } = makeStack({
      ...routed,
      quotas: [{ period: 'daily', limit_count: 10, used_count: 4 }],
    });
    await service.send(actor, withCustomer);
    expect(state.quotas[0].used_count).toBe('5');
  });

  it('refuses a send the customer cannot afford and posts no debit', async () => {
    const { service, sqlbox, state } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a', cost: '0.0200' })],
      balance: 0.01,
    });
    await expect(service.send(actor, withCustomer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
    expect(state.debits).toHaveLength(0);
    expect(state.balance).toBe(0.01);
  });

  it('debits the route cost when the send goes out', async () => {
    const { service, state } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a', cost: '0.0200' })],
      balance: 1,
    });
    const result = await service.send(actor, withCustomer);
    expect(result.charged).toBe(0.02);
    expect(state.debits).toEqual([{ amount: 0.02, balanceAfter: 0.98 }]);
  });

  it('refuses a rejected sender ID', async () => {
    const { service, sqlbox } = makeStack({
      ...routed,
      senderIds: [{ sender_id: 'JKANNEL', status: 'rejected', reason: 'impersonation' }],
    });
    await expect(service.send(actor, withCustomer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('accepts an approved sender ID', async () => {
    const { service, sqlbox } = makeStack({
      ...routed,
      senderIds: [{ sender_id: 'JKANNEL', status: 'approved' }],
    });
    await service.send(actor, withCustomer);
    expect(sqlbox.submit).toHaveBeenCalled();
  });

  it('refuses a bind the customer is not bound to', async () => {
    const { service, sqlbox } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
      customerRoutes: [{ route_id: null, smsc_id: 'smsc-b' }],
    });
    // The router already restricts to bound routes, so nothing matches at all.
    await expect(service.send(actor, withCustomer)).rejects.toThrow(/No route is available/);
    expect(sqlbox.submit).not.toHaveBeenCalled();

    // ... and an explicit override cannot get around the binding either.
    const pinned = makeStack({
      routes: [],
      customerRoutes: [{ route_id: null, smsc_id: 'smsc-b' }],
    });
    await expect(
      pinned.service.send(actor, { ...withCustomer, smscId: 'local-fake' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pinned.sqlbox.submit).not.toHaveBeenCalled();
  });

  it('leaves a send with NO customer completely unaffected (backwards compatible)', async () => {
    const { service, sqlbox, state } = makeStack({
      ...routed,
      quotas: [{ period: 'daily', limit_count: 1, used_count: 1 }],
      balance: 0,
    });
    const result = await service.send(actor, { ...message, channel: 'console' });
    expect(result.customerId).toBeNull();
    expect(result.charged).toBe(0);
    expect(sqlbox.submit).toHaveBeenCalled();
    // The exhausted quota belongs to a customer nobody claimed: untouched.
    expect(state.quotas[0].used_count).toBe('1');
  });

  it('is ATOMIC: a failed engine submission leaves no debit and no consumed quota', async () => {
    const submit = jest.fn(async () => {
      throw new Error('SQLBox spool insert failed');
    });
    const { service, state } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a', cost: '0.0200' })],
      quotas: [{ period: 'daily', limit_count: 10, used_count: 4 }],
      balance: 1,
      submit,
    });

    await expect(service.send(actor, withCustomer)).rejects.toThrow('SQLBox spool insert failed');

    expect(state.debits).toHaveLength(0);
    expect(state.balance).toBe(1);
    expect(state.quotas[0].used_count).toBe('4');
    // Only the separately-recorded rejection survives; no row claims a send.
    expect(state.decisions.every((d) => d.outcome === 'rejected')).toBe(true);
    expect(state.decisions.every((d) => d.messageRef === null)).toBe(true);
  });
});

describe('MessageSendService — recipient blocklist (evaluated before routing)', () => {
  it('refuses a blacklisted recipient without choosing a route', async () => {
    const { service, sqlbox, sql } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
      blocklist: [{ list_type: 'blacklist', msisdn: '256700000000', reason: 'complaint' }],
    });
    await expect(service.send(actor, { ...message, channel: 'console' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sqlbox.submit).not.toHaveBeenCalled();
    expect(sql.log.some((s) => s.includes('FROM routing_rules'))).toBe(false);
  });

  it('refuses a DND recipient even when a bind was pinned explicitly', async () => {
    const { service, sqlbox } = makeStack({
      blocklist: [{ list_type: 'dnd', msisdn: '256700000000' }],
    });
    await expect(
      service.send(actor, { ...message, smscId: 'local-fake', channel: 'console' }),
    ).rejects.toThrow(/dnd/);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('matches the blocklist on the normalised number, not the caller’s formatting', async () => {
    const { service } = makeStack({
      routes: [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })],
      blocklist: [{ list_type: 'blacklist', msisdn: '256700000000' }],
    });
    await expect(
      service.send(actor, { ...message, receiver: '00256700000000', channel: 'console' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MessageSendService — per-customer rate limit (customers.rate_limit_per_min)', () => {
  const routes = [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })];
  const send = (service: MessageSendService) =>
    service.send(actor, { ...message, customerId: 'cust-1', channel: 'api' });

  it('allows sends under the cap', async () => {
    const { service, sqlbox } = makeStack({ routes, rateLimitPerMin: 3 });
    await send(service);
    await send(service);
    await send(service);
    expect(sqlbox.submit).toHaveBeenCalledTimes(3);
  });

  it('refuses the send with a 429 once the cap is exceeded', async () => {
    const { service, sqlbox } = makeStack({ routes, rateLimitPerMin: 2 });
    await send(service);
    await send(service);

    await expect(send(service)).rejects.toBeInstanceOf(HttpException);
    try {
      await send(service);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
    }
    // The refusal is a refusal: nothing was spooled beyond the two allowed.
    expect(sqlbox.submit).toHaveBeenCalledTimes(2);
  });

  it('refuses BEFORE the blocklist, the router or any entitlement is consulted', async () => {
    const { service, sql, state } = makeStack({
      routes,
      rateLimitPerMin: 1,
      quotas: [{ period: 'daily', limit_count: 100, used_count: 0 }],
    });
    await send(service);
    sql.log.length = 0;

    await expect(send(service)).rejects.toBeInstanceOf(HttpException);
    expect(sql.log.some((s) => s.includes('FROM messaging_blocklist'))).toBe(false);
    expect(sql.log.some((s) => s.includes('FROM routing_rules'))).toBe(false);
    // No quota was burned by a send that never happened.
    expect(state.quotas[0].used_count).toBe('1');
  });

  it('still records the refusal so an operator can see it', async () => {
    const { service, state } = makeStack({ routes, rateLimitPerMin: 1 });
    await send(service);
    await expect(send(service)).rejects.toBeInstanceOf(HttpException);

    const rejected = state.decisions.filter((d) => d.outcome === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain('Customer rate limit exceeded');
  });

  it('does not limit a send with no customer attributed', async () => {
    const { service, sqlbox, redis } = makeStack({ routes, rateLimitPerMin: 1 });
    for (let attempt = 0; attempt < 4; attempt += 1)
      await service.send(actor, { ...message, channel: 'console' });
    expect(sqlbox.submit).toHaveBeenCalledTimes(4);
    expect(redis!.eval).not.toHaveBeenCalled();
  });

  it('does not limit a customer with no ceiling configured', async () => {
    const { service, sqlbox, redis } = makeStack({ routes, rateLimitPerMin: null });
    for (let attempt = 0; attempt < 4; attempt += 1) await send(service);
    expect(sqlbox.submit).toHaveBeenCalledTimes(4);
    expect(redis!.eval).not.toHaveBeenCalled();
  });

  it('FAILS OPEN when Redis is unavailable, rather than refusing live traffic', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { service, sqlbox } = makeStack({ routes, rateLimitPerMin: 1, redis: null });
      for (let attempt = 0; attempt < 5; attempt += 1) await send(service);
      expect(sqlbox.submit).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'customer rate limit failing open',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('MessageSendService — content filtering on the send path', () => {
  const routes = [routeRow({ id: 'r-ug', name: 'Uganda', target_smsc_id: 'smsc-a' })];
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('refuses a message whose BODY matches a block rule, and never spools it', async () => {
    const { service, sqlbox } = makeStack({
      routes,
      contentRules: [{ id: uuid(1), name: 'no-loans', pattern: 'loan' }],
    });
    await expect(
      service.send(actor, { ...message, text: 'cheap loan today', channel: 'console' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('records the refusal against the rule that caused it', async () => {
    const { service, state } = makeStack({
      routes,
      contentRules: [{ id: uuid(1), name: 'no-loans', pattern: 'loan' }],
    });
    await expect(
      service.send(actor, { ...message, text: 'cheap loan today', channel: 'console' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const rejected = state.decisions.filter((d) => d.outcome === 'rejected');
    expect(rejected).toHaveLength(1);
    // Structured, not just prose: "which rule stopped this?" is a query.
    expect(rejected[0].contentRuleId).toBe(uuid(1));
    expect(rejected[0].contentRuleName).toBe('no-loans');
    expect(String(rejected[0].reason)).toContain('no-loans');
  });

  it('bumps the rule hit counter for a block, outside the rolled-back transaction', async () => {
    const { service, state } = makeStack({
      routes,
      contentRules: [{ id: uuid(1), name: 'no-loans', pattern: 'loan' }],
    });
    await expect(
      service.send(actor, { ...message, text: 'loan', channel: 'console' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(state.contentRuleWrites.some((s) => s.includes('match_count = match_count + 1'))).toBe(
      true,
    );
  });

  it('blocks on the SENDER ID as well as the body', async () => {
    const { service, sqlbox } = makeStack({
      routes,
      contentRules: [
        {
          id: uuid(1),
          name: 'banned-sender',
          match_field: 'sender',
          match_type: 'exact',
          pattern: 'JKANNEL',
        },
      ],
    });
    await expect(service.send(actor, { ...message, channel: 'console' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('sends normally when nothing matches, and records no content rule', async () => {
    const { service, sqlbox, state } = makeStack({
      routes,
      contentRules: [{ id: uuid(1), name: 'no-loans', pattern: 'loan' }],
    });
    await service.send(actor, { ...message, text: 'your balance is 500', channel: 'console' });
    expect(sqlbox.submit).toHaveBeenCalledTimes(1);
    expect(state.decisions[0].contentRuleId).toBeNull();
  });

  it('lets a higher-precedence ALLOW rule exempt a message a block rule would stop', async () => {
    const { service, sqlbox, state } = makeStack({
      routes,
      contentRules: [
        { id: uuid(1), name: 'vip', action: 'allow', pattern: 'loan', priority: 10 },
        { id: uuid(2), name: 'no-loans', action: 'block', pattern: 'loan', priority: 20 },
      ],
    });
    await service.send(actor, { ...message, text: 'cheap loan', channel: 'console' });
    expect(sqlbox.submit).toHaveBeenCalledTimes(1);
    expect(state.decisions[0].contentRuleName).toBe('vip');
  });

  it('applies an SMSC-scoped rule only once the carrier is known, and only to that carrier', async () => {
    const blocked = makeStack({
      routes,
      contentRules: [
        { id: uuid(1), name: 'mtn-no-promo', pattern: 'promo', smsc_id: 'local-fake' },
      ],
    });
    await expect(
      blocked.service.send(actor, { ...message, text: 'promo!', channel: 'console' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(blocked.sqlbox.submit).not.toHaveBeenCalled();
    // The refusal still names the rule even though it was judged after routing.
    expect(blocked.state.decisions[0].contentRuleName).toBe('mtn-no-promo');

    const allowed = makeStack({
      routes,
      contentRules: [
        { id: uuid(1), name: 'other-carrier', pattern: 'promo', smsc_id: 'someone-else' },
      ],
    });
    await allowed.service.send(actor, { ...message, text: 'promo!', channel: 'console' });
    expect(allowed.sqlbox.submit).toHaveBeenCalledTimes(1);
  });

  it('cannot be hung by a pathological pattern that reached the table anyway', async () => {
    // Write-time validation refuses `(a+)+$`, so a row carrying it can only have
    // arrived by direct SQL. It must still not stop the sender.
    const { service, sqlbox } = makeStack({
      routes,
      contentRules: [{ id: uuid(1), name: 'hostile', match_type: 'regex', pattern: '(a+)+$' }],
    });
    const started = Date.now();
    await service.send(actor, { ...message, text: 'a'.repeat(60) + '!', channel: 'console' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sqlbox.submit).toHaveBeenCalledTimes(1);
  });
});
