import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { BlocklistType, MessageBlocklistService } from './message-blocklist.service';

type Request = AuthenticatedRequest;
const actor = (r: Request) => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const LIST_TYPES: BlocklistType[] = ['blacklist', 'whitelist', 'dnd'];

const uuid = (value: unknown, name: string): string => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new BadRequestException(`${name} must be a UUID`);
  return value;
};

const optionalUuid = (value: unknown, name: string): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : uuid(value, name);

const listType = (value: unknown, required: boolean): BlocklistType | undefined => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException(`listType must be one of ${LIST_TYPES.join(', ')}`);
    return undefined;
  }
  if (!LIST_TYPES.includes(value as BlocklistType))
    throw new BadRequestException(`listType must be one of ${LIST_TYPES.join(', ')}`);
  return value as BlocklistType;
};

/**
 * Recipient policy administration: the blacklist / whitelist / DND list the
 * send path evaluates before choosing a route (migration 032). Reuses the
 * existing messages.view / messages.send permissions rather than inventing
 * codes nothing would seed.
 */
@Controller('messaging/blocklist')
@UseGuards(AuthGuard, PermissionsGuard)
export class MessagingPolicyController {
  constructor(private readonly blocklist: MessageBlocklistService) {}

  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.blocklist.list(actor(r), {
      listType: listType(q.listType, false),
      customerId: optionalUuid(q.customerId, 'customerId') ?? null,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** Would this destination be accepted right now, and if not, why? */
  @Get('check') @RequirePermissions('messages.view') check(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    if (typeof q.msisdn !== 'string' || !q.msisdn.trim())
      throw new BadRequestException('msisdn is required');
    return this.blocklist.evaluate(
      actor(r),
      q.msisdn,
      optionalUuid(q.customerId, 'customerId') ?? null,
    );
  }

  @Post() @RequirePermissions('messages.send') add(@Req() r: Request, @Body() b: any = {}) {
    if (typeof b.msisdn !== 'string' || !b.msisdn.trim())
      throw new BadRequestException('msisdn is required');
    let expiresAt: Date | null = null;
    if (b.expiresAt) {
      expiresAt = new Date(String(b.expiresAt));
      if (Number.isNaN(expiresAt.getTime()))
        throw new BadRequestException('expiresAt must be an ISO timestamp');
    }
    return this.blocklist.add(actor(r), {
      listType: listType(b.listType, true) as BlocklistType,
      msisdn: b.msisdn,
      customerId: optionalUuid(b.customerId, 'customerId') ?? null,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
      source: typeof b.source === 'string' ? b.source : undefined,
      expiresAt,
    });
  }

  @Delete(':id') @RequirePermissions('messages.send') async remove(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    await this.blocklist.remove(actor(r), uuid(id, 'id'));
    return { removed: true, id };
  }
}
