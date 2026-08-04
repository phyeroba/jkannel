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
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, PlatformConsoleRepository } from './platform-console.repository';
import { RuntimeContainersService } from './runtime-containers.service';
import { ExportColumn, ExportService } from '../platform/export.service';
import { PluginManifestValidator } from '../plugins/plugin-manifest.validator';

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
 * A complete, least-privilege sample plugin manifest. Mirrors
 * docs/specifications/sdk/PLUGIN_DEVELOPMENT_SDK.md §4 and the shipped example at
 * plugins/examples/safe-monitor/plugin.json. Served as a downloadable starting
 * point; checksum/signature are placeholders the author replaces at build time.
 */
export const SAMPLE_PLUGIN_MANIFEST = {
  schemaVersion: '1.0',
  id: 'com.example.health-observer',
  uuid: '00000000-0000-4000-8000-000000000000',
  name: 'Health Observer (sample)',
  vendor: 'Example Vendor',
  version: '1.0.0',
  description: 'A least-privilege sample plugin that observes engine health.',
  category: 'monitoring',
  sdkVersion: '^1.0.0',
  jkannelVersion: { min: '1.0.0', max: '<2.0.0' },
  entrypoint: 'dist/index.js',
  apiVersion: 'v1',
  dependencies: { plugins: {}, services: ['metrics.v1'] },
  permissions: ['monitoring.read'],
  events: {
    subscribes: ['engine.health.changed.v1'],
    publishes: ['plugin.health.observed.v1'],
  },
  capabilities: ['monitor.health.summary'],
  migrations: [],
  configurationSchema: 'config/schema.json',
  license: 'Apache-2.0',
  checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  signature: 'REPLACE_WITH_BASE64_ED25519_SIGNATURE',
  supportUrl: 'https://example.com/support',
  documentationUrl: 'https://example.com/plugins/health-observer',
} as const;

