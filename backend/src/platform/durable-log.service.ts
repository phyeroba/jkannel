import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LogEntry, LogQuery, sharedLogBuffer } from './log-buffer';
import { registerDurableSink } from './json.logger';

/**
 * DURABLE STORAGE FOR WARN AND ABOVE.
 *
 * `GET /observability/logs` has always read a 1000-line in-memory ring buffer:
 * lost on restart, one replica's view, and evicting silently. The line an
 * incident needs is very often the one that was evicted.
 *
 * This persists warn, error and fatal to `log_entries`. Info and debug stay in
 * the ring buffer, where their volume belongs — a control plane emits an access
 * line per request and storing those in Postgres would make the table the
 * biggest thing in the database within a week.
 *
 * THREE RULES THIS FILE EXISTS TO OBEY
 * ---------------------------------------------------------------------------
 * 1. IT MUST NEVER THROW INTO THE LOGGER. A logger that can fail is worse than
 *    no logger: the failure surfaces as an unrelated 500 in whatever code
 *    happened to be logging. Every path here swallows, and the ring buffer
 *    still has the line regardless.
 *
 * 2. IT MUST NEVER BLOCK THE REQUEST. Writing a row inline would put a database
 *    round trip inside the error path of every failing request — precisely when
 *    the database may be the thing that is unwell. Lines are queued in memory
 *    and flushed on a timer, in one multi-row INSERT.
 *
 * 3. IT MUST BOUND ITS OWN MEMORY. If the database is unreachable the queue
 *    would otherwise grow until the process dies — turning "logs are not being
 *    stored" into "the API fell over", which is a strictly worse outcome. The
 *    queue is capped and drops OLDEST first, counting what it dropped so the
 *    gap is visible rather than silent.
 */
const PERSISTED_LEVELS = new Set(['warn', 'error', 'fatal']);
const FLUSH_INTERVAL_MS = Number(process.env.LOG_STORE_FLUSH_MS ?? 2000);
const MAX_QUEUE = Number(process.env.LOG_STORE_MAX_QUEUE ?? 5000);
const BATCH = 200;
/** Columns that have their own field; everything else goes to `fields`. */
const OWN_COLUMNS = new Set([
  'timestamp',
  'level',
  'message',
  'context',
  'correlationId',
  'requestId',
  'tenantId',
  'userId',
  'username',
  'method',
  'route',
  'status',
  'durationMs',
  'clientIp',
  'trace',
]);

export function isPersistedLevel(level: string): boolean {
  return PERSISTED_LEVELS.has(String(level).toLowerCase());
}

