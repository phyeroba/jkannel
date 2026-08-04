import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedPrincipal } from './auth.types';
import {
  AuthThrottledException,
  AuthThrottleService,
  ThrottleBucket,
} from './auth-throttle.service';

export type ThrottlePolicyName = 'login' | 'mfa' | 'reset-request' | 'token';

export const AUTH_THROTTLE_POLICY = 'auth:throttle:policy';

/**
 * Marks a handler as throttled and selects which bucket family applies.
 * Handlers without the decorator are not throttled (e.g. `GET /auth/me`,
 * `POST /auth/logout`, MFA status).
 */
export const ThrottlePolicy = (policy: ThrottlePolicyName, scope?: string) =>
  SetMetadata(AUTH_THROTTLE_POLICY, { policy, scope });

interface ThrottledRequest {
  body?: { tenant?: unknown; username?: unknown };
  clientIp?: string;
  ip?: string;
  principal?: AuthenticatedPrincipal;
}

interface ThrottledResponse {
  setHeader(name: string, value: string | number): void;
}

/**
 * Reads (never consumes) the auth throttle counters for the decorated handler
 * and rejects with 429 + Retry-After once a bucket is exhausted. The counters
 * themselves are incremented by the services, only on a failed attempt — see
 * {@link AuthThrottleService}.
 *
 * Keying uses `request.clientIp` (RequestContextMiddleware, derived from the
 * right-most untrusted hop) so a spoofed X-Forwarded-For cannot be used to hop
 * between throttle buckets.
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly throttle: AuthThrottleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<{ policy: ThrottlePolicyName; scope?: string } | undefined>(
      AUTH_THROTTLE_POLICY,
      context.getHandler(),
    );
    if (!meta) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<ThrottledRequest>();
    const ip = request.clientIp ?? request.ip;
    const buckets = this.bucketsFor(meta.policy, meta.scope, request, ip);
    const decision = await this.throttle.inspect(buckets);
    if (decision.allowed) return true;
    const response = http.getResponse<ThrottledResponse>();
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AuthThrottledException(decision.retryAfterSeconds);
  }

  private bucketsFor(
    policy: ThrottlePolicyName,
    scope: string | undefined,
    request: ThrottledRequest,
    ip: string | undefined,
  ): ThrottleBucket[] {
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    switch (policy) {
      case 'login':
        return this.throttle.loginBuckets(
          text(request.body?.tenant),
          text(request.body?.username),
          ip,
        );
      case 'mfa':
        return this.throttle.mfaBuckets(request.principal?.tenantId, request.principal?.userId, ip);
      case 'reset-request':
        return this.throttle.resetBuckets(
          text(request.body?.tenant),
          text(request.body?.username),
          ip,
        );
      case 'token':
      default:
        return this.throttle.tokenBuckets(scope ?? 'generic', ip);
    }
  }
}
