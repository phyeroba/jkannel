import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { SafeControlService } from './safe-control.service';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const uuid = (value: unknown, name: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new BadRequestException(`${name} must be a UUID`);
  return text;
};

/**
 * Safe control (spec §1.1, §16, UC-SMSC-02, UC-RTE-02).
 *
 * Every mutating route here demands a typed reason, and every one records an
 * audit entry AND an operational event in the same transaction as the change —
 * so the incident timeline cannot disagree with what actually happened.
 */
@Controller('control')
@UseGuards(AuthGuard, PermissionsGuard)
export class SafeControlController {
  constructor(private readonly control: SafeControlService) {}

  /**
   * What an operation will cost, BEFORE it is confirmed.
   *
   * Computed server-side rather than written into the dialog, because the
   * console must not be the only thing that knows what an action does — a
   * script calling the API directly deserves the same warning.
   */
  @Get('smscs/:id/impact/:operation')
  @RequirePermissions('smsc.view')
  impact(@Req() r: Request, @Param('id') id: string, @Param('operation') operation: string) {
    if (!['reconnect', 'disable', 'enable', 'suspend', 'resume'].includes(operation))
      throw new BadRequestException('Unsupported operation');
    return this.control.describeImpact(actor(r), uuid(id, 'id'), operation);
  }

  @Post('smscs/:id/suspend')
  @RequirePermissions('smsc.manage')
  suspend(@Req() r: Request, @Param('id') id: string, @Body() body: any = {}) {
    const reason = SafeControlService.requireReason('suspend', body.reason)!;
    return this.control.setSuspended(actor(r), uuid(id, 'id'), true, reason);
  }

  @Post('smscs/:id/resume')
  @RequirePermissions('smsc.manage')
  resume(@Req() r: Request, @Param('id') id: string, @Body() body: any = {}) {
    const reason = SafeControlService.requireReason('resume', body.reason)!;
    return this.control.setSuspended(actor(r), uuid(id, 'id'), false, reason);
  }

  @Get('failovers')
  @RequirePermissions('routes.view')
  failovers(@Req() r: Request) {
    return this.control.activeFailovers(actor(r));
  }

  @Post('routes/:id/failover')
  @RequirePermissions('routes.manage')
  failOver(@Req() r: Request, @Param('id') id: string, @Body() body: any = {}) {
    const reason = SafeControlService.requireReason('failover', body.reason)!;
    return this.control.failOver(actor(r), uuid(id, 'id'), uuid(body.toSmscId, 'toSmscId'), reason);
  }

  @Post('routes/:id/failover/revert')
  @RequirePermissions('routes.manage')
  revert(@Req() r: Request, @Param('id') id: string, @Body() body: any = {}) {
    const reason = SafeControlService.requireReason('failover', body.reason)!;
    return this.control.revertFailover(actor(r), uuid(id, 'id'), reason);
  }
}
