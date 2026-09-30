import { ConsoleRepository } from './console.repository';

/**
 * The counts behind the console's status tabs.
 *
 * The console wants a number on each tab, and the cheap way to get one is to
 * count the rows the grid already loaded. That counts the current PAGE. On a
 * register paginated at fifty, a tab would read "open 50" while three hundred
 * alerts were open — a confident wrong answer, which is worse than no answer.
 *
 * So the tally is a server-side aggregate, and it has to satisfy two things
 * the page-count version never could: it must cover the whole table, and it
 * must go through the same tenant-scoped connection as the list, or it would
 * report the size of another tenant's problem.
 */
describe('alert summary tally', () => {
  const makeRepository = (rows: Record<string, Array<{ key: string | null; n: number }>>) => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('a.status')) return { rows: rows.status };
      if (sql.includes('COALESCE(a.severity, r.severity)')) return { rows: rows.severity };
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new ConsoleRepository({} as never);
    const inTenant = jest
      .spyOn(repository as never as { inTenant: unknown }, 'inTenant' as never)
      .mockImplementation((async (_actor: unknown, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query })) as never);
    return { repository, query, inTenant };
  };

  const actor = { tenantId: '7', userId: 'user-1' } as never;

  it('tallies the whole table by status and by severity', async () => {
    const { repository } = makeRepository({
      status: [
        { key: 'open', n: 7 },
        { key: 'resolved', n: 24 },
      ],
      severity: [
        { key: 'critical', n: 8 },
        { key: 'warning', n: 23 },
      ],
    });
    await expect(repository.alertSummary(actor)).resolves.toEqual({
      total: 31,
      byStatus: { open: 7, resolved: 24 },
      bySeverity: { critical: 8, warning: 23 },
    });
  });

  // Row-level security is enforced by the tenant-scoped connection, so an
  // aggregate that bypassed `inTenant` would count rows the caller cannot read.
  it('runs through the tenant-scoped connection, like the list does', async () => {
    const { repository, inTenant } = makeRepository({ status: [], severity: [] });
    await repository.alertSummary(actor);
    expect(inTenant).toHaveBeenCalledTimes(1);
    expect(inTenant.mock.calls[0][0]).toBe(actor);
  });

  // An alert whose severity was never recorded still exists and still counts.
  // Dropping the NULL bucket would make the severity tallies disagree with the
  // total, and the strip would quietly under-report.
  it('keeps a null key as "unknown" rather than discarding the row', async () => {
    const { repository } = makeRepository({
      status: [{ key: 'open', n: 3 }],
      severity: [
        { key: null, n: 1 },
        { key: 'warning', n: 2 },
      ],
    });
    const result = await repository.alertSummary(actor);
    expect(result.bySeverity).toEqual({ unknown: 1, warning: 2 });
    expect(Object.values(result.bySeverity).reduce((a, b) => a + b, 0)).toBe(result.total);
  });

  it('reports zero rather than throwing on an empty table', async () => {
    const { repository } = makeRepository({ status: [], severity: [] });
    await expect(repository.alertSummary(actor)).resolves.toEqual({
      total: 0,
      byStatus: {},
      bySeverity: {},
    });
  });
});
