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
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor } from './message-send.service';
import { ScheduledSendService } from './scheduled-send.service';
import { scheduledSendMaxLatenessMs } from './message-scheduling';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const uuid = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  const id = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new BadRequestException(`${name} must be a UUID`);
  return id;
};

/**
 * Pending "send later" traffic: list it, cancel it, move it.
 *
 * This is the half of scheduling that a scheduler without it cannot honestly
 * offer — an operator who typed the wrong hour, or whose campaign is no longer
 * wanted, must be able to stop it. Reading requires `messages.view`; changing
 * anything requires `messages.send`, the same permission every other mutation
 * of in-flight traffic uses (queue reroute, spool cancel, resend).
 *
 * Tenant isolation is RLS, not a predicate: every statement runs inside
 * `tenantTransaction`, and `scheduled_messages` has FORCE ROW LEVEL SECURITY
 * (migration 042).
 *
 * A released message is GONE. Cancel and reschedule both answer 409 with the
 * reason once the hold has left `pending`, rather than reporting a success that
 * did not stop anything.
 */
@Controller('scheduled-messages')
@UseGuards(AuthGuard, PermissionsGuard)
export class ScheduledSendController {
  constructor(private readonly scheduling: ScheduledSendService) {}

  /**
   * Grid over held sends. Accepts the shared vocabulary: `search`, `sort`
   * (`scheduledAt`, `-createdAt`, `status`, ...), `filter.status`,
   * `filter.kind`, `limit`/`offset`, `?fields=`, and keyset pagination via
   * `?cursor=` / `?paginate=cursor`. Default sort is soonest-first, because the
   * question this endpoint answers is "what is about to go out".
   *
   * `?filter.status=pending` is the cancellable set. `releasing` rows are ones
   * a worker is mid-release on; `expired` rows were deliberately not sent
   * because they missed their window by more than the staleness ceiling.
   */
  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.scheduling.list(actor(r), q);
  }

  /**
   * The policy this deployment applies, so a console can show it rather than
   * hard-code a number that drifts from the server's configuration.
   */
  @Get('policy') @RequirePermissions('messages.view') policy() {
    const ceilingMs = scheduledSendMaxLatenessMs();
    return {
      maxLatenessMinutes: Math.round(ceilingMs / 60_000),
      maxLatenessMs: ceilingMs,
      behaviour:
        'A release later than its scheduled instant but within maxLatenessMinutes is sent and ' +
        'flagged released_late. Beyond that the message is marked expired and is NOT sent, ' +
        'because an SMS delivered far outside its window can be worse than one never delivered.',
      configuredBy: 'SCHEDULED_SEND_MAX_LATENESS_MINUTES',
    };
  }

  @Get(':id') @RequirePermissions('messages.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.scheduling.get(actor(r), uuid(id, 'id'));
  }

  /** Cancels a hold that has not been released. 409 once it has. */
  @Post(':id/cancel') @RequirePermissions('messages.send') cancel(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const reason = b?.reason;
    if (reason !== undefined && reason !== null && typeof reason !== 'string')
      throw new BadRequestException('reason must be a string when provided');
    return this.scheduling.cancel(actor(r), uuid(id, 'id'), reason);
  }

  /**
   * Moves a hold to a new instant. `scheduledAt` is ISO 8601 with an offset and
   * is validated by the same parser `POST /messages` uses, so the past-instant
   * rule (with its 60s grace), the 365-day ceiling and the "validity would
   * expire before delivery" rule all apply identically here.
   */
  @Post(':id/reschedule') @RequirePermissions('messages.send') reschedule(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    if (b?.scheduledAt === undefined || b?.scheduledAt === null || b?.scheduledAt === '')
      throw new BadRequestException('scheduledAt is required');
    return this.scheduling.reschedule(actor(r), uuid(id, 'id'), b.scheduledAt);
  }
}
