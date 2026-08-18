import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { PiiRevealService } from './pii-reveal.service';
import { MASKING_NOTICE } from './masking';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * Reveal windows for masked subscriber data (spec §10, §18).
 */
@Controller('privacy')
@UseGuards(AuthGuard, PermissionsGuard)
export class PrivacyController {
  constructor(private readonly reveal: PiiRevealService) {}

  /** What is masked and how to see through it — readable without the grant. */
  @Get('policy')
  policy() {
    return {
      notice: MASKING_NOTICE,
      maskedFields: ['sender', 'receiver', 'destination', 'message body'],
      revealPermission: 'messages.reveal',
      defaultWindowMinutes: 15,
      maxWindowMinutes: 60,
    };
  }

  @Get('reveal')
  @RequirePermissions('messages.reveal')
  async current(@Req() r: Request) {
    const grant = await this.reveal.activeGrant(actor(r));
    return {
      grant,
      // Absence is a normal state, not an error, so it is reported as data.
      active: Boolean(grant),
    };
  }

  @Post('reveal')
  @RequirePermissions('messages.reveal')
  request(@Req() r: Request, @Body() body: any = {}) {
    return this.reveal.grant(actor(r), {
      reason: body.reason,
      minutes: body.minutes,
      messageRef: body.messageRef ?? null,
    });
  }

  @Delete('reveal/:id')
  @RequirePermissions('messages.reveal')
  revoke(@Req() r: Request, @Param('id') id: string) {
    return this.reveal.revoke(actor(r), id);
  }
}
