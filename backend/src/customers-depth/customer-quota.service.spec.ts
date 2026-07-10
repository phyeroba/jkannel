import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomerQuotaService } from './customer-quota.service';

const actor = { tenantId: '1', userId: 'u1' };
const CUSTOMER = 'c1';

/**
 * Mock DB client that answers by SQL fragment. `quotas` seeds the rows returned
 * by the SELECT ... FOR UPDATE; the UPDATE echoes the new used_count back.
 */
function makeClient(opts: { customer?: boolean; quotas?: any[] } = {}) {
  const customer = opts.customer ?? true;
  const quotas = opts.quotas ?? [];
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM customers WHERE id='))
      return { rows: customer ? [{ '?column?': 1 }] : [] };
    if (sql.includes('FROM customer_quotas') && sql.includes('SELECT')) return { rows: quotas };
    if (sql.startsWith('UPDATE customer_quotas')) {
      const [id, , used] = params;
      const row = quotas.find((q) => q.id === id);
      return { rows: [{ ...row, used_count: String(used) }] };
    }
    if (sql.startsWith('INSERT INTO customer_quotas')) {
      return {
        rows: [
          {
            id: 'q-new',
            customer_id: params[1],
            period: params[2],
            limit_count: String(params[3]),
            used_count: '0',
            window_start: new Date().toISOString(),
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { query, calls };
}

function serviceWith(client: any) {
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return new CustomerQuotaService(db);
}

function quotaRow(over: Partial<any> = {}) {
  return {
    id: 'q1',
    customer_id: CUSTOMER,
    period: 'daily',
    limit_count: '100',
    used_count: '10',
    window_start: new Date().toISOString(),
    ...over,
  };
}

describe('CustomerQuotaService.consume', () => {
  it('consumes under the limit and increments the counter', async () => {
    const client = makeClient({ quotas: [quotaRow({ used_count: '10', limit_count: '100' })] });
    const service = serviceWith(client);
    const usage = await service.consume(actor, CUSTOMER, 5);
    expect(usage[0].used).toBe(15);
    expect(usage[0].remaining).toBe(85);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE customer_quotas'))).toBe(true);
  });

  it('rejects when the consume would exceed the limit', async () => {
    const client = makeClient({ quotas: [quotaRow({ used_count: '98', limit_count: '100' })] });
    const service = serviceWith(client);
    await expect(service.consume(actor, CUSTOMER, 5)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.calls.some((c) => c.sql.startsWith('UPDATE customer_quotas'))).toBe(false);
  });

  it('allows consuming exactly up to the limit', async () => {
    const client = makeClient({ quotas: [quotaRow({ used_count: '95', limit_count: '100' })] });
    const service = serviceWith(client);
    const usage = await service.consume(actor, CUSTOMER, 5);
    expect(usage[0].used).toBe(100);
    expect(usage[0].remaining).toBe(0);
  });

  it('resets an elapsed window before applying the consume', async () => {
    const stale = new Date('2000-01-01T00:00:00Z').toISOString();
    const client = makeClient({
      quotas: [quotaRow({ used_count: '100', limit_count: '100', window_start: stale })],
    });
    const service = serviceWith(client);
    // Even though used_count is at the cap, the window is stale so it resets to 0
    // and 5 is allowed.
    const usage = await service.consume(actor, CUSTOMER, 5);
    expect(usage[0].used).toBe(5);
  });

  it('treats a customer with no quotas as unconstrained', async () => {
    const client = makeClient({ quotas: [] });
    const service = serviceWith(client);
    await expect(service.consume(actor, CUSTOMER, 1000)).resolves.toEqual([]);
  });

  it('rejects a non-positive count', async () => {
    const client = makeClient();
    const service = serviceWith(client);
    await expect(service.consume(actor, CUSTOMER, 0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the customer does not exist', async () => {
    const client = makeClient({ customer: false });
    const service = serviceWith(client);
    await expect(service.consume(actor, CUSTOMER, 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CustomerQuotaService.setQuota', () => {
  it('rejects a negative limit', async () => {
    const client = makeClient();
    const service = serviceWith(client);
    await expect(
      service.setQuota(actor, CUSTOMER, { period: 'daily', limit: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts the quota and audits', async () => {
    const client = makeClient();
    const service = serviceWith(client);
    const usage = await service.setQuota(actor, CUSTOMER, { period: 'monthly', limit: 500 });
    expect(usage.limit).toBe(500);
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });
});
