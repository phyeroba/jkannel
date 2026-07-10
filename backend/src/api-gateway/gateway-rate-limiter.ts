import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_REDIS, RedisLike } from './redis.provider';

export interface RateLimitResult {
  /** False only when the key has exceeded its window budget. */
  allowed: boolean;
  /** Configured ceiling for the window (echoed back for X-RateLimit-Limit). */
  limit: number;
  /** Requests still permitted in the current window (never negative). */
  remaining: number;
  /** Seconds until the current window resets — the Retry-After value on 429. */
  retryAfterSeconds: number;
  /** True when the decision was made without Redis (fail-open). */
  degraded: boolean;
}

// Atomic fixed-window counter: INCR the window key, set its TTL on first hit,
// and read the TTL back so the caller can compute Retry-After. Running this as a
// single EVAL guarantees the INCR and EXPIRE cannot interleave across requests.
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

/**
 * Per-key fixed-window rate limiter backed by Redis.
 *
 * Enforcement is atomic (single Lua EVAL: INCR + conditional EXPIRE + TTL). The
 * limiter FAILS OPEN: if Redis is absent, unreachable, or errors, the request is
 * allowed and the degradation is logged rather than hard-failing the API. A key
 * with no configured limit (`limit <= 0`) is unlimited.
 */
@Injectable()
export class GatewayRateLimiter {
  constructor(@Inject(GATEWAY_REDIS) private readonly redis: RedisLike | null) {}

  async consume(keyId: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    if (!limit || limit <= 0)
      return { allowed: true, limit: 0, remaining: 0, retryAfterSeconds: 0, degraded: false };

    if (!this.redis) {
      this.logDegraded(keyId, 'redis client unavailable');
      return {
        allowed: true,
        limit,
        remaining: limit,
        retryAfterSeconds: 0,
        degraded: true,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const redisKey = `gw:rl:${keyId}:${windowStart}`;
    try {
      const raw = (await this.redis.eval(WINDOW_SCRIPT, 1, redisKey, windowSeconds)) as [
        number,
        number,
      ];
      const count = Number(raw[0]);
      const ttlRaw = Number(raw[1]);
      // A missing/expired TTL (-1/-2) falls back to a full window remainder.
      const ttl = ttlRaw > 0 ? ttlRaw : windowSeconds;
      const allowed = count <= limit;
      return {
        allowed,
        limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: allowed ? 0 : ttl,
        degraded: false,
      };
    } catch (error) {
      this.logDegraded(keyId, String((error as Error).message ?? error));
      return {
        allowed: true,
        limit,
        remaining: limit,
        retryAfterSeconds: 0,
        degraded: true,
      };
    }
  }

  private logDegraded(keyId: string, reason: string): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'gateway rate limiter failing open',
        keyId,
        reason,
      }),
    );
  }
}
