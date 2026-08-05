import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, BulkSendService, BULK_SEND_MAX_RECIPIENTS } from './bulk-send.service';
import { parseMessageSchedule } from './message-scheduling';

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
   *
   * `scheduledAt` (ISO 8601) and `validityMinutes` schedule the whole campaign:
   * every recipient inherits them and each one's `send_sms` row carries the
   * corresponding `deferred` / `validity`. A past `scheduledAt`, or a validity
   * that would expire at or before it, is a 400. See message-scheduling.ts for
   * what deferral actually guarantees — on the `smsc = fake` bind, nothing.
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
      schedule: parseMessageSchedule(b),
    });
  }

  /**
   * Campaign grid. Accepts the shared grid vocabulary: `search`, `sort`
   * (`-createdAt`, `name`, `status`, ...), `filter.<field>`, `limit`/`offset`,
   * `?fields=`, and keyset pagination via `?cursor=` / `?paginate=cursor`.
   */
  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.service.listJobs(actor(r), q);
  }

  /**
   * CSV of the campaigns the grid would show for the SAME filters. Declared
   * before `:id` so the literal path wins the route match.
   */
  @Get('export.csv') @RequirePermissions('messages.view') async exportJobs(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    const exported = await this.service.exportJobsCsv(actor(r), q);
    sendCsv(response, exported);
  }

  @Get(':id') @RequirePermissions('messages.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.service.getJob(actor(r), uuid(id, 'id'));
  }

  /** Recipient grid for one campaign; same vocabulary as {@link list}. */
  @Get(':id/recipients') @RequirePermissions('messages.view') recipients(
    @Req() r: Request,
    @Param('id') id: string,
    @Query() q: any = {},
  ) {
    return this.service.listRecipients(actor(r), uuid(id, 'id'), q);
  }

  /** CSV of the recipients the grid would show for the SAME filters. */
  @Get(':id/recipients/export.csv') @RequirePermissions('messages.view') async exportRecipients(
    @Req() r: Request,
    @Param('id') id: string,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    const exported = await this.service.exportRecipientsCsv(actor(r), uuid(id, 'id'), q);
    sendCsv(response, exported);
  }
}

/** Shared CSV response shape, matching the message export's headers. */
function sendCsv(
  response: any,
  exported: { filename: string; rowCount: number; content: string },
): void {
  response.setHeader('content-type', 'text/csv; charset=utf-8');
  response.setHeader('content-disposition', `attachment; filename="${exported.filename}"`);
  response.setHeader('x-jkannel-export-row-count', String(exported.rowCount));
  response.send(exported.content);
}
