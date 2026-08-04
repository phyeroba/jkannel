import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CustomerCreditService } from '../customers-depth/customer-credit.service';
import { CustomerQuotaService } from '../customers-depth/customer-quota.service';
import { SendEntitlementsService } from './send-entitlements.service';

const actor = { tenantId: '1', userId: 'u1' };

interface Fixture {
  customer?: { status?: string; enabled?: boolean } | null;
  senderIds?: Array<{ sender_id: string; status: string; reason?: string | null }>;
  customerRoutes?: Array<{ route_id: string | null; smsc_id: string | null }>;
  quotas?: Array<{ period: string; limit_count: number; used_count: number }>;
  balance?: number;
  smscRowId?: string;
}

/**
 * Fake client that models just enough of the schema for the real
 * CustomerQuotaService / CustomerCreditService transactional cores to run
 * against it — those are the primitives whose correctness we are relying on, so
 * they are NOT mocked out.
 */
function makeClient(fixture: Fixture) {
  const state = {
    quotas: (fixture.quotas ?? []).map((q, index) => ({
      id: `quota-${index}`,
      customer_id: 'cust-1',
      period: q.period,
      limit_count: String(q.limit_count),
      used_count: String(q.used_count),
      window_start: new Date().toISOString(),
      created_by: 'u1',
      created_at: 'now',
      updated_at: 'now',
    })),
    balance: fixture.balance ?? 0,
    debits: [] as Array<{ amount: number; balanceAfter: number }>,
  };
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM customers'))
      return {
        rows:
          fixture.customer === null
            ? []
            : [
                {
                  status: fixture.customer?.status ?? 'active',
                  enabled: fixture.customer?.enabled ?? true,
                },
              ],
      };
    if (sql.includes('FROM sender_ids')) return { rows: fixture.senderIds ?? [] };
    if (sql.includes('FROM customer_routes')) return { rows: fixture.customerRoutes ?? [] };
    if (sql.includes('FROM smsc_definitions'))
      return { rows: fixture.smscRowId ? [{ id: fixture.smscRowId }] : [] };
    if (sql.includes('FROM customer_quotas')) return { rows: state.quotas };
    if (sql.startsWith('UPDATE customer_quotas')) {
      const row = state.quotas.find((q) => q.id === params[0])!;
      row.used_count = String(params[2]);
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO customer_balances')) return { rows: [] };
    if (sql.includes('FROM customer_balances'))
      return { rows: [{ balance: String(state.balance) }] };
    if (sql.startsWith('UPDATE customer_balances')) {
      state.balance = Number(params[1]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO credit_transactions')) {
      state.debits.push({ amount: Number(params[3]), balanceAfter: Number(params[4]) });
      return {
        rows: [
          {
            id: 'tx-1',
            customer_id: 'cust-1',
            direction: params[2],
            amount: params[3],
            balance_after: params[4],
            reason: params[5],
            reference: params[6],
            created_by: params[7],
            created_at: 'now',
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { client: { query } as never, state };
}

function makeService() {
  const database = {} as never;
  return new SendEntitlementsService(
    new CustomerQuotaService(database),
    new CustomerCreditService(database),
  );
}

describe('SendEntitlementsService', () => {
  it('is a clean no-op when the send carries no customer', async () => {
    const { client, state } = makeClient({});
    const outcome = await makeService().consumeInClient(client, actor, { customerId: null });
    expect(outcome).toMatchObject({ customerId: null, quotas: [], charged: 0 });
    expect(state.debits).toHaveLength(0);
  });

  it('refuses a send for a suspended customer', async () => {
    const { client } = makeClient({ customer: { status: 'suspended' } });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s for a customer that does not exist in the tenant', async () => {
    const { client } = makeClient({ customer: null });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a REJECTED sender ID and says why', async () => {
    const { client } = makeClient({
      senderIds: [{ sender_id: 'SCAMCO', status: 'rejected', reason: 'impersonates a bank' }],
    });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', sender: 'SCAMCO' }),
    ).rejects.toThrow(/rejected: impersonates a bank/);
  });

  it('refuses a sender ID still pending approval', async () => {
    const { client } = makeClient({ senderIds: [{ sender_id: 'NEWCO', status: 'pending' }] });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', sender: 'NEWCO' }),
    ).rejects.toThrow(/pending/);
  });

  it('refuses a sender ID that is not registered once the customer has any', async () => {
    const { client } = makeClient({ senderIds: [{ sender_id: 'GOODCO', status: 'approved' }] });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', sender: 'OTHER' }),
    ).rejects.toThrow(/not registered/);
  });

  it('accepts an approved sender ID', async () => {
    const { client } = makeClient({ senderIds: [{ sender_id: 'GOODCO', status: 'approved' }] });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      sender: 'GOODCO',
    });
    expect(outcome.senderChecked).toBe(true);
  });

  it('leaves a customer with no registered sender IDs unconstrained', async () => {
    const { client } = makeClient({ senderIds: [] });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      sender: 'ANYTHING',
    });
    expect(outcome.senderChecked).toBe(false);
  });

  it('refuses a bind the customer is not entitled to', async () => {
    const { client } = makeClient({
      customerRoutes: [{ route_id: null, smsc_id: 'smsc-b' }],
      smscRowId: 'smsc-a',
    });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', smscId: 'local-fake' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a bind the customer IS entitled to', async () => {
    const { client } = makeClient({
      customerRoutes: [{ route_id: null, smsc_id: 'smsc-a' }],
      smscRowId: 'smsc-a',
    });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      smscId: 'local-fake',
    });
    expect(outcome.routeBindingChecked).toBe(true);
  });

  it('refuses a send that would exceed the daily quota', async () => {
    const { client } = makeClient({
      quotas: [{ period: 'daily', limit_count: 10, used_count: 10 }],
    });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a batch that would push usage past the cap', async () => {
    const { client } = makeClient({
      quotas: [{ period: 'daily', limit_count: 10, used_count: 8 }],
    });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', count: 3 }),
    ).rejects.toThrow(/daily quota exceeded/);
  });

  it('consumes quota when the send fits inside the cap', async () => {
    const { client } = makeClient({
      quotas: [{ period: 'daily', limit_count: 10, used_count: 8 }],
    });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      count: 2,
    });
    expect(outcome.quotas).toEqual([{ period: 'daily', limit: 10, used: 10, remaining: 0 }]);
  });

  it('refuses a send the customer cannot afford, and posts NO debit', async () => {
    const { client, state } = makeClient({ balance: 0.005 });
    await expect(
      makeService().consumeInClient(client, actor, { customerId: 'cust-1', cost: 0.02 }),
    ).rejects.toThrow(/insufficient credit/);
    expect(state.debits).toHaveLength(0);
    expect(state.balance).toBe(0.005);
  });

  it('debits the per-message cost when the customer can afford it', async () => {
    const { client, state } = makeClient({ balance: 1 });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      cost: 0.02,
      count: 2,
      reference: 'job-1',
    });
    expect(outcome.charged).toBe(0.04);
    expect(outcome.balanceAfter).toBeCloseTo(0.96, 5);
    expect(state.debits).toEqual([{ amount: 0.04, balanceAfter: 0.96 }]);
  });

  it('does not touch the ledger when the traffic is unpriced', async () => {
    const { client, state } = makeClient({ balance: 0 });
    const outcome = await makeService().consumeInClient(client, actor, {
      customerId: 'cust-1',
      cost: null,
    });
    expect(outcome.charged).toBe(0);
    expect(state.debits).toHaveLength(0);
  });
});
