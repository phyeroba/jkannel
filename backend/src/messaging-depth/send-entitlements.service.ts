import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CustomerCreditService } from '../customers-depth/customer-credit.service';
import { CustomerQuotaService } from '../customers-depth/customer-quota.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface EntitlementCheck {
  /** The customer the traffic is attributed to; null = no entitlements apply. */
  customerId?: string | null;
  /** Sender ID the message will carry. */
  sender?: string | null;
  /** Engine-level bind the message will be submitted through. */
  smscId?: string | null;
  /** Controlling route id, when the routing engine chose one. */
  routeId?: string | null;
  /** Number of messages this send consumes (1 for a single submit). */
  count?: number;
  /** Per-message charge; 0/undefined means the send is not billed. */
  cost?: number | null;
  /** Ledger reference (message foreign id, bulk job id, ...). */
  reference?: string | null;
}

export interface EntitlementOutcome {
  customerId: string | null;
  /** Quota periods consumed, with post-consume usage. */
  quotas: Array<{ period: string; limit: number; used: number; remaining: number }>;
  /** Amount debited, 0 when the send is not billed. */
  charged: number;
  balanceAfter: number | null;
  senderChecked: boolean;
  routeBindingChecked: boolean;
}

/** Per-message charge when a route does not price its own traffic. */
function defaultMessageCost(): number {
  const parsed = Number(process.env.MESSAGE_DEFAULT_COST ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Customer entitlement enforcement ON the send path (gap G5).
 *
 * `CustomerQuotaService.consumeInClient` and `CustomerCreditService.postInClient`
 * were written for exactly this and then called by nobody but their own admin
 * endpoints: a customer with a 10 000/day quota could be sent unlimited traffic,
 * a customer with a zero balance was never debited, and a sender ID an operator
 * had explicitly REJECTED was accepted verbatim.
 *
 * This service performs all four checks — sender-ID approval, customer route
 * binding, quota, credit — against the caller's ALREADY OPEN tenant transaction,
 * which is the same transaction the send is recorded in. That is what makes the
 * guarantee real: if the engine submission then fails, the transaction rolls
 * back and no quota was consumed and no debit was posted. Equally, a refusal
 * throws a specific 4xx (403 for a policy refusal, 400 for an exhausted quota or
 * balance) and can never be reported as a successful send.
 *
 * BACKWARDS COMPATIBILITY: with no `customerId` there is nothing to enforce, so
 * {@link consumeInClient} is a clean no-op. Every send path that existed before
 * customers were attached keeps working unchanged.
 */
@Injectable()
export class SendEntitlementsService {
  constructor(
    private readonly quotas: CustomerQuotaService,
    private readonly credit: CustomerCreditService,
  ) {}

  /** The customer row, asserted to exist and be able to send. */
  private async assertSendableCustomer(client: PoolClient, customerId: string): Promise<void> {
    const row = (
      await client.query<{ status: string; enabled: boolean }>(
        'SELECT status, enabled FROM customers WHERE id=$1',
        [customerId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Customer not found');
    if (!row.enabled || row.status !== 'active')
      throw new ForbiddenException(
        `Customer is not able to send (status ${row.status}${row.enabled ? '' : ', disabled'})`,
      );
  }

  /**
   * The sender ID must be registered AND approved for the customer.
   *
   * A customer with no sender IDs registered at all is unconstrained — that is
   * the pre-existing behaviour for every account an operator has not yet
   * curated, and tightening it would silently stop live traffic. Once ANY
   * sender ID is registered the list is closed, and a 'pending' or 'rejected'
   * one is refused with the reason the operator recorded.
   */
  private async assertSenderApproved(
    client: PoolClient,
    customerId: string,
    sender: string,
  ): Promise<boolean> {
    const rows = (
      await client.query<{ sender_id: string; status: string; reason: string | null }>(
        'SELECT sender_id, status, reason FROM sender_ids WHERE customer_id=$1',
        [customerId],
      )
    ).rows;
    if (!rows.length) return false;
    const match = rows.find((row) => row.sender_id === sender);
    if (!match)
      throw new ForbiddenException(
        `Sender ID "${sender}" is not registered for this customer; register and approve it first`,
      );
    if (match.status !== 'approved')
      throw new ForbiddenException(
        `Sender ID "${sender}" is ${match.status}${match.reason ? `: ${match.reason}` : ''}`,
      );
    return true;
  }

  /**
   * The chosen route / bind must be one the customer is entitled to.
   *
   * A customer with no bindings is unconstrained. With bindings, either the
   * controlling route or the target SMSC must be bound. The bind arrives as an
   * engine id (`smsc_definitions.engine_id`), so it is resolved back to the row
   * id `customer_routes.smsc_id` references.
   */
  private async assertRoutePermitted(
    client: PoolClient,
    customerId: string,
    smscId: string | null | undefined,
    routeId: string | null | undefined,
  ): Promise<boolean> {
    const bindings = (
      await client.query<{ route_id: string | null; smsc_id: string | null }>(
        'SELECT route_id::text, smsc_id::text FROM customer_routes WHERE customer_id=$1 AND enabled=true',
        [customerId],
      )
    ).rows;
    if (!bindings.length) return false;
    if (routeId && bindings.some((b) => b.route_id === routeId)) return true;
    if (smscId) {
      const definition = (
        await client.query<{ id: string }>(
          'SELECT id::text FROM smsc_definitions WHERE engine_id=$1',
          [smscId],
        )
      ).rows[0];
      if (definition && bindings.some((b) => b.smsc_id === definition.id)) return true;
    }
    throw new ForbiddenException(
      `Customer is not entitled to send through ${smscId ?? 'the selected route'}`,
    );
  }

  /** Balance read on the caller's client (no nested transaction). */
  private async balanceInClient(
    client: PoolClient,
    tenantId: string,
    customerId: string,
  ): Promise<number> {
    await client.query(
      `INSERT INTO customer_balances(tenant_id,customer_id) VALUES($1,$2)
         ON CONFLICT (tenant_id,customer_id) DO NOTHING`,
      [tenantId, customerId],
    );
    const row = (
      await client.query<{ balance: string }>(
        'SELECT balance FROM customer_balances WHERE customer_id=$1',
        [customerId],
      )
    ).rows[0];
    return row ? Number(row.balance) : 0;
  }

  /**
   * Runs every entitlement check and consumes what the send costs, inside the
   * caller's transaction. Returns a no-op outcome when there is no customer.
   */
  async consumeInClient(
    client: PoolClient,
    actor: Actor,
    check: EntitlementCheck,
  ): Promise<EntitlementOutcome> {
    const empty: EntitlementOutcome = {
      customerId: null,
      quotas: [],
      charged: 0,
      balanceAfter: null,
      senderChecked: false,
      routeBindingChecked: false,
    };
    const customerId = check.customerId ?? null;
    if (!customerId) return empty;

    const count = Math.max(1, Math.trunc(check.count ?? 1));
    await this.assertSendableCustomer(client, customerId);

    const senderChecked = check.sender
      ? await this.assertSenderApproved(client, customerId, check.sender)
      : false;
    const routeBindingChecked = await this.assertRoutePermitted(
      client,
      customerId,
      check.smscId,
      check.routeId,
    );

    // Quota first: it is the cheaper refusal and the one an operator expects to
    // see when both would fail.
    const quotas = await this.quotas.consumeInClient(client, actor, customerId, count);

    const unitCost = check.cost ?? defaultMessageCost();
    const charge = unitCost > 0 ? Number((unitCost * count).toFixed(4)) : 0;
    let balanceAfter: number | null = null;
    if (charge > 0) {
      // hasSufficientBalance, evaluated on THIS client so the read sees the
      // uncommitted state of this very transaction, then the debit itself,
      // which re-checks under FOR UPDATE and rejects an over-draw.
      const balance = await this.balanceInClient(client, actor.tenantId, customerId);
      if (balance < charge)
        throw new ForbiddenException(`insufficient credit: ${charge} required, balance ${balance}`);
      const transaction = await this.credit.postInClient(client, actor, customerId, {
        direction: 'debit',
        amount: charge,
        reason: 'message submission',
        reference: check.reference ?? undefined,
      });
      balanceAfter = Number(transaction.balance_after);
    }

    return {
      customerId,
      quotas: quotas.map((q) => ({
        period: q.period,
        limit: q.limit,
        used: q.used,
        remaining: q.remaining,
      })),
      charged: charge,
      balanceAfter,
      senderChecked,
      routeBindingChecked,
    };
  }
}
