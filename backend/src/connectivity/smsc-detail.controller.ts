import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { SmscDetailService } from './smsc-detail.service';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * SMSC detail and the bind timeline behind the SMPP Sessions screen
 * (spec §4.2, §5).
 *
 * The response carries a `limits` block naming every field §5 asks for that
 * bearerbox does not emit. That is part of the contract, not a footnote: the
 * console renders it so an operator can tell the difference between "this bind
 * reported no errors" and "this engine cannot report errors at that level".
 */
@Controller('smscs')
@UseGuards(AuthGuard, PermissionsGuard)
export class SmscDetailController {
  constructor(private readonly detail: SmscDetailService) {}

  @Get(':engineId/detail')
  @RequirePermissions('smsc.view')
  get(@Req() r: Request, @Param('engineId') engineId: string) {
    return this.detail.detail(actor(r), engineId);
  }
}
