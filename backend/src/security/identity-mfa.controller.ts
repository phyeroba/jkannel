import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { AuthThrottleGuard, ThrottlePolicy } from './auth-throttle.guard';
import { IdentityMfaService, MfaActor } from './identity-mfa.service';

interface MfaRequest extends AuthenticatedRequest {
  ip?: string;
  /** Right-most untrusted hop, set by RequestContextMiddleware. */
  clientIp?: string;
}

/**
 * AuthGuard runs first (it populates `request.principal`, which the throttle
 * guard keys on), then AuthThrottleGuard rejects code verification with 429 +
 * Retry-After once the per-user MFA penalty ceiling is reached.
 */
@Controller('auth/mfa')
@UseGuards(AuthGuard, AuthThrottleGuard)
export class IdentityMfaController {
  constructor(private readonly mfa: IdentityMfaService) {}

  private actor(request: MfaRequest): MfaActor {
    const principal = request.principal!;
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      username: principal.username,
      ipAddress: request.clientIp ?? request.ip,
    };
  }

  private code(body: { code?: unknown }): string {
    if (typeof body.code !== 'string' || !body.code.trim())
      throw new BadRequestException('code is required');
    return body.code.trim();
  }

  @Post('enroll')
  enroll(@Req() request: MfaRequest) {
    return this.mfa.enroll(this.actor(request));
  }

  @Post('confirm')
  @ThrottlePolicy('mfa')
  confirm(@Req() request: MfaRequest, @Body() body: { code?: unknown }) {
    return this.mfa.confirm(this.actor(request), this.code(body));
  }

  @Post('disable')
  @ThrottlePolicy('mfa')
  disable(@Req() request: MfaRequest, @Body() body: { code?: unknown }) {
    return this.mfa.disable(this.actor(request), this.code(body));
  }

  @Get('status')
  status(@Req() request: MfaRequest) {
    return this.mfa.status(this.actor(request));
  }
}
