import { Injectable } from '@nestjs/common';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: string;
  correlationId?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  username?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  clientIp?: string;
  trace?: string;
}

export interface LogQuery {
  correlationId?: string;
  requestId?: string;
  level?: string;
  /** Minimum severity; 'warn' returns warn + error + fatal. */
  minLevel?: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  contains?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface LogQueryResult {
  items: LogEntry[];
  /** Entries matching the filter (before `limit` was applied). */
  matched: number;
  /** Entries currently held in the buffer. */
  stored: number;
  capacity: number;
  /** Entries evicted since boot because the buffer wrapped. */
  dropped: number;
  oldest: string | null;
  newest: string | null;
  /** Always false. This buffer is process memory, not a log store. */
  durable: false;
  scope: 'process';
  notice: string;
}

export const LOG_LEVELS: Readonly<Record<string, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const DEFAULT_CAPACITY = 1000;
const MAX_CAPACITY = 20_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const NOTICE =
  'In-memory ring buffer: newest-first, capped, and local to THIS process only. ' +
  'It is not durable — entries are lost on restart, are not shared between replicas, ' +
  'and older lines are evicted once the buffer wraps. Ship stdout to a log store for retention.';

/**
 * A bounded, newest-first ring buffer of the log lines this process emitted.
 *
 * The platform logs JSON to stdout and nowhere else, so there was no way for an
 * operator to answer "show me everything for correlation id X". Rather than
 * pretend to a durability we do not have, this keeps the last N lines in memory
 * and every response says exactly that: one process, no persistence, evicting.
 *
 * The instance is shared via {@link sharedLogBuffer} because JsonLogger is
 * constructed outside Nest's injector (main.ts passes it to NestFactory before
 * the container exists), while the query controller is injected normally.
 */
@Injectable()
export class LogBufferService {
  private readonly entries: LogEntry[] = [];
  private dropped = 0;

  constructor(readonly capacity: number = LogBufferService.configuredCapacity()) {}

  static configuredCapacity(): number {
    const configured = Number(process.env.LOG_BUFFER_SIZE);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_CAPACITY;
    return Math.min(Math.floor(configured), MAX_CAPACITY);
  }

  /** Appends an entry, evicting the oldest once capacity is reached. */
  push(entry: LogEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
      this.dropped += 1;
    }
  }

  /** Test/ops helper: empties the buffer and resets the eviction counter. */
  clear(): void {
    this.entries.length = 0;
    this.dropped = 0;
  }

  size(): number {
    return this.entries.length;
  }

  query(filter: LogQuery = {}): LogQueryResult {
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const minRank = filter.minLevel ? (LOG_LEVELS[filter.minLevel.toLowerCase()] ?? 0) : 0;
    const since = filter.since ? Date.parse(filter.since) : undefined;
    const until = filter.until ? Date.parse(filter.until) : undefined;
    const contains = filter.contains?.toLowerCase();

    const matches = this.entries.filter((entry) => {
      if (filter.correlationId && entry.correlationId !== filter.correlationId) return false;
      if (filter.requestId && entry.requestId !== filter.requestId) return false;
      if (filter.level && entry.level !== filter.level.toLowerCase()) return false;
      if (minRank && (LOG_LEVELS[entry.level] ?? 0) < minRank) return false;
      if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
      if (filter.userId && entry.userId !== filter.userId) return false;
      if (filter.route && !(entry.route ?? '').includes(filter.route)) return false;
      if (contains && !entry.message.toLowerCase().includes(contains)) return false;
      const at = Date.parse(entry.timestamp);
      if (since !== undefined && !Number.isNaN(since) && at < since) return false;
      if (until !== undefined && !Number.isNaN(until) && at > until) return false;
      return true;
    });

    // Newest first: the operator asking this question wants the last thing that
    // happened, not the first thing still in memory.
    const items = matches.slice(-limit).reverse();
    return {
      items,
      matched: matches.length,
      stored: this.entries.length,
      capacity: this.capacity,
      dropped: this.dropped,
      oldest: this.entries[0]?.timestamp ?? null,
      newest: this.entries.at(-1)?.timestamp ?? null,
      durable: false,
      scope: 'process',
      notice: NOTICE,
    };
  }
}

let shared: LogBufferService | undefined;

/** The process-wide buffer both JsonLogger and the query endpoint use. */
export function sharedLogBuffer(): LogBufferService {
  return (shared ??= new LogBufferService());
}
