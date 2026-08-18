import { BadRequestException } from '@nestjs/common';
import { TestToolsService } from './test-tools.service';

function makeService(routeRows: Record<string, unknown>[] = []) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      sql.push(text);
      params.push(values);
      if (text.includes('FROM routing_rules')) return { rows: routeRows };
      if (text.startsWith('INSERT INTO test_sends')) return { rows: [{ id: 't1' }] };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return { service: new TestToolsService(database), sql, params };
}

const actor = { tenantId: '1', userId: 'u1' };

/**
 * §15 asks the number tool to "normalize number and identify configured
 * market / network / prefix". Two of those three are possible here. The
 * network is not: there is no prefix-to-operator database in this product, and
 * inferring one from a prefix would be a fabricated fact an operator then acts
 * on. The tool says so rather than leaving a blank that reads as "no network".
 */
describe('TestToolsService.lookupNumber', () => {
  it('normalises an international number and reports it', async () => {
    const { service } = makeService();
    const result = await service.lookupNumber(actor, '+256 772 000 118');
    expect(result.digits).toBe('256772000118');
    expect(result.normalized).toBe('+256772000118');
    expect(result.valid).toBe(true);
  });

  it('states plainly that the mobile network is not identified', async () => {
    const { service } = makeService();
    const result = await service.lookupNumber(actor, '+256772000118');
    expect(result.limits.join(' ')).toMatch(/no prefix-to-operator database/);
  });

  it('explains why a national number could not be normalised', async () => {
    // normalizeMsisdn refuses to invent a country code; the tool says why
    // rather than reporting a bare "invalid".
    delete process.env.DEFAULT_COUNTRY_CODE;
    const { service } = makeService();
    const result = await service.lookupNumber(actor, '0772000118');
    expect(result.valid).toBe(false);
    expect(result.limits.join(' ')).toMatch(/DEFAULT_COUNTRY_CODE/);
    // It still searches by the digits as typed rather than refusing outright.
    expect(result.digits).toBe('0772000118');
  });

  it('matches configured prefixes longest-first, the order the selector uses', async () => {
    const { service, sql } = makeService([
      { id: 'r1', name: 'Uganda MTN', match_prefix: '25677', priority: 10 },
      { id: 'r2', name: 'Uganda', match_prefix: '256', priority: 20 },
    ]);
    const result = await service.lookupNumber(actor, '+256772000118');
    expect(result.matchingPrefixes).toHaveLength(2);
    const query = sql.find((text) => text.includes('FROM routing_rules'))!;
    expect(query).toContain('length(r.match_prefix) DESC');
  });

  it('rejects an input with no digits at all', async () => {
    const { service } = makeService();
    await expect(service.lookupNumber(actor, 'not-a-number')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('TestToolsService.analyseMessage', () => {
  it('infers the encoding from the content rather than assuming GSM-7', () => {
    const { service } = makeService();
    // Cyrillic forces UCS-2, which is 70 characters per part, not 160 — the
    // single most common surprise when a message costs twice what was expected.
    const ascii = service.analyseMessage('hello');
    const cyrillic = service.analyseMessage('Привет');
    expect(ascii.alphabet).not.toBe(cyrillic.alphabet);
    expect(ascii.singleCapacity).toBe(160);
    expect(cyrillic.singleCapacity).toBe(70);
  });

  it('rejects a non-string body', () => {
    const { service } = makeService();
    expect(() => service.analyseMessage(undefined as never)).toThrow(BadRequestException);
  });
});

/**
 * UC-TST-01: "Visually distinguish test traffic from production traffic in
 * traces/events." Tagged in JKANNEL's own table keyed on foreign_id, because
 * sent_sms is engine-owned and adding columns there is something to avoid
 * unless the engine reads them.
 */
describe('TestToolsService.tagTestSend', () => {
  it('records the tag against the message correlation key', async () => {
    const { service, params } = makeService();
    await service.tagTestSend(actor, {
      foreignId: '4211',
      destination: '+256772000118',
      reason: 'verifying MTN route',
    });
    expect(params.some((values) => values.includes('4211'))).toBe(true);
  });

  it('is idempotent, so re-tagging does not duplicate', async () => {
    const { service, sql } = makeService();
    await service.tagTestSend(actor, { foreignId: '4211', destination: '+256772000118' });
    expect(sql.find((text) => text.startsWith('INSERT INTO test_sends'))).toContain(
      'ON CONFLICT (tenant_id, foreign_id) DO UPDATE',
    );
  });

  it('requires a foreign id, since the tag is useless without one', async () => {
    const { service } = makeService();
    await expect(
      service.tagTestSend(actor, { foreignId: '', destination: '+256772000118' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an empty set for no references rather than querying', async () => {
    const { service, sql } = makeService();
    expect(await service.testSendFlags(actor, [])).toEqual(new Set());
    expect(sql).toEqual([]);
  });
});
