import Redis from 'ioredis';
import { createRedisClient } from '../platform/redis-options';
import { AUTH_THROTTLE_REDIS, ThrottleRedis } from './auth-throttle.service';

/**
 * Lazily construct the Redis client used by {@link AuthThrottleService}.
 *
 * Same resilient pattern as `api-gateway/redis.provider`: Sentinel-aware via
 * `createRedisClient`, `lazyConnect`, offline queue disabled and a swallowed
 * 'error' handler so an unreachable Redis can never crash the process — the
 * throttle fails open instead. Returns null when construction itself throws
 * (e.g. a malformed REDIS_URL), which the service treats as "no Redis".
 */
export function createAuthThrottleRedis(): Redis | null {
  try {
    const client = createRedisClient({
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
    });
    client.on('error', () => undefined);
    return client;
  } catch {
    return null;
  }
}

export const authThrottleRedisProvider = {
  provide: AUTH_THROTTLE_REDIS,
  useFactory: (): ThrottleRedis | null => createAuthThrottleRedis(),
};
