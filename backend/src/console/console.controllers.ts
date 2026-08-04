import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { PasswordHasher } from '../security/password-hasher';
import {
  DEFAULT_SECURITY_POLICY,
  SecurityPolicyService,
} from '../security/security-policy.service';
import { ConsoleRepository, Actor, GridPage } from './console.repository';
import { ExportColumn, ExportService } from '../platform/export.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import {
  ConfigurationGeneratorService,
  EngineConfiguration,
} from '../configuration/configuration-generator.service';
import { ConfigurationDeploymentService } from '../configuration/configuration-deployment.service';
import { EngineAdapterRegistry } from '../engine/engine-adapter.registry';
import { ConfigurationDiffService } from '../configuration/configuration-diff.service';
import { ConfigurationModelBuilder } from '../configuration/configuration-model.builder';
import { MissingSecretError } from '../configuration/secret-resolver.service';
import { SmscConnectivityService } from '../smsc/smsc-connectivity.service';
import { SmscService, SmscType } from '../smsc/smsc.service';
import { RoutingService } from '../routing/routing.service';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { MessageSendService } from '../messaging-depth/message-send.service';
import {
  MessageFilters,
  describeMessageFilters,
  parseMessageFilters,
} from '../messaging-depth/message-filters';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});
const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string) => {
  const x = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))
    throw new BadRequestException(`${name} must be a UUID`);
  return x;
};
const optionalUuid = (value: unknown, name: string) =>
  value === undefined || value === null || value === '' ? undefined : uuid(value, name);
const optionalPrefix = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const prefix = text(value, 'destinationPrefix');
  if (!/^\+?[0-9]{1,20}$/.test(prefix))
    throw new BadRequestException('destinationPrefix must be an E.164-like prefix');
  return prefix;
};
const optionalText = (value: unknown, name: string, max: number) => {
  if (value === undefined || value === null || value === '') return undefined;
  const x = text(value, name);
  if (x.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`);
  return x;
};
/**
 * Role names are shown in the console, embedded in JWT `roles` claims and used
 * as the idempotency key of the migration-036 seed, so they are constrained to
 * printable single-line text rather than left free-form.
 */
const roleName = (value: unknown) => {
  const name = text(value, 'name');
  if (name.length > 64) throw new BadRequestException('name must be at most 64 characters');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name))
    throw new BadRequestException(
      'name must start alphanumerically and use only letters, numbers, spaces, dots, underscores and hyphens',
    );
  return name;
};
/**
 * Shape-check a permission code list. Whether each code EXISTS is decided by the
 * repository against the catalogue, in the same transaction as the write, so
 * there is no window in which a deleted permission could be granted.
 */
const permissionCodes = (value: unknown, required: boolean): string[] => {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException('permissions must be an array of permission codes');
    return [];
  }
  if (!Array.isArray(value))
    throw new BadRequestException('permissions must be an array of permission codes');
  return value.map((entry) => {
    const code = text(entry, 'permission code');
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(code))
      throw new BadRequestException(`Invalid permission code: ${code}`);
    return code;
  });
};
const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return number;
};

/**
 * Streams a grid page as a CSV or PDF attachment. Export endpoints are
 * audit-logged by the audit-trail interceptor (path suffix match).
 */
async function sendExport(
  exporter: ExportService,
  response: any,
  format: 'csv' | 'pdf',
  page: GridPage<Record<string, unknown>>,
  columns: ExportColumn[],
  title: string,
  requestedBy: string,
  filtersApplied?: string,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const basename = `jkannel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`;
  response.setHeader('x-jkannel-export-row-count', String(page.items.length));
  response.setHeader('x-jkannel-export-total', String(page.total));
  if (format === 'csv') {
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="${basename}.csv"`);
    response.send(exporter.toCsv(page.items, columns));
    return;
  }
  const pdf = await exporter.toPdf(page.items, columns, {
    title,
    requestedBy,
    filtersApplied,
    rowCount: page.items.length,
  });
  response.setHeader('content-type', 'application/pdf');
  response.setHeader('content-disposition', `attachment; filename="${basename}.pdf"`);
  response.send(pdf);
}

function describeFilters(q: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof q.search === 'string' && q.search) parts.push(`search="${q.search}"`);
  if (typeof q.sort === 'string' && q.sort) parts.push(`sort=${q.sort}`);
  for (const [key, value] of Object.entries(q))
    if (key.startsWith('filter.') && value) parts.push(`${key.slice(7)}=${value}`);
  return parts.length ? parts.join(', ') : undefined;
}

const SMSC_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'name', header: 'Name', weight: 2 },
  { key: 'engine_id', header: 'Engine ID', weight: 2 },
  { key: 'type', header: 'Type' },
  { key: 'host', header: 'Host', weight: 2 },
  { key: 'port', header: 'Port' },
  { key: 'tps', header: 'TPS' },
  { key: 'priority', header: 'Priority' },
  { key: 'enabled', header: 'Enabled' },
  { key: 'lifecycle_state', header: 'State' },
  { key: 'updated_at', header: 'Updated', weight: 2 },
];

