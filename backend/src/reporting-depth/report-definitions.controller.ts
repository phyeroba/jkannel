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
import {
  Actor,
  REPORT_FORMATS,
  REPORT_SCHEDULES,
  REPORT_TYPES,
  ReportDefinitionInput,
  ReportDefinitionPatch,
  ReportDefinitionsRepository,
  ReportFormat,
  ReportSchedule,
  ReportType,
} from './report-definitions.repository';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string): string => {
  const v = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
    throw new BadRequestException(`${name} must be a UUID`);
  return v;
};

const reportType = (value: unknown): ReportType => {
  const v = text(value, 'reportType');
  if (!(REPORT_TYPES as readonly string[]).includes(v))
    throw new BadRequestException(`reportType must be one of ${REPORT_TYPES.join(', ')}`);
  return v as ReportType;
};
const optionalReportType = (value: unknown): ReportType | undefined =>
  value === undefined || value === null || value === '' ? undefined : reportType(value);

/** schedule may be explicitly null (unschedule), a cadence, or omitted. */
const optionalSchedule = (value: unknown, present: boolean): ReportSchedule | null | undefined => {
  if (!present) return undefined;
  if (value === null || value === '') return null;
  const v = text(value, 'schedule');
  if (!(REPORT_SCHEDULES as readonly string[]).includes(v))
    throw new BadRequestException(`schedule must be one of ${REPORT_SCHEDULES.join(', ')}`);
  return v as ReportSchedule;
};
const optionalFormat = (value: unknown): ReportFormat | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const v = text(value, 'format');
  if (!(REPORT_FORMATS as readonly string[]).includes(v))
    throw new BadRequestException(`format must be one of ${REPORT_FORMATS.join(', ')}`);
  return v as ReportFormat;
};
const optionalParameters = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('parameters must be a JSON object');
  return value as Record<string, unknown>;
};
const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException(`${name} must be a boolean`);
  return value;
};

/**
 * Saved report definitions. A definition names a catalog report kind plus its
 * parameters so the user can re-run it and, optionally, have it exported and
 * delivered on a schedule (see ReportScheduleService). Reads require
 * reports.view; mutations require system.manage; every mutation is audited.
 */
@Controller('reports/definitions')
@UseGuards(AuthGuard, PermissionsGuard)
export class ReportDefinitionsController {
  constructor(private readonly repository: ReportDefinitionsRepository) {}

  @Get() @RequirePermissions('reports.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.list(actor(r), q);
  }

  @Post() @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any = {}) {
    const value: ReportDefinitionInput = {
      name: text(b.name, 'name'),
      reportType: reportType(b.reportType),
      parameters: optionalParameters(b.parameters),
      schedule: optionalSchedule(b.schedule, b.schedule !== undefined) ?? undefined,
      format: optionalFormat(b.format),
      enabled: optionalBoolean(b.enabled, 'enabled'),
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    };
    return this.repository.create(actor(r), value);
  }

  @Get(':id') @RequirePermissions('reports.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.get(actor(r), uuid(id, 'id'));
  }

  @Get(':id/runs') @RequirePermissions('reports.view') runs(
    @Req() r: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.repository.runs(actor(r), uuid(id, 'id'), limit ? Number(limit) : 50);
  }

  @Patch(':id') @RequirePermissions('system.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const value: ReportDefinitionPatch = {
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined,
      reportType: optionalReportType(b.reportType),
      parameters: optionalParameters(b.parameters),
      schedule: optionalSchedule(b.schedule, 'schedule' in b),
      format: optionalFormat(b.format),
      enabled: optionalBoolean(b.enabled, 'enabled'),
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    };
    return this.repository.update(actor(r), uuid(id, 'id'), value);
  }

  @Delete(':id') @RequirePermissions('system.manage') remove(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.remove(actor(r), uuid(id, 'id'));
  }
}
