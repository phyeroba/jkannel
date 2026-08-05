import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MAX_DESTINATIONS_PER_RULE, MoDestinationRow, MoRuleRow } from './mo-routing';
import {
  MAX_MO_RULES_PER_TENANT,
  MoRulesService,
  validateDestinationConfig,
} from './mo-rules.service';

const actor = { tenantId: '1', userId: 'u1' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ruleRow(overrides: Partial<MoRuleRow> = {}): MoRuleRow {
  return {
    id: id(1),
    name: 'rule',
    description: null,
    enabled: true,
    priority: 100,
    match_smsc_id: null,
    match_destination: null,
    match_destination_type: 'any',
    match_sender_prefix: null,
    match_keyword: null,
    match_keyword_type: 'any',
    case_sensitive: false,
    continue_after_match: false,
    customer_id: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Fixture {
  rules?: MoRuleRow[];
  destinations?: MoDestinationRow[];
  smscs?: string[];
  ruleCount?: number;
  destinationCount?: number;
}

function makeService(fixture: Fixture = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const text = sql.trim();
      if (text.includes('count(*)') && text.includes('mo_routing_rules'))
        return { rows: [{ count: String(fixture.ruleCount ?? 0) }] };
      if (text.includes('count(*)') && text.includes('mo_rule_destinations'))
        return { rows: [{ count: String(fixture.destinationCount ?? 0) }] };
      if (text.includes('FROM mo_routing_rules')) return { rows: fixture.rules ?? [] };
      if (text === 'SELECT 1 FROM mo_routing_rules WHERE id=$1')
        return { rows: (fixture.rules ?? []).length ? [{ '?column?': 1 }] : [] };
      if (text.includes('FROM mo_rule_destinations')) return { rows: fixture.destinations ?? [] };
      if (text.startsWith('INSERT INTO mo_routing_rules'))
        return { rows: [ruleRow({ name: params[1] as string })] };
      if (text.startsWith('UPDATE mo_routing_rules'))
        return { rows: [ruleRow({ name: params[1] as string })] };
      if (text.startsWith('DELETE FROM mo_routing_rules'))
        return { rows: (fixture.rules ?? []).map((r) => ({ id: r.id, name: r.name })) };
      if (text.startsWith('INSERT INTO mo_rule_destinations'))
        return { rows: [{ id: id(50), rule_id: params[1], kind: params[2], target: params[3] }] };
      if (text.startsWith('DELETE FROM mo_rule_destinations')) return { rows: [] };
      if (text.includes('FROM smsc_definitions'))
        return {
          rows: (fixture.smscs ?? ['mtn-ug']).includes(String(params[0])) ? [{ id: 1 }] : [],
        };
      if (text.includes('FROM customers')) return { rows: [] };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return { service: new MoRulesService(database), client, calls };
}

const base = { name: 'crm-forward' };

describe('MoRulesService — validation', () => {
  it('refuses a match type with no value, which would silently mean "any"', async () => {
    const { service } = makeService();
    await expect(
      service.create(actor, { ...base, matchKeywordType: 'first_word' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(actor, { ...base, matchDestinationType: 'exact' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a rule scoped to an SMSC the tenant does not own', async () => {
    const { service } = makeService({ smscs: ['mtn-ug'] });
    await expect(
      service.create(actor, { ...base, matchSmscId: 'not-ours' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(actor, { ...base, matchSmscId: 'mtn-ug' })).resolves.toBeTruthy();
  });

  it('refuses a non-numeric sender prefix', async () => {
    const { service } = makeService();
    await expect(
      service.create(actor, { ...base, matchSenderPrefix: 'MTN' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps the enabled rule set so ingest cost stays bounded', async () => {
    const { service } = makeService({ ruleCount: MAX_MO_RULES_PER_TENANT });
    await expect(service.create(actor, base)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps the destinations of one rule', async () => {
    const { service } = makeService({
      rules: [ruleRow()],
      destinationCount: MAX_DESTINATIONS_PER_RULE,
    });
    await expect(
      service.addDestination(actor, id(1), { kind: 'webhook', target: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a destination on a rule that does not exist', async () => {
    const { service } = makeService({ rules: [] });
    await expect(
      service.addDestination(actor, id(9), { kind: 'webhook', target: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalises an SMS destination to canonical digits before storing it', async () => {
    const { service, calls } = makeService({ rules: [ruleRow()] });
    await service.addDestination(actor, id(1), { kind: 'sms', target: '+256 700 123 456' });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO mo_rule_destinations'))!;
    expect(insert.params[3]).toBe('256700123456');
  });

  it('audits every mutation inside the same transaction as the write', async () => {
    const { service, calls } = makeService();
    await service.create(actor, base);
    expect(calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('answers 409 for a duplicate rule name instead of leaking a Postgres error as a 500', async () => {
    const { service, client } = makeService();
    client.query.mockImplementationOnce(async () => ({ rows: [{ count: '0' }] }));
    client.query.mockImplementationOnce(async () => {
      const error: Error & { code?: string } = new Error('duplicate key value');
      error.code = '23505';
      throw error;
    });
    await expect(service.create(actor, base)).rejects.toBeInstanceOf(ConflictException);
  });

  it('deleting a rule that is not there is a 404, not a silent success', async () => {
    const { service } = makeService({ rules: [] });
    await expect(service.remove(actor, id(9))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MoRulesService — destination config', () => {
  it('keeps only the keys each transport actually uses', () => {
    expect(validateDestinationConfig('webhook', { method: 'put', secret: 's', bogus: 1 })).toEqual({
      method: 'PUT',
      secret: 's',
    });
    expect(validateDestinationConfig('email', { subject: 'MO', bogus: 1 })).toEqual({
      subject: 'MO',
    });
    expect(validateDestinationConfig('sms', { sender: 'JK', bogus: 1 })).toEqual({ sender: 'JK' });
  });

  it('refuses a method the transport does not support', () => {
    expect(() => validateDestinationConfig('webhook', { method: 'DELETE' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses headers that would rewrite the transport itself', () => {
    expect(() =>
      validateDestinationConfig('webhook', { headers: { Host: 'evil.example' } }),
    ).toThrow(BadRequestException);
    expect(() => validateDestinationConfig('webhook', { headers: { 'bad header': 'x' } })).toThrow(
      BadRequestException,
    );
    expect(validateDestinationConfig('webhook', { headers: { 'X-Tenant': 'acme' } })).toEqual({
      method: 'POST',
      headers: { 'X-Tenant': 'acme' },
    });
  });
});

describe('MoRulesService — preview', () => {
  it('answers with the rules that would match and where the message would go', async () => {
    const { service } = makeService({
      rules: [ruleRow({ id: id(1), name: 'crm' })],
      destinations: [
        {
          id: id(50),
          rule_id: id(1),
          kind: 'webhook',
          target: 'https://crm.example.com',
          enabled: true,
          config: {},
          max_attempts: 5,
          created_by: 'u1',
          created_at: 'now',
          updated_at: 'now',
        },
      ],
    });
    const result = await service.preview(actor, {
      smscId: 'mtn-ug',
      sender: '+256700123456',
      receiver: '8080',
      body: 'BAL',
    });
    expect(result.matches.map((m) => m.ruleName)).toEqual(['crm']);
    expect(result.deliveries).toEqual([
      {
        ruleId: id(1),
        ruleName: 'crm',
        destinationId: id(50),
        kind: 'webhook',
        target: 'https://crm.example.com',
      },
    ]);
  });
});
