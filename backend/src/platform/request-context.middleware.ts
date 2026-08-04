import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClientIpRequest, resolveClientIp, trustedProxyConfig } from '../security/client-ip';

export interface ContextRequest extends ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  requestId?: string;
  correlationId?: string;
  requestStartedAt?: number;
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
}
type Next = () => void;

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
    next();
  }
}