@Controller('smscs')
@UseGuards(AuthGuard, PermissionsGuard)
export class SmscController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly engines?: EngineAdapterRegistry,
    private readonly connectivity?: SmscConnectivityService,
    private readonly exporter?: ExportService,
    // Domain validation for the SMSC attribute set. Defaulted so the many
    // direct `new SmscController(repo)` constructions in tests keep the
    // assertion active rather than silently skipping it.
    private readonly domain: SmscService = new SmscService(),
  ) {}
  @Get() @RequirePermissions('smsc.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listSmscs(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('smsc.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('smsc.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listSmscs(actor(r), { ...q, limit: q.limit ?? 500 });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      SMSC_EXPORT_COLUMNS,
      'SMSC Connections',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  @Post() @RequirePermissions('smsc.manage') create(@Req() r: Request, @Body() b: any) {
    const type = text(b.type, 'type');
    if (!['smpp', 'http', 'fake', 'at'].includes(type))
      throw new BadRequestException('Unsupported SMSC type');
    if (!Number.isInteger(b.tps) || b.tps < 1)
      throw new BadRequestException('tps must be a positive integer');
    const engineId = text(
      b.engineId ?? b.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
      'engineId',
    );
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(engineId)) throw new BadRequestException('Invalid engineId');
    const name = text(b.name, 'name');
    const attributes = this.domain.attributesFrom(b);
    // Domain assertion before persistence: this is what stops a plaintext
    // password reaching credential_secret_ref, and it checks the full SMPP
    // attribute set the generator will render.
    const errors = this.domain.validate({
      ...attributes,
      id: engineId,
      name,
      type: type as SmscType,
      host: b.host ?? undefined,
      port: b.port ?? undefined,
      credentialSecretRef: b.credentialSecretRef ?? undefined,
      tps: b.tps,
      enabled: b.enabled ?? true,
    });
    if (errors.length) throw new BadRequestException({ message: 'SMSC validation failed', errors });
    return this.repository.createSmsc(actor(r), { ...b, ...attributes, engineId, name, type });
  }
  @Patch(':id') @RequirePermissions('smsc.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const attributes = this.domain.attributesFrom(b);
    const errors = this.domain.validate({
      ...attributes,
      // Only the supplied fields are validated on a partial update; the
      // identity/type/endpoint checks are satisfied from the stored row by the
      // database constraints.
      id: 'placeholder',
      name: 'placeholder',
      type: 'fake',
      tps: Number.isInteger(b.tps) ? b.tps : 1,
      enabled: true,
      credentialSecretRef: b.credentialSecretRef ?? undefined,
    });
    if (errors.length) throw new BadRequestException({ message: 'SMSC validation failed', errors });
    return this.repository.updateSmsc(actor(r), uuid(id, 'id'), { ...b, ...attributes });
  }
  @Get(':id/deployments') @RequirePermissions('smsc.view') deployments(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.listSmscDeployments(actor(r), uuid(id, 'id'));
  }
  @Get(':id') @RequirePermissions('smsc.view') detail(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getSmscDetail(actor(r), uuid(id, 'id'));
  }
  @Delete(':id') @RequirePermissions('smsc.manage') archive(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.archiveSmsc(actor(r), uuid(id, 'id'));
  }
  @Post(':id/actions/:operation') @RequirePermissions('smsc.manage') async operate(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('operation') operation: string,
    @Headers('idempotency-key') key: string,
  ) {
    const smscId = uuid(id, 'id');
    if (!['enable', 'disable', 'reconnect', 'test'].includes(operation))
      throw new BadRequestException('Unsupported SMSC operation');
    const idempotencyKey = text(key, 'Idempotency-Key');
    if (idempotencyKey.length > 128) throw new BadRequestException('Idempotency-Key is too long');
    const record: any = await this.repository.beginSmscOperation(
      actor(r),
      smscId,
      operation,
      idempotencyKey,
    );
    if (record.replayed || record.status !== 'pending') return record;
    const smsc: any = await this.repository.getSmsc(actor(r), smscId);
    try {
      if (operation === 'test') {
        // A REAL SMPP bind where this container can resolve the credentials;
        // otherwise a TCP check that says, in its own detail text, that it is
        // only a TCP check and why. `verified` carries the level so no caller
        // has to infer it from prose.
        const result = await this.connectivity!.verify(smsc);
        const completed = await this.repository.completeSmscOperation(
          actor(r),
          record.id,
          smscId,
          operation,
          result.passed,
          result.detail,
          result.latencyMs,
          result.verified,
        );
        return { ...completed, verification: result };
      }
      const result = await this.engines!.smscControl(
        process.env.ENGINE_IMPLEMENTATION ?? 'kamex',
      ).controlSmsc(operation as 'enable' | 'disable' | 'reconnect', smsc.engine_id);
      const completed = await this.repository.completeSmscOperation(
        actor(r),
        record.id,
        smscId,
        operation,
        true,
        result.detail,
        undefined,
        // A reconnect records whether the bind cycle was actually observed, so
        // an unverifiable cycle is never indistinguishable from a verified one.
        operation === 'reconnect'
          ? result.states?.cycleVerified
            ? 'bind_cycled'
            : 'command_accepted'
          : undefined,
      );
      return result.states ? { ...completed, states: result.states } : completed;
    } catch (error) {
      await this.repository.completeSmscOperation(
        actor(r),
        record.id,
        smscId,
        operation,
        false,
        (error as Error).message,
      );
      throw error;
    }
  }
}

const ROUTE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'name', header: 'Name', weight: 2 },
  { key: 'priority', header: 'Priority' },
  { key: 'destination_prefix', header: 'Prefix' },
  { key: 'sender', header: 'Sender' },
  { key: 'target_smsc_name', header: 'Target SMSC', weight: 2 },
  { key: 'fallback_smsc_name', header: 'Fallback SMSC', weight: 2 },
  { key: 'enabled', header: 'Enabled' },
  { key: 'deployment_state', header: 'Deployment' },
  { key: 'updated_at', header: 'Updated', weight: 2 },
];

