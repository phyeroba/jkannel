import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { AuthThrottleGuard, ThrottlePolicy } from './auth-throttle.guard';

interface RequestInfo extends AuthenticatedRequest {
  ip?: string;
  /** Right-most untrusted hop, set by RequestContextMiddleware. */
  clientIp?: string;
}

/**
 * `AuthThrottleGuard` reads (never consumes) the Redis penalty counters for the
 * handlers marked with `@ThrottlePolicy`, returning 429 + Retry-After once a
 * bucket is exhausted; the service increments those counters only on a failed
 * attempt. `logout` and `me` are deliberately unthrottled — both require an
 * already-valid credential and neither is a guessing oracle.
 */
@Controller('auth')
@UseGuards(AuthThrottleGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * The client IP must come from `clientIp` (right-most untrusted hop), never
   * from a raw X-Forwarded-For — otherwise a caller could pick which throttle
   * bucket to spend and poison login history.
   */
  private context(request: RequestInfo) {
    return {
      ipAddress: request.clientIp ?? request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent']
          : undefined,
    };
  }

  @Post('login')
  @ThrottlePolicy('login')
  login(
    @Body()
    body: {
      tenant: string;
      username: string;
      password: string;
      totp?: string;
      recoveryCode?: string;
    },
    @Req() request: RequestInfo,
  ) {
    return this.auth.login(body.tenant, body.username, body.password, this.context(request), {
      totp: body.totp,
      recoveryCode: body.recoveryCode,
    });
  }

  @Post('refresh')
  @ThrottlePolicy('token', 'refresh')
  refresh(@Body() body: { refreshToken: string }, @Req() request: RequestInfo) {
    return this.auth.refresh(body.refreshToken, this.context(request));
  }

  @Post('logout') async logout(@Body() body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
    return { revoked: true };
  }

  @Post('password-reset/request')
  @ThrottlePolicy('reset-request')
  requestPasswordReset(
    @Body() body: { tenant: string; username: string },
    @Req() request: RequestInfo,
  ) {
    return this.auth.requestPasswordReset(body.tenant, body.username, this.context(request));
  }

  @Post('password-reset/confirm')
  @ThrottlePolicy('token', 'reset')
  confirmPasswordReset(
    @Body() body: { tenant: string; token: string; newPassword: string },
    @Req() request: RequestInfo,
  ) {
    return this.auth.confirmPasswordReset(body.token, body.newPassword, this.context(request));
  }

  @Post('invitations/accept')
  @ThrottlePolicy('token', 'invitation')
  acceptInvitation(
    @Body() body: { token: string; username: string; password: string },
    @Req() request: RequestInfo,
  ) {
    return this.auth.acceptInvitation(
      body.token,
      body.username,
      body.password,
      this.context(request),
    );
  }

  @Get('me') @UseGuards(AuthGuard) me(@Req() request: RequestInfo) {
    return request.principal;
  }
}
