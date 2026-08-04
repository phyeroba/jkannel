import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { DatabaseService } from '../database/database.service';
import { MessageSendService } from '../messaging-depth/message-send.service';
import { ApiKeyAuthGuard, GatewayRequest } from './api-key-auth.guard';
import { GatewayAuditInterceptor } from './gateway-audit.interceptor';
import { GATEWAY_SCOPES } from './gateway-scopes';

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

/** Longest single-submit body we accept (10 concatenated GSM-7 parts). */
const MAX_TEXT_LENGTH = 1530;

/**
 * The gateway's business API: message submission and message/decision reads,
 * authenticated by API KEY and gated on the key's SCOPES.
 *
 * This closes gap G9. Previously `ApiKeyAuthGuard` protected exactly one route
 * — `GET /gateway/whoami`, an echo endpoint that carried no `PermissionsGuard`
 * — so no business function was reachable by API key and no scope was enforced
 * anywhere in the product. The rate limiter, IP allowlist and expiry machinery
 * were policing nothing of consequence.
 *
 * The guard stack is the whole mechanism:
 *   - {@link ApiKeyAuthGuard} resolves the key -> tenant/customer, applies
 *     expiry, the IP allowlist and the per-key rate limit, and publishes the
 *     key's scopes as the request principal's permissions;
 *   - {@link PermissionsGuard} then enforces `@RequirePermissions(<scope>)`, so
 *     a key without `sms.send` gets a 403 and never reaches the send path;
 *   - {@link GatewayAuditInterceptor} records the outcome and duration.
 *
 * CUSTOMER IDENTITY. `api_keys.customer_id` (migration 033) is the customer the
 * key submits for; it is passed to the send path, which enforces that
 * customer's quota, credit, approved sender IDs and route bindings inside the
 * same transaction as the send. A key with no customer submits as the tenant,
 * with no entitlements to consume — the pre-existing behaviour.
 */
@Controller('gateway')
@UseGuards(ApiKeyAuthGuard, PermissionsGuard)
@UseInterceptors(GatewayAuditInterceptor)
export class GatewayMessagingController {
  constructor(
    private readonly send: MessageSendService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly database: DatabaseService,
  ) {}

  private tenantId(request: GatewayRequest): string {
    return request.gatewayClient!.tenantId;
  }

  /** Engine SMSC ids the key's tenant owns, for scoping SQLBox reads. */
  private async smscScope(request: GatewayRequest): Promise<string[]> {
    return this.database.tenantTransaction(this.tenantId(request), async (client) =>
      (
        await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      ).rows.map((row) => row.engine_id),
    );
  }

  /**
   * Submit one message.
   *
   * `smscId` is OPTIONAL and normally omitted: the routing engine picks the
   * bind from the tenant's deployed routes and live bind health, and the
   * decision is recorded. Supplying it pins the bind (still validated against
   * the tenant's own SMSCs).
   */
  @Post('messages')
  @RequirePermissions(GATEWAY_SCOPES.smsSend)
  async submit(@Req() request: GatewayRequest, @Body() body: Record<string, unknown> = {}) {
    const client = request.gatewayClient!;
    const message = text(body.text, 'text');
    if (message.length > MAX_TEXT_LENGTH)
      throw new BadRequestException(`text must be at most ${MAX_TEXT_LENGTH} characters`);
    return this.send.send(
      { tenantId: client.tenantId, userId: client.userId },
      {
        sender: text(body.sender, 'sender'),
        receiver: text(body.receiver, 'receiver'),
        text: message,
        smscId: optionalText(body.smscId) ?? null,
        dlrUrl: optionalText(body.dlrUrl),
        dlrMask:
          body.dlrMask === undefined || body.dlrMask === null
            ? undefined
            : boundedInt(body.dlrMask, 'dlrMask', 0, 31, 31),
        foreignId: optionalText(body.foreignId),
        // Never taken from the body: a client cannot submit as another customer.
        customerId: client.customerId,
        channel: 'api',
        reference: optionalText(body.reference) ?? null,
        operator: optionalText(body.operator) ?? null,
      },
    );
  }

  /** Message history for the key's tenant. */
  @Get('messages')
  @RequirePermissions(GATEWAY_SCOPES.smsRead)
  async messages(@Req() request: GatewayRequest, @Query() query: Record<string, unknown> = {}) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        items: [],
        nextCursor: null,
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    const page = await this.sqlbox.list({
      limit: boundedInt(query.limit, 'limit', 1, 200, 50),
      cursor: query.cursor
        ? boundedInt(query.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER, 0)
        : undefined,
      deliveryStatus: typeof query.status === 'string' ? query.status : undefined,
      allowedSmscIds: await this.smscScope(request),
    });
    return { ...page, source: { status: 'available', type: 'kamex-sqlbox' } };
  }

  /**
   * Why a message went out on the carrier it did — the recorded routing
   * decision, including the strategy, whether the fallback was taken and the
   * full selector trace.
   */
  @Get('routing-decisions')
  @RequirePermissions(GATEWAY_SCOPES.routingRead)
  async decisions(@Req() request: GatewayRequest, @Query() query: Record<string, unknown> = {}) {
    const limit = boundedInt(query.limit, 'limit', 1, 200, 50);
    const offset = boundedInt(query.offset, 'offset', 0, 5_000_000, 0);
    const messageRef = optionalText(query.messageRef) ?? null;
    const customerId = request.gatewayClient!.customerId;
    return this.database.tenantTransaction(this.tenantId(request), async (db) => {
      const result = await db.query(
        `SELECT id::text, message_ref, foreign_id, channel, sender, destination, route_id::text,
                route_name, strategy, smsc_id, requested_smsc_id, fallback_used, outcome, reason,
                candidates_considered, trace, created_at, count(*) OVER() AS __total
           FROM message_route_decisions
          WHERE ($1::text IS NULL OR message_ref = $1)
            AND ($2::uuid IS NULL OR customer_id = $2::uuid)
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [messageRef, customerId, limit, offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      return {
        items: result.rows.map(({ __total, ...row }) => row),
        total,
        limit,
        offset,
      };
    });
  }
}
