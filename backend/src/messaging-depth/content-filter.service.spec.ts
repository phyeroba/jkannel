import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ContentRuleRow, MAX_REGEX_RULES_PER_TENANT, MAX_RULES_PER_TENANT } from './content-filter';
import { ContentFilterService } from './content-filter.service';

const actor = { tenantId: '1', userId: 'u1' };

function row(overrides: Partial<ContentRuleRow> = {}): ContentRuleRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'rule',
    description: null,
    match_field: 'body',
    match_type: 'substring',
    pattern: 'loan',
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

interface Fixture {
  rules?: Array<Partial<ContentRuleRow>>;
  /** count(*) answers for the capacity check. */
  counts?: { total: number; regex: number };
  smscs?: string[];
  customers?: string[];
}

function makeService(fixture: Fixture = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let stored = (fixture.rules ?? []).map((r) => row(r));
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const text = sql.trim();
      if (text.includes('FROM messaging_content_rules') && text.includes('count(*)'))
        return {
          rows: [
            {
              total: String(fixture.counts?.total ?? stored.length),
              regex: String(fixture.counts?.regex ?? 0),
            },
          ],
        };
      if (text.startsWith('SELECT') && text.includes('FROM messaging_content_rules'))
        return { rows: stored };
      if (text.startsWith('INSERT INTO messaging_content_rules')) {
        const created = row({
          id: '00000000-0000-4000-8000-0000000000ff',
          name: params[1] as string,
          match_field: params[3] as never,
          match_type: params[4] as never,
          pattern: params[5] as string,
          action: params[7] as never,
          smsc_id: (params[8] ?? null) as string | null,
          priority: Number(params[11]),
        });
        stored = [...stored, created];
        return { rows: [created] };
      }
      if (text.startsWith('UPDATE messaging_content_rules')) {
        // Quarantine and edit both land here; return the affected rows.
        return { rows: stored.map((r) => ({ ...r, enabled: false })) };
      }
      if (text.startsWith('DELETE FROM messaging_content_rules'))
        return { rows: stored.length ? [{ id: stored[0].id, name: stored[0].name }] : [] };
      if (text.includes('FROM smsc_definitions'))
        return {
          rows: (fixture.smscs ?? ['mtn-ug']).includes(String(params[0])) ? [{ id: 1 }] : [],
        };
      if (text.includes('FROM customers'))
        return {
          rows: (fixture.customers ?? []).includes(String(params[0])) ? [{ id: params[0] }] : [],
        };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return {
    service: new ContentFilterService(database),
    client,
    calls,
    get stored() {
      return stored;
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ContentFilterService — send-path evaluation', () => {
  afterEach(() => {
    delete process.env.CONTENT_FILTER_CACHE_TTL_MS;
  });

  it('refuses a blocked message with a 403 naming the rule, never a 500', async () => {
    const { service, client } = makeService({ rules: [{ name: 'no-loans', pattern: 'loan' }] });
    const set = await service.loadInClient(client as never, '1');
    const verdict = service.evaluate(set, {
      sender: 'S',
      recipient: '256700000000',
      body: 'loan offer',
    });
    expect(() => service.assertAllowed(verdict)).toThrow(ForbiddenException);
    try {
      service.assertAllowed(verdict);
    } catch (error) {
      expect((error as Error).message).toContain('no-loans');
    }
  });

  it('flags a rule set that contains an SMSC-scoped rule, which moves the evaluation point', async () => {
    const plain = makeService({ rules: [{ pattern: 'loan' }] });
    expect((await plain.service.loadInClient(plain.client as never, '1')).hasSmscScopedRules).toBe(
      false,
    );
    const scoped = makeService({ rules: [{ pattern: 'loan', smsc_id: 'mtn-ug' }] });
    expect(
      (await scoped.service.loadInClient(scoped.client as never, '1')).hasSmscScopedRules,
    ).toBe(true);
  });

  it('caches the rule set: repeated sends inside the window cost ZERO extra queries', async () => {
    const { service, client } = makeService({ rules: [{ pattern: 'loan' }] });
    await service.loadInClient(client as never, '1');
    const after = client.query.mock.calls.length;
    for (let i = 0; i < 50; i += 1) await service.loadInClient(client as never, '1');
    expect(client.query.mock.calls.length).toBe(after);
  });

  it('reloads once the cache window has elapsed', async () => {
    process.env.CONTENT_FILTER_CACHE_TTL_MS = '0';
    const { service, client } = makeService({ rules: [{ pattern: 'loan' }] });
    await service.loadInClient(client as never, '1');
    const after = client.query.mock.calls.length;
    await service.loadInClient(client as never, '1');
    expect(client.query.mock.calls.length).toBeGreaterThan(after);
  });

  it('a mutation invalidates the cache immediately in this process', async () => {
    const { service, client } = makeService({ rules: [{ pattern: 'loan' }] });
    await service.loadInClient(client as never, '1');
    const before = client.query.mock.calls.length;
    service.invalidate('1');
    await service.loadInClient(client as never, '1');
    expect(client.query.mock.calls.length).toBeGreaterThan(before);
  });

  it('evaluates a full 500-rule set well inside a millisecond budget per send', async () => {
    // The ceiling that makes the per-send cost predictable. If a full rule set
    // is not cheap to scan, content filtering does not belong on the send path.
    const rules = Array.from({ length: MAX_RULES_PER_TENANT }, (_, index) => ({
      id: uuid(index + 1),
      name: `rule-${index}`,
      pattern: `keyword-${index}`,
      priority: index,
    }));
    const { service, client } = makeService({ rules });
    const set = await service.loadInClient(client as never, '1');
    expect(set.rules).toHaveLength(MAX_RULES_PER_TENANT);
    const context = { sender: 'JKANNEL', recipient: '256700000000', body: 'x'.repeat(1000) };
    const started = Date.now();
    for (let i = 0; i < 200; i += 1) service.evaluate(set, context);
    const perSendMs = (Date.now() - started) / 200;
    expect(perSendMs).toBeLessThan(2);
  });
});

describe('ContentFilterService — quarantine of a runaway regex', () => {
  it('disables the rule, audits it and evicts the cache', async () => {
    const { service, client, calls } = makeService({ rules: [{ match_type: 'regex' }] });
    await service.loadInClient(client as never, '1');
    await service.quarantine('1', [uuid(1)]);
    const update = calls.find((c) => c.sql.includes('quarantined_at = now()'));
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('enabled = false');
    expect(calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
    // Evicted: the next load hits the database again.
    const before = client.query.mock.calls.length;
    await service.loadInClient(client as never, '1');
    expect(client.query.mock.calls.length).toBeGreaterThan(before);
  });

  it('settle() quarantines over-budget rules and counts a block, but writes nothing on a clean allow', async () => {
    const { service, calls } = makeService();
    await service.settle('1', {
      allowed: true,
      decidedBy: null,
      reason: 'no match',
      rulesEvaluated: 3,
      overBudgetRuleIds: [],
    });
    expect(calls).toHaveLength(0);

    await service.settle('1', {
      allowed: false,
      decidedBy: {
        ruleId: uuid(1),
        ruleName: 'no-loans',
        action: 'block',
        field: 'body',
        matchType: 'substring',
        pattern: 'loan',
        priority: 10,
        matchedOn: 'body',
        reason: null,
      },
      reason: 'blocked',
      rulesEvaluated: 1,
      overBudgetRuleIds: [uuid(2)],
    });
    expect(calls.some((c) => c.sql.includes('quarantined_at = now()'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('match_count = match_count + 1'))).toBe(true);
  });

  it('never lets bookkeeping failure change the outcome the sender saw', async () => {
    const database: any = {
      tenantTransaction: async () => {
        throw new Error('database is down');
      },
    };
    const service = new ContentFilterService(database);
    await expect(
      service.settle('1', {
        allowed: false,
        decidedBy: {
          ruleId: uuid(1),
          ruleName: 'r',
          action: 'block',
          field: 'body',
          matchType: 'substring',
          pattern: 'p',
          priority: 1,
          matchedOn: 'body',
          reason: null,
        },
        reason: 'blocked',
        rulesEvaluated: 1,
        overBudgetRuleIds: [],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ContentFilterService — preview', () => {
  it('answers with the outcome, the deciding rule and the shadowed matches', async () => {
    const { service } = makeService({
      rules: [
        { id: uuid(1), name: 'exempt', action: 'allow', pattern: 'loan', priority: 10 },
        { id: uuid(2), name: 'block-loans', action: 'block', pattern: 'loan', priority: 20 },
      ],
    });
    const result = await service.preview(actor, {
      sender: 'JKANNEL',
      recipient: '+256700000000',
      text: 'cheap loan',
    });
    expect(result.outcome).toBe('allow');
    expect(result.decidedBy?.ruleName).toBe('exempt');
    expect(result.matches.map((m) => m.shadowed)).toEqual([false, true]);
    expect(result.evaluationPoint).toBe('before_route_selection');
  });

  it('normalises the recipient exactly as the send path does', async () => {
    const { service } = makeService({
      rules: [{ match_field: 'recipient', match_type: 'prefix', pattern: '25670' }],
    });
    const result = await service.preview(actor, {
      sender: 'S',
      recipient: '00256 700 000 000',
      text: 'hi',
    });
    expect(result.context.recipient).toBe('256700000000');
    expect(result.outcome).toBe('block');
  });

  it('reports the deferred evaluation point when a rule is SMSC-scoped', async () => {
    const { service } = makeService({ rules: [{ smsc_id: 'mtn-ug', pattern: 'loan' }] });
    const result = await service.preview(actor, {
      sender: 'S',
      recipient: '256700000000',
      text: 'loan',
    });
    expect(result.evaluationPoint).toBe('after_route_selection');
    // Without a carrier the SMSC-scoped rule is out of scope, not assumed to fire.
    expect(result.outcome).toBe('allow');
    expect(result.rulesOutOfScope).toBe(1);
  });
});

describe('ContentFilterService — CRUD', () => {
  const base = {
    name: 'no-loans',
    matchField: 'body' as const,
    matchType: 'substring' as const,
    pattern: 'loan',
    action: 'block' as const,
  };

  it('creates a rule and audits it in the same transaction as the write', async () => {
    const { service, calls } = makeService();
    await service.create(actor, base);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO messaging_content_rules'))!;
    expect(insert.params[1]).toBe('no-loans');
    expect(calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('refuses an unsafe regex at write time rather than at send time', async () => {
    const { service } = makeService();
    await expect(
      service.create(actor, { ...base, matchType: 'regex', pattern: '(a+)+$' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a rule scoped to an SMSC the tenant does not own', async () => {
    const { service } = makeService({ smscs: ['mtn-ug'] });
    await expect(service.create(actor, { ...base, smscId: 'not-ours' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(actor, { ...base, smscId: 'mtn-ug' })).resolves.toBeTruthy();
  });

  it('refuses a rule scoped to a customer that does not exist', async () => {
    const { service } = makeService({ customers: [] });
    await expect(service.create(actor, { ...base, customerId: uuid(9) })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('caps the enabled rule set so per-send cost cannot grow without limit', async () => {
    const atLimit = makeService({ counts: { total: MAX_RULES_PER_TENANT, regex: 0 } });
    await expect(atLimit.service.create(actor, base)).rejects.toBeInstanceOf(BadRequestException);

    const regexAtLimit = makeService({
      counts: { total: 1, regex: MAX_REGEX_RULES_PER_TENANT },
    });
    await expect(
      regexAtLimit.service.create(actor, { ...base, matchType: 'regex', pattern: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not count a disabled rule against the ceiling', async () => {
    const { service } = makeService({ counts: { total: MAX_RULES_PER_TENANT, regex: 0 } });
    await expect(service.create(actor, { ...base, enabled: false })).resolves.toBeTruthy();
  });

  it('answers 409 for a duplicate rule name instead of leaking a Postgres error as a 500', async () => {
    const { service, client } = makeService();
    client.query.mockImplementationOnce(async () => ({ rows: [{ total: '0', regex: '0' }] }));
    client.query.mockImplementationOnce(async () => {
      const error: Error & { code?: string } = new Error('duplicate key value');
      error.code = '23505';
      throw error;
    });
    await expect(service.create(actor, base)).rejects.toBeInstanceOf(ConflictException);
  });

  it('deleting a rule that is not there is a 404, not a silent success', async () => {
    const { service } = makeService();
    await expect(service.remove(actor, uuid(7))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publishes its precedence so a console does not have to hard-code it', () => {
    const { service } = makeService();
    expect(service.policy()).toMatchObject({
      precedence: 'first_match_wins',
      order: 'priority ASC, created_at ASC, id ASC',
      defaultOutcome: 'allow',
    });
  });
});
