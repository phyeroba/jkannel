import {
  DELIVERY_STATUS_GROUPS,
  DLR_EVENT_STATUS,
  KamexSqlboxRepository,
  isKnownStatusToken,
  resolveDeliveryStatuses,
} from './kamex-sqlbox.repository';

/**
 * The repository builds its own pg Pool from KAMEX_SQLBOX_DATABASE_URL; these
 * tests replace it with a recording fake so the emitted SQL and the row
 * normalisation can be asserted without a database.
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

/** A sent_sms MT row as returned by the classified query. */
const mtRow = (overrides: Record<string, any> = {}) => ({
  sql_id: '42',
  momt: 'MT',
  sender: 'SENDER',
  receiver: '+256700000000',
  msgdata: 'hello world',
  time: '1754000000',
  smsc_id: 'local-fake',
  service: null,
  account: null,
  // The MT row's own mask: the REQUESTED dlr types, not an outcome.
  dlr_mask: 31,
  dlr_url: null,
  boxc_id: null,
  foreign_id: 'ref-42',
  dlr_event: null,
  dlr_time: null,
  delivery_status: 'pending',
  ...overrides,
});

describe('delivery status vocabulary', () => {
  it('maps every Kannel DLR event value to a status', () => {
    expect(DLR_EVENT_STATUS).toEqual({
      1: 'delivered',
      2: 'failed',
      4: 'buffered',
      8: 'accepted',
      16: 'rejected',
    });
  });

  it('expands the operator groups', () => {
    expect(DELIVERY_STATUS_GROUPS.resendable).toEqual(['failed', 'rejected']);
    expect(resolveDeliveryStatuses('resendable')).toEqual(['failed', 'rejected']);
    expect(resolveDeliveryStatuses('in-flight')).toEqual(['pending', 'buffered']);
    expect(resolveDeliveryStatuses('failed,rejected,failed')).toEqual(['failed', 'rejected']);
  });

  it('leaves the legacy momt tokens to the momt filter', () => {
    expect(resolveDeliveryStatuses('sent')).toBeUndefined();
    expect(resolveDeliveryStatuses('dlr')).toBeUndefined();
    expect(resolveDeliveryStatuses(undefined)).toBeUndefined();
    expect(resolveDeliveryStatuses('nonsense')).toBeUndefined();
  });

  it('recognises legacy, individual and group tokens', () => {
    expect(['sent', 'dlr', 'failed', 'pending', 'resendable'].every(isKnownStatusToken)).toBe(true);
    expect(isKnownStatusToken('faield')).toBe(false);
  });
});

describe('KamexSqlboxRepository delivery-status correlation SQL', () => {
  it('correlates the latest DLR on foreign_id, newest first, one per message', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['local-fake'] });
    const sql = calls[0].sql;

    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain("r.momt = 'DLR'");
    expect(sql).toContain('r.foreign_id = m.foreign_id');
    // latest wins
    expect(sql).toContain('ORDER BY r.time DESC,r.sql_id DESC');
    expect(sql).toContain('LIMIT 1');
    // a DLR row must never correlate to itself
    expect(sql).toContain("m.momt IS DISTINCT FROM 'DLR'");
    // and the derivation must read the DLR's mask, never the MT's own
    expect(sql).toContain('WHEN d.dlr_mask = 2 THEN');
    expect(sql).not.toContain('WHEN m.dlr_mask = 2 THEN');
  });

  it('derives pending for an MT row with no DLR yet', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['local-fake'] });
    expect(calls[0].sql).toContain("WHEN d.dlr_mask IS NULL THEN 'pending'");
  });

  it('applies a derived status filter outside the correlation, tenant scope inside', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['local-fake', 'local-fake-b'], status: 'failed' });
    const { sql, params } = calls[0];

    expect(sql).toContain('q.delivery_status = ANY(');
    expect(sql).toContain('m.smsc_id = ANY($1)');
    expect(params[0]).toEqual(['local-fake', 'local-fake-b']);
    expect(params).toContainEqual(['failed']);
  });

  it('expands a group filter to its member statuses', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['local-fake'], status: 'resendable' });
    expect(calls[0].params).toContainEqual(['failed', 'rejected']);
  });

  it('keeps the legacy sent / delivery_report momt filters working', async () => {
    const sent = makeRepository();
    await sent.repository.list({ allowedSmscIds: ['local-fake'], status: 'sent' });
    expect(sent.calls[0].sql).toContain("m.momt <> 'DLR'");
    expect(sent.calls[0].sql).not.toContain('q.delivery_status = ANY(');

    const dlr = makeRepository();
    await dlr.repository.list({ allowedSmscIds: ['local-fake'], status: 'delivery_report' });
    expect(dlr.calls[0].sql).toContain("m.momt = 'DLR'");
  });

  it('qualifies every filtered column so the self-join is unambiguous', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({
      allowedSmscIds: ['local-fake'],
      cursor: 100,
      smscId: 'local-fake',
      query: 'needle',
      direction: 'MT',
    });
    const where = calls[0].sql.split('WHERE')[1];
    for (const column of ['smsc_id', 'sql_id', 'momt', 'sender', 'receiver', 'msgdata'])
      expect(where).not.toMatch(new RegExp(`[^.a-z_]${column}`));
  });
});