@Injectable()
export class DurableLogService implements OnModuleInit, OnModuleDestroy {
  private queue: LogEntry[] = [];
  private dropped = 0;
  private written = 0;
  private lastError: string | null = null;
  private timer?: NodeJS.Timeout;
  private available = false;

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    // Probe once at boot. A deployment whose migration has not run yet must
    // degrade to the ring buffer rather than log an error per line about being
    // unable to log.
    this.available = await this.tableExists();
    registerDurableSink((entry) => this.accept(entry));
    if (this.available) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Best effort: a clean shutdown should not lose the last two seconds.
    await this.flush();
  }

  /** Called from the logger. Synchronous, non-throwing, and never awaited. */
  accept(entry: LogEntry): void {
    if (!this.available || !isPersistedLevel(entry.level)) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(entry);
  }

  async flush(): Promise<void> {
    if (!this.available || !this.queue.length) return;
    const batch = this.queue.splice(0, BATCH);
    try {
      await this.insert(batch);
      this.written += batch.length;
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error)?.message ?? String(error);
      // The rows are NOT put back. Retrying a batch that failed for a reason
      // that will not change (a bad value, a dropped column) would retry it
      // forever and block every line behind it. They are counted as dropped,
      // which is visible in `stats`.
      this.dropped += batch.length;
    }
  }

  private async insert(batch: LogEntry[]): Promise<void> {
    const columns = [
      'occurred_at',
      'level',
      'message',
      'context',
      'correlation_id',
      'request_id',
      'tenant_id',
      'user_id',
      'username',
      'method',
      'route',
      'status',
      'duration_ms',
      'client_ip',
      'trace',
      'fields',
    ];
    const values: unknown[] = [];
    const tuples = batch.map((entry, row) => {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry))
        if (!OWN_COLUMNS.has(key)) extra[key] = value;
      values.push(
        entry.timestamp,
        String(entry.level).toLowerCase(),
        entry.message,
        entry.context ?? null,
        entry.correlationId ?? null,
        entry.requestId ?? null,
        entry.tenantId ?? null,
        entry.userId ?? null,
        entry.username ?? null,
        entry.method ?? null,
        entry.route ?? null,
        entry.status ?? null,
        entry.durationMs ?? null,
        entry.clientIp ?? null,
        entry.trace ?? null,
        JSON.stringify(extra),
      );
      const base = row * columns.length;
      return `(${columns.map((_, i) => `$${base + i + 1}`).join(',')})`;
    });
    await this.database.query(
      `INSERT INTO log_entries(${columns.join(',')}) VALUES ${tuples.join(',')}`,
      values,
    );
  }

  /**
   * Read the durable store. Mirrors {@link LogBufferService.query}'s filters so
   * the console can point the same controls at either source.
   */
  async query(filter: LogQuery = {}): Promise<{ items: LogEntry[]; matched: number }> {
    if (!this.available) return { items: [], matched: 0 };
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.correlationId) add('correlation_id = ?', filter.correlationId);
    if (filter.requestId) add('request_id = ?', filter.requestId);
    if (filter.level) add('level = ?', filter.level.toLowerCase());
    if (filter.tenantId) add('tenant_id = ?', filter.tenantId);
    if (filter.userId) add('user_id = ?', filter.userId);
    if (filter.route) add('route ILIKE ?', `%${filter.route}%`);
    if (filter.contains) add('message ILIKE ?', `%${filter.contains}%`);
    if (filter.since) add('occurred_at >= ?', filter.since);
    if (filter.until) add('occurred_at <= ?', filter.until);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 1000);
    const offset = Math.max(Math.floor(filter.offset ?? 0), 0);

    const counted = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM log_entries ${clause}`,
      params,
    );
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT occurred_at,level,message,context,correlation_id,request_id,tenant_id,user_id,
              username,method,route,status,duration_ms,client_ip,trace,fields
         FROM log_entries ${clause}
        ORDER BY occurred_at ${filter.direction === 'asc' ? 'ASC' : 'DESC'}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      matched: Number(counted.rows[0]?.count ?? 0),
      items: rows.rows.map((row) => this.toEntry(row)),
    };
  }

  private toEntry(row: Record<string, unknown>): LogEntry {
    const fields = (row.fields ?? {}) as Record<string, unknown>;
    const at = row.occurred_at;
    return {
      timestamp: at instanceof Date ? at.toISOString() : String(at),
      level: String(row.level),
      message: String(row.message),
      context: (row.context as string) ?? undefined,
      correlationId: (row.correlation_id as string) ?? undefined,
      requestId: (row.request_id as string) ?? undefined,
      tenantId: (row.tenant_id as string) ?? undefined,
      userId: (row.user_id as string) ?? undefined,
      username: (row.username as string) ?? undefined,
      method: (row.method as string) ?? undefined,
      route: (row.route as string) ?? undefined,
      status: (row.status as number) ?? undefined,
      durationMs: (row.duration_ms as number) ?? undefined,
      clientIp: (row.client_ip as string) ?? undefined,
      trace: (row.trace as string) ?? undefined,
      ...fields,
    };
  }

  /** Delete lines older than the retention window. Returns rows removed. */
  async prune(days = Number(process.env.LOG_STORE_RETENTION_DAYS ?? 30)): Promise<number> {
    if (!this.available) return 0;
    const result = await this.database.query(
      `DELETE FROM log_entries WHERE occurred_at < now() - ($1 || ' days')::interval`,
      [String(Math.max(1, Math.floor(days)))],
    );
    return result.rowCount ?? 0;
  }

  async stats() {
    const ring = sharedLogBuffer().query({ limit: 1 });
    let stored = 0;
    let oldest: string | null = null;
    if (this.available) {
      try {
        const row = (
          await this.database.query<{ count: string; oldest: Date | null }>(
            'SELECT count(*)::text AS count, min(occurred_at) AS oldest FROM log_entries',
          )
        ).rows[0];
        stored = Number(row?.count ?? 0);
        oldest = row?.oldest ? new Date(row.oldest).toISOString() : null;
      } catch {
        // stats must not fail the endpoint
      }
    }
    return {
      durable: this.available,
      levels: [...PERSISTED_LEVELS],
      stored,
      oldest,
      queued: this.queue.length,
      written: this.written,
      dropped: this.dropped,
      lastError: this.lastError,
      retentionDays: Number(process.env.LOG_STORE_RETENTION_DAYS ?? 30),
      ringBuffer: { stored: ring.stored, capacity: ring.capacity, dropped: ring.dropped },
    };
  }

  private async tableExists(): Promise<boolean> {
    try {
      const result = await this.database.query<{ ok: boolean }>(
        `SELECT to_regclass('public.log_entries') IS NOT NULL AS ok`,
      );
      return result.rows[0]?.ok === true;
    } catch {
      return false;
    }
  }
}
