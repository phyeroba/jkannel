import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BulkSendService } from './bulk-send.service';

const actor = { tenantId: '1', userId: 'u1' };

/** Mock DB client that records inserts/updates and answers by SQL fragment. */
function makeClient(
  opts: {
    smscIds?: string[];
    recipients?: any[];
    lock?: boolean;
    customer?: string | null;
    jobSmscId?: string | null;
    jobSender?: string;
  } = {},
) {
  const smscIds = opts.smscIds ?? ['carrier-a'];
  const recipients = opts.recipients ?? [{ id: 'r1', receiver: '+256700000000', text: 'hi' }];
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('smsc_definitions'))
      return { rows: smscIds.map((engine_id) => ({ engine_id })) };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: opts.lock ?? true }] };
    if (sql.includes('FROM customers')) return { rows: opts.customer ? [{ id: 'cust-1' }] : [] };
    if (sql.startsWith('INSERT INTO bulk_send_jobs'))
      return {
        rows: [
          {
            id: 'job-1',
            name: params[1],
            smsc_id: params[2],
            sender: params[3],
            customer_id: params[4],
            status: 'queued',
            total: params[5],
          },
        ],
      };
    if (sql.includes("UPDATE bulk_send_jobs SET status='running'"))
      return {
        rows: [
          {
            id: 'job-1',
            smsc_id: opts.jobSmscId === undefined ? smscIds[0] : opts.jobSmscId,
            sender: opts.jobSender ?? 'CAMPAIGN',
            customer_id: opts.customer ?? null,
            created_by: 'u1',
          },
        ],
      };
    if (sql.includes("status='pending'")) return { rows: recipients };
    return { rows: [] };
  });
  return { query, calls };
}

/**
 * Stand-in for the real send path. Bulk send now dispatches every recipient
 * through {@link MessageSendService} (routing, blocklist, entitlements,
 * recorded decision) rather than spooling directly, so the fake forwards to the
 * `sqlbox.submit` spy the existing assertions use.
 */
function makeSend(sqlbox: any) {
  return {
    send: jest.fn(async (_actor: any, request: any) => {
      const queued = await sqlbox.submit({
        sender: request.sender,
        receiver: request.receiver,
        text: request.text,
        smscId: request.smscId,
      });
      return { ...queued, smscId: request.smscId ?? 'routed-bind', charged: 0 };
    }),
  };
}