async function streamExport(
  exporter: ExportService,
  response: any,
  format: 'csv' | 'pdf',
  page: { items: Array<Record<string, unknown>> },
  columns: ExportColumn[],
  title: string,
  requestedBy: string,
) {
  const stamp = new Date().toISOString().slice(0, 10);
  const basename = `jkannel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`;
  response.setHeader('x-jkannel-export-row-count', String(page.items.length));
  if (format === 'csv') {
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="${basename}.csv"`);
    response.send(exporter.toCsv(page.items, columns));
    return;
  }
  const pdf = await exporter.toPdf(page.items, columns, {
    title,
    requestedBy,
    rowCount: page.items.length,
  });
  response.setHeader('content-type', 'application/pdf');
  response.setHeader('content-disposition', `attachment; filename="${basename}.pdf"`);
  response.send(pdf);
}

@Controller('api-gateway')
@UseGuards(AuthGuard, PermissionsGuard)
export class ApiGatewayController {
  constructor(
    private readonly repository: PlatformConsoleRepository,
    private readonly exporter?: ExportService,
  ) {}

  @Get('clients') @RequirePermissions('system.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listApiClients(actor(r), q);
  }
  @Get('clients/export.csv') @RequirePermissions('system.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() res?: any,
  ) {
    return this.export(r, 'csv', q, res);
  }
  @Get('clients/export.pdf') @RequirePermissions('system.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() res?: any,
  ) {
    return this.export(r, 'pdf', q, res);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, res: any) {
    const page = await this.repository.listApiClients(actor(r), { ...q, limit: q.limit ?? 500 });
    await streamExport(
      this.exporter!,
      res,
      format,
      page,
      [
        { key: 'name', header: 'Name', weight: 2 },
        { key: 'client_key', header: 'Client key', weight: 2 },
        { key: 'status', header: 'Status' },
        { key: 'rate_limit_per_min', header: 'Rate/min' },
        { key: 'last_used_at', header: 'Last used', weight: 2 },
        { key: 'created_at', header: 'Created', weight: 2 },
      ],
      'API Clients',
      requester(r),
    );
  }
  @Post('clients') @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any) {
    return this.repository.createApiClient(actor(r), { ...b, name: text(b.name, 'name') });
  }
  @Patch('clients/:id') @RequirePermissions('system.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.updateApiClient(actor(r), uuid(id, 'id'), b);
  }
  @Post('clients/:id/rotate-secret') @RequirePermissions('system.manage') rotate(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.rotateApiClientSecret(actor(r), uuid(id, 'id'));
  }
  @Delete('clients/:id') @RequirePermissions('system.manage') revoke(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.deleteApiClient(actor(r), uuid(id, 'id'));
  }
}

@Controller('plugins')
@UseGuards(AuthGuard, PermissionsGuard)
export class PluginsController {
  /**
   * PluginManifestValidator was thorough, tested and had ZERO callers: the
   * install path below inserted posted JSON verbatim after checking only
   * `if (!b.id)`, so an unsigned manifest with wildcard permissions, a
   * traversing entrypoint or a mismatched checksum installed cleanly. It is
   * instantiated directly (rather than injected) because it is stateless and
   * because a DI misconfiguration must not be able to silently skip it.
   */
  private readonly manifests = new PluginManifestValidator();

  constructor(private readonly repository: PlatformConsoleRepository) {}

  @Get() @RequirePermissions('system.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listPlugins(actor(r), q);
  }
  // Declared before ':id' so the literal path matches first. Returns a complete,
  // downloadable sample plugin.json the frontend offers as a starting point;
  // mirrors PLUGIN_DEVELOPMENT_SDK §4 and plugins/examples/safe-monitor.
  @Get('sample-manifest') @RequirePermissions('system.view') sampleManifest() {
    return SAMPLE_PLUGIN_MANIFEST;
  }
  @Get(':id') @RequirePermissions('system.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getPlugin(actor(r), uuid(id, 'id'));
  }
  /**
   * Installs a plugin AFTER validating its manifest. A manifest that fails
   * validation is rejected with the full, path-annotated issue list so the
   * author can fix it — nothing is written to plugin_registrations.
   *
   * In production an approved publisher key (PLUGIN_PUBLISHER_PUBLIC_KEY) is
   * required, so an unsigned or foreign-signed plugin cannot be installed on a
   * production deployment.
   */
  @Post('install') @RequirePermissions('system.manage') install(@Req() r: Request, @Body() b: any) {
    if (!b || typeof b !== 'object' || !b.id)
      throw new BadRequestException('A plugin manifest with an id is required');
    const result = this.manifests.validate(b, {
      production: process.env.NODE_ENV === 'production',
      publisherPublicKeyPem: process.env.PLUGIN_PUBLISHER_PUBLIC_KEY,
    });
    if (!result.valid)
      throw new BadRequestException({
        message: 'Plugin manifest is invalid; the plugin was not installed',
        issues: result.issues,
      });
    return this.repository.installPlugin(actor(r), result.manifest ?? b);
  }
  @Post(':id/enable') @RequirePermissions('system.manage') enable(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.setPluginStatus(actor(r), uuid(id, 'id'), 'enabled');
  }
  @Post(':id/disable') @RequirePermissions('system.manage') disable(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.setPluginStatus(actor(r), uuid(id, 'id'), 'disabled');
  }
}

@Controller('backups')
@UseGuards(AuthGuard, PermissionsGuard)
export class BackupsController {
  constructor(
    private readonly repository: PlatformConsoleRepository,
    private readonly exporter?: ExportService,
  ) {}

  @Get() @RequirePermissions('system.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listBackups(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('system.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() res?: any,
  ) {
    return this.export(r, 'csv', q, res);
  }
  @Get('export.pdf') @RequirePermissions('system.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() res?: any,
  ) {
    return this.export(r, 'pdf', q, res);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, res: any) {
    const page = await this.repository.listBackups(actor(r), { ...q, limit: q.limit ?? 500 });
    await streamExport(
      this.exporter!,
      res,
      format,
      page,
      [
        { key: 'label', header: 'Label', weight: 2 },
        { key: 'kind', header: 'Kind' },
        { key: 'status', header: 'Status' },
        { key: 'size_bytes', header: 'Rows/size' },
        { key: 'checksum', header: 'Checksum', weight: 2 },
        { key: 'started_at', header: 'Started', weight: 2 },
        { key: 'completed_at', header: 'Completed', weight: 2 },
      ],
      'Backups',
      requester(r),
    );
  }
  @Post() @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any = {}) {
    return this.repository.createBackup(actor(r), b);
  }
  @Post(':id/verify') @RequirePermissions('system.manage') verify(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.verifyBackup(actor(r), uuid(id, 'id'));
  }
  @Post(':id/restore') @RequirePermissions('system.manage') restore(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.restoreBackup(actor(r), uuid(id, 'id'), text(b?.reason, 'reason'));
  }
}

@Controller('docker')
@UseGuards(AuthGuard, PermissionsGuard)
export class RuntimeContainersController {
  constructor(private readonly runtime: RuntimeContainersService) {}
  @Get('containers') @RequirePermissions('system.view') list() {
    return this.runtime.list();
  }
}
