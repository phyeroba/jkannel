import { OperationalEventsService } from './operational-events.service';

/**
 * PAGING THE EVENT STREAM.
 *
 * The stream used to answer `LIMIT n` and nothing else, so the newest n events
 * were the only ones reachable. The console said so honestly and then advised
 * raising the row count, which runs out at the 500-row ceiling — on the screen
 * you open precisely when a great deal has just happened.
 *
 * What is tested here is the property that makes a pager trustworthy: the page
 * and the count must describe the SAME set of rows. A `total` counted without
 * the filters would say 4,000 while the filtered page held 12, and every page
 * button after the first would land on nothing.
 */
function harness(pageRows: unknown[] = [], total = '0') {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('count(*)')) return { rows: [{ total }] };
      return { rows: pageRows };
    },
  };
  const database = { tenantTransaction: (_t: string, work: any) => work(client) } as any;
  return { service: new OperationalEventsService(database), statements };
}

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const pageQuery = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.find((entry) => entry.sql.includes('FROM operational_events') && !entry.sql.includes('count(*)'))!;
const countQuery = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.find((entry) => entry.sql.includes('count(*)'))!;

describe('OperationalEventsService.list', () => {
  it('asks for the page the caller wanted', async () => {
    const { service, statements } = harness([{ id: 'e1' }], '240');
    const result = await service.list(actor, { limit: 50, offset: 100 });

    const page = pageQuery(statements);
    expect(page.sql).toContain('LIMIT');
    expect(page.sql).toContain('OFFSET');
    // Limit and offset are the last two bound parameters, in that order.
    expect(page.params.slice(-2)).toEqual([50, 100]);
    expect(result).toMatchObject({ limit: 50, offset: 100, total: 240 });
  });

  it('counts under the SAME filters as the page it counts for', async () => {
    // A total counted without the WHERE clause reports the whole table, so the
    // pager offers pages that are empty the moment a filter is applied.
    const { service, statements } = harness([], '3');
    await service.list(actor, { severity: 'critical', kindPrefix: 'smsc.', limit: 25 });

    const page = pageQuery(statements);
    const count = countQuery(statements);
    expect(count.sql).toContain('severity =');
    expect(count.sql).toContain('kind LIKE');
    // The count takes exactly the filter parameters — not the limit or offset,
    // which is what makes the two clauses identical rather than merely similar.
    expect(count.params).toEqual(page.params.slice(0, -2));
    expect(count.params).toEqual(['smsc.%', 'critical']);
  });

  it('clamps a limit past the ceiling and refuses a negative offset', async () => {
    const { service, statements } = harness([], '0');
    await service.list(actor, { limit: 5000, offset: -40 });
    expect(pageQuery(statements).params.slice(-2)).toEqual([500, 0]);
  });

  it('defaults to the newest page when the caller says nothing', async () => {
    const { service, statements } = harness([], '0');
    await service.list(actor);
    expect(pageQuery(statements).params.slice(-2)).toEqual([100, 0]);
    expect(pageQuery(statements).sql).toContain('ORDER BY observed_at DESC');
  });
});
