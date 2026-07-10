import Redis from 'ioredis';

/**
 * Minimal surface the {@link GatewayRateLimiter} needs from a Redis client.
 * Declaring it as an interface keeps the limiter unit-testable with a fake and
 * decouples it from the concrete ioredis type.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** DI token for the (possibly null) gateway Redis client. */
export const GATEWAY_REDIS = 'GATEWAY_REDIS';

/**
 * Lazily construct a shared Redis client for gateway rate limiting, mirroring
 * the resilient pattern in platform-metrics.service: `lazyConnect` plus a
 * swallowed 'error' handler so an unreachable/absent Redis never crashes the
 * process — the limiter fails open instead. Returns null when construction
 * itself throws (e.g. a malformed URL).
 */
export function createGatewayRedis(): Redis | null {
  const url = process.env.REDIS_URL ?? 'redis://redis:6379';
  try {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
    });
    // Prevent an unhandled 'error' event from taking down the process when
    // Redis is unreachable; the limiter's try/catch handles the failure path.
    client.on('error', () => undefined);
    return client;
  } catch {
    return null;
  }
}

export const gatewayRedisProvider = {
  provide: GATEWAY_REDIS,
  useFactory: (): RedisLike | null => createGatewayRedis(),
};
