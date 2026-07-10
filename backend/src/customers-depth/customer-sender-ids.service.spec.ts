import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerSenderIdsService } from './customer-sender-ids.service';

const actor = { tenantId: '1', userId: 'u1' };
const CUSTOMER = 'c1';
const SID = 's1';

/**
 * Mock DB client answering by SQL fragment. `existing` seeds the row returned
 * by the SELECT that review/remove read; the UPDATE echoes the new status back.
 */
function makeClient(opts: { customer?: boolean; existing?: any; conflict?: boolean } = {}) {
  const customer = opts.customer ?? true;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM customers WHERE id='))
      return { rows: customer ? [{ '?column?': 1 }] : [] };
    if (sql.startsWith('INSERT INTO sender_ids')) {
      if (opts.conflict) {
        const err: any = new Error('duplicate');
        err.code = '23505';
        throw err;
      }
      return {
        rows: [
          {
            id: 'new-sid',
            customer_id: params[1],
            sender_id: params[2],
            status: 'pending',
            reason: null,
          },
        ],
      };
    }
    if (sql.includes('SELECT') && sql.includes('FROM sender_ids WHERE id='))
      return { rows: opts.existing ? [opts.existing] : [] };
    if (sql.startsWith('UPDATE sender_ids'))
      return { rows: [{ ...opts.existing, status: params[2], reason: params[3] }] };
    if (sql.startsWith('DELETE FROM sender_ids'))
      return { rows: opts.existing ? [{ id: opts.existing.id }] : [] };
    return { rows: [] };
  });
  return { query, calls };
}

function serviceWith(client: any) {
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return new CustomerSenderIdsService(db);
}

function pending(over: Partial<any> = {}) {
  return { id: SID, customer_id: CUSTOMER, sender_id: 'BRAND', status: 'pending', ...over };
}

describe('CustomerSenderIdsService.request', () => {
  it('registers a pending sender ID and audits', async () => {
    const client = makeClient();
    const service = serviceWith(client);
    const row = await service.request(actor, CUSTOMER, { senderId: 'BRAND' });
    expect(row.status).toBe('pending');
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('conflicts on a duplicate sender ID', async () => {
    const client = makeClient({ conflict: true });
    const service = serviceWith(client);
    await expect(service.request(actor, CUSTOMER, { senderId: 'BRAND' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('CustomerSenderIdsService.review', () => {
  it('approves a pending sender ID', async () => {
    const client = makeClient({ existing: pending() });
    const service = serviceWith(client);
    const row = await service.review(actor, CUSTOMER, SID, { status: 'approved' });
    expect(row.status).toBe('approved');
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE sender_ids'))).toBe(true);
  });

  it('rejects a pending sender ID with a reason', async () => {
    const client = makeClient({ existing: pending() });
    const service = serviceWith(client);
    const row = await service.review(actor, CUSTOMER, SID, { status: 'rejected', reason: 'nope' });
    expect(row.status).toBe('rejected');
    expect(row.reason).toBe('nope');
  });

  it('refuses to re-review an already approved sender ID', async () => {
    const client = makeClient({ existing: pending({ status: 'approved' }) });
    const service = serviceWith(client);
    await expect(
      service.review(actor, CUSTOMER, SID, { status: 'rejected' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to re-review an already rejected sender ID', async () => {
    const client = makeClient({ existing: pending({ status: 'rejected' }) });
    const service = serviceWith(client);
    await expect(
      service.review(actor, CUSTOMER, SID, { status: 'approved' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an invalid target status', async () => {
    const client = makeClient({ existing: pending() });
    const service = serviceWith(client);
    await expect(
      service.review(actor, CUSTOMER, SID, { status: 'pending' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the sender ID does not exist', async () => {
    const client = makeClient({ existing: undefined });
    const service = serviceWith(client);
    await expect(
      service.review(actor, CUSTOMER, SID, { status: 'approved' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
