import { BadRequestException } from '@nestjs/common';
import {
  KamexSqlboxRepository,
  SENT_SMS_INDEX_NAMES,
  parseSqlboxSort,
} from './kamex-sqlbox.repository';

/**
 * Same recording-fake approach as the other engine specs: the repository builds
 * its own pg Pool, so it is replaced with something that records the SQL it
 * emitted. `answer` lets a test respond differently per statement.
 */
function makeRepository(
  rows: any[] = [],
  answer?: (sql: string) => any[] | undefined,
  fail?: (sql: string) => Error | undefined,
) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const repository = new KamexSqlboxRepository();
  (repository as any).pool = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const error = fail?.(sql);
      if (error) throw error;
      const answered = answer?.(sql);
      const result = answered ?? rows;
      return { rows: result, rowCount: result.length };
    }),
  };
  return { repository, calls };
}

const dlrRow = (overrides: Record<string, any> = {}) => ({
  sql_id: '77',
  momt: 'DLR',
  sender: 'SENDER',
  receiver: '+256700000000',
  msgdata: 'ACK/id:1 sub:001 dlvrd:001',
  time: '1754400000',
  smsc_id: 'carrier-a',
  service: null,
  account: null,
  dlr_mask: 1,
  dlr_url: null,
  boxc_id: null,
  foreign_id: 'ref-42',
  dlr_event: 1,
  dlr_time: null,
  delivery_status: 'delivered',
  coding: 0,
  charset: 'GSM',
  udhdata: null,
  validity: null,
  deferred: null,
  mclass: null,
  pid: null,
  binfo: null,
  meta_data: null,
  ...overrides,
});

describe('scheduled / deferred submission', () => {
  it('writes deferred and validity onto the send_sms insert', async () => {
    const { repository, calls } = makeRepository([{ sql_id: '901' }]);
    const result = await repository.submit({
      sender: 'ACME',
      receiver: '+256700000000',
      text: 'later',
      smscId: 'carrier-a',
      deferredMinutes: 90,
      validityMinutes: 240,
    });

    // The engine stores RELATIVE MINUTES in both columns; sqlbox converts them
    // to absolute instants when it picks the row up.
    expect(calls[0].sql).toContain('deferred,validity');
    expect(calls[0].params.slice(-2)).toEqual([90, 240]);
    expect(result).toMatchObject({ deferredMinutes: 90, validityMinutes: 240, status: 'queued' });
  });

  it('writes NULL, not 0, when no schedule was expressed', async () => {
    // 0 is a real value meaning "no delay"; NULL is what sqlbox decodes as
    // SMS_PARAM_UNDEFINED, i.e. "the caller had no preference". Conflating them
    // would make every ordinary send look like an explicit zero-delay request.
    const { repository, calls } = makeRepository([{ sql_id: '902' }]);
    await repository.submit({ sender: 'ACME', receiver: '+256700000000', text: 'now' });
    expect(calls[0].params.slice(-2)).toEqual([null, null]);
  });

  it('writes a zero deferral as 0 when the caller genuinely asked for one', async () => {
    const { repository, calls } = makeRepository([{ sql_id: '903' }]);
    await repository.submit({
      sender: 'ACME',
      receiver: '+256700000000',
      text: 'now',
      deferredMinutes: 0,
      validityMinutes: 5,
    });
    expect(calls[0].params.slice(-2)).toEqual([0, 5]);
  });
});

