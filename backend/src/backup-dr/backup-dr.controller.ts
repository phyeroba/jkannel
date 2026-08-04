import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ExportService } from '../platform/export.service';
import { Actor, BackupDrRepository } from './backup-dr.repository';
import { BackupDrService } from './backup-dr.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});
const requester = (r: Request) => r.principal!.username ?? r.principal!.userId;
const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string) => {
  const v = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
    throw new BadRequestException(`${name} must be a UUID`);
  return v;
};

/**
 * Real backup / disaster-recovery API. Mounted at /backup-dr to avoid colliding
 * with the legacy platform-console /backups catalog controller. Grid responses
 * carry {items,total,limit,offset}. system.view reads, system.manage mutates.
 */
@Controller('backup-dr')
@UseGuards(AuthGuard, PermissionsGuard)
export class BackupDrController {
  constructor(
    private readonly service: BackupDrService,
    private readonly repository: BackupDrRepository,
    private readonly exporter?: ExportService,
  ) {}

  @Get() @RequirePermissions('system.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listBackups(actor(r), q);
  }

  @Get('export.csv') @RequirePermissions('system.view') async exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() res?: any,
  ) {
    const page = await this.repository.listBackups(actor(r), { ...q, limit: q.limit ?? 500 });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="jkannel-backups-${stamp}.csv"`);
    res.setHeader('x-jkannel-export-row-count', String(page.items.length));
    res.send(
      this.exporter!.toCsv(page.items as unknown as Array<Record<string, unknown>>, [
        { key: 'label', header: 'Label' },
        { key: 'kind', header: 'Kind' },
        { key: 'status', header: 'Status' },
        { key: 'retention_class', header: 'Retention' },
        { key: 'size_bytes', header: 'Size (bytes)' },
        { key: 'checksum', header: 'Checksum' },
        { key: 'verified_at', header: 'Verified' },
        { key: 'artifact_path', header: 'Artifact' },
        { key: 'started_at', header: 'Started' },
        { key: 'completed_at', header: 'Completed' },
      ]),
    );
  }

  @Post() @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any = {}) {
    return this.service.createBackup(actor(r), {
      kind: b?.kind,
      retentionClass: b?.retentionClass,
      label: b?.label,
      scope: b?.scope,
    });
  }

  @Post(':id/verify') @RequirePermissions('system.manage') verify(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.service.verifyBackup(actor(r), uuid(id, 'id'));
  }

  @Post(':id/restore') @RequirePermissions('system.manage') restore(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.service.restoreBackup(actor(r), uuid(id, 'id'), {
      reason: b?.reason,
      confirm: b?.confirm,
    });
  }

  @Post('retention/apply') @RequirePermissions('system.manage') applyRetention(@Req() r: Request) {
    return this.service.applyRetention(actor(r));
  }

  @Get('schedules') @RequirePermissions('system.view') listSchedules(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.repository.listSchedules(actor(r), q);
  }

  @Post('schedules') @RequirePermissions('system.manage') createSchedule(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const name = text(b?.name, 'name');
    const cron = typeof b?.cron === 'string' && b.cron.trim() ? b.cron.trim() : null;
    const intervalMinutes =
      b?.intervalMinutes === undefined || b?.intervalMinutes === null
        ? null
        : Number(b.intervalMinutes);
    if (intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0))
      throw new BadRequestException('intervalMinutes must be a positive integer');
    if (!cron && intervalMinutes === null)
      throw new BadRequestException('Provide either cron or intervalMinutes');
    // 'incremental' is no longer a backup kind: pg_dump has no incremental mode
    // and WAL archiving is not configured, so it always produced a full dump
    // under a false label (migration 035). Recorded as 'full' instead.
    const kind = b?.kind === 'incremental' ? 'full' : (b?.kind ?? 'full');
    if (!['full', 'schema'].includes(kind))
      throw new BadRequestException(
        "kind must be full or schema ('incremental' is not supported: it requires WAL " +
          'archiving, which this deployment does not configure)',
      );
    const retentionClass = b?.retentionClass ?? 'daily';
    if (!['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'manual'].includes(retentionClass))
      throw new BadRequestException('retentionClass is not a recognised class');
    const nextRunAt =
      intervalMinutes !== null ? new Date(Date.now() + intervalMinutes * 60_000) : null;
    return this.repository.createSchedule(actor(r), {
      name,
      cron,
      intervalMinutes,
      kind,
      retentionClass,
      enabled: b?.enabled !== false,
      nextRunAt,
    });
  }
}
