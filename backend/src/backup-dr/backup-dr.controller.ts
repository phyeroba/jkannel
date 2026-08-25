import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ExportService } from '../platform/export.service';
import { assertIfMatch, setEtagHeader } from '../platform/etag';
import { Actor, BackupDrRepository, BackupSchedulePatch } from './backup-dr.repository';
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
 * 'incremental' is no longer a backup kind: pg_dump has no incremental mode and
 * WAL archiving is not configured, so it always produced a full dump under a
 * false label (migration 035). A requested 'incremental' is coerced to 'full'.
 */
const scheduleKind = (value: unknown): 'full' | 'schema' => {
  const kind = value === 'incremental' ? 'full' : value;
  if (kind !== 'full' && kind !== 'schema')
    throw new BadRequestException(
      "kind must be full or schema ('incremental' is not supported: it requires WAL " +
        'archiving, which this deployment does not configure)',
    );
  return kind;
};

const RETENTION_CLASSES = ['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'manual'] as const;
type ScheduleRetentionClass = (typeof RETENTION_CLASSES)[number];

const scheduleRetentionClass = (value: unknown): ScheduleRetentionClass => {
  if (!RETENTION_CLASSES.includes(value as ScheduleRetentionClass))
    throw new BadRequestException('retentionClass is not a recognised class');
  return value as ScheduleRetentionClass;
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

  /**
   * One backup.
   *
   * The repository has had `getBackup` all along; nothing exposed it, so the
   * register offered Verify and Restore against a row an operator could never
   * open. Restore is the most consequential button in this console and the
   * decision behind it — which scope, how old, whether the artifact was ever
   * verified, and where it actually lives — was only ever visible as a table
   * row.
   *
   * Declared before `:id/verify` and `:id/restore` in the file but after the
   * literal `export.*` and `schedules` paths, so no static segment is captured.
   */
  @Get(':id') @RequirePermissions('system.view') async get(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    const record = await this.repository.getBackup(actor(r), id);
    if (!record) throw new NotFoundException('Backup not found');
    return record;
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
    const kind = scheduleKind(b?.kind ?? 'full');
    const retentionClass = scheduleRetentionClass(b?.retentionClass ?? 'daily');
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

  /**
   * Reads one schedule and publishes its version as a strong `ETag`. This is
   * the read half of the optimistic-concurrency contract in `platform/etag.ts`
   * — a client that wants to edit safely reads here, keeps the ETag, and sends
   * it back as `If-Match` on the PATCH below.
   */
  @Get('schedules/:id') @RequirePermissions('system.view') async getSchedule(
    @Req() r: Request,
    @Param('id') id: string,
    @Res({ passthrough: true }) res?: any,
  ) {
    const row = await this.repository.getSchedule(actor(r), uuid(id, 'id'));
    if (!row) throw new NotFoundException('Backup schedule not found');
    setEtagHeader(res, row);
    return row;
  }

  /**
   * Updates a schedule, honouring `If-Match`.
   *
   * Without a precondition this behaves like any other PATCH (last write wins),
   * so existing clients are unaffected. With `If-Match: "<version>"` a stale
   * caller gets 412 instead of silently overwriting the edit it never saw —
   * which for a backup schedule is how a retention window quietly reverts and a
   * restore point stops existing.
   */
  @Patch('schedules/:id') @RequirePermissions('system.manage') async updateSchedule(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
    @Res({ passthrough: true }) res?: any,
  ) {
    const scheduleId = uuid(id, 'id');
    const current = await this.repository.getSchedule(actor(r), scheduleId);
    if (!current) throw new NotFoundException('Backup schedule not found');

    // 412 before any validation work: a stale caller's body describes a
    // resource state that no longer exists, so validating it is meaningless.
    const expectedVersion = assertIfMatch(r.headers['if-match'], current, 'Backup schedule');

    const patch: BackupSchedulePatch = {};
    if (b?.name !== undefined) patch.name = text(b.name, 'name');
    if (b?.cron !== undefined)
      patch.cron = typeof b.cron === 'string' && b.cron.trim() ? b.cron.trim() : null;
    if (b?.intervalMinutes !== undefined) {
      if (b.intervalMinutes === null) patch.intervalMinutes = null;
      else {
        const minutes = Number(b.intervalMinutes);
        if (!Number.isInteger(minutes) || minutes <= 0)
          throw new BadRequestException('intervalMinutes must be a positive integer');
        patch.intervalMinutes = minutes;
        // The next fire time is derived from the interval, so changing one
        // without the other would leave the schedule on its old cadence.
        patch.nextRunAt = new Date(Date.now() + minutes * 60_000);
      }
    }
    if (b?.kind !== undefined) patch.kind = scheduleKind(b.kind);
    if (b?.retentionClass !== undefined)
      patch.retentionClass = scheduleRetentionClass(b.retentionClass);
    if (b?.enabled !== undefined) patch.enabled = b.enabled !== false;

    // A schedule with neither a cron nor an interval would never fire again.
    const cronAfter = patch.cron !== undefined ? patch.cron : current.cron;
    const intervalAfter =
      patch.intervalMinutes !== undefined ? patch.intervalMinutes : current.interval_minutes;
    if (!cronAfter && (intervalAfter === null || intervalAfter === undefined))
      throw new BadRequestException('A schedule must keep either cron or intervalMinutes');

    const row = await this.repository.updateSchedule(actor(r), scheduleId, patch, expectedVersion);
    if (!row) throw new NotFoundException('Backup schedule not found');
    setEtagHeader(res, row);
    return row;
  }
}