@Controller('routes')
@UseGuards(AuthGuard, PermissionsGuard)
export class RoutesController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly routing?: RoutingService,
    private readonly exporter?: ExportService,
  ) {}
  @Get() @RequirePermissions('routes.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listRoutes(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('routes.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('routes.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listRoutes(actor(r), { ...q, limit: q.limit ?? 500 });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      ROUTE_EXPORT_COLUMNS,
      'Routing Rules',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  @Get('history') @RequirePermissions('routes.view') historyAll(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.repository.listAuditEvents(actor(r), q);
  }
  @Get(':id/history') @RequirePermissions('routes.view') history(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.routeHistory(actor(r), uuid(id, 'id'));
  }
  @Get(':id') @RequirePermissions('routes.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getRoute(actor(r), uuid(id, 'id'));
  }
  @Post() @RequirePermissions('routes.manage') create(@Req() r: Request, @Body() b: any) {
    if (!Number.isInteger(b.priority) || b.priority < 0)
      throw new BadRequestException('priority must be a non-negative integer');
    return this.repository.createRoute(actor(r), {
      ...b,
      name: text(b.name, 'name'),
      destinationPrefix: optionalPrefix(b.destinationPrefix),
      targetSmscId: uuid(b.targetSmscId, 'targetSmscId'),
      fallbackSmscId: optionalUuid(b.fallbackSmscId, 'fallbackSmscId'),
    });
  }
  @Post('simulate') @RequirePermissions('routes.view') async simulate(
    @Req() r: Request,
    @Body() b: any,
  ) {
    const destination = text(b.destination, 'destination');
    if (!/^\+?[0-9]{3,20}$/.test(destination))
      throw new BadRequestException('destination must be an E.164-like address');
    const data = await this.repository.routeSimulationData(actor(r));
    const rules = data.routes.map((row: any) => ({
      id: row.id,
      priority: row.priority,
      enabled: row.enabled,
      destinationPrefix: row.destination_prefix ?? undefined,
      sender: row.sender ?? undefined,
      targetSmscId: row.target_smsc_id,
      fallbackSmscId: row.fallback_smsc_id ?? undefined,
    }));
    try {
      return this.routing!.evaluate(
        {
          messageId: text(b.messageId ?? randomUUID(), 'messageId'),
          destination,
          sender: b.sender,
          now: new Date(),
          healthySmscIds: new Set(data.smscs.map((row: any) => row.id)),
        },
        rules,
      );
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
  @Post(':id/validate') @RequirePermissions('routes.manage') validate(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.validateRoute(actor(r), uuid(id, 'id'), b?.reason);
  }
  @Post(':id/simulate') @RequirePermissions('routes.view') async simulateOne(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const destination = text(b.destination, 'destination');
    if (!/^\+?[0-9]{3,20}$/.test(destination))
      throw new BadRequestException('destination must be an E.164-like address');
    const route: any = await this.repository.getRoute(actor(r), uuid(id, 'id'));
    const data = await this.repository.routeSimulationData(actor(r));
    try {
      return this.routing!.evaluate(
        {
          messageId: text(b.messageId ?? randomUUID(), 'messageId'),
          destination,
          sender: b.sender,
          now: new Date(),
          healthySmscIds: new Set(data.smscs.map((row: any) => row.id)),
        },
        [
          {
            id: route.id,
            priority: route.priority,
            enabled: route.enabled,
            destinationPrefix: route.destination_prefix ?? undefined,
            sender: route.sender ?? undefined,
            targetSmscId: route.target_smsc_id,
            fallbackSmscId: route.fallback_smsc_id ?? undefined,
          },
        ],
      );
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
  @Post(':id/deploy') @RequirePermissions('routes.manage') deploy(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.deployRoute(actor(r), uuid(id, 'id'), b?.reason);
  }
  @Post(':id/rollback') @RequirePermissions('routes.manage') rollback(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.rollbackRoute(actor(r), uuid(id, 'id'), b?.reason);
  }
  @Patch(':id') @RequirePermissions('routes.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    if (b.priority !== undefined && (!Number.isInteger(b.priority) || b.priority < 0))
      throw new BadRequestException('priority must be a non-negative integer');
    return this.repository.updateRoute(actor(r), uuid(id, 'id'), {
      ...b,
      destinationPrefix: optionalPrefix(b.destinationPrefix),
      targetSmscId: optionalUuid(b.targetSmscId, 'targetSmscId'),
      fallbackSmscId: optionalUuid(b.fallbackSmscId, 'fallbackSmscId'),
    });
  }
}

const ALERT_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'summary', header: 'Summary', weight: 3 },
  { key: 'rule_name', header: 'Rule', weight: 2 },
  { key: 'severity', header: 'Severity' },
  { key: 'status', header: 'Status' },
  { key: 'opened_at', header: 'Opened', weight: 2 },
  { key: 'acknowledged_by', header: 'Acknowledged by', weight: 2 },
  { key: 'acknowledged_at', header: 'Acknowledged at', weight: 2 },
];

@Controller('alerts')
@UseGuards(AuthGuard, PermissionsGuard)
export class AlertsController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly notifications?: NotificationDeliveryService,
    private readonly exporter?: ExportService,
  ) {}
  @Get() @RequirePermissions('alerts.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listAlerts(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('alerts.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('alerts.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listAlerts(actor(r), { ...q, limit: q.limit ?? 500 });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      ALERT_EXPORT_COLUMNS,
      'Alerts',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  @Get('rules') @RequirePermissions('alerts.view') rules(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listAlertRules(actor(r), q);
  }
  @Post('rules') @RequirePermissions('system.manage') createRule(
    @Req() r: Request,
    @Body() b: any,
  ) {
    return this.repository.createAlertRule(actor(r), {
      ...b,
      name: text(b.name, 'name'),
      metric: text(b.metric, 'metric'),
      operator: text(b.operator, 'operator'),
      severity: text(b.severity, 'severity'),
    });
  }
  @Get('channels') @RequirePermissions('alerts.view') channels(@Req() r: Request) {
    return this.repository.listNotificationChannels(actor(r));
  }
  @Post('channels') @RequirePermissions('system.manage') createChannel(
    @Req() r: Request,
    @Body() b: any,
  ) {
    const type = text(b.type, 'type');
    if (!['dashboard', 'webhook', 'email', 'sms'].includes(type))
      throw new BadRequestException('Unsupported notification channel type');
    return this.repository.createNotificationChannel(actor(r), {
      ...b,
      name: text(b.name, 'name'),
      type,
    });
  }
  @Post(':id/acknowledgements') @RequirePermissions('alerts.acknowledge') acknowledge(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.acknowledge(actor(r), uuid(id, 'id'), b?.note);
  }
  @Get(':id/notifications') @RequirePermissions('alerts.view') deliveries(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.notificationDeliveries(actor(r), uuid(id, 'id'));
  }
  @Post(':id/notifications') @RequirePermissions('alerts.acknowledge') async notify(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const alert: any = await this.repository.getAlert(actor(r), uuid(id, 'id'));
    const channels = await this.repository.notificationTargets(
      actor(r),
      b?.channelId ? uuid(b.channelId, 'channelId') : undefined,
    );
    const attempts = [];
    for (const channel of channels) {
      const attempt = await this.notifications!.deliver(
        {
          id: alert.id,
          summary: alert.summary,
          status: alert.status,
          severity: alert.severity ?? alert.rule_severity,
          details: alert.details,
          opened_at: alert.opened_at,
        },
        channel as any,
      );
      attempts.push(await this.repository.recordNotificationDelivery(actor(r), alert.id, attempt));
    }
    return { alertId: alert.id, attempts };
  }
}

@Controller('system/settings')
@UseGuards(AuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly repository: ConsoleRepository) {}
  @Get() @RequirePermissions('system.view') list(@Req() r: Request) {
    return this.repository.listSettings(actor(r));
  }
  @Put(':key') @RequirePermissions('system.manage') put(
    @Req() r: Request,
    @Param('key') key: string,
    @Body() b: any,
  ) {
    if (!/^[a-z][a-z0-9_.-]+$/.test(key)) throw new BadRequestException('Invalid setting key');
    if (!Object.prototype.hasOwnProperty.call(b, 'value'))
      throw new BadRequestException('value is required');
    return this.repository.putSetting(actor(r), key, b);
  }
}

const USER_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'username', header: 'Username', weight: 2 },
  { key: 'status', header: 'Status' },
  { key: 'roles', header: 'Roles', weight: 2 },
  { key: 'created_at', header: 'Created', weight: 2 },
  { key: 'updated_at', header: 'Updated', weight: 2 },
];