describe('delivery-report classification', () => {
  it('decodes each receipt’s own dlr_mask instead of the catch-all delivery_report', async () => {
    const { repository, calls } = makeRepository([dlrRow()]);
    const page = await repository.list({ allowedSmscIds: ['carrier-a'], deliveryReport: true });

    // On a DLR row the mask IS the outcome — the one place reading it off the
    // row itself is correct.
    expect(calls[0].sql).toContain("WHEN m.dlr_mask = 1 THEN 'delivered'");
    expect(calls[0].sql).toContain("WHEN m.momt IS DISTINCT FROM 'DLR' THEN 'unknown'");
    expect((page.items[0] as any).deliveryStatus).toBe('delivered');
  });

  it('keeps the message log’s own classification untouched', async () => {
    const { repository, calls } = makeRepository([dlrRow({ delivery_status: 'delivery_report' })]);
    const page = await repository.list({ allowedSmscIds: ['carrier-a'] });
    expect(calls[0].sql).toContain("WHEN m.momt = 'DLR' THEN 'delivery_report'");
    expect((page.items[0] as any).deliveryStatus).toBe('delivery_report');
  });

  it('pins the direction to DLR and cannot be widened by a query parameter', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({
      allowedSmscIds: ['carrier-a'],
      deliveryReport: true,
      direction: 'MT',
    });
    expect(calls[0].params).toContain('DLR');
    expect(calls[0].params).not.toContain('MT');
  });

  it('applies the same status vocabulary the messages grid uses', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({
      allowedSmscIds: ['carrier-a'],
      deliveryReport: true,
      deliveryStatus: 'resendable',
    });
    expect(calls[0].sql).toContain('q.delivery_status = ANY(');
    const statuses = calls[0].params.find((p: any) => Array.isArray(p) && p.includes('failed'));
    expect(statuses.sort()).toEqual(['failed', 'rejected']);
  });
});

describe('grid sorting and paging on the engine tables', () => {
  it('rejects a sort field that is not whitelisted', () => {
    expect(() => parseSqlboxSort('msgdata')).toThrow(BadRequestException);
    expect(() => parseSqlboxSort('receiver; DROP TABLE sent_sms')).toThrow(BadRequestException);
  });

  it('keeps the fast keyset path — no window count — for the default ordering', async () => {
    const { repository, calls } = makeRepository();
    const page = await repository.list({ allowedSmscIds: ['carrier-a'] });
    // sent_sms is the fastest-growing table in the system; a count(*) OVER()
    // over a filtered range of it is a scan of that range on every page load.
    expect(calls[0].sql).not.toContain('count(*) OVER()');
    expect(calls[0].sql).toContain('ORDER BY q.sql_id DESC');
    expect(page.total).toBeNull();
  });

  it('switches to offset paging with a total when a non-default sort is asked for', async () => {
    const { repository, calls } = makeRepository([{ ...dlrRow(), __total: '412' }]);
    const page = await repository.list({
      allowedSmscIds: ['carrier-a'],
      sort: '-time',
      limit: 10,
    });
    expect(calls[0].sql).toContain('count(*) OVER() AS __total');
    expect(calls[0].sql).toContain('ORDER BY q.time DESC, q.sql_id DESC');
    expect(page.total).toBe(412);
    // A non-default sort has no sql_id keyset, so no cursor is offered rather
    // than one that would page in the wrong order.
    expect(page.nextCursor).toBeNull();
    // The paging artefact must not survive into the row (and thence a CSV cell).
    expect((page.items[0] as any).raw.__total).toBeUndefined();
  });

  it('always closes the ORDER BY with the unique sql_id tiebreaker', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['carrier-a'], sort: 'receiver,-time' });
    expect(calls[0].sql).toContain('ORDER BY q.receiver ASC, q.time DESC, q.sql_id DESC');
  });

  it('honours an explicit offset even under the default sort', async () => {
    const { repository, calls } = makeRepository();
    await repository.list({ allowedSmscIds: ['carrier-a'], offset: 200, limit: 50 });
    expect(calls[0].sql).toContain('OFFSET $');
    expect(calls[0].params.slice(-2)).toEqual([51, 200]);
  });
});