describe('KamexSqlboxRepository row normalisation', () => {
  it('exposes deliveryStatus without changing the legacy status field', async () => {
    const { repository } = makeRepository([mtRow({ delivery_status: 'failed', dlr_event: 2 })]);
    const [item] = (await repository.list({ allowedSmscIds: ['local-fake'] })).items;

    // Legacy contract preserved for existing callers.
    expect(item.status).toBe('sent');
    expect(item.deliveryStatus).toBe('failed');
    expect(item.dlrEvent).toBe(2);
  });

  it('never mistakes an MT row’s requested dlr_mask of 31 for a status', async () => {
    const { repository } = makeRepository([mtRow()]);
    const [item] = (await repository.list({ allowedSmscIds: ['local-fake'] })).items;

    expect(item.dlrMask).toBe(31);
    // 31 is a subscription mask; with no DLR correlated the message is pending.
    expect(item.deliveryStatus).toBe('pending');
    expect(item.dlrEvent).toBeNull();
  });

  it.each([
    [1, 'delivered'],
    [2, 'failed'],
    [4, 'buffered'],
    [8, 'accepted'],
    [16, 'rejected'],
  ])('reports DLR event %i as %s', async (event, expected) => {
    const { repository } = makeRepository([
      mtRow({ dlr_event: event, delivery_status: expected, dlr_time: '1754000100' }),
    ]);
    const [item] = (await repository.list({ allowedSmscIds: ['local-fake'] })).items;
    expect(item.deliveryStatus).toBe(expected);
    expect(item.dlrAt).toBe(new Date(1_754_000_100 * 1000).toISOString());
  });

  it('reports an unrecognised DLR event as unknown rather than guessing', async () => {
    const { repository } = makeRepository([mtRow({ dlr_event: 64, delivery_status: 'unknown' })]);
    const [item] = (await repository.list({ allowedSmscIds: ['local-fake'] })).items;
    expect(item.deliveryStatus).toBe('unknown');
    expect(item.dlrEvent).toBe(64);
  });

  it('classifies a DLR row itself as delivery_report and keeps its own event', async () => {
    const { repository } = makeRepository([
      mtRow({
        sql_id: '43',
        momt: 'DLR',
        dlr_mask: 1,
        dlr_event: 1,
        delivery_status: 'delivery_report',
      }),
    ]);
    const [item] = (await repository.list({ allowedSmscIds: ['local-fake'] })).items;
    expect(item.status).toBe('delivery_report');
    expect(item.deliveryStatus).toBe('delivery_report');
    expect(item.dlrEvent).toBe(1);
  });

  it('falls back to unknown for a query that did not correlate DLRs', async () => {
    const { repository } = makeRepository([
      { ...mtRow(), delivery_status: undefined, dlr_event: undefined },
    ]);
    const [item] = (await repository.listQueue({ allowedSmscIds: ['local-fake'] })).items;
    // send_sms rows are spool rows, never a delivery outcome
    expect(item.deliveryStatus).toBe('queued');

    const sent = makeRepository([{ ...mtRow(), delivery_status: undefined }]);
    const [row] = (await sent.repository.findSentForResend(['42'], ['local-fake'])) as any[];
    expect(row.deliveryStatus).toBe('unknown');
  });

  it('returns a full zeroed status breakdown plus the operator groups', async () => {
    const { repository, calls } = makeRepository([
      { delivery_status: 'failed', count: '2' },
      { delivery_status: 'rejected', count: '1' },
      { delivery_status: 'pending', count: '4' },
    ]);
    const counts = await repository.deliveryStatusCounts({ allowedSmscIds: ['local-fake'] });

    expect(counts).toEqual({
      delivered: 0,
      failed: 2,
      rejected: 1,
      buffered: 0,
      accepted: 0,
      pending: 4,
      unknown: 0,
      resendable: 3,
      inFlight: 4,
    });
    // Receipts are not messages and must not appear in the breakdown.
    expect(calls[0].sql).toContain("m.momt IS DISTINCT FROM 'DLR'");
  });
});

