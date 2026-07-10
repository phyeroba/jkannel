import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { IdentityMfaService, MfaActor } from './identity-mfa.service';

@Controller('auth/mfa')
@UseGuards(AuthGuard)
export class IdentityMfaController {
  constructor(private readonly mfa: IdentityMfaService) {}

  private actor(request: AuthenticatedRequest): MfaActor {
    const principal = request.principal!;
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      username: principal.username,
    };
  }

  private code(body: { code?: unknown }): string {
    if (typeof body.code !== 'string' || !body.code.trim())
      throw new BadRequestException('code is required');
    return body.code.trim();
  }

  @Post('enroll')
  enroll(@Req() request: AuthenticatedRequest) {
    return this.mfa.enroll(this.actor(request));
  }

  @Post('confirm')
  confirm(@Req() request: AuthenticatedRequest, @Body() body: { code?: unknown }) {
    return this.mfa.confirm(this.actor(request), this.code(body));
  }

  @Post('disable')
  disable(@Req() request: AuthenticatedRequest, @Body() body: { code?: unknown }) {
    return this.mfa.disable(this.actor(request), this.code(body));
  }

  @Get('status')
  status(@Req() request: AuthenticatedRequest) {
    return this.mfa.status(this.actor(request));
  }
}
