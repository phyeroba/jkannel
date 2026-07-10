import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { DatabaseService } from '../database/database.service';

/**
 * Platform-level Prometheus exporter for signals the in-process
 * {@link MetricsRegistry} cannot see: PostgreSQL pool/activity/size and Redis
 * liveness/memory. These are global (not tenant-scoped) infrastructure gauges.
 *
 * `render()` never throws: when the database or Redis is unreachable it emits an
 * honest `_up 0` gauge rather than failing the whole /metrics scrape. The Redis
 * client is created lazily and configured not to crash the process when
 * REDIS_URL points at an unavailable server or is absent.
 */
@Injectable()
export class PlatformMetricsService implements OnModuleDestroy {
  // undefined => not yet resolved; null => intentionally disabled (no client).
  private redis?: Redis | null;

  constructor(private readonly database: DatabaseService) {}

  async render(): Promise<string> {
    const [db, redis] = await Promise.all([this.databaseMetrics(), this.redisMetrics()]);
    return [...db, ...redis].join('\n');
  }

  private async databaseMetrics(): Promise<string[]> {
    try {
      const result = await this.database.query<{
        connections: string;
        db_size: string;
        commits: string | null;
        rollbacks: string | null;
      }>(
        `SELECT
           (SELECT count(*) FROM pg_stat_activity) AS connections,
           pg_database_size(current_database()) AS db_size,
           (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()) AS commits,
           (SELECT xact_rollback FROM pg_stat_database WHERE datname = current_database()) AS rollbacks`,
      );
      const row = result.rows[0];
      return [
        '# HELP jkannel_db_up Database reachability as a boolean gauge.',
        '# TYPE jkannel_db_up gauge',
        'jkannel_db_up 1',
        '# HELP jkannel_db_connections Current server connections (pg_stat_activity).',
        '# TYPE jkannel_db_connections gauge',
        `jkannel_db_connections ${this.int(row.connections)}`,
        '# HELP jkannel_db_size_bytes On-disk size of the current database in bytes.',
        '# TYPE jkannel_db_size_bytes gauge',
        `jkannel_db_size_bytes ${this.int(row.db_size)}`,
        '# HELP jkannel_db_commits_total Committed transactions on the current database.',
        '# TYPE jkannel_db_commits_total counter',
        `jkannel_db_commits_total ${this.int(row.commits)}`,
        '# HELP jkannel_db_rollbacks_total Rolled-back transactions on the current database.',
        '# TYPE jkannel_db_rollbacks_total counter',
        `jkannel_db_rollbacks_total ${this.int(row.rollbacks)}`,
      ];
    } catch {
      return [
        '# HELP jkannel_db_up Database reachability as a boolean gauge.',
        '# TYPE jkannel_db_up gauge',
        'jkannel_db_up 0',
      ];
    }
  }

  private async redisMetrics(): Promise<string[]> {
    const info = await this.readRedisInfo();
    if (info === null) {
      return [
        '# HELP jkannel_redis_up Redis reachability as a boolean gauge.',
        '# TYPE jkannel_redis_up gauge',
        'jkannel_redis_up 0',
      ];
    }
    const usedMemory = this.parseInfo(info, 'used_memory');
    const connectedClients = this.parseInfo(info, 'connected_clients');
    return [
      '# HELP jkannel_redis_up Redis reachability as a boolean gauge.',
      '# TYPE jkannel_redis_up gauge',
      'jkannel_redis_up 1',
      '# HELP jkannel_redis_used_memory_bytes Redis used_memory in bytes.',
      '# TYPE jkannel_redis_used_memory_bytes gauge',
      `jkannel_redis_used_memory_bytes ${usedMemory ?? 0}`,
      '# HELP jkannel_redis_connected_clients Number of client connections to Redis.',
      '# TYPE jkannel_redis_connected_clients gauge',
      `jkannel_redis_connected_clients ${connectedClients ?? 0}`,
    ];
  }

  /** Returns the raw INFO payload, or null when Redis is unreachable. */
  private async readRedisInfo(): Promise<string | null> {
    const client = this.redisClient();
    if (!client) return null;
    try {
      return await client.info();
    } catch {
      return null;
    }
  }

  private redisClient(): Redis | null {
    if (this.redis !== undefined) return this.redis;
    const url = process.env.REDIS_URL ?? 'redis://redis:6379';
    try {
      // Lazy, non-fatal: never queue offline commands or retry forever, so a
      // missing/unreachable Redis surfaces as jkannel_redis_up 0 rather than a
      // hung scrape or an unhandled connection error.
      this.redis = new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        retryStrategy: () => null,
      });
      // Swallow async connection errors emitted outside of a command call.
      this.redis.on('error', () => undefined);
    } catch {
      this.redis = null;
    }
    return this.redis;
  }

  private parseInfo(info: string, key: string): number | null {
    const match = new RegExp(`^${key}:(\\d+)`, 'm').exec(info);
    return match ? Number(match[1]) : null;
  }

  private int(value: string | null | undefined): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try {
        this.redis.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
