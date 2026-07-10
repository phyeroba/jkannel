import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ApiKeyAuthGuard, GatewayRequest } from './api-key-auth.guard';
import { GatewayAuditInterceptor } from './gateway-audit.interceptor';
import { GatewayActor, GatewayKeySettings, GatewayKeysService } from './gateway-keys.service';
import { GatewayLogRepository } from './gateway-log.repository';
import { parseIp } from './ip-allowlist';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuid = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException(`${name} must be a UUID`);
  return value;
};

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

/** Validate a rate limit: undefined (skip), null (clear), or a positive int. */
const parseRateLimit = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000_000)
    throw new BadRequestException('rateLimit must be a positive integer or null to clear');
  return parsed;
};

/** Validate an IP/CIDR allowlist; every entry must parse. */
const parseAllowlist = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new BadRequestException('ipAllowlist must be an array of strings');
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim())
      throw new BadRequestException('ipAllowlist entries must be non-empty strings');
    const trimmed = entry.trim();
    const address = trimmed.includes('/') ? trimmed.slice(0, trimmed.indexOf('/')) : trimmed;
    if (parseIp(address) === null)
      throw new BadRequestException(`ipAllowlist entry is not a valid IP/CIDR: ${trimmed}`);
    return trimmed;
  });
};

/** Validate expiry: undefined (skip), null/'' (clear), or a valid date. */
const parseExpiry = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new BadRequestException('expiresAt must be a valid date');
  return date;
};

const parseEnabled = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException('enabled must be a boolean');
  return value;
};

/**
 * API Gateway management + a reference gateway-authenticated endpoint.
 *
 * Management routes (`/gateway/keys/*`, `/gateway/request-log`) are JWT-
 * authenticated and reuse existing permissions — `users.manage` for key config
 * (the same permission the personal api-keys controller uses) and `system.view`
 * for reading the audit log. We deliberately did NOT invent gateway.* permissions
 * because nothing in the seeded permission catalog would grant them, which would
 * lock existing administrators out.
 *
 * `/gateway/whoami` is authenticated by the API KEY itself via {@link
 * ApiKeyAuthGuard}, exercising rate limiting, IP allowlist and expiry end to end.
 */
@Controller('gateway')
export class ApiGatewayController {
  constructor(
    private readonly keys: GatewayKeysService,
    private readonly log: GatewayLogRepository,
  ) {}

  private actor(request: AuthenticatedRequest): GatewayActor {
    return { tenantId: request.principal!.tenantId, userId: request.principal!.userId };
  }

  @Get('keys/:id')
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  getKey(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.keys.get(this.actor(request), uuid(id, 'id'));
  }

  @Patch('keys/:id')
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermissions('users.manage')
  configureKey(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const settings: GatewayKeySettings = {
      rateLimit: parseRateLimit(body.rateLimit),
      ipAllowlist: parseAllowlist(body.ipAllowlist),
      expiresAt: parseExpiry(body.expiresAt),
      enabled: parseEnabled(body.enabled),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
    return this.keys.configure(this.actor(request), uuid(id, 'id'), settings);
  }

  @Get('request-log')
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermissions('system.view')
  requestLog(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown> = {}) {
    return this.log.list(this.actor(request).tenantId, {
      limit: boundedInt(query.limit, 'limit', 1, 500, 50),
      offset: boundedInt(query.offset, 'offset', 0, 5_000_000, 0),
    });
  }

  /**
   * Reference endpoint authenticated by an API key. Returns the identity the
   * gateway resolved from the presented key. Reaching this handler means the key
   * passed authentication, expiry, IP allowlist and rate-limit checks.
   */
  @Get('whoami')
  @UseGuards(ApiKeyAuthGuard)
  @UseInterceptors(GatewayAuditInterceptor)
  whoami(@Req() request: GatewayRequest) {
    const client = request.gatewayClient!;
    return {
      apiKeyId: client.apiKeyId,
      keyPrefix: client.keyPrefix,
      tenantId: client.tenantId,
      scopes: client.scopes,
      rateLimit: client.rateLimit,
    };
  }
}
