import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Actor, GridPage, assertCustomerExists, audit, pageArgs } from './customer-accounts.common';

export type LedgerDirection = 'credit' | 'debit';

export interface CreditTransactionRow {
  id: string;
  customer_id: string;
  direction: LedgerDirection;
  amount: string;
  balance_after: string;
  reason: string | null;
  reference: string | null;
  created_by: string;
  created_at: string;
}

export interface PostTransactionInput {
  direction: LedgerDirection;
  amount: number;
  reason?: string;
  reference?: string;
}

export interface BalanceView {
  customerId: string;
  balance: number;
}

/**
 * Per-customer prepaid credit balance and its append-only transaction ledger
 * (migration 026). {@link getBalance} reports the current balance;
 * {@link postTransaction} atomically applies a credit or debit and appends a
 * ledger entry recording the resulting balance. A debit that would drive the
 * balance negative is rejected — this is the "sufficient balance" check the
 * send path relies on. The balance row is locked FOR UPDATE for the duration of
 * a post so concurrent debits cannot race past zero.
 */
@Injectable()
export class CustomerCreditService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Reads (locking when `forUpdate`) the customer's current balance, creating
   * the balance row at zero on first touch. Assumes the customer is verified.
   */
  private async currentBalance(
    client: PoolClient,
    actor: Actor,
    customerId: string,
    forUpdate: boolean,
  ): Promise<number> {
    await client.query(
      `INSERT INTO customer_balances(tenant_id,customer_id) VALUES($1,$2)
         ON CONFLICT (tenant_id,customer_id) DO NOTHING`,
      [actor.tenantId, customerId],
    );
    const row = (
      await client.query<{ balance: string }>(
        `SELECT balance FROM customer_balances WHERE customer_id=$1 ${forUpdate ? 'FOR UPDATE' : ''}`,
        [customerId],
      )
    ).rows[0];
    return Number(row.balance);
  }

  /** Current balance for the customer. */
  async getBalance(actor: Actor, customerId: string): Promise<BalanceView> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const balance = await this.currentBalance(client, actor, customerId, false);
      return { customerId, balance };
    });
  }

  /** True when the customer's balance is at least `amount`. */
  async hasSufficientBalance(actor: Actor, customerId: string, amount: number): Promise<boolean> {
    const { balance } = await this.getBalance(actor, customerId);
    return balance >= amount;
  }

  /** Recent ledger entries, newest first. */
  async listTransactions(
    actor: Actor,
    customerId: string,
    query: Record<string, unknown> = {},
  ): Promise<GridPage<CreditTransactionRow>> {
    const { limit, offset } = pageArgs(query);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const result = await client.query<CreditTransactionRow & { __total: string }>(
        `SELECT id,customer_id,direction,amount,balance_after,reason,reference,created_by,created_at,
                count(*) OVER() AS __total
           FROM credit_transactions WHERE customer_id=$1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [customerId, limit, offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row);
      return { items, total, limit, offset };
    });
  }

  /** Posts a credit or debit and appends the ledger entry (see class doc). */
  async postTransaction(
    actor: Actor,
    customerId: string,
    input: PostTransactionInput,
  ): Promise<{ balance: BalanceView; transaction: CreditTransactionRow }> {
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0)
      throw new BadRequestException('amount must be a positive number');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const transaction = await this.postInClient(client, actor, customerId, input);
      return { balance: { customerId, balance: Number(transaction.balance_after) }, transaction };
    });
  }

  /**
   * Transactional core of {@link postTransaction}, reusable by a caller that
   * already holds a tenant transaction (e.g. a send path debiting per message).
   * Locks the balance row, rejects an over-drawing debit, writes the new
   * balance, and appends the ledger row. Assumes the customer is verified.
   *
   * INTEGRATION POINT: the live send / bulk-send path should call this with a
   * 'debit' of the per-message cost (reference = job/message id) inside the same
   * transaction that records the send, after {@link hasSufficientBalance}. It is
   * exposed here and via POST /customer-accounts/:id/credit/transactions but is
   * NOT yet wired into BulkSendService (owned by the messaging-depth module).
   */
  async postInClient(
    client: PoolClient,
    actor: Actor,
    customerId: string,
    input: PostTransactionInput,
  ): Promise<CreditTransactionRow> {
    const current = await this.currentBalance(client, actor, customerId, true);
    const delta = input.direction === 'credit' ? input.amount : -input.amount;
    const next = current + delta;
    if (next < 0)
      throw new BadRequestException(
        `insufficient balance: debit ${input.amount} exceeds balance ${current}`,
      );
    await client.query(
      'UPDATE customer_balances SET balance=$2, updated_at=now() WHERE customer_id=$1',
      [customerId, next],
    );
    const transaction = (
      await client.query<CreditTransactionRow>(
        `INSERT INTO credit_transactions
           (tenant_id,customer_id,direction,amount,balance_after,reason,reference,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,customer_id,direction,amount,balance_after,reason,reference,created_by,created_at`,
        [
          actor.tenantId,
          customerId,
          input.direction,
          input.amount,
          next,
          input.reason ?? null,
          input.reference ?? null,
          actor.userId,
        ],
      )
    ).rows[0];
    await audit(
      client,
      actor,
      `customer_credit.${input.direction}`,
      'credit_transaction',
      transaction.id,
      null,
      transaction,
      input.reason,
    );
    return transaction;
  }
}
