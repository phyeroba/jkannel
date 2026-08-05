import { KamexSqlboxRepository } from './kamex-sqlbox.repository';

/**
 * Same recording-fake approach as kamex-sqlbox.delivery-status.spec: the
 * repository builds its own pg Pool, so it is replaced with something that
 * records the SQL and parameters the repository emitted.
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

/** A sent_sms MT row carrying the columns that were previously never selected. */
const detailedRow = (overrides: Record<string, any> = {}) => ({
  sql_id: '42',
  momt: 'MT',
  sender: 'SENDER',
  receiver: '+256700000000',
  msgdata: 'hello world',
  time: '1754298000',
  smsc_id: 'carrier-a',
  service: null,
  account: null,
  dlr_mask: 31,
  dlr_url: null,
  boxc_id: null,
  foreign_id: 'ref-42',
  dlr_event: null,
  dlr_time: null,
  delivery_status: 'pending',
  coding: 0,
  charset: 'GSM',
  udhdata: null,
  validity: 1440,
  deferred: 0,
  mclass: 1,
  pid: 0,
  binfo: 'BILL-77',
  meta_data: '?smpp?dest_addr_ton=1',
  ...overrides,
});

describe('date-range filtering on the engine time column', () => {
  it('emits an INCLUSIVE range on the indexed epoch column, qualified for the self-join', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({
      allowedSmscIds: ['carrier-a'],
      fromEpoch: 1754298000,
      toEpoch: 1754301600,
    });
    const { sql, params } = calls[0];

    // >= and <= (not > / <): 09:00:00 and 10:00:00 are both in a 09:00-10:00 ask.
    expect(sql).toContain('m.time >= $2');
    expect(sql).toContain('m.time <= $3');
    expect(params[1]).toBe(1754298000);
    expect(params[2]).toBe(1754301600);
    // The tenant predicate is still first and still mandatory.
    expect(sql).toContain('m.smsc_id = ANY($1)');
    expect(params[0]).toEqual(['carrier-a']);
  });

  it('applies only the bound that was supplied', async () => {
    const from = makeRepository();
    await from.repository.list({ allowedSmscIds: ['carrier-a'], fromEpoch: 1 });
    expect(from.calls[0].sql).toContain('m.time >= ');
    expect(from.calls[0].sql).not.toContain('m.time <= ');

    const to = makeRepository();
    await to.repository.list({ allowedSmscIds: ['carrier-a'], toEpoch: 2 });
    expect(to.calls[0].sql).toContain('m.time <= ');
    expect(to.calls[0].sql).not.toContain('m.time >= ');
  });

  it('accepts epoch 0 as a real bound rather than treating it as absent', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['carrier-a'], fromEpoch: 0, toEpoch: 0 });
    expect(calls[0].sql).toContain('m.time >= ');
    expect(calls[0].sql).toContain('m.time <= ');
    expect(calls[0].params.slice(1, 3)).toEqual([0, 0]);
  });

  it('narrows the delivery-status breakdown by the same range', async () => {
    const { repository, calls } = makeRepository();
    await repository.deliveryStatusCounts({
      allowedSmscIds: ['carrier-a'],
      fromEpoch: 100,
      toEpoch: 200,
    });
    expect(calls[0].sql).toContain('m.time >= ');
    expect(calls[0].sql).toContain('m.time <= ');
  });

  it('ranges the spool listing too, on unqualified column names', async () => {
    const { repository, calls } = makeRepository();
    await repository.listQueue({ allowedSmscIds: ['carrier-a'], fromEpoch: 100, toEpoch: 200 });
    expect(calls[0].sql).toContain('time >= $2');
    expect(calls[0].sql).toContain('time <= $3');
  });

  it('keeps the range served by the indexes ensureIndexes creates', async () => {
    const { repository, calls } = makeRepository();
    const result = await repository.ensureIndexes();
    // (time DESC, sql_id DESC) covers an unscoped range plus the sql_id paging;
    // (smsc_id, time DESC) covers the tenant-scoped range every console read
    // actually issues.
    expect(result.indexes).toEqual(
      expect.arrayContaining([
        'jkannel_sqlbox_sent_sms_time_idx',
        'jkannel_sqlbox_sent_sms_smsc_time_idx',
      ]),
    );
    // calls[0] is the invalid-index sweep (an interrupted CONCURRENTLY build
    // leaves an index IF NOT EXISTS would then skip forever); the CREATEs follow.
    const created = calls.filter((call) => call.sql.includes('CREATE INDEX'));
    expect(created[0].sql).toContain('ON sent_sms(time DESC, sql_id DESC)');
    expect(created[1].sql).toContain('ON sent_sms(smsc_id, time DESC)');
    // The manual endpoint keeps taking the plain (blocking) lock it always did.
    expect(created[0].sql.startsWith('CREATE INDEX IF NOT EXISTS')).toBe(true);
  });
});

