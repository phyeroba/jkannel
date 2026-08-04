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
import { Actor, BulkSendService, BULK_SEND_MAX_RECIPIENTS } from './bulk-send.service';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const uuid = (value: unknown, name: string): string => {
  const x = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))
    throw new BadRequestException(`${name} must be a UUID`);
  return x;
};

/** Validates and normalises the recipient list. */
function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequestException('recipients must be a non-empty array');
  if (value.length > BULK_SEND_MAX_RECIPIENTS)
    throw new BadRequestException(
      `recipients exceeds the maximum of ${BULK_SEND_MAX_RECIPIENTS} per job`,
    );
  return value.map((raw, index) => {
    if (typeof raw !== 'string' || !raw.trim())
      throw new BadRequestException(`recipients[${index}] must be a non-empty string`);
    const receiver = raw.trim();
    if (!/^\+?[0-9]{3,20}$/.test(receiver))
      throw new BadRequestException(`recipients[${index}] must be an E.164-like address`);
    return receiver;
  });
}

/**
 * Bulk send / campaign jobs. Creating a job requires configuration.manage
 * (matching the single-message submit); reading jobs and recipients requires
 * messages.view.
 */
@Controller('bulk-send')
@UseGuards(AuthGuard, PermissionsGuard)
export class BulkSendController {
  constructor(private readonly service: BulkSendService) {}

  /**
   * `smscId` is now OPTIONAL: omit it and the routing engine picks the bind for
   * each recipient at dispatch time, honouring route configuration, deployment
   * state and live bind health. `customerId` attributes the campaign so its
   * quota, credit, sender IDs and route bindings are enforced per message.
   */
  @Post() @RequirePermissions('configuration.manage') create(@Req() r: Request, @Body() b: any) {
    return this.service.createJob(actor(r), {
      name: text(b?.name, 'name'),
      smscId: optionalText(b?.smscId),
      message: text(b?.message, 'message'),
      recipients: parseRecipients(b?.recipients),
      sender: optionalText(b?.sender),
      customerId:
        b?.customerId === undefined || b?.customerId === null || b?.customerId === ''
          ? undefined
          : uuid(b.customerId, 'customerId'),
    });
  }

  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.service.listJobs(actor(r), q);
  }

  @Get(':id') @RequirePermissions('messages.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.service.getJob(actor(r), uuid(id, 'id'));
  }

  @Get(':id/recipients') @RequirePermissions('messages.view') recipients(
    @Req() r: Request,
    @Param('id') id: string,
    @Query() q: any = {},
  ) {
    return this.service.listRecipients(actor(r), uuid(id, 'id'), q);
  }
}
