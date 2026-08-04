import { HttpException, HttpStatus } from '@nestjs/common';
import { GatewayRateLimiter } from '../api-gateway/gateway-rate-limiter';
import { CustomerRateLimitService } from './customer-rate-limit.service';

/**
 * The in-memory stand-in performs the same fixed-window INCR the Lua script
 * does, so the limiter's real arithmetic (count vs limit, remaining, TTL) is
 * exercised rather than mocked away.
 */
function fakeRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    keys: [] as string[],
    eval: jest.fn(async function (this: any, _script: string, _numKeys: number, key: string) {
      const next = (counters.get(String(key)) ?? 0) + 1;
      counters.set(String(key), next);
      return [next, 42];
    }),
  };
}

/** A PoolClient that answers only the one query the service issues. */
function client(rateLimitPerMin: number | string | null, exists = true) {
  return {
    query: jest.fn(async () => ({ rows: exists ? [{ rate_limit_per_min: rateLimitPerMin }] : [] })),
  } as any;
}

const service = (redis: any) => new CustomerRateLimitService(new GatewayRateLimiter(redis));

describe('per-customer rate limiting', () => {
  it('allows every send under the cap and reports what is left', async () => {
    const redis = fakeRedis();
    const limiter = service(redis);
    const db = client(3);

    for (const remaining of [2, 1, 0]) {
      const outcome = await limiter.consumeInClient(db, '7', 'cust-1');
      expect(outcome).toMatchObject({ enforced: true, limit: 3, remaining, degraded: false });
    }
  });

  it('refuses the send with a 429 once the cap is passed', async () => {
    const limiter = service(fakeRedis());
    const db = client(2);
    await limiter.consumeInClient(db, '7', 'cust-1');
    await limiter.consumeInClient(db, '7', 'cust-1');

    await expect(limiter.consumeInClient(db, '7', 'cust-1')).rejects.toBeInstanceOf(HttpException);
    try {
      await limiter.consumeInClient(db, '7', 'cust-1');
    } catch (error) {
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const body: any = exception.getResponse();
      // The refusal must be legible: what the cap is, and when to retry.
      expect(body.message).toContain('Customer rate limit exceeded');
      expect(body.message).toContain('2 message(s) per minute');
      expect(body.limit).toBe(2);
      expect(body.windowSeconds).toBe(60);
      expect(body.retryAfterSeconds).toBe(42);
      expect(body.customerId).toBe('cust-1');
    }
  });

  it('keys the counter per tenant AND per customer, namespaced away from API keys', async () => {
    const redis = fakeRedis();
    const limiter = service(redis);
    await limiter.consumeInClient(client(5), '7', 'cust-1');
    await limiter.consumeInClient(client(5), '8', 'cust-1');
    await limiter.consumeInClient(client(5), '7', 'cust-2');

    const keys = redis.eval.mock.calls.map((call) => String(call[2]));
    expect(keys[0]).toContain('customer:7:cust-1');
    // Two tenants, and two customers, must never share a window.
    expect(new Set(keys).size).toBe(3);
    // The prefix keeps a customer id from colliding with an API key id.
    for (const key of keys) expect(key.startsWith('gw:rl:customer:')).toBe(true);
    expect(CustomerRateLimitService.keyFor('7', 'cust-1')).toBe('customer:7:cust-1');
  });

  it('counts a customer’s traffic across all of its credentials — one window', async () => {
    // The gap this closes: four API keys, four separate per-key budgets, and a
    // customer sending four times its contracted rate.
    const redis = fakeRedis();
    const limiter = service(redis);
    const db = client(2);
    await limiter.consumeInClient(db, '7', 'cust-1');
    await limiter.consumeInClient(db, '7', 'cust-1');
    await expect(limiter.consumeInClient(db, '7', 'cust-1')).rejects.toBeInstanceOf(HttpException);
    expect(redis.counters.size).toBe(1);
  });

  it('consumes one slot per message when a send carries several', async () => {
    const redis = fakeRedis();
    const limiter = service(redis);
    const outcome = await limiter.consumeInClient(client(10), '7', 'cust-1', 4);
    expect(redis.eval).toHaveBeenCalledTimes(4);
    expect(outcome.remaining).toBe(6);
  });
});

describe('when there is nothing to enforce', () => {
  it('does not touch Redis or the database with no customer attributed', async () => {
    const redis = fakeRedis();
    const db = client(10);
    const outcome = await service(redis).consumeInClient(db, '7', null);
    expect(outcome).toMatchObject({ enforced: false, limit: 0 });
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it.each([null, 0, -1])('treats rate_limit_per_min=%p as unlimited', async (value) => {
    const redis = fakeRedis();
    const outcome = await service(redis).consumeInClient(client(value), '7', 'cust-1');
    expect(outcome.enforced).toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('accepts the numeric column arriving as a string', async () => {
    const redis = fakeRedis();
    const outcome = await service(redis).consumeInClient(client('5'), '7', 'cust-1');
    expect(outcome).toMatchObject({ enforced: true, limit: 5, remaining: 4 });
  });

  it('leaves a missing customer to the entitlement check that reports it properly', async () => {
    const redis = fakeRedis();
    const outcome = await service(redis).consumeInClient(client(null, false), '7', 'cust-gone');
    expect(outcome.enforced).toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('reads the limit under RLS on the caller’s own client', async () => {
    const db = client(5);
    await service(fakeRedis()).consumeInClient(db, '7', 'cust-1');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM customers'), ['cust-1']);
  });
});

describe('fail open', () => {
  it('allows the send when Redis is absent, and logs the degradation', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const outcome = await service(null).consumeInClient(client(1), '7', 'cust-1');
      expect(outcome).toMatchObject({ degraded: true, enforced: false, limit: 1 });
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('customer rate limit failing open');
      expect(logged).toContain('cust-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('allows the send when Redis errors, however far over the cap', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const redis = { eval: jest.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) };
      const limiter = service(redis);
      const db = client(1);
      for (let attempt = 0; attempt < 5; attempt += 1)
        expect((await limiter.consumeInClient(db, '7', 'cust-1')).degraded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
