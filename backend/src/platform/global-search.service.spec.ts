import { GlobalSearchService } from './global-search.service';

function makeService(
  options: {
    smscRows?: Array<Record<string, unknown>>;
    routeRows?: Array<Record<string, unknown>>;
    messageItems?: Array<Record<string, unknown>>;
    sqlboxAvailable?: boolean;
    sqlboxThrows?: boolean;
  } = {},
) {
  const seen: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      seen.push(sql);
      if (sql.includes('FROM smsc_definitions')) return { rows: options.smscRows ?? [] };
      if (sql.includes('FROM routing_rules')) return { rows: options.routeRows ?? [] };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const sqlbox: any = {
    probe: jest.fn(async () => ({ available: options.sqlboxAvailable ?? true, evidence: 'ok' })),
    list: jest.fn(async () => {
      if (options.sqlboxThrows) throw new Error('sqlbox exploded');
      return { items: options.messageItems ?? [] };
    }),
  };
  return { service: new GlobalSearchService(database, sqlbox), sqlbox, seen };
}

const ALL = new Set(['smsc.view', 'routes.view', 'messages.view']);
const actor = { tenantId: '1' };

describe('GlobalSearchService', () => {
  it('finds SMSCs by engine id and by name', async () => {
    const { service } = makeService({
      smscRows: [
        {
          id: 'u1',
          engine_id: 'mtn-p1',
          name: 'MTN Primary',
          type: 'smpp',
          lifecycle_state: 'active',
        },
      ],
    });
    const result = await service.search(actor, 'mtn', ALL);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ kind: 'smsc', title: 'MTN Primary' });
    expect(result.hits[0].to).toContain('mtn-p1');
  });

  /**
   * An operator pasting a number from a support ticket does not know which form
   * the engine happened to store. Without normalisation `0772000118` and
   * `+256772000118` are different searches over the same traffic.
   */
  it('normalises an international number so the stored form does not matter', async () => {
    const { service, sqlbox } = makeService({
      messageItems: [{ id: '901', receiver: '+256772000118', deliveryStatus: 'delivered' }],
    });
    const result = await service.search(actor, '+256 772 000 118', ALL);
    expect(result.interpretedAsMsisdn).toBe(true);
    expect(sqlbox.list).toHaveBeenCalledWith(expect.objectContaining({ query: '256772000118' }));
    expect(result.hits[0].kind).toBe('msisdn');
  });

  /**
   * normalizeMsisdn refuses to expand a national number without a configured
   * country code — it will not invent a country on a multi-country gateway.
   * Search must not punish the operator for that: it falls back to the digits
   * as typed, which guesses at nothing.
   */
  it('still searches a national number by its raw digits when no country is configured', async () => {
    delete process.env.DEFAULT_COUNTRY_CODE;
    const { service, sqlbox } = makeService({ messageItems: [] });
    const result = await service.search(actor, '0772000118', ALL);
    expect(result.interpretedAsMsisdn).toBe(true);
    expect(sqlbox.list).toHaveBeenCalledWith(expect.objectContaining({ query: '0772000118' }));
  });

  it('treats a non-numeric term as a message id, not an MSISDN', async () => {
    const { service, sqlbox } = makeService({
      messageItems: [{ id: 'msg_01HXQ4K2R9', receiver: '+256700000001' }],
    });
    const result = await service.search(actor, 'msg_01HXQ4K2R9', ALL);
    expect(result.interpretedAsMsisdn).toBe(false);
    expect(sqlbox.list).toHaveBeenCalledWith(expect.objectContaining({ query: 'msg_01HXQ4K2R9' }));
  });

  /**
   * The gate runs BEFORE the query. Filtering results afterwards would leak
   * existence through timing even when the row is never rendered.
   */
  it('does not query a kind the caller cannot see, and says which it skipped', async () => {
    const { service, sqlbox, seen } = makeService({ smscRows: [] });
    const result = await service.search(actor, 'anything', new Set(['smsc.view']));
    expect(seen.some((sql) => sql.includes('routing_rules'))).toBe(false);
    expect(sqlbox.list).not.toHaveBeenCalled();
    expect(result.skipped.map((s) => s.permission).sort()).toEqual([
      'messages.view',
      'routes.view',
    ]);
  });

  it('reports an incomplete search rather than erroring when SQLBox is down', async () => {
    const { service } = makeService({ sqlboxAvailable: false });
    const result = await service.search(actor, 'msg_1', ALL);
    expect(result.hits).toEqual([]);
  });

  it('survives a SQLBox failure — a search must never be what errors a page', async () => {
    const { service } = makeService({ sqlboxThrows: true });
    await expect(service.search(actor, 'msg_1', ALL)).resolves.toMatchObject({ hits: [] });
  });

  it('does not search on a single character', async () => {
    const { service, seen } = makeService();
    const result = await service.search(actor, 'm', ALL);
    expect(result.hits).toEqual([]);
    expect(seen).toEqual([]);
  });
});
