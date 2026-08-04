import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, EscalationStep, MonitoringDepthRepository } from './monitoring-depth.repository';
import { NotificationReadinessService } from './notification-readiness.service';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string): string => {
  const x = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))
    throw new BadRequestException(`${name} must be a UUID`);
  return x;
};
const isoTimestamp = (value: unknown, name: string): string => {
  const x = text(value, name);
  if (Number.isNaN(Date.parse(x)))
    throw new BadRequestException(`${name} must be an ISO timestamp`);
  return x;
};

const CHANNEL_TYPES = ['dashboard', 'webhook', 'email', 'sms'];
const SEVERITIES = ['info', 'warning', 'critical'];

/** Validates the ordered escalation steps array. */
function parseSteps(value: unknown): EscalationStep[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequestException('steps must be a non-empty array');
  return value.map((raw, index) => {
    const step = raw as Record<string, unknown>;
    const afterMinutes = Number(step.afterMinutes);
    if (!Number.isFinite(afterMinutes) || afterMinutes < 0)
      throw new BadRequestException(`steps[${index}].afterMinutes must be a non-negative number`);
    const channelType = text(step.channelType, `steps[${index}].channelType`);
    if (!CHANNEL_TYPES.includes(channelType))
      throw new BadRequestException(`steps[${index}].channelType is unsupported`);
    const severity = step.severity === undefined ? undefined : text(step.severity, 'severity');
    if (severity && !SEVERITIES.includes(severity))
      throw new BadRequestException(`steps[${index}].severity is invalid`);
    return {
      afterMinutes,
      channelType,
      target: text(step.target, `steps[${index}].target`),
      severity,
    };
  });
}

/** Validates the maintenance scope object. */
function parseScope(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('scope must be an object');
  const scope = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (scope.all !== undefined) out.all = Boolean(scope.all);
  for (const key of ['smscs', 'routes'] as const) {
    if (scope[key] !== undefined) {
      if (!Array.isArray(scope[key]))
        throw new BadRequestException(`scope.${key} must be an array of ids`);
      out[key] = (scope[key] as unknown[]).map((v) => text(v, `scope.${key}[]`));
    }
  }
  return out;
}

@Controller('monitoring/escalation')
@UseGuards(AuthGuard, PermissionsGuard)
export class EscalationController {
  constructor(private readonly repository: MonitoringDepthRepository) {}

  @Get('policies') @RequirePermissions('alerts.view') listPolicies(@Req() r: Request) {
    return this.repository.listEscalationPolicies(actor(r));
  }
  @Post('policies') @RequirePermissions('system.manage') createPolicy(
    @Req() r: Request,
    @Body() b: any,
  ) {
    return this.repository.createEscalationPolicy(actor(r), {
      name: text(b?.name, 'name'),
      steps: parseSteps(b?.steps),
      enabled: b?.enabled,
    });
  }
  @Get('policies/:id') @RequirePermissions('alerts.view') getPolicy(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.getEscalationPolicy(actor(r), uuid(id, 'id'));
  }
  @Patch('policies/:id') @RequirePermissions('system.manage') updatePolicy(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.updateEscalationPolicy(actor(r), uuid(id, 'id'), {
      name: b?.name === undefined ? undefined : text(b.name, 'name'),
      steps: b?.steps === undefined ? undefined : parseSteps(b.steps),
      enabled: b?.enabled,
      reason: b?.reason,
    });
  }
  @Delete('policies/:id') @RequirePermissions('system.manage') deletePolicy(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.deleteEscalationPolicy(actor(r), uuid(id, 'id'), b?.reason);
  }
  @Get('alerts/:alertId') @RequirePermissions('alerts.view') listForAlert(
    @Req() r: Request,
    @Param('alertId') alertId: string,
  ) {
    return this.repository.listEscalationsForAlert(actor(r), uuid(alertId, 'alertId'));
  }
}

@Controller('monitoring/maintenance')
@UseGuards(AuthGuard, PermissionsGuard)
export class MaintenanceController {
  constructor(private readonly repository: MonitoringDepthRepository) {}

  @Get() @RequirePermissions('alerts.view') list(@Req() r: Request) {
    return this.repository.listMaintenanceWindows(actor(r));
  }
  @Get('active') @RequirePermissions('alerts.view') active(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    const now = q?.at ? new Date(isoTimestamp(q.at, 'at')) : new Date();
    return this.repository.activeMaintenanceWindows(actor(r), now);
  }
  @Post() @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any) {
    const startsAt = isoTimestamp(b?.startsAt, 'startsAt');
    const endsAt = isoTimestamp(b?.endsAt, 'endsAt');
    if (Date.parse(endsAt) <= Date.parse(startsAt))
      throw new BadRequestException('endsAt must be after startsAt');
    return this.repository.createMaintenanceWindow(actor(r), {
      name: text(b?.name, 'name'),
      startsAt,
      endsAt,
      scope: parseScope(b?.scope),
      reason: b?.reason,
    });
  }
  @Get(':id') @RequirePermissions('alerts.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getMaintenanceWindow(actor(r), uuid(id, 'id'));
  }
  @Patch(':id') @RequirePermissions('system.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const startsAt = b?.startsAt === undefined ? undefined : isoTimestamp(b.startsAt, 'startsAt');
    const endsAt = b?.endsAt === undefined ? undefined : isoTimestamp(b.endsAt, 'endsAt');
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
      throw new BadRequestException('endsAt must be after startsAt');
    return this.repository.updateMaintenanceWindow(actor(r), uuid(id, 'id'), {
      name: b?.name === undefined ? undefined : text(b.name, 'name'),
      startsAt,
      endsAt,
      scope: b?.scope === undefined ? undefined : parseScope(b.scope),
      reason: b?.reason,
    });
  }
  @Delete(':id') @RequirePermissions('system.manage') remove(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.deleteMaintenanceWindow(actor(r), uuid(id, 'id'), b?.reason);
  }
}

@Controller('monitoring/correlations')
@UseGuards(AuthGuard, PermissionsGuard)
export class CorrelationController {
  constructor(private readonly repository: MonitoringDepthRepository) {}

  @Get() @RequirePermissions('alerts.view') list(@Req() r: Request) {
    return this.repository.correlationSummary(actor(r));
  }
}

/**
 * Surfaces "can this tenant actually be told about an alert?" — the condition
 * that used to be invisible on a fresh install. See
 * {@link NotificationReadinessService}.
 */
@Controller('monitoring/notifications')
@UseGuards(AuthGuard, PermissionsGuard)
export class NotificationReadinessController {
  constructor(private readonly readiness: NotificationReadinessService) {}

  @Get('readiness') @RequirePermissions('alerts.view') get(@Req() r: Request) {
    return this.readiness.readinessForTenant(actor(r).tenantId);
  }

  /** Re-seeds the default dashboard channel / escalation policy if missing. */
  @Post('readiness/repair') @RequirePermissions('system.manage') async repair(@Req() r: Request) {
    const tenantId = actor(r).tenantId;
    const seeded = await this.readiness.ensureTenantDefaults(tenantId);
    return { ...seeded, readiness: await this.readiness.readinessForTenant(tenantId) };
  }
}