@Controller('users')
@UseGuards(AuthGuard, PermissionsGuard)
export class UsersController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly exporter?: ExportService,
    private readonly passwords?: PasswordHasher,
    // Resolves the tenant's configured password policy. Optional so unit tests
    // can construct the controller with a repository alone; absent, the strict
    // built-in defaults apply.
    private readonly policies?: SecurityPolicyService,
  ) {}
  /**
   * Validate an operator-set password against the tenant's configured policy
   * (`security.password_min_length` + the four complexity knobs) instead of the
   * hardcoded "12 characters" this path used to apply.
   */
  private async assertPasswordMeetsPolicy(password: string, r: Request): Promise<void> {
    if (this.policies) {
      await this.policies.assertPasswordMeetsPolicy(password, r.principal!.tenantId);
      return;
    }
    SecurityPolicyService.assertPasswordAllowed(password, { ...DEFAULT_SECURITY_POLICY });
  }
  @Get() @RequirePermissions('users.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listUsers(actor(r), q);
  }
  // --- Roles and permissions -------------------------------------------------
  // Reads need users.view, mutations users.manage. Declared ahead of the
  // `:id` user routes so Nest matches `/users/roles*` and `/users/permissions`
  // before them. Every mutation is audited by the repository inside the same
  // transaction as the write, and additionally by the global
  // AuditTrailInterceptor.
  @Get('roles') @RequirePermissions('users.view') roles(@Req() r: Request) {
    return this.repository.listRoles(actor(r));
  }
  /** The permission catalogue a role may draw from: [{code, description, category}]. */
  @Get('permissions') @RequirePermissions('users.view') permissions(@Req() r: Request) {
    return this.repository.listPermissions(actor(r));
  }
  @Post('roles') @RequirePermissions('users.manage') createRole(@Req() r: Request, @Body() b: any) {
    return this.repository.createRole(actor(r), {
      name: roleName(b.name),
      description: optionalText(b.description, 'description', 500),
      permissions: permissionCodes(b.permissions, true),
    });
  }
  @Get('roles/:id') @RequirePermissions('users.view') role(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.getRole(actor(r), uuid(id, 'id'));
  }
  /** `permissions`, when present, REPLACES the role's whole grant set. */
  @Patch('roles/:id') @RequirePermissions('users.manage') updateRole(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const value: {
      name?: string;
      description?: string;
      permissions?: string[];
      reason?: string;
    } = { reason: optionalText(b.reason, 'reason', 500) };
    if (b.name !== undefined) value.name = roleName(b.name);
    if (b.description !== undefined)
      value.description = optionalText(b.description, 'description', 500) ?? '';
    if (b.permissions !== undefined) value.permissions = permissionCodes(b.permissions, false);
    if (
      value.name === undefined &&
      value.description === undefined &&
      value.permissions === undefined
    )
      throw new BadRequestException('Provide at least one of name, description or permissions');
    return this.repository.updateRole(actor(r), uuid(id, 'id'), value);
  }
  @Delete('roles/:id') @RequirePermissions('users.manage') deleteRole(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.deleteRole(actor(r), uuid(id, 'id'));
  }
  @Get('export.csv') @RequirePermissions('users.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('users.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listUsers(actor(r), { ...q, limit: q.limit ?? 500 });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      USER_EXPORT_COLUMNS,
      'Users',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  @Get('invitations') @RequirePermissions('users.view') invitations(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.repository.listInvitations(actor(r), q);
  }
  @Post('invitations') @RequirePermissions('users.invite') invite(
    @Req() r: Request,
    @Body() b: any,
  ) {
    const email = text(b.email, 'email');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Invalid email');
    return this.repository.invite(actor(r), { ...b, email });
  }
  @Post() @RequirePermissions('users.manage') async create(@Req() r: Request, @Body() b: any) {
    const username = text(b.username, 'username');
    if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username))
      throw new BadRequestException('username must be 2–64 chars (letters, numbers, . _ -)');
    const password = text(b.password, 'password');
    await this.assertPasswordMeetsPolicy(password, r);
    const passwordHash = await this.passwords!.hash(password);
    return this.repository.createUser(actor(r), {
      username,
      passwordHash,
      roleIds: Array.isArray(b.roleIds) ? b.roleIds.map((x: unknown) => uuid(x, 'roleId')) : [],
      status: b.status,
    });
  }
  @Get(':id') @RequirePermissions('users.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getUser(actor(r), uuid(id, 'id'));
  }
  @Patch(':id') @RequirePermissions('users.manage') async update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const value: any = { reason: b.reason };
    if (b.status !== undefined) {
      if (!['active', 'disabled', 'locked', 'archived'].includes(b.status))
        throw new BadRequestException('Unsupported user status');
      value.status = b.status;
    }
    if (Array.isArray(b.roleIds)) value.roleIds = b.roleIds.map((x: unknown) => uuid(x, 'roleId'));
    if (b.password !== undefined) {
      const password = text(b.password, 'password');
      await this.assertPasswordMeetsPolicy(password, r);
      value.passwordHash = await this.passwords!.hash(password);
    }
    return this.repository.updateUser(actor(r), uuid(id, 'id'), value);
  }
  @Delete(':id') @RequirePermissions('users.manage') archive(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.archiveUser(actor(r), uuid(id, 'id'));
  }
}

