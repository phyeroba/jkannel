import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions.guard';
import { SessionActor, SessionAdminRepository } from './session-admin.repository';
import { ExportService } from '../platform/export.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

@Controller('sessions')
@UseGuards(AuthGuard, PermissionsGuard)
export class SessionsController {
  constructor(
    private readonly sessions: SessionAdminRepository,
    private readonly exporter?: ExportService,
  ) {}

  private actor(request: AuthenticatedRequest): SessionActor {
    return { tenantId: request.principal!.tenantId, userId: request.principal!.userId };
  }

  private options(query: Record<string, unknown>, limit = 50) {
    const userId = query.userId;
    if (userId !== undefined && userId !== '' && !UUID.test(String(userId)))
      throw new BadRequestException('userId must be a UUID');
    return {
      userId: userId ? String(userId) : undefined,
      active: query.active === 'true' || query.active === true,
      search: typeof query.search === 'string' ? query.search : undefined,
      sort: typeof query.sort === 'string' ? query.sort : undefined,
      limit: boundedInt(query.limit, 'limit', 1, 500, limit),
      offset: boundedInt(query.offset, 'offset', 0, 5_000_000, 0),
    };
  }

  @Get()
  @RequirePermissions('users.sessions')
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.sessions.listSessions(this.actor(request), this.options(query));
  }

  @Get('export.csv')
  @RequirePermissions('users.sessions')
  exportCsv(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
    @Res() response?: any,
  ) {
    return this.export(request, 'csv', query, response);
  }

  @Get('export.pdf')
  @RequirePermissions('users.sessions')
  exportPdf(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
    @Res() response?: any,
  ) {
    return this.export(request, 'pdf', query, response);
  }

  private async export(
    request: AuthenticatedRequest,
    format: 'csv' | 'pdf',
    query: Record<string, unknown>,
    response: any,
  ) {
    const page = await this.sessions.listSessions(this.actor(request), this.options(query, 500));
    const columns = [
      { key: 'username', header: 'Username', weight: 2 },
      { key: 'ip_address', header: 'IP address', weight: 2 },
      { key: 'user_agent', header: 'User agent', weight: 3 },
      { key: 'created_at', header: 'Created', weight: 2 },
      { key: 'last_seen_at', header: 'Last seen', weight: 2 },
      { key: 'expires_at', header: 'Expires', weight: 2 },
      { key: 'revoked_at', header: 'Revoked', weight: 2 },
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    response.setHeader('x-jkannel-export-row-count', String(page.items.length));
    if (format === 'csv') {
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader(
        'content-disposition',
        `attachment; filename="jkannel-sessions-${stamp}.csv"`,
      );
      response.send(this.exporter!.toCsv(page.items as any, columns));
      return;
    }
    const pdf = await this.exporter!.toPdf(page.items as any, columns, {
      title: 'Active Sessions',
      requestedBy: request.principal!.username ?? request.principal!.userId,
      rowCount: page.items.length,
    });
    response.setHeader('content-type', 'application/pdf');
    response.setHeader(
      'content-disposition',
      `attachment; filename="jkannel-sessions-${stamp}.pdf"`,
    );
    response.send(pdf);
  }

  // After the literal `export.*` routes above, so `:id` cannot swallow them.
  @Get(':id')
  @RequirePermissions('users.sessions')
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sessions.getSession(this.actor(request), id);
  }

  @Post(':id/revoke')
  @RequirePermissions('users.sessions')
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a UUID');
    return this.sessions.revokeSession(this.actor(request), id);
  }
}
