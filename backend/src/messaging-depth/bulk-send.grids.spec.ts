import { BadRequestException } from '@nestjs/common';
import { encodeCursor } from '../platform/cursor';
import { BulkSendService } from './bulk-send.service';
import { parseMessageSchedule } from './message-scheduling';

const actor = { tenantId: '1', userId: 'u1' };

/**
 * Records every statement the grid emits. `rows` answers the grid query; the
 * job-existence probe is answered separately so the recipient grid gets past it.
 */
function makeService(rows: any[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT 1 FROM bulk_send_jobs')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('smsc_definitions')) return { rows: [{ engine_id: 'carrier-a' }] };
      if (sql.startsWith('INSERT INTO bulk_send_jobs'))
        return { rows: [{ id: 'job-1', status: params[7], scheduled_at: params[8] }] };
      return { rows };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return { service: new BulkSendService(database, {} as any, {} as any), calls };
}

/** The grid statement itself, not the job-existence probe that precedes it. */
const gridCall = (calls: Array<{ sql: string; params: any[] }>) =>
  calls.find(
    (call) =>
      call.sql.includes('FROM bulk_send') && !call.sql.startsWith('SELECT 1 FROM bulk_send_jobs'),
  )!;

const JOB_ID = '11111111-1111-4111-8111-111111111111';

describe('bulk send job grid', () => {
  it('defaults to created_at DESC offset paging with a total', async () => {
    const { service, calls } = makeService([{ id: 'a', __total: '3' }]);
    const page = await service.listJobs(actor);
    const sql = gridCall(calls).sql;
    expect(sql).toContain('count(*) OVER() AS __total');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(page).toMatchObject({ total: 3, offset: 0, pagination: 'offset', nextCursor: null });
    // The paging artefact never reaches the caller.
    expect(page.items[0]).toEqual({ id: 'a' });
  });

  it('searches, sorts and filters on whitelisted fields only', async () => {
    const { service, calls } = makeService();
    await service.listJobs(actor, {
      search: 'promo',
      sort: '-status,name',
      'filter.smscId': 'carrier-a',
    });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('name::text ILIKE');
    expect(sql).toContain('ORDER BY status DESC, name ASC');
    expect(sql).toContain('smsc_id::text = $');
    // Everything the caller supplied travels as a bind parameter.
    expect(params).toContain('%promo%');
    expect(params).toContain('carrier-a');
  });

  it('rejects an unknown sort or filter field rather than ignoring it', async () => {
    const { service } = makeService();
    await expect(service.listJobs(actor, { sort: 'created_by' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.listJobs(actor, { 'filter.created_by': 'u1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('keeps the pre-existing bare ?status= working as a filter', async () => {
    const { service, calls } = makeService();
    await service.listJobs(actor, { status: 'queued' });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('status::text = $');
    expect(params).toContain('queued');
  });

  it('pages by keyset when asked, so a deep page is a seek and not a scan', async () => {
    const { service, calls } = makeService([
      { id: 'a', __cursor_sort: '2026-08-05T10:00:00.000Z', __cursor_id: 'a' },
    ]);
    const page = await service.listJobs(actor, { paginate: 'cursor', limit: 1 });
    const { sql } = gridCall(calls);
    expect(sql).toContain('AS __cursor_sort');
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).not.toContain('OFFSET');
    // A keyset page deliberately does not pay for a count.
    expect(page).toMatchObject({ pagination: 'cursor', total: null, offset: null });
  });

  it('seeks past the boundary row when a cursor is supplied', async () => {
    const cursor = encodeCursor({ v: '2026-08-05T10:00:00.000Z', i: 'a' });
    const { service, calls } = makeService();
    await service.listJobs(actor, { cursor });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('created_at < $');
    expect(sql).toContain('created_at = $');
    expect(params).toContain('2026-08-05T10:00:00.000Z');
    expect(params).toContain('a');
  });

  it('exports the campaigns the grid would show, honouring the same filters', async () => {
    const { service, calls } = makeService([
      {
        id: 'job-1',
        name: 'Promo, "August"',
        status: 'scheduled',
        smsc_id: 'carrier-a',
        sender: 'ACME',
        customer_id: null,
        total: 2,
        submitted: 0,
        failed: 0,
        scheduled_at: new Date('2026-09-01T08:00:00Z'),
        validity_minutes: 240,
        detail: null,
        created_by: 'u1',
        created_at: new Date('2026-08-05T09:00:00Z'),
        completed_at: null,
      },
    ]);
    const exported = await service.exportJobsCsv(actor, { 'filter.status': 'scheduled' });

    const { sql, params } = gridCall(calls);
    expect(sql).toContain('status::text = $');
    expect(params).toContain('scheduled');
    expect(exported.rowCount).toBe(1);
    const [header, row] = exported.content.split('\r\n');
    expect(header.split(',')).toContain('scheduled_at');
    // Quoted, and an embedded quote doubled, so a campaign name with a comma
    // cannot shift every following column.
    expect(row).toContain('"Promo, ""August"""');
    expect(row).toContain('"2026-09-01T08:00:00.000Z"');
    expect(row).toContain('"240"');
  });

  it('never exports a cursor slice — an export is the top of the filtered set', async () => {
    const { service, calls } = makeService();
    await service.exportJobsCsv(actor, { paginate: 'cursor', cursor: 'nonsense' });
    expect(gridCall(calls).sql).toContain('count(*) OVER()');
  });
});

describe('bulk send recipient grid', () => {
  it('scopes to the job, orders by created_at and pages by offset', async () => {
    const { service, calls } = makeService([{ id: 'r1', __total: '9' }]);
    const page = await service.listRecipients(actor, JOB_ID, { limit: 10, offset: 20 });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('WHERE job_id=$1');
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(params[0]).toBe(JOB_ID);
    expect(page).toMatchObject({ total: 9, limit: 10, offset: 20 });
  });

  it('filters, searches and sorts on its own whitelist', async () => {
    const { service, calls } = makeService();
    await service.listRecipients(actor, JOB_ID, {
      search: '2567',
      sort: '-createdAt',
      'filter.status': 'failed',
    });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('receiver::text ILIKE');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('status::text = $');
    expect(params).toContain('failed');
  });

  it('pages by keyset, ascending, with the job predicate kept intact', async () => {
    const { service, calls } = makeService();
    await service.listRecipients(actor, JOB_ID, { paginate: 'cursor' });
    const { sql, params } = gridCall(calls);
    expect(sql).toContain('WHERE job_id=$1');
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(params[0]).toBe(JOB_ID);
  });

  it('404s a job the tenant cannot see, before running any grid query', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })) };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const service = new BulkSendService(database, {} as any, {} as any);
    await expect(service.listRecipients(actor, JOB_ID)).rejects.toThrow('Bulk send job not found');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('exports recipients with the active filters applied', async () => {
    const { service, calls } = makeService([
      {
        id: 'r1',
        job_id: JOB_ID,
        receiver: '+256700000000',
        status: 'failed',
        foreign_id: null,
        error: 'rejected by SMSC',
        created_at: new Date('2026-08-05T09:00:00Z'),
        text: 'hi',
      },
    ]);
    const exported = await service.exportRecipientsCsv(actor, JOB_ID, {
      'filter.status': 'failed',
    });
    expect(gridCall(calls).params).toContain('failed');
    expect(exported.filename).toContain(JOB_ID);
    const [header, row] = exported.content.split('\r\n');
    expect(header).toBe('id,job_id,receiver,status,foreign_id,error,created_at,text');
    expect(row).toContain('"rejected by SMSC"');
    // A NULL is an empty cell, not the string "null".
    expect(row).toContain(',"",');
  });
});

describe('scheduled campaigns', () => {
  const future = () => new Date(Date.now() + 6 * 3_600_000).toISOString();

  it('records scheduled_at, validity_minutes and the scheduled status', async () => {
    const { service, calls } = makeService();
    const schedule = parseMessageSchedule({ scheduledAt: future(), validityMinutes: 720 });
    await service.createJob(actor, {
      name: 'Promo',
      message: 'hi',
      recipients: ['+256700000000'],
      schedule,
    });
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO bulk_send_jobs'))!;
    expect(insert.sql).toContain('scheduled_at,validity_minutes');
    expect(insert.params[7]).toBe('scheduled');
    expect((insert.params[8] as Date).toISOString()).toBe(
      new Date(schedule.scheduledAtMs!).toISOString(),
    );
    expect(insert.params[9]).toBe(720);
  });

  it('stays plain queued when no delivery instant was asked for', async () => {
    const { service, calls } = makeService();
    await service.createJob(actor, {
      name: 'Promo',
      message: 'hi',
      recipients: ['+256700000000'],
      schedule: parseMessageSchedule({ validityMinutes: 60 }),
    });
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO bulk_send_jobs'))!;
    expect(insert.params[7]).toBe('queued');
    expect(insert.params[8]).toBeNull();
    expect(insert.params[9]).toBe(60);
  });

  it('hands every recipient the campaign schedule at dispatch', async () => {
    const scheduledAt = new Date('2026-09-01T08:00:00Z');
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (sql.includes("SET status='running'"))
          return {
            rows: [
              {
                id: 'job-1',
                smsc_id: 'carrier-a',
                sender: 'ACME',
                customer_id: null,
                created_by: 'u1',
                scheduled_at: scheduledAt,
                validity_minutes: 720,
              },
            ],
          };
        if (sql.includes("status='pending'"))
          return { rows: [{ id: 'r1', receiver: '+256700000000', text: 'hi' }] };
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const sqlbox: any = { probe: jest.fn(async () => ({ available: true, evidence: 'ok' })) };
    const send: any = { send: jest.fn(async () => ({ sqlId: '900' })) };
    const service = new BulkSendService(database, sqlbox, send);

    await service.processJob('1', 'job-1');
    expect(send.send.mock.calls[0][1].schedule).toEqual({
      scheduledAtMs: scheduledAt.getTime(),
      validityMinutes: 720,
    });
  });

  it('claims scheduled jobs on the same tick as queued ones', async () => {
    const { service, calls } = makeService();
    await service.processJob('1', 'job-1').catch(() => undefined);
    const claim = calls.find((call) => call.sql.includes("SET status='running'"));
    // The wait lives on the engine row, not in a JKANNEL timer: 'scheduled' is
    // a label for the grid, never a gate on dispatch.
    expect(claim!.params[1]).toEqual(['queued', 'scheduled']);
  });
});