@Controller('configurations')
@UseGuards(AuthGuard, PermissionsGuard)
export class ConfigurationsController {
  constructor(
    private readonly repository: ConsoleRepository,
    private readonly generator?: ConfigurationGeneratorService,
    private readonly deployment?: ConfigurationDeploymentService,
    private readonly differences?: ConfigurationDiffService,
    private readonly exporter?: ExportService,
    // Builds the EngineConfiguration from smsc_definitions. Optional so the
    // controller can still be constructed with a body-supplied model in tests.
    private readonly modelBuilder?: ConfigurationModelBuilder,
  ) {}
  @Get() @RequirePermissions('configuration.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listConfigurations(actor(r), q);
  }
  @Get('history') @RequirePermissions('configuration.view') history(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.repository.listConfigurations(actor(r), q);
  }
  @Get('export.csv') @RequirePermissions('configuration.view') exportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'csv', q, response);
  }
  @Get('export.pdf') @RequirePermissions('configuration.view') exportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.export(r, 'pdf', q, response);
  }
  private async export(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository.listConfigurations(actor(r), {
      ...q,
      limit: q.limit ?? 500,
    });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      [
        { key: 'scope', header: 'Scope' },
        { key: 'version_number', header: 'Version' },
        { key: 'status', header: 'Status' },
        { key: 'change_reason', header: 'Reason', weight: 3 },
        { key: 'created_by', header: 'Created by', weight: 2 },
        { key: 'created_at', header: 'Created', weight: 2 },
        { key: 'deployed_at', header: 'Deployed', weight: 2 },
      ],
      'Configuration Versions',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  // Declared before ':id' so the literal path matches first. Returns a documented
  // STARTER configuration (matching the EngineConfiguration shape that
  // ConfigurationGeneratorService.generate expects) that a user can edit and POST
  // back to /configurations to create the first version.
  @Get('baseline') @RequirePermissions('configuration.view') baseline() {
    const content: EngineConfiguration = {
      adminPort: 13000,
      smsboxPort: 13001,
      adminSecretRef: 'secret://kamex/admin-password',
      logLevel: 1,
      sqlbox: {
        enabled: true,
        host: 'postgres',
        port: 5432,
        database: 'jkannel',
        usernameEnv: 'JKANNEL_SQLBOX_USER',
        passwordEnv: 'JKANNEL_SQLBOX_PASSWORD',
      },
      smsc: [
        {
          id: 'example-smsc',
          type: 'smpp',
          host: 'smsc.example.com',
          port: 2775,
          usernameSecretRef: 'secret://kamex/example-smsc',
          passwordSecretRef: 'secret://kamex/example-smsc-password',
          systemType: 'VMA',
          bindMode: 'transceiver',
          interfaceVersion: 34,
          sourceAddrTon: 5,
          sourceAddrNpi: 0,
          destAddrTon: 1,
          destAddrNpi: 1,
          windowSize: 10,
          throughput: 10,
          keepaliveSeconds: 30,
          reconnectDelaySeconds: 10,
          waitAckSeconds: 60,
          enabled: true,
        },
      ],
      // Without these three groups the gateway starts but accepts no traffic,
      // so the baseline includes them. Shapes match runtime/kamex/kamex.conf.
      smsbox: { bearerboxHost: 'kamex-bearerbox', sendsmsPort: 13013, logLevel: 1 },
      sendsmsUsers: [{ username: 'jkannel', passwordSecretRef: 'secret://kamex/sendsms-password' }],
      smsServices: [{ keyword: 'default', text: 'No service specified' }],
      dlrStorage: { type: 'internal' },
    };
    return {
      scope: 'gateway',
      content,
      description:
        'A baseline Kamex gateway configuration: admin and SMSBox ports, SQLBox ' +
        'persistence, one example authenticated SMPP SMSC, and the smsbox, ' +
        'sendsms-user and sms-service groups a working gateway needs. Edit it, then ' +
        'POST to /configurations to create the first version, or to ' +
        '/configurations/generate to render and natively validate it first.',
      notes: [
        'This is a starter template. POST /configurations/generate with no body renders ' +
          'your tenant’s real SMSC definitions from the database instead.',
        'Replace example-smsc with your real SMSC id, host, port, system type and ' +
          'credential references.',
        'The scope ("gateway") groups a versioned configuration; creating from an edited ' +
          'baseline appends a new version rather than mutating an existing one.',
        'adminSecretRef and each SMSC username/password reference must be secret:// ' +
          'references, never inline credentials; they render as ${ENV} placeholders.',
        'SQLBox usernameEnv/passwordEnv are environment variable names resolved at runtime.',
      ],
    };
  }
  @Get('diff/:id1/:id2') @RequirePermissions('configuration.view') async diff(
    @Req() r: Request,
    @Param('id1') id1: string,
    @Param('id2') id2: string,
  ) {
    const [left, right]: any[] = await Promise.all([
      this.repository.getConfiguration(actor(r), uuid(id1, 'id1')),
      this.repository.getConfiguration(actor(r), uuid(id2, 'id2')),
    ]);
    return {
      from: { id: left.id, version: left.version_number },
      to: { id: right.id, version: right.version_number },
      lines: this.differences!.compare(left.content?.rendered ?? '', right.content?.rendered ?? ''),
    };
  }
  @Get(':id') @RequirePermissions('configuration.view') get(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.getConfiguration(actor(r), uuid(id, 'id'));
  }
  /**
   * Renders and natively validates an engine configuration.
   *
   * The database is the source of truth (CONFIGURATION_GENERATOR spec §5): with
   * no body — how the console calls it — the model is composed from the
   * tenant's own `smsc_definitions` by {@link ConfigurationModelBuilder}, so an
   * SMSC created in the SMSC workspace appears in the generated file.
   *
   * A caller that posts an explicit model still gets it rendered (preview /
   * what-if / existing API clients); the response says which source was used.
   * `?source=database` forces the database even when a body is present, and
   * `?source=body` is the explicit escape hatch.
   */
  @Post('generate') @RequirePermissions('configuration.manage') async generate(
    @Req() r: Request,
    @Body() b: EngineConfiguration | undefined,
    @Query() q: any = {},
  ) {
    const hasBodyModel = Boolean(b && typeof b === 'object' && Object.keys(b).length);
    const requested = q?.source;
    if (requested && !['database', 'body'].includes(requested))
      throw new BadRequestException('source must be "database" or "body"');
    const source = requested ?? (hasBodyModel ? 'body' : 'database');
    if (source === 'body' && !hasBodyModel)
      throw new BadRequestException('source=body requires a configuration model in the body');

    let model: EngineConfiguration;
    let built: Awaited<ReturnType<ConfigurationModelBuilder['build']>> | undefined;
    if (source === 'database') {
      if (!this.modelBuilder)
        throw new BadRequestException('Database-sourced generation is not available');
      built = await this.modelBuilder.build(actor(r));
      model = built.model;
    } else {
      model = b as EngineConfiguration;
    }

    const errors = this.generator!.validate(model);
    if (errors.length)
      throw new BadRequestException({ message: 'Configuration validation failed', errors, source });
    let generated;
    try {
      generated = this.generator!.generate(model);
    } catch (error) {
      // MissingSecretError names the reference and the environment variable
      // it needs — never the secret value.
      if (error instanceof MissingSecretError)
        throw new BadRequestException({
          message: 'Configuration references secrets that are not available',
          references: error.references,
          envNames: error.envNames,
        });
      throw error;
    }
    const nativeValidation = await this.deployment!.validateNative(generated.content);
    return {
      ...generated,
      nativeValidation,
      source,
      model: source === 'database' ? model : undefined,
      sources: built?.sources,
      warning:
        source === 'body'
          ? 'Rendered from the supplied model. The database is the source of truth; ' +
            'call this endpoint without a body (or with ?source=database) to render the ' +
            'tenant’s actual SMSC definitions.'
          : undefined,
    };
  }
  @Post() @RequirePermissions('configuration.manage') create(@Req() r: Request, @Body() b: any) {
    if (!b.content || typeof b.content !== 'object')
      throw new BadRequestException('content object is required');
    return this.repository.createConfiguration(actor(r), {
      ...b,
      scope: text(b.scope, 'scope'),
      reason: text(b.reason, 'reason'),
    });
  }
  @Post('validate') @RequirePermissions('configuration.manage') async validate(@Body() b: any) {
    const rendered = text(b.rendered, 'rendered');
    return this.deployment!.validateNative(rendered);
  }
  @Post('approve') @RequirePermissions('configuration.deploy') approveSelected(
    @Req() r: Request,
    @Body() b: any,
  ) {
    return this.repository.markConfigurationApproved(actor(r), uuid(b.id, 'id'), b?.reason);
  }
  @Post('deploy') @RequirePermissions('configuration.deploy') deploySelected(
    @Req() r: Request,
    @Body() b: any,
  ) {
    return this.deploy(r, uuid(b.id, 'id'));
  }
  @Post('rollback') @RequirePermissions('configuration.deploy') async rollback(
    @Req() r: Request,
    @Body() b: any,
  ) {
    const target: any = await this.repository.getConfiguration(actor(r), uuid(b.id, 'id'));
    const rendered = target.content?.rendered;
    if (typeof rendered !== 'string')
      throw new BadRequestException('Rollback target does not contain rendered configuration');
    await this.deployment!.validateNative(rendered);
    const version: any = await this.repository.createConfiguration(actor(r), {
      scope: target.scope,
      reason: text(b.reason ?? `Rollback to version ${target.version_number}`, 'reason'),
      content: { ...target.content, rollbackOf: target.id },
    });
    await this.repository.markConfigurationApproved(
      actor(r),
      version.id,
      `Approved rollback to version ${target.version_number}`,
    );
    return this.deploy(r, version.id);
  }
  @Post(':id/validate') @RequirePermissions('configuration.manage') async validateVersion(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    const version: any = await this.repository.getConfiguration(actor(r), uuid(id, 'id'));
    const rendered = version.content?.rendered;
    if (typeof rendered !== 'string')
      throw new BadRequestException('Version does not contain rendered configuration');
    const result = await this.deployment!.validateNative(rendered);
    return this.repository.markConfigurationValidated(actor(r), id, result, b?.reason);
  }
  @Post(':id/approve') @RequirePermissions('configuration.deploy') approve(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.repository.markConfigurationApproved(actor(r), uuid(id, 'id'), b?.reason);
  }
  @Post(':id/deploy') @RequirePermissions('configuration.deploy') async deploy(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    const version: any = await this.repository.getConfiguration(actor(r), uuid(id, 'id'));
    if (version.status !== 'approved')
      throw new BadRequestException('Configuration must be approved before deployment');
    const rendered = version.content?.rendered;
    if (typeof rendered !== 'string')
      throw new BadRequestException('Version does not contain rendered configuration');
    const result = await this.deployment!.deploy(rendered);
    return {
      version: await this.repository.markConfigurationDeployed(actor(r), id),
      deployment: result,
    };
  }
}

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class ReadModelsController {
  constructor(
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly engines?: EngineAdapterRegistry,
    private readonly repository?: ConsoleRepository,
    private readonly exporter?: ExportService,
    // THE send path (messaging-depth): routing, blocklist, customer
    // entitlements and the recorded decision. Optional only so the existing
    // controller unit tests can construct it with the collaborators they need.
    private readonly send?: MessageSendService,
  ) {}
  /**
   * SQLBox tables are engine-owned and have no tenant column; every read is
   * restricted to the SMSC identifiers the caller's tenant has defined.
   */
  private async tenantSmscScope(r: Request): Promise<string[]> {
    return this.repository!.listTenantSmscEngineIds(actor(r));
  }
  /**
   * The filter set for the grid and for BOTH exports, from one parser
   * (`parseMessageFilters`). Validation runs before the SQLBox probe so an
   * invalid range is a 400 whether or not the engine store is reachable.
   */
  private messageFilters(q: any, limits: { defaultLimit: number; maxLimit: number }) {
    return parseMessageFilters(q, limits);
  }
  private exportLimits() {
    const maxLimit = Number(process.env.SQLBOX_EXPORT_MAX_ROWS ?? 5000);
    return { defaultLimit: Math.min(500, maxLimit), maxLimit };
  }
  @Get('messages') @RequirePermissions('messages.view') async messages(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    const filters = this.messageFilters(q, { defaultLimit: 100, maxLimit: 500 });
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        items: [],
        nextCursor: null,
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    const page = await this.sqlbox.list({
      ...filters,
      allowedSmscIds: await this.tenantSmscScope(r),
    });
    return {
      ...page,
      // Echoed so the console (and an export raised from it) can prove the two
      // were asked the same question.
      filters: { ...filters, description: describeMessageFilters(filters) ?? null },
      source: { status: 'available', type: 'kamex-sqlbox' },
    };
  }
  @Get('messages/export.csv') @RequirePermissions('messages.export') async exportMessages(
    @Req() r: Request,
    @Query() q: any,
    @Res() response: any,
  ) {
    // Identical parse to the grid: the export cannot honour a narrower set.
    const filters = this.messageFilters(q, this.exportLimits());
    const probe = await this.sqlbox.probe();
    if (!probe.available) {
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      // Say so rather than let an empty file read as "no matching messages".
      response.setHeader('x-jkannel-export-row-count', '0');
      response.setHeader('x-jkannel-source-status', 'unavailable');
      response.send(KamexSqlboxRepository.exportHeaderRow());
      return;
    }
    const exported = await this.sqlbox.exportCsv({
      ...filters,
      allowedSmscIds: await this.tenantSmscScope(r),
    });
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="${exported.filename}"`);
    response.setHeader('x-jkannel-export-row-count', String(exported.rowCount));
    response.setHeader('x-jkannel-source-status', 'available');
    const description = describeMessageFilters(filters);
    if (description) response.setHeader('x-jkannel-export-filters', description);
    if (exported.nextCursor)
      response.setHeader('x-jkannel-next-cursor', String(exported.nextCursor));
    response.send(exported.content);
  }
  @Get('messages/:id/trace') @RequirePermissions('messages.view') async messageTrace(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        id,
        events: [],
        summary: { eventCount: 0, finalStatus: 'unavailable' },
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    return {
      ...(await this.sqlbox.trace(id, await this.tenantSmscScope(r))),
      source: { status: 'available', type: 'kamex-sqlbox' },
    };
  }
  @Get('messages/retention/status') @RequirePermissions('system.view') async retentionStatus(
    @Query() q: any = {},
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    return this.sqlbox.retentionStatus({
      olderThanDays: boundedInt(
        q.olderThanDays,
        'olderThanDays',
        1,
        3650,
        Number(process.env.SQLBOX_RETENTION_DAYS ?? 90),
      ),
      dryRun: true,
    });
  }
  @Post('messages/retention/apply') @RequirePermissions('system.manage') async applyRetention(
    @Body() b: any = {},
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
        applied: false,
        deletedRows: 0,
      };
    return this.sqlbox.applyRetention({
      olderThanDays: boundedInt(
        b.olderThanDays,
        'olderThanDays',
        1,
        3650,
        Number(process.env.SQLBOX_RETENTION_DAYS ?? 90),
      ),
      dryRun: b.dryRun !== false,
    });
  }
  @Post('messages/indexes') @RequirePermissions('system.manage') async ensureMessageIndexes() {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    return this.sqlbox.ensureIndexes();
  }
  /**
   * Submit one message.
   *
   * `smscId` is now OPTIONAL. Omit it and the routing engine chooses the bind
   * from the tenant's DEPLOYED routes and live bind health, records the decision
   * in message_route_decisions, and refuses the send outright when nothing
   * matches — it never falls back to an arbitrary carrier. Supplying it pins the
   * bind exactly as before (and is still validated against the tenant's own
   * SMSCs before anything else happens).
   *
   * `customerId` attributes the message so the customer's blocklist, approved
   * sender IDs, route bindings, quota and credit are enforced inside the same
   * transaction as the send.
   */
  @Post('messages') @RequirePermissions('configuration.manage') async submit(
    @Req() r: Request,
    @Body() b: any,
  ) {
    const allowed = await this.tenantSmscScope(r);
    const smscId =
      b?.smscId === undefined || b?.smscId === null || b?.smscId === ''
        ? null
        : text(b.smscId, 'smscId');
    if (smscId && !allowed.includes(smscId))
      throw new BadRequestException('smscId must reference one of your tenant’s SMSCs');
    return this.send!.send(actor(r), {
      sender: text(b.sender, 'sender'),
      receiver: text(b.receiver, 'receiver'),
      text: text(b.text, 'text'),
      smscId,
      dlrMask: b.dlrMask,
      dlrUrl: b.dlrUrl,
      foreignId: b.foreignId,
      customerId: optionalUuid(b.customerId, 'customerId') ?? null,
      channel: 'console',
      operator: typeof b.operator === 'string' ? b.operator : null,
    });
  }
  @Get('queues') @RequirePermissions('messages.view') async queues(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        items: [],
        nextCursor: null,
        queued: null,
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    const allowed = await this.tenantSmscScope(r);
    const [page, summary] = await Promise.all([
      this.sqlbox.listQueue({
        limit: boundedInt(q.limit, 'limit', 1, 500, 100),
        cursor: q.cursor
          ? boundedInt(q.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER, 0)
          : undefined,
        query: q.query,
        smscId: q.smscId,
        allowedSmscIds: allowed,
      }),
      this.sqlbox.queueSummary(allowed),
    ]);
    return { ...page, summary, source: { status: 'available', type: 'kamex-sqlbox' } };
  }
  @Get('reports/delivery') @RequirePermissions('reports.view') async reports(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return {
        items: [],
        nextCursor: null,
        summary: null,
        source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: probe.evidence },
      };
    const page = await this.sqlbox.list({
      ...this.messageFilters(q, { defaultLimit: 100, maxLimit: 500 }),
      // This report is, by definition, the delivery-receipt rows.
      direction: 'DLR',
      allowedSmscIds: await this.tenantSmscScope(r),
    });
    return {
      ...page,
      summary: { total: page.items.length, nextCursor: page.nextCursor },
      source: { status: 'available', type: 'kamex-sqlbox' },
    };
  }
  @Get('reports/delivery/export.csv') @RequirePermissions('reports.view') async deliveryExport(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    const probe = await this.sqlbox.probe();
    if (!probe.available) {
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('x-jkannel-export-row-count', '0');
      response.setHeader('x-jkannel-source-status', 'unavailable');
      response.send(KamexSqlboxRepository.exportHeaderRow());
      return;
    }
    const exported = await this.sqlbox.exportCsv({
      ...this.messageFilters(q, this.exportLimits()),
      // This report is, by definition, the delivery-receipt rows.
      direction: 'DLR',
      allowedSmscIds: await this.tenantSmscScope(r),
    });
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="${exported.filename}"`);
    response.setHeader('x-jkannel-export-row-count', String(exported.rowCount));
    response.send(exported.content);
  }
  @Get('monitoring') @RequirePermissions('monitoring.view') async monitoring() {
    const adapter = this.engines!.forImplementation(process.env.ENGINE_IMPLEMENTATION ?? 'kamex');
    const [identity, health, capabilities, diagnostics] = await Promise.all([
      adapter.identify(),
      adapter.health(),
      adapter.discoverCapabilities(),
      adapter.coreDiagnostics(),
    ]);
    return {
      items: [
        {
          id: identity.instanceId,
          name: `${identity.family} ${identity.version}`,
          status: health.engine,
          detail: `transport ${health.transport}`,
          updatedAt: health.observedAt,
        },
      ],
      identity,
      health,
      capabilities,
      diagnostics,
    };
  }
  @Get('engine/capabilities') @RequirePermissions('system.view') capabilities() {
    return this.engines!.forImplementation(
      process.env.ENGINE_IMPLEMENTATION ?? 'kamex',
    ).discoverCapabilities();
  }
  @Get('audit-events') @RequirePermissions('system.view') auditEvents(
    @Req() r: Request,
    @Query() q: any = {},
  ) {
    return this.repository!.listAuditEvents(actor(r), q);
  }
  @Get('audit-events/export.csv') @RequirePermissions('system.view') auditExportCsv(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.auditExport(r, 'csv', q, response);
  }
  @Get('audit-events/export.pdf') @RequirePermissions('system.view') auditExportPdf(
    @Req() r: Request,
    @Query() q: any = {},
    @Res() response?: any,
  ) {
    return this.auditExport(r, 'pdf', q, response);
  }
  private async auditExport(r: Request, format: 'csv' | 'pdf', q: any, response: any) {
    const page = await this.repository!.listAuditEvents(actor(r), { ...q, limit: q.limit ?? 1000 });
    await sendExport(
      this.exporter!,
      response,
      format,
      page,
      [
        { key: 'created_at', header: 'When', weight: 2 },
        { key: 'actor_id', header: 'Who', weight: 2 },
        { key: 'action', header: 'Action', weight: 2 },
        { key: 'entity_type', header: 'Entity type' },
        { key: 'entity_id', header: 'Entity', weight: 2 },
        { key: 'reason', header: 'Reason', weight: 2 },
        { key: 'correlation_id', header: 'Correlation', weight: 2 },
        { key: 'source_ip', header: 'Source IP' },
      ],
      'Audit Events',
      r.principal!.username ?? r.principal!.userId,
      describeFilters(q),
    );
  }
  // Declared after the export routes so the literal paths match first.
  @Get('audit-events/:id') @RequirePermissions('system.view') auditEvent(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository!.getAuditEvent(actor(r), uuid(id, 'id'));
  }
  @Get('messages/export.pdf') @RequirePermissions('messages.export') async exportMessagesPdf(
    @Req() r: Request,
    @Query() q: any,
    @Res() response?: any,
  ) {
    // Same parser as the grid and the CSV export — see parseMessageFilters.
    const filters: MessageFilters = this.messageFilters(q, this.exportLimits());
    const probe = await this.sqlbox.probe();
    const page = probe.available
      ? await this.sqlbox.list({ ...filters, allowedSmscIds: await this.tenantSmscScope(r) })
      : { items: [] as Array<Record<string, unknown>>, nextCursor: null };
    await sendExport(
      this.exporter!,
      response,
      'pdf',
      { items: page.items, total: page.items.length, limit: filters.limit ?? 500, offset: 0 },
      [
        { key: 'id', header: 'ID' },
        { key: 'timestamp', header: 'Timestamp', weight: 2 },
        { key: 'direction', header: 'Dir' },
        { key: 'deliveryStatus', header: 'Delivery' },
        { key: 'sender', header: 'Sender', weight: 2 },
        { key: 'receiver', header: 'Receiver', weight: 2 },
        { key: 'smscId', header: 'SMSC' },
        { key: 'segments', header: 'Parts' },
        { key: 'coding', header: 'DCS' },
        { key: 'externalRef', header: 'External ref', weight: 2 },
        { key: 'text', header: 'Text', weight: 3 },
      ],
      'Messages',
      r.principal!.username ?? r.principal!.userId,
      // The applied filter set, not the raw query string: what the reader needs
      // is which rows this page is a subset of.
      describeMessageFilters(filters) ??
        (probe.available ? undefined : 'SQLBox unavailable — no rows could be read'),
    );
  }
}
