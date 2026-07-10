import { BadRequestException } from '@nestjs/common';
import { BulkSendService } from './bulk-send.service';

const actor = { tenantId: '1', userId: 'u1' };

/** Mock DB client that records inserts/updates and answers by SQL fragment. */
function makeClient(opts: { smscIds?: string[]; recipients?: any[]; lock?: boolean } = {}) {
  const smscIds = opts.smscIds ?? ['carrier-a'];
  const recipients = opts.recipients ?? [{ id: 'r1', receiver: '+256700000000', text: 'hi' }];
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('smsc_definitions'))
      return { rows: smscIds.map((engine_id) => ({ engine_id })) };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: opts.lock ?? true }] };
    if (sql.startsWith('INSERT INTO bulk_send_jobs'))
      return {
        rows: [
          { id: 'job-1', name: params[1], smsc_id: params[2], status: 'queued', total: params[3] },
        ],
      };
    if (sql.includes("UPDATE bulk_send_jobs SET status='running'"))
      return { rows: [{ id: 'job-1', smsc_id: smscIds[0] }] };
    if (sql.includes("status='pending'")) return { rows: recipients };
    return { rows: [] };
  });
  return { query, calls };
}

describe('BulkSendService.createJob', () => {
  it('rejects an empty recipient list', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any);
    await expect(
      service.createJob(actor, { name: 'c', smscId: 'carrier-a', message: 'm', recipients: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a batch over the maximum', async () => {
    const client = makeClient();
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any);
    const recipients = Array.from({ length: 5001 }, (_v, i) => `+2567${i}`);
    await expect(
      service.createJob(actor, { name: 'c', smscId: 'carrier-a', message: 'm', recipients }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an SMSC the tenant does not own', async () => {
    const client = makeClient({ smscIds: ['carrier-a'] });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const service = new BulkSendService(db, {} as any);
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
    const service = new BulkSendService(db, {} as any);
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
    const service = new BulkSendService(db, sqlbox);
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
    const service = new BulkSendService(db, sqlbox);
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
    const service = new BulkSendService(db, sqlbox);
    const result = await service.processJob('1', 'job-1');
    expect(sqlbox.submit).not.toHaveBeenCalled();
    expect(result).toEqual({ submitted: 0, failed: 1, status: 'failed' });
  });

  it('skips when the advisory lock is held by another worker', async () => {
    const client = makeClient({ lock: false });
    const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
    const sqlbox: any = { probe: jest.fn(), submit: jest.fn() };
    const service = new BulkSendService(db, sqlbox);
    const result = await service.processJob('1', 'job-1');
    expect(result.status).toBe('skipped');
    expect(sqlbox.probe).not.toHaveBeenCalled();
  });
});
