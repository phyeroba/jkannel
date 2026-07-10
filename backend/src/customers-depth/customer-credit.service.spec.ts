import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomerCreditService } from './customer-credit.service';

const actor = { tenantId: '1', userId: 'u1' };
const CUSTOMER = 'c1';

/**
 * Mock DB client with a mutable balance. The balance INSERT ... ON CONFLICT DO
 * NOTHING is a no-op here; SELECT balance returns the current value; UPDATE
 * customer_balances mutates it; the ledger INSERT echoes the row back.
 */
function makeClient(opts: { customer?: boolean; balance?: number } = {}) {
  const customer = opts.customer ?? true;
  let balance = opts.balance ?? 0;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM customers WHERE id='))
      return { rows: customer ? [{ '?column?': 1 }] : [] };
    if (sql.startsWith('INSERT INTO customer_balances')) return { rows: [] };
    if (sql.includes('SELECT balance FROM customer_balances'))
      return { rows: [{ balance: String(balance) }] };
    if (sql.startsWith('UPDATE customer_balances')) {
      balance = Number(params[1]);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO credit_transactions')) {
      return {
        rows: [
          {
            id: 'tx-1',
            customer_id: params[1],
            direction: params[2],
            amount: String(params[3]),
            balance_after: String(params[4]),
            reason: params[5],
            reference: params[6],
            created_by: params[7],
            created_at: new Date().toISOString(),
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { query, calls, getBalance: () => balance };
}

function serviceWith(client: any) {
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return new CustomerCreditService(db);
}

describe('CustomerCreditService.postTransaction', () => {
  it('credits and increases the balance', async () => {
    const client = makeClient({ balance: 100 });
    const service = serviceWith(client);
    const { balance, transaction } = await service.postTransaction(actor, CUSTOMER, {
      direction: 'credit',
      amount: 50,
    });
    expect(balance.balance).toBe(150);
    expect(transaction.balance_after).toBe('150');
    expect(client.getBalance()).toBe(150);
  });

  it('debits and reduces the balance', async () => {
    const client = makeClient({ balance: 100 });
    const service = serviceWith(client);
    const { balance } = await service.postTransaction(actor, CUSTOMER, {
      direction: 'debit',
      amount: 30,
    });
    expect(balance.balance).toBe(70);
    expect(client.getBalance()).toBe(70);
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('rejects a debit that exceeds the balance and leaves it unchanged', async () => {
    const client = makeClient({ balance: 20 });
    const service = serviceWith(client);
    await expect(
      service.postTransaction(actor, CUSTOMER, { direction: 'debit', amount: 50 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getBalance()).toBe(20);
    expect(client.calls.some((c) => c.sql.startsWith('INSERT INTO credit_transactions'))).toBe(
      false,
    );
  });

  it('allows a debit down to exactly zero', async () => {
    const client = makeClient({ balance: 40 });
    const service = serviceWith(client);
    const { balance } = await service.postTransaction(actor, CUSTOMER, {
      direction: 'debit',
      amount: 40,
    });
    expect(balance.balance).toBe(0);
  });

  it('rejects a non-positive amount', async () => {
    const client = makeClient({ balance: 100 });
    const service = serviceWith(client);
    await expect(
      service.postTransaction(actor, CUSTOMER, { direction: 'credit', amount: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s for a missing customer', async () => {
    const client = makeClient({ customer: false });
    const service = serviceWith(client);
    await expect(
      service.postTransaction(actor, CUSTOMER, { direction: 'credit', amount: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CustomerCreditService.hasSufficientBalance', () => {
  it('is true when balance covers the amount and false otherwise', async () => {
    const service = serviceWith(makeClient({ balance: 100 }));
    await expect(service.hasSufficientBalance(actor, CUSTOMER, 100)).resolves.toBe(true);
    const service2 = serviceWith(makeClient({ balance: 100 }));
    await expect(service2.hasSufficientBalance(actor, CUSTOMER, 101)).resolves.toBe(false);
  });
});
