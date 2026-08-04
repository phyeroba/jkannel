import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { isKnownStatusToken } from '../engine/kamex-sqlbox.repository';
import { parseInstant } from '../messaging-depth/message-filters';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, BindOperation, HistoryQuery, QueueConsoleService } from './queue-console.service';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/** Upper bound on a single reroute/cancel/resend batch, so one call cannot lock the spool. */
const MAX_BATCH = 500;

function boundedInt(value: unknown, name: string, min: number, max: number, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be a string`);
  const text = value.trim();
  if (text.length > 256) throw new BadRequestException(`${name} is too long`);
  return text || undefined;
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value, name);
  if (!text) throw new BadRequestException(`${name} is required`);
  return text;
}

/** Parses a batch of `sql_id` values: positive integers, deduplicated, bounded. */
function parseSqlIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length)
    throw new BadRequestException('sqlIds must be a non-empty array');
  if (value.length > MAX_BATCH)
    throw new BadRequestException(`sqlIds may not contain more than ${MAX_BATCH} entries`);
  const ids = value.map((entry) => {
    const parsed = typeof entry === 'string' ? Number(entry.trim()) : entry;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1)
      throw new BadRequestException('sqlIds must contain positive integers');
    return parsed;
  });
  return [...new Set(ids)];
}

/** Parses a batch of history identifiers (sql_id or foreign_id), which are opaque strings. */
function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length)
    throw new BadRequestException('ids must be a non-empty array');
  if (value.length > MAX_BATCH)
    throw new BadRequestException(`ids may not contain more than ${MAX_BATCH} entries`);
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' && typeof entry !== 'number')
      throw new BadRequestException('ids must contain strings');
    const id = String(entry).trim();
    if (!id) throw new BadRequestException('ids must not contain empty values');
    if (id.length > 128) throw new BadRequestException('ids must not exceed 128 characters');
    return id;
  });
  return [...new Set(ids)];
}

/**
 * Validates a delivery-status expression. Rejecting unknown tokens is
 * deliberate: silently ignoring a typo like `faield` would quietly resend
 * everything instead of the failures.
 */
function parseStatus(value: unknown): string | undefined {
  const status = optionalText(value, 'status');
  if (!status) return undefined;
  const unknown = status
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token && !isKnownStatusToken(token));
  if (unknown.length) throw new BadRequestException(`unknown status: ${unknown.join(', ')}`);
  return status;
}

function parseHistoryQuery(source: any = {}): HistoryQuery {
  // Same ISO 8601 parser and the same inverted-range refusal as GET /messages,
  // so the two message logs cannot disagree about what a date range means.
  const fromEpoch = parseInstant(source.from, 'from');
  const toEpoch = parseInstant(source.to, 'to');
  if (fromEpoch !== undefined && toEpoch !== undefined && fromEpoch > toEpoch)
    throw new BadRequestException(
      `from must not be after to (from="${String(source.from).trim()}", to="${String(source.to).trim()}")`,
    );
  return {
    limit: boundedInt(source.limit, 'limit', 1, MAX_BATCH, 100),
    cursor: source.cursor
      ? boundedInt(source.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER, 0)
      : undefined,
    smscId: optionalText(source.smscId, 'smscId'),
    query: optionalText(source.query, 'query'),
    status: parseStatus(source.status),
    fromEpoch,
    toEpoch,
  };
}

function parseOperation(value: unknown): BindOperation {
  if (value === 'enable' || value === 'disable' || value === 'reconnect') return value;
  throw new BadRequestException('operation must be one of enable, disable, reconnect');
}

/**
 * Live message-queue console: read the live queue state and reroute traffic to a
 * different SMPP bind without restarting the engine.
 *
 * Reroute/cancel act on the SQLBox spool (`send_sms`), which is individually
 * addressable, so they take effect on SQLBox's next poll with no restart.
 * Messages already handed to bearerbox are not individually addressable — see
 * the bind control endpoint for the workaround.
 */
@Controller('queue-console')
@UseGuards(AuthGuard, PermissionsGuard)
export class QueueConsoleController {
  constructor(private readonly queue: QueueConsoleService) {}

  /** Engine totals, the tenant's binds and the spool backlog in one poll. */
  @Get('live') @RequirePermissions('messages.view') live(@Req() r: Request) {
    return this.queue.live(actor(r));
  }

  @Get('spool') @RequirePermissions('messages.view') spool(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.queue.spool(actor(r), {
      limit: boundedInt(q.limit, 'limit', 1, 500, 100),
      cursor: q.cursor ? boundedInt(q.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER, 0) : undefined,
      smscId: optionalText(q.smscId, 'smscId'),
      query: optionalText(q.query, 'query'),
    });
  }

  /** Repoints spooled messages at another bind. No engine restart. */
  @Post('spool/reroute') @RequirePermissions('messages.send') reroute(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.queue.reroute(actor(r), {
      sqlIds: parseSqlIds(b?.sqlIds),
      targetSmscId: requiredText(b?.targetSmscId, 'targetSmscId'),
    });
  }

  @Post('spool/cancel') @RequirePermissions('messages.send') cancel(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.queue.cancel(actor(r), parseSqlIds(b?.sqlIds));
  }

  /**
   * The message log classified by real delivery outcome (delivered / failed /
   * rejected / buffered / accepted / pending / unknown), filterable by status
   * or by the `resendable` and `in-flight` groups, with counts for the whole
   * filtered scope. Feed the selected ids straight into POST resend.
   */
  @Get('history') @RequirePermissions('messages.view') history(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.queue.history(actor(r), parseHistoryQuery(q));
  }

  /**
   * Submits new spool rows for already-sent messages, against another bind.
   * Either `ids` (explicit) or `filter` (delivery-status selection, defaulting
   * to `resendable` = failed + rejected).
   */
  @Post('resend') @RequirePermissions('messages.send') resend(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const targetSmscId = requiredText(b?.targetSmscId, 'targetSmscId');
    if (b?.ids !== undefined && b?.filter !== undefined)
      throw new BadRequestException('provide either ids or filter, not both');
    if (b?.ids !== undefined)
      return this.queue.resend(actor(r), { ids: parseIds(b.ids), targetSmscId });
    return this.queue.resend(actor(r), {
      filter: parseHistoryQuery({ limit: MAX_BATCH, ...(b?.filter ?? {}) }),
      targetSmscId,
    });
  }

  /** Stop / start / reconnect a single bind; bearerbox itself keeps running. */
  @Post('binds/:engineId/control') @RequirePermissions('smsc.manage') control(
    @Req() r: Request,
    @Param('engineId') engineId: string,
    @Body() b: any = {},
  ) {
    return this.queue.controlBind(
      actor(r),
      requiredText(engineId, 'engineId'),
      parseOperation(b?.operation),
    );
  }
}
