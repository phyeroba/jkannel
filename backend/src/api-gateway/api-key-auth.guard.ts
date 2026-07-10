import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedPrincipal } from '../security/auth.types';
import { GatewayClient, GatewayKeyAuthenticator } from './gateway-key-authenticator';
import { GatewayRateLimiter } from './gateway-rate-limiter';
import { GatewayLogRepository } from './gateway-log.repository';
import { isIpAllowed } from './ip-allowlist';

export interface GatewayRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  correlationId?: string;
  principal?: AuthenticatedPrincipal;
  gatewayClient?: GatewayClient;
}

interface GatewayResponse {
  setHeader(name: string, value: string | number): void;
}

const RATE_WINDOW_SECONDS = 60;

/** Read the first client IP from X-Forwarded-For, else the socket address. */
export function callerIp(request: GatewayRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw.trim()) return raw.split(',')[0].trim();
  return request.ip ?? request.socket?.remoteAddress ?? undefined;
}

/** Pull the presented key from X-API-Key or an `Authorization: ApiKey …` header. */
function extractRawKey(request: GatewayRequest): string | null {
  const header = request.headers['x-api-key'];
  const apiKeyHeader = Array.isArray(header) ? header[0] : header;
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) return apiKeyHeader.trim();
  const auth = request.headers.authorization;
  const authHeader = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authHeader === 'string' && /^ApiKey\s+/i.test(authHeader)) return authHeader.trim();
  return null;
}

/**
 * Authenticates and polices API-key-authenticated gateway requests:
 *   1. resolve the key -> tenant (rejects missing/disabled/expired -> 401),
 *   2. enforce the per-key IP allowlist (403 when the caller IP is not allowed;
 *      an empty allowlist allows all),
 *   3. enforce the per-key Redis rate limit (429 + Retry-After; fails open if
 *      Redis is down).
 *
 * On success it attaches `gatewayClient` and a `principal` (permissions = the
 * key's scopes) so the standard PermissionsGuard and downstream handlers work
 * unchanged. Blocked requests are written to gateway_request_log here; allowed
 * requests are logged by {@link GatewayAuditInterceptor} once the final status
 * is known.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly authenticator: GatewayKeyAuthenticator,
    private readonly rateLimiter: GatewayRateLimiter,
    private readonly log: GatewayLogRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<GatewayRequest>();
    const response = http.getResponse<GatewayResponse>();
    const ip = callerIp(request);

    const rawKey = extractRawKey(request);
    if (!rawKey)
      throw new UnauthorizedException('API key required (X-API-Key or Authorization: ApiKey)');

    let client: GatewayClient;
    try {
      client = await this.authenticator.authenticate(rawKey);
    } catch (error) {
      // Unauthorized keys have no known tenant, so they cannot be tenant-scoped
      // into gateway_request_log; they surface via the auth error path instead.
      throw error;
    }

    // 2. IP allowlist (empty => allow all).
    if (!isIpAllowed(ip, client.allowedIps)) {
      await this.recordBlocked(client, request, HttpStatus.FORBIDDEN, 'ip_blocked', ip);
      throw new ForbiddenException('Caller IP is not permitted for this API key');
    }

    // 3. Per-key rate limit (fail-open when Redis is unavailable).
    if (client.rateLimit && client.rateLimit > 0) {
      const result = await this.rateLimiter.consume(
        client.apiKeyId,
        client.rateLimit,
        RATE_WINDOW_SECONDS,
      );
      response.setHeader('X-RateLimit-Limit', String(result.limit));
      response.setHeader('X-RateLimit-Remaining', String(result.remaining));
      if (!result.allowed) {
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        await this.recordBlocked(client, request, HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', ip);
        throw new HttpException('API key rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    request.gatewayClient = client;
    request.principal = {
      tenantId: client.tenantId,
      userId: client.userId,
      sessionId: `apikey:${client.apiKeyId}`,
      username: `apikey:${client.keyPrefix}`,
      roles: [],
      permissions: client.scopes,
    };
    void this.authenticator.touch(client.apiKeyId);
    return true;
  }

  private recordBlocked(
    client: GatewayClient,
    request: GatewayRequest,
    status: number,
    outcome: 'ip_blocked' | 'rate_limited',
    ip: string | undefined,
  ): Promise<void> {
    return this.log.record({
      tenantId: client.tenantId,
      apiKeyId: client.apiKeyId,
      keyPrefix: client.keyPrefix,
      route: (request.originalUrl ?? request.url ?? '').split('?')[0],
      method: (request.method ?? 'GET').toUpperCase(),
      statusCode: status,
      outcome,
      ipAddress: ip ?? null,
      correlationId: request.correlationId ?? null,
    });
  }
}