describe('BulkSendService.createJob', () => {
  it('rejects an empty recipient list', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    await expect(
      service.createJob(actor, { name: 'c', smscId: 'carrier-a', message: 'm', recipients: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a batch over the maximum', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    const recipients = Array.from({ length: 5001 }, (_v, i) => `+2567${i}`);
    await expect(
      service.createJob(actor, { name: 'c', smscId: 'carrier-a', message: 'm', recipients }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an SMSC the tenant does not own', async () => {
    const client = makeClient({ smscIds: ['carrier-a'] });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    await expect(
      service.createJob(actor, {
        name: 'c',
        smscId: 'carrier-x',
        message: 'm',
        recipients: ['+256700000000'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists a queued job, its recipients, and an audit row', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    const job = await service.createJob(actor, {
      name: 'Campaign A',
      smscId: 'carrier-a',
      message: 'hi',
      recipients: ['+256700000000', '+256711111111'],
    });
    expect(job.id).toBe('job-1');
    expect(job.total).toBe(2);
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.startsWith('INSERT INTO bulk_send_jobs'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO bulk_send_recipients'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO audit_log'))).toBe(true);
  });
});

describe('BulkSendService.processJob', () => {
  it('submits each recipient and completes the job', async () => {
    const client = makeClient({
      recipients: [
        { id: 'r1', receiver: '+256700000000', text: 'hi' },
        { id: 'r2', receiver: '+256711111111', text: 'hi' },
      ],
    });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      submit: jest.fn(async () => ({ sqlId: '900', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const service = new BulkSendService(db, sqlbox, makeSend(sqlbox) as any);
    const result = await service.processJob('1', 'job-1');
    expect(sqlbox.submit).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ submitted: 2, failed: 0, status: 'completed' });
  });

  it('records a partial when some recipients fail', async () => {
    const client = makeClient({
      recipients: [
        { id: 'r1', receiver: '+256700000000', text: 'hi' },
        { id: 'r2', receiver: 'bad', text: 'hi' },
      ],
    });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    let call = 0;
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      submit: jest.fn(async () => {
        call += 1;
        if (call === 2) throw new Error('rejected by SMSC');
        return { sqlId: '900', status: 'queued', source: 'kamex-sqlbox' };
      }),
    };
    const service = new BulkSendService(db, sqlbox, makeSend(sqlbox) as any);
    const result = await service.processJob('1', 'job-1');
    expect(result).toEqual({ submitted: 1, failed: 1, status: 'partial' });
  });

  it('records an honest failure when SQLBox is unavailable', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: false, evidence: 'not configured' })),
      submit: jest.fn(),
    };
    const service = new BulkSendService(db, sqlbox, makeSend(sqlbox) as any);
    const result = await service.processJob('1', 'job-1');
    expect(sqlbox.submit).not.toHaveBeenCalled();
    expect(result).toEqual({ submitted: 0, failed: 1, status: 'failed' });
  });

  it('skips when the advisory lock is held by another worker', async () => {
    const client = makeClient({ lock: false });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = { probe: jest.fn(), submit: jest.fn() };
    const service = new BulkSendService(db, sqlbox, makeSend(sqlbox) as any);
    const result = await service.processJob('1', 'job-1');
    expect(result.status).toBe('skipped');
    expect(sqlbox.probe).not.toHaveBeenCalled();
  });

  it('dispatches through the send path so routing and entitlements apply', async () => {
    const client = makeClient({ jobSmscId: null, jobSender: 'CAMPAIGN', customer: 'cust-1' });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      submit: jest.fn(async () => ({ sqlId: '900', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const send = makeSend(sqlbox);
    const service = new BulkSendService(db, sqlbox, send as any);
    await service.processJob('1', 'job-1');

    expect(send.send).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      expect.objectContaining({
        // No pinned bind: the routing engine decides per recipient.
        smscId: null,
        sender: 'CAMPAIGN',
        customerId: 'cust-1',
        channel: 'bulk',
        reference: 'job-1',
      }),
    );
  });

  it('gives campaign messages a real sender instead of an empty one', async () => {
    const client = makeClient({ jobSender: undefined as never });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      submit: jest.fn(async () => ({ sqlId: '900', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const service = new BulkSendService(db, sqlbox, makeSend(sqlbox) as any);
    await service.processJob('1', 'job-1');
    expect(sqlbox.submit.mock.calls[0][0].sender).toBeTruthy();
  });
});

describe('BulkSendService.createJob — optional bind and customer attribution', () => {
  it('accepts a job with no smscId and leaves the bind to the routing engine', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    const job = await service.createJob(actor, {
      name: 'Campaign A',
      message: 'hi',
      recipients: ['+256700000000'],
    });
    expect(job.smsc_id).toBeNull();
    // No pinned bind means no tenant-SMSC validation was needed.
    expect(client.calls.some((c) => c.sql.includes('SELECT engine_id FROM smsc_definitions'))).toBe(
      false,
    );
  });

  it('records a real sender and the customer on the job', async () => {
    const client = makeClient({ customer: 'cust-1' });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    const job = await service.createJob(actor, {
      name: 'Campaign A',
      message: 'hi',
      recipients: ['+256700000000'],
      sender: 'ACME',
      customerId: 'cust-1',
    });
    expect(job.sender).toBe('ACME');
    expect(job.customer_id).toBe('cust-1');
  });

  it('404s a customer that does not exist in the tenant', async () => {
    const client = makeClient({ customer: null });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any, {} as any);
    await expect(
      service.createJob(actor, {
        name: 'Campaign A',
        message: 'hi',
        recipients: ['+256700000000'],
        customerId: 'cust-missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
