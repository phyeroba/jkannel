import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { GatewayRateLimiter } from '../api-gateway/gateway-rate-limiter';

export interface CustomerRateLimitOutcome {
  customerId: string | null;
  /** The configured ceiling; 0 means the customer is unlimited. */
  limit: number;
  /** Requests still permitted in the current minute. */
  remaining: number;
  /** True when Redis was unavailable and the send was allowed regardless. */
  degraded: boolean;
  /** False when there was nothing to enforce (no customer, or no limit set). */
  enforced: boolean;
}

/**
 * Per-CUSTOMER send rate limiting, reading `customers.rate_limit_per_min`.
 *
 * The gateway already limited per API KEY, which is a different control: a
 * customer holding four keys could send four times its contracted rate and
 * every individual key stayed inside its own budget. This limits the customer,
 * whichever credential (or console session, or bulk job) the traffic arrives
 * through, because it is applied inside {@link MessageSendService} — the single
 * send path all of them funnel into.
 *
 * MECHANISM. The same Redis fixed-window counter the gateway limiter uses
 * ({@link GatewayRateLimiter}, one atomic Lua INCR + EXPIRE + TTL), keyed on
 * `customer:<tenantId>:<customerId>` so a customer id can never collide with an
 * API key id in the shared `gw:rl:` namespace, and so the limit is per tenant
 * even in the impossible case of a shared customer id.
 *
 * FAIL OPEN. If Redis is absent or erroring the send is ALLOWED and the
 * degradation is logged, here and by the limiter. Refusing live traffic because
 * a counter is unreachable would convert a cache outage into an outage.
 *
 * COUNTS REQUESTS, NOT SUCCESSES. The window is incremented before the send is
 * attempted, so a send that is subsequently refused (blocklist, quota, credit)
 * still consumed a slot. That is the point of a rate limit: it sheds load, and
 * a caller cannot get unlimited attempts by making them all fail.
 */
@Injectable()
export class CustomerRateLimitService {
  constructor(private readonly limiter: GatewayRateLimiter) {}

  /** Window in seconds — the column is expressed per minute. */
  static readonly WINDOW_SECONDS = 60;

  /** Redis key id for a customer, namespaced away from API key ids. */
  static keyFor(tenantId: string, customerId: string): string {
    return `customer:${tenantId}:${customerId}`;
  }

  /**
   * Consumes one slot of the customer's per-minute budget on the caller's ALREADY
   * OPEN tenant transaction (the limit is read under RLS, so a customer of
   * another tenant is simply not visible).
   *
   * @throws HttpException 429 when the budget is exhausted.
   */
  async consumeInClient(
    client: PoolClient,
    tenantId: string,
    customerId: string | null | undefined,
    count = 1,
  ): Promise<CustomerRateLimitOutcome> {
    const unenforced: CustomerRateLimitOutcome = {
      customerId: customerId ?? null,
      limit: 0,
      remaining: 0,
      degraded: false,
      enforced: false,
    };
    // No customer attributed: there is no per-customer policy to apply, exactly
    // as with quota and credit.
    if (!customerId) return unenforced;

    const row = (
      await client.query<{ rate_limit_per_min: number | string | null }>(
        'SELECT rate_limit_per_min FROM customers WHERE id=$1',
        [customerId],
      )
    ).rows[0];
    // A missing row is not this control's business to report — the entitlement
    // check that follows raises the proper 404.
    const limit = Number(row?.rate_limit_per_min ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return unenforced;

    const keyId = CustomerRateLimitService.keyFor(tenantId, customerId);
    let result = await this.limiter.consume(keyId, limit, CustomerRateLimitService.WINDOW_SECONDS);
    // A send worth more than one message (a batched submit) consumes the rest of
    // its slots too, so a batch cannot slip through on a single increment.
    for (let extra = 1; extra < Math.max(1, Math.trunc(count)); extra += 1)
      result = await this.limiter.consume(keyId, limit, CustomerRateLimitService.WINDOW_SECONDS);

    if (result.degraded) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'customer rate limit failing open (send allowed)',
          tenantId,
          customerId,
          limit,
        }),
      );
      return { customerId, limit, remaining: result.remaining, degraded: true, enforced: false };
    }

    if (!result.allowed)
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message:
            `Customer rate limit exceeded: ${limit} message(s) per minute ` +
            `(customers.rate_limit_per_min). Retry in ${result.retryAfterSeconds}s.`,
          limit,
          windowSeconds: CustomerRateLimitService.WINDOW_SECONDS,
          retryAfterSeconds: result.retryAfterSeconds,
          customerId,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    return {
      customerId,
      limit,
      remaining: result.remaining,
      degraded: false,
      enforced: true,
    };
  }
}
