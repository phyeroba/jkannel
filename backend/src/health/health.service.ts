import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { DatabaseService } from '../database/database.service';
import { createRedisClient } from '../platform/redis-options';

/** Per-dependency outcome. `skipped` means the dependency is not configured. */
export type DependencyState = 'ok' | 'unhealthy' | 'skipped';
/** Overall process state. `degraded` still serves traffic; `unhealthy` does not. */
export type OverallState = 'ok' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: 'postgres' | 'redis';
  status: DependencyState;
  /** True when a failure of this dependency makes the whole service unhealthy. */
  required: boolean;
  /** How long the probe took, including a timeout that fired. */
  durationMs: number;
  /** Short, redacted explanation — never a DSN, credential or driver stack. */
  detail: string;
}

export interface HealthStatus {
  service: 'jkannel-backend';
  status: OverallState;
  timestamp: string;
  /** Wall-clock cost of the whole probe, so a slow dependency is visible. */
  durationMs: number;
  dependencies: DependencyHealth[];
}

/**
 * Per-dependency budget. A health probe that can block is worse than useless —
 * container healthchecks, load balancers and the watchdog all time out and
 * conclude "unhealthy" anyway, but only after their own (much longer) deadline.
 */
function timeoutMs(): number {
  const configured = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 1500);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 200), 5000) : 1500;
}

/**
 * Resolves `work` or rejects with a timeout error after `ms`. The loser of the
 * race is left to settle on its own; Promise.race has already subscribed to it,
 * so a late rejection can never surface as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Reduces a driver error to one short, safe line. Connection strings, inline
 * credentials and multi-line stack traces are stripped: /health is unauthenticated,
 * so anything it returns is public.
 */
export function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .split('\n')[0]
      // postgres://user:pass@host/db, redis://…, and any other URL-ish token.
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[redacted]')
      .replace(/\b(password|passwd|pwd|secret|token|key)\s*[=:]\s*\S+/gi, '$1=[redacted]')
      .slice(0, 160) || 'probe failed'
  );
}

/**
 * Real liveness/readiness probe for the API process.
 *
 * The previous implementation returned a hardcoded `{status:'ok'}`, which meant
 * container healthchecks, load-balancer ejection, the watchdog and HA failover
 * all believed a process that could not reach its database was fine. Every
 * dependency is now actually exercised, under a short per-dependency timeout so
 * a wedged dependency cannot stall the probe itself.
 *
 * PostgreSQL is required (no database, no service -> `unhealthy` -> HTTP 503).
 * Redis is optional: it backs idempotency/rate-limiting caches which fail open,
 * so losing it is `degraded` (HTTP 200) rather than a reason to eject the
 * instance from the load balancer.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  // Lazily resolved, mirroring PlatformMetricsService: `undefined` = not yet
  // resolved, `null` = unconfigured or unconstructable.
  private redis?: Redis | null;

  constructor(private readonly database: DatabaseService) {}

  async check(): Promise<HealthStatus> {
    const startedAt = Date.now();
    const dependencies = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const failedRequired = dependencies.some((d) => d.required && d.status === 'unhealthy');
    const failedOptional = dependencies.some((d) => !d.required && d.status === 'unhealthy');
    return {
      service: 'jkannel-backend',
      status: failedRequired ? 'unhealthy' : failedOptional ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      dependencies,
    };
  }

  private async checkPostgres(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.database.query('SELECT 1'), timeoutMs());
      return {
        name: 'postgres',
        status: 'ok',
        required: true,
        durationMs: Date.now() - startedAt,
        detail: 'SELECT 1 succeeded',
      };
    } catch (error) {
      // A timeout is an unhealthy dependency, not an exception to propagate:
      // the probe must always answer.
      return {
        name: 'postgres',
        status: 'unhealthy',
        required: true,
        durationMs: Date.now() - startedAt,
        detail: safeDetail(error),
      };
    }
  }

  private async checkRedis(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    const client = this.redisClient();
    if (!client)
      return {
        name: 'redis',
        status: 'skipped',
        required: false,
        durationMs: Date.now() - startedAt,
        detail: 'REDIS_URL/REDIS_SENTINELS not configured',
      };
    try {
      await withTimeout(Promise.resolve(client.ping()), timeoutMs());
      return {
        name: 'redis',
        status: 'ok',
        required: false,
        durationMs: Date.now() - startedAt,
        detail: 'PING succeeded',
      };
    } catch (error) {
      // Drop the cached client so the NEXT probe builds a fresh one. The shared
      // factory sets `retryStrategy: () => null` (deliberately — a health probe
      // must never queue or block on a dead dependency), which means a client
      // whose connection has closed will fail every subsequent PING with
      // "Connection is closed." forever. Without this reset a single transient
      // blip would pin the service to `degraded` until the process restarted,
      // long after Redis recovered — worse than no probe at all, because it
      // trains operators to ignore the signal. Verified against the live stack:
      // stop redis -> degraded, start redis -> ok again on the next poll.
      this.disposeRedis();
      return {
        name: 'redis',
        status: 'unhealthy',
        required: false,
        durationMs: Date.now() - startedAt,
        detail: safeDetail(error),
      };
    }
  }

  /** Disconnects and forgets the cached client so it is rebuilt on next use. */
  private disposeRedis(): void {
    const client = this.redis;
    this.redis = undefined;
    if (!client) return;
    try {
      client.disconnect();
    } catch {
      // Already closed; nothing to release.
    }
  }

  /**
   * Shared, lazily built client — the same resilient pattern as
   * PlatformMetricsService and the gateway limiter, so /health does not
   * introduce a second Redis connection style. Skipped entirely when Redis is
   * unconfigured, so a Redis-less development run reports `ok` rather than a
   * permanently `degraded` service.
   */
  private redisClient(): Redis | null {
    if (this.redis !== undefined) return this.redis;
    if (!process.env.REDIS_URL && !process.env.REDIS_SENTINELS) {
      this.redis = null;
      return this.redis;
    }
    try {
      this.redis = createRedisClient({
        lazyConnect: true,
        // Offline queueing must stay ON here, unlike the metrics exporter and the
        // gateway limiter. Those hold a long-lived connection and want a command
        // to fail instantly rather than wait. This client is rebuilt after every
        // failed probe, so its very next command is issued against a socket that
        // is still connecting: with the queue disabled that command is rejected
        // outright ("Stream isn't writeable and enableOfflineQueue options is
        // false") and the probe could never recover. Queueing lets the PING wait
        // for the handshake instead; withTimeout() still bounds the whole thing,
        // and retryStrategy below keeps a dead Redis from stalling us.
        enableOfflineQueue: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        retryStrategy: () => null,
      });
      // Swallow async connection errors emitted outside of a command call so an
      // unreachable Redis can never take the process down.
      this.redis.on('error', () => undefined);
    } catch {
      this.redis = null;
    }
    return this.redis;
  }

  onModuleDestroy(): void {
    this.disposeRedis();
  }
}
