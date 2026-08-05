import {
  DLR_EVENT_DELIVERED,
  DLR_EVENT_FAILED,
  DLR_EVENT_REJECTED,
  KamexSqlboxRepository,
  SENT_SMS_INDEX_NAMES,
} from './kamex-sqlbox.repository';

/**
 * The engine reads behind delivery-failure retry. The repository builds its own
 * pg Pool from KAMEX_SQLBOX_DATABASE_URL, so it is replaced with a recording
 * fake and the emitted SQL is asserted directly — the predicates ARE the
 * behaviour here, and a fake that only returned rows would prove nothing about
 * the one that matters.
 */
function makeRepository(rows: any[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const repository = new KamexSqlboxRepository();
  (repository as any).pool = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
  };
  return { repository, calls };
}

const reportRow = (overrides: Record<string, any> = {}) => ({
  dlr_sql_id: '500',
  foreign_id: '42',
  dlr_event: 2,
  dlr_time: '1785823400',
  dlr_text: 'ACK/undeliverable',
  sender: 'JKANNEL',
  receiver: '256700000001',
  msgdata: 'your code is 1234',
  smsc_id: 'mtn-ug',
  requested_mask: 31,
  dlr_url: null,
  sent_time: '1785823371',
  ...overrides,
});

describe('findNegativeDeliveryReports', () => {
  it('reads the EVENT off receipt rows only', async () => {
    // The whole defect this guards against: `dlr_mask` on an MT row is the mask
    // the sender REQUESTED (31 = report everything), not a status. Without
    // `momt = 'DLR'` on the predicate, a mask filter would match ordinary sent
    // messages and the retry path would re-send the outbox.
    const { repository, calls } = makeRepository();
    await repository.findNegativeDeliveryReports({
      afterSqlId: '100',
      events: [DLR_EVENT_FAILED, DLR_EVENT_REJECTED],
      allowedSmscIds: ['mtn-ug'],
    });
    const { sql, params } = calls[0];
    expect(sql).toContain("WHERE r.momt = 'DLR'");
    expect(sql).toContain('r.dlr_mask = ANY($2::int[])');
    expect(sql).toContain("o.momt = 'MT'");
    // The MT row is reached only through the foreign_id correlation, and its own
    // mask is projected under a name that cannot be mistaken for an outcome.
    expect(sql).toContain('o.foreign_id = r.foreign_id');
    expect(sql).toContain('m.dlr_mask::int requested_mask');
    expect(params[1]).toEqual([2, 16]);
  });

  it('scans forward from the watermark so no receipt is seen twice', async () => {
    const { repository, calls } = makeRepository();
    await repository.findNegativeDeliveryReports({
      afterSqlId: '100',
      events: [2],
      allowedSmscIds: ['mtn-ug'],
      limit: 50,
    });
    expect(calls[0].sql).toContain('r.sql_id > $1::bigint');
    expect(calls[0].sql).toContain('ORDER BY r.sql_id ASC');
    expect(calls[0].params).toEqual(['100', [2], ['mtn-ug'], 50]);
  });

  it('scopes to the tenant through the ORIGINAL message, not the receipt', async () => {
    // The MT row always carries the bind the message went out on; a receipt's
    // smsc_id can be unset depending on the driver, and scoping on it would
    // silently drop actionable failures.
    const { repository, calls } = makeRepository();
    await repository.findNegativeDeliveryReports({
      events: [2],
      allowedSmscIds: ['mtn-ug', 'airtel-ug'],
    });
    expect(calls[0].sql).toContain('m.smsc_id = ANY($3)');
    expect(calls[0].sql).not.toContain('r.smsc_id = ANY');
  });

  it('reads nothing at all when the tenant owns no binds', async () => {
    const { repository, calls } = makeRepository();
    expect(
      await repository.findNegativeDeliveryReports({ events: [2], allowedSmscIds: [] }),
    ).toEqual([]);
    expect(
      await repository.findNegativeDeliveryReports({ events: [], allowedSmscIds: ['a'] }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns the failure joined to the message it reports on', async () => {
    const { repository } = makeRepository([reportRow()]);
    const [found] = await repository.findNegativeDeliveryReports({
      events: [2],
      allowedSmscIds: ['mtn-ug'],
    });
    expect(found).toEqual({
      dlrSqlId: '500',
      foreignId: '42',
      dlrEvent: 2,
      dlrAt: '2026-08-04T06:03:20.000Z',
      detail: 'ACK/undeliverable',
      sender: 'JKANNEL',
      receiver: '256700000001',
      text: 'your code is 1234',
      smscId: 'mtn-ug',
      // Carried through as what it is: a subscription, not an outcome.
      requestedDlrMask: 31,
      dlrUrl: null,
      sentAt: '2026-08-04T06:02:51.000Z',
    });
  });
});

describe('latestDeliveryEvents', () => {
  it('returns the newest event per correlation id', async () => {
    const { repository, calls } = makeRepository([
      { foreign_id: '42', dlr_event: DLR_EVENT_DELIVERED, dlr_time: '1785823500' },
    ]);
    const found = await repository.latestDeliveryEvents(['42', '43', '42']);
    expect(calls[0].sql).toContain('DISTINCT ON (foreign_id)');
    expect(calls[0].sql).toContain("WHERE momt = 'DLR'");
    expect(calls[0].sql).toContain('ORDER BY foreign_id, time DESC, sql_id DESC');
    // De-duplicated before the query rather than after.
    expect(calls[0].params).toEqual([['42', '43']]);
    expect(found.get('42')).toEqual({ event: 1, at: '2026-08-04T06:05:00.000Z' });
    expect(found.has('43')).toBe(false);
  });

  it('does not query at all for an empty set', async () => {
    const { repository, calls } = makeRepository();
    expect((await repository.latestDeliveryEvents([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('the index the retry scanner depends on', () => {
  it('creates a partial index over receipt rows for the forward scan', async () => {
    const { repository, calls } = makeRepository();
    const result = await repository.ensureIndexes();
    expect(result.indexes).toEqual([...SENT_SMS_INDEX_NAMES]);
    const created = calls.filter((call) => call.sql.includes('CREATE INDEX'));
    expect(created.at(-1)!.sql).toContain("ON sent_sms(sql_id) WHERE momt = 'DLR'");
  });
});
