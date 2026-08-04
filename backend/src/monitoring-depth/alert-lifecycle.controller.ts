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
import { Actor } from './monitoring-depth.repository';
import { AlertLifecycleRepository } from './alert-lifecycle.repository';

type Request = AuthenticatedRequest;

const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
  username: request.principal!.username,
});

const uuid = (value: unknown, name: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new BadRequestException(`${name} must be a UUID`);
  return text;
};

const optionalText = (value: unknown, name: string, max = 2000): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new BadRequestException(`${name} must be <= ${max} characters`);
  return trimmed;
};

const requiredText = (value: unknown, name: string, max = 4000): string => {
  const text = optionalText(value, name, max);
  if (!text) throw new BadRequestException(`${name} is required`);
  return text;
};

/**
 * The alert lifecycle endpoints.
 *
 * These live beside the console's AlertsController (same `alerts` prefix, no
 * overlapping paths) rather than inside it, because console/ is owned by
 * another workstream; Nest merges the two route sets. `POST
 * /alerts/:id/acknowledgements` (console) and `POST /alerts/:id/acknowledge`
 * (here) both work and write the same acknowledgement row.
 *
 * Operator actions require `alerts.acknowledge`; suppression — which stops
 * anyone being paged — requires `system.manage`.
 */
@Controller('alerts')
@UseGuards(AuthGuard, PermissionsGuard)
export class AlertLifecycleController {
  constructor(private readonly repository: AlertLifecycleRepository) {}

  @Post(':id/acknowledge')
  @RequirePermissions('alerts.acknowledge')
  acknowledge(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.acknowledge(actor(r), uuid(id, 'id'), optionalText(b?.note, 'note'));
  }

  @Post(':id/resolve')
  @RequirePermissions('alerts.acknowledge')
  resolve(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.resolve(actor(r), uuid(id, 'id'), optionalText(b?.note, 'note'));
  }

  @Post(':id/assign')
  @RequirePermissions('alerts.acknowledge')
  assign(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.assign(
      actor(r),
      uuid(id, 'id'),
      requiredText(b?.assignee, 'assignee', 200),
    );
  }

  @Post(':id/suppress')
  @RequirePermissions('system.manage')
  suppress(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    const minutes = Number(b?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw new BadRequestException('minutes must be a positive number');
    return this.repository.suppress(
      actor(r),
      uuid(id, 'id'),
      minutes,
      optionalText(b?.reason, 'reason'),
    );
  }

  @Post(':id/reopen')
  @RequirePermissions('alerts.acknowledge')
  reopen(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.reopen(actor(r), uuid(id, 'id'), optionalText(b?.reason, 'reason'));
  }

  @Post(':id/close')
  @RequirePermissions('alerts.acknowledge')
  close(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.close(actor(r), uuid(id, 'id'), optionalText(b?.reason, 'reason'));
  }

  @Post(':id/comments')
  @RequirePermissions('alerts.acknowledge')
  addComment(@Req() r: Request, @Param('id') id: string, @Body() b: any = {}) {
    return this.repository.addComment(actor(r), uuid(id, 'id'), requiredText(b?.body, 'body'));
  }

  @Get(':id/comments')
  @RequirePermissions('alerts.view')
  listComments(@Req() r: Request, @Param('id') id: string) {
    return this.repository.listComments(actor(r), uuid(id, 'id'));
  }

  @Get(':id/lifecycle')
  @RequirePermissions('alerts.view')
  lifecycle(@Req() r: Request, @Param('id') id: string) {
    return this.repository.get(actor(r), uuid(id, 'id'));
  }
}
