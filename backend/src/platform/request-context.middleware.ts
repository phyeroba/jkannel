import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClientIpRequest, resolveClientIp, trustedProxyConfig } from '../security/client-ip';
import { sharedJsonLogger } from './json.logger';
import { runWithRequestContext } from './request-context.store';

export interface ContextRequest extends ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  requestId?: string;
  correlationId?: string;
  requestStartedAt?: number;
  /** Set by AuthGuard later in the chain; read lazily when a line is logged. */
  principal?: { userId?: string; tenantId?: string; username?: string };
  /**
   * Client IP derived from the right-most *untrusted* hop — the one trustworthy
   * value. Every consumer (API-key IP allowlist, gateway request log, auth
   * throttling, login history, audit) should read this rather than
   * `X-Forwarded-For` or `request.ip`. See security/client-ip.ts.
   */
  clientIp?: string;
}
interface ContextResponse {
  setHeader(name: string, value: string): void;
  statusCode?: number;
  on?(event: string, listener: () => void): void;
}
type Next = () => void;

/** Strips the query string so log lines group by route, not by parameter. */
export function logRoute(url: string | undefined): string {
  if (!url) return '/';
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: ContextRequest, response: ContextResponse, next: Next): void {
    request.requestId = randomUUID();
    const supplied = request.headers['x-correlation-id'];
    request.correlationId =
      typeof supplied === 'string' && supplied.trim() ? supplied.trim() : request.requestId;
    request.requestStartedAt = Date.now();
    // Read the trusted-proxy config per request so tests (and a hot config
    // reload) see env changes; it is two cheap string reads.
    request.clientIp = resolveClientIp(request, trustedProxyConfig());
    response.setHeader('x-request-id', request.requestId);
    response.setHeader('x-correlation-id', request.correlationId);

    const route = logRoute(request.originalUrl ?? request.url);
    // One access line per request, emitted on 'finish' so it can carry the
    // status and duration. `principalCarrier` is the request itself: AuthGuard
    // fills `principal` after this point, and the logger reads it at log time.
    response.on?.('finish', () => {
      sharedJsonLogger().http({
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Date.now() - (request.requestStartedAt ?? Date.now()),
        correlationId: request.correlationId,
        requestId: request.requestId,
        userId: request.principal?.userId,
        tenantId: request.principal?.tenantId,
        username: request.principal?.username,
        clientIp: request.clientIp,
      });
    });

    // Everything downstream (guards, interceptors, controllers, repositories)
    // runs inside this scope, so any log line it writes carries the ids above
    // without threading a context parameter through every signature.
    runWithRequestContext(
      {
        requestId: request.requestId,
        correlationId: request.correlationId,
        method: request.method,
        route,
        clientIp: request.clientIp,
        startedAt: request.requestStartedAt,
        principalCarrier: request,
      },
      next,
    );
  }
}
