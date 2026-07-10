import { GatewayRateLimiter } from './gateway-rate-limiter';
import { RedisLike } from './redis.provider';

/**
 * Fake Redis that emulates the fixed-window Lua script: a per-key counter plus a
 * TTL that "resets" when the test advances a virtual clock. Only the behaviour
 * the limiter relies on (INCR, first-hit EXPIRE, TTL readback) is modelled.
 */
class FakeRedis implements RedisLike {
  private counters = new Map<string, { count: number; expiresAt: number }>();
  public now = 1_000_000; // virtual seconds
  public evalCalls = 0;

  eval(_script: string, _numKeys: number, key: string, windowSeconds: number): Promise<unknown> {
    this.evalCalls += 1;
    const window = Number(windowSeconds);
    const existing = this.counters.get(String(key));
    if (!existing || existing.expiresAt <= this.now) {
      this.counters.set(String(key), { count: 1, expiresAt: this.now + window });
      return Promise.resolve([1, window]);
    }
    existing.count += 1;
    return Promise.resolve([existing.count, existing.expiresAt - this.now]);
  }
}

describe('GatewayRateLimiter', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1000);
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows requests up to the limit then returns 429 details with Retry-After', async () => {
    const redis = new FakeRedis();
    const limiter = new GatewayRateLimiter(redis);

    const first = await limiter.consume('key-1', 3, 60);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    await limiter.consume('key-1', 3, 60); // 2nd
    const third = await limiter.consume('key-1', 3, 60);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await limiter.consume('key-1', 3, 60);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('resets the budget once the window elapses', async () => {
    const redis = new FakeRedis();
    const limiter = new GatewayRateLimiter(redis);

    await limiter.consume('key-2', 1, 60);
    const blocked = await limiter.consume('key-2', 1, 60);
    expect(blocked.allowed).toBe(false);

    // Advance both the limiter's Date.now window and the fake's TTL clock past
    // the 60s window boundary.
    redis.now += 61;
    jest.spyOn(Date, 'now').mockReturnValue((1_000_000 + 61) * 1000);

    const afterReset = await limiter.consume('key-2', 1, 60);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(0);
  });

  it('isolates counters per key', async () => {
    const redis = new FakeRedis();
    const limiter = new GatewayRateLimiter(redis);
    await limiter.consume('a', 1, 60);
    const aBlocked = await limiter.consume('a', 1, 60);
    const bAllowed = await limiter.consume('b', 1, 60);
    expect(aBlocked.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });

  it('treats a non-positive limit as unlimited and never touches Redis', async () => {
    const redis = new FakeRedis();
    const limiter = new GatewayRateLimiter(redis);
    const result = await limiter.consume('key-3', 0, 60);
    expect(result.allowed).toBe(true);
    expect(redis.evalCalls).toBe(0);
  });

  it('fails OPEN (allows) when Redis is unavailable', async () => {
    const limiter = new GatewayRateLimiter(null);
    const result = await limiter.consume('key-4', 1, 60);
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('fails OPEN when the Redis call throws', async () => {
    const throwing: RedisLike = {
      eval: () => Promise.reject(new Error('connection refused')),
    };
    const limiter = new GatewayRateLimiter(throwing);
    const result = await limiter.consume('key-5', 1, 60);
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });
});
