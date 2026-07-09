import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
interface RequestInfo extends AuthenticatedRequest {
  ip?: string;
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') login(
    @Body() body: { tenant: string; username: string; password: string },
    @Req() request: RequestInfo,
  ) {
    return this.auth.login(body.tenant, body.username, body.password, {
      ipAddress: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent']
          : undefined,
    });
  }
  @Post('refresh') refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }
  @Post('logout') async logout(@Body() body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
    return { revoked: true };
  }
  @Post('password-reset/request') requestPasswordReset(
    @Body() body: { tenant: string; username: string },
  ) {
    return this.auth.requestPasswordReset(body.tenant, body.username);
  }
  @Post('password-reset/confirm') confirmPasswordReset(
    @Body() body: { tenant: string; token: string; newPassword: string },
  ) {
    return this.auth.confirmPasswordReset(body.token, body.newPassword);
  }
  @Post('invitations/accept') acceptInvitation(
    @Body() body: { token: string; username: string; password: string },
  ) {
    return this.auth.acceptInvitation(body.token, body.username, body.password);
  }
  @Get('me') @UseGuards(AuthGuard) me(@Req() request: RequestInfo) {
    return request.principal;
  }
}