describe('boot-time index creation', () => {
  const NODE_ENV = process.env.NODE_ENV;
  const AUTO = process.env.SQLBOX_AUTO_INDEX;
  // The boot path logs a structured line on success; capture it so the suite
  // output stays readable, and so the assertion below can prove it happened.
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
  });
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV;
    if (AUTO === undefined) delete process.env.SQLBOX_AUTO_INDEX;
    else process.env.SQLBOX_AUTO_INDEX = AUTO;
  });

  it('is skipped under NODE_ENV=test and touches no database', async () => {
    process.env.NODE_ENV = 'test';
    const { repository, calls } = makeRepository();
    await expect(repository.ensureIndexesAtBoot()).resolves.toEqual({
      status: 'skipped',
      detail: 'NODE_ENV=test',
    });
    expect(calls).toHaveLength(0);
  });

  it('can be turned off for a DBA who owns the DDL', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SQLBOX_AUTO_INDEX = 'false';
    const { repository, calls } = makeRepository();
    expect((await repository.ensureIndexesAtBoot()).status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('skips silently when SQLBox is not configured at all', async () => {
    process.env.NODE_ENV = 'production';
    const repository = new KamexSqlboxRepository();
    (repository as any).pool = undefined;
    expect((await repository.ensureIndexesAtBoot()).status).toBe('skipped');
  });

  it('creates every index CONCURRENTLY and idempotently once SQLBox is up', async () => {
    process.env.NODE_ENV = 'production';
    const { repository, calls } = makeRepository([], (sql) =>
      sql.includes('to_regclass') ? [{ send_sms: 'send_sms', sent_sms: 'sent_sms' }] : [],
    );
    const result = await repository.ensureIndexesAtBoot();
    expect(result).toEqual({ status: 'ensured', indexes: [...SENT_SMS_INDEX_NAMES] });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('sqlbox indexes ensured at boot'));

    const created = calls.filter((call) => call.sql.includes('CREATE INDEX'));
    expect(created).toHaveLength(SENT_SMS_INDEX_NAMES.length);
    for (const call of created) {
      // CONCURRENTLY: a plain CREATE INDEX takes ACCESS EXCLUSIVE on sent_sms
      // and would block every sqlbox insert for the whole build.
      expect(call.sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    }
    // Idempotent: running it again is the same statements, all no-ops.
    const second = await repository.ensureIndexesAtBoot();
    expect(second).toEqual(result);
  });

  it('clears an index a previous interrupted build left INVALID', async () => {
    process.env.NODE_ENV = 'production';
    const { repository, calls } = makeRepository([], (sql) => {
      if (sql.includes('to_regclass')) return [{ send_sms: 'send_sms', sent_sms: 'sent_sms' }];
      if (sql.includes('indisvalid')) return [{ relname: 'jkannel_sqlbox_sent_sms_time_idx' }];
      return [];
    });
    await repository.ensureIndexesAtBoot();
    // Without this, IF NOT EXISTS would see the invalid index, skip the create,
    // and the table would look indexed while planning as though it were not.
    expect(
      calls.some((call) =>
        call.sql.startsWith('DROP INDEX IF EXISTS "jkannel_sqlbox_sent_sms_time_idx"'),
      ),
    ).toBe(true);
  });

  it('is non-fatal: a failure is reported, not thrown', async () => {
    process.env.NODE_ENV = 'production';
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { repository } = makeRepository(
      [],
      (sql) =>
        sql.includes('to_regclass') ? [{ send_sms: 'send_sms', sent_sms: 'sent_sms' }] : [],
      (sql) => (sql.includes('CREATE INDEX') ? new Error('permission denied') : undefined),
    );
    // A missing index makes queries slow, never wrong. Refusing to boot over
    // one would be strictly the worse outcome.
    await expect(repository.ensureIndexesAtBoot()).resolves.toMatchObject({
      status: 'failed',
      detail: 'permission denied',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not block startup: onApplicationBootstrap returns before the build does', () => {
    process.env.NODE_ENV = 'production';
    const { repository } = makeRepository();
    const pending = jest.spyOn(repository, 'ensureIndexesAtBoot').mockReturnValue(
      new Promise(() => {
        /* never settles: the point is that the hook does not wait for it */
      }) as any,
    );
    // An index build on a large table takes minutes; the API has to be serving
    // traffic throughout, so the hook must not await it.
    expect(repository.onApplicationBootstrap()).toBeUndefined();
    expect(pending).toHaveBeenCalled();
    pending.mockRestore();
  });
});
