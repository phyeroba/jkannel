import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { LOG_LEVELS, LOG_SORT_FIELDS, LogBufferService, LogQuery } from './log-buffer';
import { DurableLogService } from './durable-log.service';

const isoOrThrow = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (Number.isNaN(Date.parse(text)))
    throw new BadRequestException(`${name} must be an ISO timestamp`);
  return text;
};

const levelOrThrow = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).toLowerCase();
  if (!(text in LOG_LEVELS))
    throw new BadRequestException(`${name} must be one of ${Object.keys(LOG_LEVELS).join(', ')}`);
  return text;
};

/**
 * Log explorer over the process-local ring buffer.
 *
 * Search by correlation id, request id, level, tenant, route, substring, and
 * time window. `GET /observability/logs?correlationId=…` is the "trace this
 * incident" query the platform previously had no answer for.
 *
 * The honest limit is stated in every response body (`durable: false`,
 * `scope: 'process'`, plus a `notice`): this reads memory in one API process.
 * It is not a log store, it does not survive a restart, it does not see other
 * replicas, and it evicts the oldest lines once `LOG_BUFFER_SIZE` is exceeded.
 * Stdout remains the durable path — ship it somewhere that keeps it.
 */
/** A sort column, or undefined for the default. Named values only. */
const sortOrThrow = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!(LOG_SORT_FIELDS as readonly string[]).includes(text))
    throw new BadRequestException(`sort must be one of ${LOG_SORT_FIELDS.join(', ')}`);
  return text as (typeof LOG_SORT_FIELDS)[number];
};

const directionOrThrow = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'asc' && value !== 'desc')
    throw new BadRequestException('direction must be asc or desc');
  return value;
};

@Controller('observability/logs')
@UseGuards(AuthGuard, PermissionsGuard)
export class LogsController {
  constructor(
    private readonly buffer: LogBufferService,
    private readonly durable: DurableLogService,
  ) {}

  @Get()
  @RequirePermissions('system.view')
  async search(@Query() q: Record<string, string> = {}) {
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
      throw new BadRequestException('limit must be a positive number');
    // Zero is valid here and `limit`'s rule is not: page one is offset 0.
    const offset = q.offset === undefined ? undefined : Number(q.offset);
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0))
      throw new BadRequestException('offset must be zero or a positive number');
    const filter: LogQuery = {
      correlationId: q.correlationId || undefined,
      requestId: q.requestId || undefined,
      level: levelOrThrow(q.level, 'level'),
      minLevel: levelOrThrow(q.minLevel, 'minLevel'),
      tenantId: q.tenantId || undefined,
      userId: q.userId || undefined,
      route: q.route || undefined,
      contains: q.contains || undefined,
      since: isoOrThrow(q.since, 'since'),
      until: isoOrThrow(q.until, 'until'),
      limit,
      offset,
      sort: sortOrThrow(q.sort),
      direction: directionOrThrow(q.direction),
    };
    /*
     * `?source=durable` reads the `log_entries` table instead of the ring
     * buffer. Opt-in rather than the default, because the two sources answer
     * different questions and silently switching would be worse than either:
     *
     *   ring buffer  every level, this process only, lost on restart
     *   durable      warn and above, every process, survives a restart
     *
     * A caller looking for an info line would find nothing in the durable store
     * and reasonably conclude it never happened. So the response states which
     * source answered and what that source does not contain.
     */
    if (q.source === 'durable') {
      const { items, matched } = await this.durable.query(filter);
      const stats = await this.durable.stats();
      return {
        items,
        matched,
        durable: stats.durable,
        scope: 'deployment',
        source: 'log_entries',
        levels: stats.levels,
        notice: stats.durable
          ? `Durable store: ${stats.levels.join(', ')} only, kept ${stats.retentionDays} days. ` +
            'Info and debug are not here — query the ring buffer for those.'
          : 'The durable log table is not present in this deployment; nothing is stored.',
      };
    }
    return this.buffer.query(filter);
  }

  /** Buffer health, and the durable store's, so one call answers both. */
  @Get('stats')
  @RequirePermissions('system.view')
  async stats() {
    const { items: _items, ...rest } = this.buffer.query({ limit: 1 });
    return { ...rest, durableStore: await this.durable.stats() };
  }
}
