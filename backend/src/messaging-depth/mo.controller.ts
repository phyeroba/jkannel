import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor } from './message-send.service';
import { MoInboundService } from './mo-inbound.service';
import { MoRulesService } from './mo-rules.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuid = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim()))
    throw new BadRequestException(`${name} must be a UUID`);
  return value.trim();
};

const requiredText = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value;
};

/**
 * INBOUND (MO) ROUTING AND FAN-OUT.
 *
 * `messages.view` reads; `messages.send` mutates and ingests. Ingest is a
 * mutation of traffic state and it can cause outbound SMS to be sent (an `sms`
 * fan-out destination), so it is deliberately NOT a view-level operation.
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON `POST /mo/inbound`, WHICH IS THE PUSH PATH
 * ---------------------------------------------------------------------------
 * This is the endpoint a Kannel `sms-service` with `post-url` would call. As
 * shipped, NOTHING CALLS IT: the deployed `kamex.conf` and the configuration
 * builder both emit a single `sms-service` group with `text = "No service
 * specified"` and no callback URL at all. Wiring it up is an
 * `infrastructure/`-side change that is not made here.
 *
 * That is exactly why the ENGINE SWEEP (`POST /mo/ingest/sweep`, and the
 * `mo.ingest.poll` job behind `POST /mo/ingest/polling`) exists and is the
 * primary path: it reads the MO rows SQLBox already writes, so fan-out works on
 * the topology that is deployed today without a Kannel change.
 */
@Controller('mo')
@UseGuards(AuthGuard, PermissionsGuard)
export class MoController {
  constructor(
    private readonly rules: MoRulesService,
    private readonly inbound: MoInboundService,
  ) {}

  // ---- rules ---------------------------------------------------------------

  /** Grid over MO routing rules, in evaluation order by default. */
  @Get('rules') @RequirePermissions('messages.view') listRules(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.rules.list(actor(r), q);
  }

  /** What would happen to this inbound message? Same matcher the ingest uses. */
  @Post('rules/preview') @RequirePermissions('messages.view') preview(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.rules.preview(actor(r), {
      smscId: typeof b.smscId === 'string' && b.smscId.trim() ? b.smscId.trim() : null,
      sender: requiredText(b.sender, 'sender'),
      receiver: requiredText(b.receiver, 'receiver'),
      body: typeof b.text === 'string' ? b.text : typeof b.body === 'string' ? b.body : '',
    });
  }

  @Get('rules/:id') @RequirePermissions('messages.view') getRule(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.rules.get(actor(r), uuid(id, 'id'));
  }

  @Post('rules') @RequirePermissions('messages.send') createRule(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.rules.create(actor(r), b ?? {});
  }

  @Patch('rules/:id') @RequirePermissions('messages.send') updateRule(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.rules.update(actor(r), uuid(id, 'id'), b ?? {});
  }

  @Delete('rules/:id') @RequirePermissions('messages.send') async removeRule(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    await this.rules.remove(actor(r), uuid(id, 'id'));
    return { removed: true, id };
  }

  // ---- destinations --------------------------------------------------------

  @Post('rules/:id/destinations') @RequirePermissions('messages.send') addDestination(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.rules.addDestination(actor(r), uuid(id, 'id'), {
      kind: b.kind,
      target: b.target,
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      config: b.config ?? {},
      maxAttempts: b.maxAttempts,
    });
  }

  @Delete('rules/:id/destinations/:destinationId')
  @RequirePermissions('messages.send')
  async removeDestination(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('destinationId') destinationId: string,
  ) {
    await this.rules.removeDestination(
      actor(r),
      uuid(id, 'id'),
      uuid(destinationId, 'destinationId'),
    );
    return { removed: true, id: destinationId };
  }

  // ---- ingest --------------------------------------------------------------

  /**
   * Push ingest. Idempotent on `externalRef`: the same inbound message
   * submitted twice produces one record and one fan-out, and the second call
   * answers `duplicate: true` rather than silently duplicating every webhook.
   */
  @Post('inbound') @RequirePermissions('messages.send') ingest(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    let receivedAt: Date | null = null;
    if (b.receivedAt) {
      receivedAt = new Date(String(b.receivedAt));
      if (Number.isNaN(receivedAt.getTime()))
        throw new BadRequestException('receivedAt must be an ISO 8601 timestamp');
    }
    return this.inbound.ingest(actor(r), {
      sender: requiredText(b.sender, 'sender'),
      receiver: requiredText(b.receiver, 'receiver'),
      text: typeof b.text === 'string' ? b.text : typeof b.body === 'string' ? b.body : '',
      smscId: typeof b.smscId === 'string' && b.smscId.trim() ? b.smscId.trim() : null,
      externalRef: b.externalRef ?? b.messageId ?? null,
      receivedAt,
    });
  }

  /** Watermark, polling state and the last sweep's outcome. */
  @Get('ingest/status') @RequirePermissions('messages.view') ingestStatus(@Req() r: Request) {
    return this.inbound.status(actor(r));
  }

  /** Runs one engine sweep now. */
  @Post('ingest/sweep') @RequirePermissions('messages.send') sweep(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.inbound.sweep(actor(r), { limit: b?.limit });
  }

  /** Turns continuous sweeping on or off (the job queue is the timer). */
  @Post('ingest/polling') @RequirePermissions('messages.send') polling(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    if (typeof b?.enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean');
    return this.inbound.setPolling(actor(r), b.enabled, b.pollIntervalSeconds);
  }

  // ---- observation ---------------------------------------------------------

  /** Grid over received inbound messages, including the ones that matched NOTHING. */
  @Get('messages') @RequirePermissions('messages.view') listMessages(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.inbound.listMessages(actor(r), q);
  }

  @Get('messages/:id') @RequirePermissions('messages.view') getMessage(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.inbound.getMessage(actor(r), uuid(id, 'id'));
  }

  /** Grid over individual fan-out delivery attempts and their outcomes. */
  @Get('deliveries') @RequirePermissions('messages.view') listDeliveries(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.inbound.listDeliveries(actor(r), q);
  }

  /** Re-queues one failed or dead-lettered delivery. */
  @Post('deliveries/:id/retry') @RequirePermissions('messages.send') retry(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.inbound.retryDelivery(actor(r), uuid(id, 'id'));
  }
}
