import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ConsoleRepository, Actor } from './console.repository';
import { ExportColumn, ExportService } from '../platform/export.service';
import { ReportJobsService } from '../reporting/report-jobs.service';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const VOLUME_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'period_type', header: 'Period' },
  { key: 'period_start', header: 'From', weight: 2 },
  { key: 'period_end', header: 'To', weight: 2 },
  { key: 'scope', header: 'Scope' },
  { key: 'scope_label', header: 'Name', weight: 3 },
  { key: 'message_count', header: 'Messages' },
  { key: 'dlr_count', header: 'DLRs' },
  { key: 'generated_at', header: 'Generated', weight: 2 },
];

/**
 * In-app notification centre: report deliveries and (future) alert pushes for
 * the signed-in user. Every authenticated user can read their own
 * notifications; no extra permission is needed.
 */
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly repository: ConsoleRepository) {}
  @Get() list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listNotifications(actor(r), q);
  }
  @Get('unread-count') async unread(@Req() r: Request) {
    return { unread: await this.repository.unreadNotificationCount(actor(r)) };
  }
  @Post(':id/read') markRead(@Req() r: Request, @Param('id') id: string) {
    return this.repository.markNotificationRead(actor(r), id);
  }
  @Post('read-all') markAllRead(@Req() r: Request) {
    return this.repository.markAllNotificationsRead(actor(r));
  }
}

/** Persisted daily/weekly message-volume report snapshots. */
@Controller('reports/volume')
@UseGuards(AuthGuard, PermissionsGuard)
export class VolumeReportsController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly jobs?: ReportJobsService,
    private readonly exporter?: ExportService,
  ) {}
  @Get() @RequirePermissions('reports.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listReportSnapshots(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('reports.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('reports.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  /** Force report generation now (normally the scheduler handles this). */
  @Post('run') @RequirePermissions('system.manage') async run() {
    const results = await this.jobs!.runPending();
    return { results };
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listReportSnapshots(actor(r), {
      ...q,
      limit: q.limit ?? 1000,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const basename = `jkannel-volume-report-${stamp}`;
    response.setHeader('x-jkannel-export-row-count', String(page.items.length));
    if (format === 'csv') {
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', `attachment; filename="${basename}.csv"`);
      response.send(this.exporter!.toCsv(page.items, VOLUME_EXPORT_COLUMNS));
      return;
    }
    const pdf = await this.exporter!.toPdf(page.items, VOLUME_EXPORT_COLUMNS, {
      title: 'Message Volume Report',
      requestedBy: r.principal!.username ?? r.principal!.userId,
      rowCount: page.items.length,
    });
    response.setHeader('content-type', 'application/pdf');
    response.setHeader('content-disposition', `attachment; filename="${basename}.pdf"`);
    response.send(pdf);
  }
}
