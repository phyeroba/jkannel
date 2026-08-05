import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor } from '../messaging-depth/message-send.service';
import { DeliveryRetryService } from './delivery-retry.service';
import { DELIVERY_RETRY_DEFAULTS, parsePolicyInput } from './delivery-retry.policy';

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

/**
 * RESEND ON DELIVERY FAILURE — read it, and configure it.
 *
 * `messages.view` reads; `messages.send` changes anything. Saving a policy is
 * deliberately a `messages.send` operation and not a view-level one: switching
 * retrying on causes outbound SMS to be sent and the customer's credit to be
 * spent, which is the same class of act as submitting a message.
 *
 * ROUTE ORDER IS LOAD-BEARING. `attempts`, `policies`, `status`, `scan` and
 * `effective-policy` are declared before `:id`, because Nest matches in
 * declaration order and `/delivery-retries/policies` would otherwise be read as
 * a chain id and answered with a 400.
 *
 * Tenant isolation is RLS rather than a predicate: every statement behind these
 * routes runs inside `tenantTransaction`, and all four tables carry FORCE ROW
 * LEVEL SECURITY (migration 047).
 */
@Controller('delivery-retries')
@UseGuards(AuthGuard, PermissionsGuard)
export class DeliveryRetryController {
  constructor(private readonly retries: DeliveryRetryService) {}

  /**
   * Grid over retry chains — one row per message that a carrier failed to
   * deliver and this platform tried again. Accepts the shared vocabulary:
   * `search`, `sort` (`-createdAt`, `status`, `attempts`, ...),
   * `filter.status`, `filter.customerId`, `filter.originSmscId`,
   * `filter.triggerDlrEvent`, `limit`/`offset`, `?fields=`, and keyset
   * pagination via `?cursor=` / `?paginate=cursor`.
   */
  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.retries.listChains(actor(r), q);
  }

  /**
   * Grid over individual re-sends: which bind carried each one, which binds were
   * excluded, what it cost, and how it was delivered. Same grid vocabulary.
   */
  @Get('attempts') @RequirePermissions('messages.view') listAttempts(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.retries.listAttempts(actor(r), q);
  }

  /**
   * The configured policies plus the built-in defaults that apply when none
   * matches, so a console can show what happens with nothing configured rather
   * than hard-coding numbers that drift from the server.
   */
  @Get('policies') @RequirePermissions('messages.view') listPolicies(@Req() r: Request) {
    return this.retries.listPolicies(actor(r));
  }

  /**
   * The policy that WOULD apply to a failure on `smscId` for `customerId`,
   * resolved most-specific-wins. Answers "why was this message not retried?"
   * without making an operator resolve three scopes by hand.
   */
  @Get('policies/effective') @RequirePermissions('messages.view') effective(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.retries.effectivePolicy(actor(r), {
      smscId: typeof q.smscId === 'string' && q.smscId.trim() ? q.smscId.trim() : null,
      customerId:
        typeof q.customerId === 'string' && q.customerId.trim() ? q.customerId.trim() : null,
    });
  }

  /**
   * Creates or replaces the policy for one scope (`tenant`, `smsc`, `customer`).
   * Idempotent by scope: one row per tenant, per SMSC and per customer, enforced
   * by the partial unique indexes rather than by a read-then-write.
   *
   * Enabling a policy also starts the scanner if it is not already running, so
   * an operator who turns retrying on sees it working rather than waiting for
   * some unrelated event to schedule a scan.
   *
   * `chargeCreditOnRetry: false` suppresses the CREDIT DEBIT only. Quota is
   * still consumed, because the retry goes through the shared send path.
   */
  @Put('policies') @RequirePermissions('messages.send') savePolicy(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    return this.retries.upsertPolicy(actor(r), parsePolicyInput(b ?? {}));
  }

  @Delete('policies/:id') @RequirePermissions('messages.send') async removePolicy(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    await this.retries.removePolicy(actor(r), uuid(id, 'id'));
    return { removed: true, id, defaults: DELIVERY_RETRY_DEFAULTS };
  }

  /** Scanner watermark, last sweep and lifetime counters. */
  @Get('status') @RequirePermissions('messages.view') status(@Req() r: Request) {
    return this.retries.status(actor(r));
  }

  /**
   * Runs one scan now. Safe to call repeatedly: the chain table's unique index
   * on the original message means a re-scan opens nothing twice.
   */
  @Post('scan') @RequirePermissions('messages.send') scan(@Req() r: Request, @Body() b: any = {}) {
    return this.retries.scan(actor(r), { limit: b?.limit });
  }

  /** How often the self-perpetuating scan job re-enqueues itself. */
  @Post('poll-interval') @RequirePermissions('messages.send') pollInterval(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const seconds = Number(b?.pollIntervalSeconds);
    if (!Number.isFinite(seconds)) throw new BadRequestException('pollIntervalSeconds is required');
    return this.retries.setPollInterval(actor(r), seconds);
  }

  /** One chain with every attempt: which carriers, in what order, and why. */
  @Get(':id') @RequirePermissions('messages.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.retries.getChain(actor(r), uuid(id, 'id'));
  }
}