describe('KamexSqlboxRepository spool mutations', () => {
  it('reroutes only rows inside the tenant scope and returns the affected ids', async () => {
    const { repository, calls } = makeRepository([{ sql_id: '1' }, { sql_id: '3' }]);
    const result = await repository.rerouteSpool([1, 2, 3], 'local-fake-b', [
      'local-fake',
      'local-fake-b',
    ]);

    expect(calls[0].sql).toContain('UPDATE send_sms SET smsc_id=$1');
    // The tenant predicate is mandatory: without it a caller could move another
    // tenant's queued message.
    expect(calls[0].sql).toContain('smsc_id = ANY($3)');
    expect(calls[0].sql).toContain('RETURNING sql_id');
    expect(calls[0].params).toEqual(['local-fake-b', [1, 2, 3], ['local-fake', 'local-fake-b']]);
    expect(result).toEqual({ rerouted: 2, sqlIds: [1, 3] });
  });

  it('does not query at all when the tenant owns no SMSCs', async () => {
    const { repository, calls } = makeRepository();
    expect(await repository.rerouteSpool([1], 'local-fake', [])).toEqual({
      rerouted: 0,
      sqlIds: [],
    });
    expect(await repository.cancelSpool([1], [])).toEqual({ cancelled: 0, sqlIds: [] });
    expect(await repository.findSentForResend(['1'], [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('cancels within the tenant scope', async () => {
    const { repository, calls } = makeRepository([{ sql_id: '5' }]);
    const result = await repository.cancelSpool([5, 6], ['local-fake']);
    expect(calls[0].sql).toContain('DELETE FROM send_sms');
    expect(calls[0].sql).toContain('smsc_id = ANY($2)');
    expect(result).toEqual({ cancelled: 1, sqlIds: [5] });
  });

  it('groups spool depth by SMSC within the tenant scope', async () => {
    const { repository, calls } = makeRepository([{ smsc_id: 'local-fake', count: '3' }]);
    expect(await repository.spoolBySmsc(['local-fake'])).toEqual([
      { smscId: 'local-fake', count: 3 },
    ]);
    expect(calls[0].sql).toContain('smsc_id = ANY($1)');
  });

  it('restricts resend lookups to the tenant SMSCs', async () => {
    const { repository, calls } = makeRepository([mtRow()]);
    await repository.findSentForResend(['42', 'ref-42'], ['local-fake']);
    expect(calls[0].sql).toContain('m.smsc_id = ANY($2)');
    expect(calls[0].params).toEqual([['42', 'ref-42'], ['local-fake']]);
  });
});
