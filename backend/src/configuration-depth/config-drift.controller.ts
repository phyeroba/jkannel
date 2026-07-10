import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, ConfigDriftService } from './config-drift.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

/**
 * Configuration drift endpoints. GET reports whether the live engine config
 * file matches the deployed version (configuration.view, read-only). POST
 * runs the check and records a config_drift_checks row (system.manage).
 *
 * Route ordering note: registered before the console ConfigurationsController
 * (see app.module) so /configurations/drift* matches ahead of that
 * controller's /configurations/:id route.
 */
@Controller('configurations/drift')
@UseGuards(AuthGuard, PermissionsGuard)
export class ConfigDriftController {
  constructor(private readonly drift: ConfigDriftService) {}

  @Get() @RequirePermissions('configuration.view') check(@Req() r: Request) {
    return this.drift.check(actor(r));
  }

  @Post('check') @RequirePermissions('system.manage') record(@Req() r: Request) {
    return this.drift.recordCheck(actor(r));
  }
}