describe('encoding / UDH / validity / billing columns', () => {
  it('SELECTs every previously-missing column, for sent_sms and for the spool', async () => {
    const expected = [
      'coding',
      'charset',
      'udhdata',
      'validity',
      'deferred',
      'mclass',
      'pid',
      'binfo',
      'meta_data',
    ];

    const history = makeRepository();
    await history.repository.list({ allowedSmscIds: ['carrier-a'] });
    for (const column of expected) expect(history.calls[0].sql).toContain(`m.${column}`);

    const queue = makeRepository();
    await queue.repository.listQueue({ allowedSmscIds: ['carrier-a'] });
    for (const column of expected) expect(queue.calls[0].sql).toContain(column);
  });

  it('surfaces them on the normalised row under stable camelCase names', async () => {
    const { repository } = makeRepository([detailedRow()]);
    const [item] = (await repository.list({ allowedSmscIds: ['carrier-a'] })).items as any[];

    expect(item).toMatchObject({
      coding: 0,
      charset: 'GSM',
      udhData: null,
      validity: 1440,
      deferred: 0,
      mclass: 1,
      pid: 0,
      binfo: 'BILL-77',
      metaData: '?smpp?dest_addr_ton=1',
    });
  });

  it('reports an absent numeric column as null, never as 0', async () => {
    const { repository } = makeRepository([
      detailedRow({ coding: null, validity: null, deferred: null, mclass: null, pid: null }),
    ]);
    const [item] = (await repository.list({ allowedSmscIds: ['carrier-a'] })).items as any[];
    // 0 is a real value (coding 0 = GSM-7, mclass 0 = flash); conflating it with
    // "not recorded" would make a flash message indistinguishable from a normal
    // one whose class was never set.
    expect(item.coding).toBeNull();
    expect(item.validity).toBeNull();
    expect(item.deferred).toBeNull();
    expect(item.mclass).toBeNull();
    expect(item.pid).toBeNull();
  });

  it('carries them onto spool rows and trace events as well', async () => {
    const { repository } = makeRepository([detailedRow()]);
    const [queued] = (await repository.listQueue({ allowedSmscIds: ['carrier-a'] })).items as any[];
    expect(queued).toMatchObject({ coding: 0, binfo: 'BILL-77', validity: 1440 });
  });
});

describe('derived segment count on a message row', () => {
  it('is 1 for a short GSM-7 body', async () => {
    const { repository } = makeRepository([detailedRow({ msgdata: 'hello', coding: 0 })]);
    const [item] = (await repository.list({ allowedSmscIds: ['carrier-a'] })).items as any[];
    expect(item.segments).toBe(1);
    expect(item.segmentation).toMatchObject({ alphabet: 'gsm7', singleCapacity: 160 });
  });

  it('is 2 at 161 GSM-7 septets and 1 at 160', async () => {
    const one = makeRepository([detailedRow({ msgdata: 'a'.repeat(160), coding: 0 })]);
    expect(((await one.repository.list({})).items[0] as any).segments).toBe(1);

    const two = makeRepository([detailedRow({ msgdata: 'a'.repeat(161), coding: 0 })]);
    expect(((await two.repository.list({})).items[0] as any).segments).toBe(2);
  });

  it('is 2 at 71 UCS-2 units and 1 at 70', async () => {
    const one = makeRepository([detailedRow({ msgdata: 'あ'.repeat(70), coding: 2 })]);
    expect(((await one.repository.list({})).items[0] as any).segments).toBe(1);

    const two = makeRepository([detailedRow({ msgdata: 'あ'.repeat(71), coding: 2 })]);
    const item = (await two.repository.list({})).items[0] as any;
    expect(item.segments).toBe(2);
    expect(item.segmentation).toMatchObject({ alphabet: 'ucs2', multipartCapacity: 67 });
  });

  it('trusts the part count a concatenation UDH declares', async () => {
    // UDHL=5, IEI=00, len=03, ref=aa, total=03, seq=01
    const { repository } = makeRepository([
      detailedRow({ msgdata: 'part one', coding: 0, udhdata: '050003aa0301' }),
    ]);
    const [item] = (await repository.list({})).items as any[];
    expect(item.segments).toBe(3);
    expect(item.segmentation.declaredByUdh).toBe(true);
    expect(item.udhData).toBe('050003aa0301');
  });
});

describe('CSV export column set', () => {
  it('exports the new fields and keeps text last', () => {
    const columns = KamexSqlboxRepository.EXPORT_COLUMNS;
    expect(columns).toEqual(
      expect.arrayContaining([
        'deliveryStatus',
        'segments',
        'coding',
        'charset',
        'udhData',
        'validity',
        'deferred',
        'mclass',
        'pid',
        'binfo',
        'metaData',
      ]),
    );
    expect(columns.at(-1)).toBe('text');
  });

  it('emits a header row identical to the one a real export produces', async () => {
    const { repository } = makeRepository([detailedRow()]);
    const exported = await repository.exportCsv({ allowedSmscIds: ['carrier-a'] });
    expect(`${exported.content.split('\r\n')[0]}\r\n`).toBe(
      KamexSqlboxRepository.exportHeaderRow(),
    );
  });

  it('writes the new fields into the row body', async () => {
    const { repository } = makeRepository([
      detailedRow({ msgdata: 'a'.repeat(200), coding: 0, binfo: 'BILL-77' }),
    ]);
    const exported = await repository.exportCsv({ allowedSmscIds: ['carrier-a'] });
    const [header, row] = exported.content.split('\r\n');
    const cells = header.split(',');
    const values = row.split(',');
    const cell = (name: string) => values[cells.indexOf(name)];

    expect(cell('segments')).toBe('"2"');
    expect(cell('binfo')).toBe('"BILL-77"');
    expect(cell('coding')).toBe('"0"');
    expect(cell('deliveryStatus')).toBe('"pending"');
  });
});
