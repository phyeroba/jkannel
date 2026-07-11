import Redis, { RedisOptions } from 'ioredis';

/**
 * Parses a comma-separated `host:port` sentinel list (e.g.
 * "sentinel-1:26379,sentinel-2:26379") into ioredis sentinel entries. A bare
 * host with no port defaults to the standard sentinel port 26379. Returns an
 * empty array for an unset/blank value.
 */
export function parseSentinels(raw?: string): Array<{ host: string; port: number }> {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((hostport) => {
      const idx = hostport.lastIndexOf(':');
      if (idx === -1) return { host: hostport, port: 26379 };
      const host = hostport.slice(0, idx);
      const port = Number(hostport.slice(idx + 1)) || 26379;
      return { host, port };
    });
}

/**
 * Builds an ioredis client that follows the HA topology automatically.
 *
 * When `REDIS_SENTINELS` is set, the client connects through Redis Sentinel and
 * tracks the monitored master group (`REDIS_MASTER_NAME`, default "mymaster"),
 * so it follows automatic master failover provided by the HA overlay
 * (docker-compose.ha.yml / infrastructure/ha/redis). Otherwise it falls back to
 * the single-host `REDIS_URL` (default redis://redis:6379) — the standard
 * single-node behavior. `extra` options (lazyConnect, timeouts, retry strategy)
 * are merged in by the caller and apply to both modes.
 */
export function createRedisClient(extra: RedisOptions = {}): Redis {
  const sentinels = parseSentinels(process.env.REDIS_SENTINELS);
  if (sentinels.length > 0) {
    return new Redis({
      sentinels,
      name: process.env.REDIS_MASTER_NAME ?? 'mymaster',
      ...extra,
    });
  }
  const url = process.env.REDIS_URL ?? 'redis://redis:6379';
  return new Redis(url, extra);
}
