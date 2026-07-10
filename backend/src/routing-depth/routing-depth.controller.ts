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
import { Actor, RouteInput, RoutingDepthRepository, TargetInput } from './routing-depth.repository';
import { RoutingDepthService } from './routing-depth.service';
import { RouteType, SelectionStrategy } from './route-selection';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const ROUTE_TYPES: RouteType[] = ['static', 'prefix', 'country', 'operator', 'weighted'];
const STRATEGIES: SelectionStrategy[] = [
  'priority',
  'least-cost',
  'load-balance',
  'round-robin',
  'time-based',
];

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
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalPriority = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new BadRequestException('priority must be a non-negative integer');
  return value as number;
};

const optionalCost = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`${name} must be >= 0`);
  return n;
};

const optionalRouteType = (value: unknown): RouteType | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const v = text(value, 'routeType') as RouteType;
  if (!ROUTE_TYPES.includes(v))
    throw new BadRequestException(`routeType must be one of ${ROUTE_TYPES.join(', ')}`);
  return v;
};

const optionalStrategy = (value: unknown): SelectionStrategy | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const v = text(value, 'strategy') as SelectionStrategy;
  if (!STRATEGIES.includes(v))
    throw new BadRequestException(`strategy must be one of ${STRATEGIES.join(', ')}`);
  return v;
};

const optionalTime = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const v = text(value, name);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    throw new BadRequestException(`${name} must be HH:MM (24h)`);
  return v;
};

const optionalDays = (value: unknown): number[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException('activeDays must be an array of 0-6');
  return value.map((d) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6)
      throw new BadRequestException('activeDays entries must be integers 0-6 (0=Sunday)');
    return n;
  });
};

const optionalTargets = (value: unknown): TargetInput[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException('targets must be an array');
  return value.map((raw, index) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const smscId = uuid(t.smscId, `targets[${index}].smscId`);
    const weight = t.weight === undefined ? 1 : Number(t.weight);
    if (!Number.isInteger(weight) || weight < 0)
      throw new BadRequestException(`targets[${index}].weight must be a non-negative integer`);
    return {
      smscId,
      weight,
      cost: optionalCost(t.cost, `targets[${index}].cost`) ?? null,
      enabled: t.enabled === undefined ? true : Boolean(t.enabled),
    };
  });
};

/**
 * Advanced routing depth API. All endpoints are tenant-scoped, guarded by the
 * existing routes.view / routes.manage permissions, and mutations are audited
 * (route_versions snapshot + audit_log) inside the repository. The `resolve`
 * endpoint previews which SMSC a destination would be sent through and why.
 */
@Controller('routing')
@UseGuards(AuthGuard, PermissionsGuard)
export class RoutingDepthController {
  constructor(
    private readonly repository: RoutingDepthRepository,
    private readonly service: RoutingDepthService,
  ) {}

  @Get('routes') @RequirePermissions('routes.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listRoutes(actor(r), q);
  }

  @Post('routes') @RequirePermissions('routes.manage') create(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const value = this.parseInput(b, true) as RouteInput;
    return this.repository.createRoute(actor(r), value);
  }

  @Post('resolve') @RequirePermissions('routes.view') resolve(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const msisdn = text(b.msisdn, 'msisdn');
    const rotation = b.rotation === undefined ? undefined : Number(b.rotation);
    if (rotation !== undefined && (!Number.isInteger(rotation) || rotation < 0))
      throw new BadRequestException('rotation must be a non-negative integer');
    let availableSmscIds: string[] | null | undefined;
    if (b.availableSmscIds !== undefined && b.availableSmscIds !== null) {
      if (!Array.isArray(b.availableSmscIds))
        throw new BadRequestException('availableSmscIds must be an array of SMSC ids');
      availableSmscIds = b.availableSmscIds.map((id: unknown) =>
        uuid(id, 'availableSmscIds entry'),
      );
    }
    let at: Date | undefined;
    if (b.at !== undefined && b.at !== null) {
      at = new Date(b.at);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('at must be an ISO timestamp');
    }
    return this.service.resolve(actor(r), {
      msisdn,
      sender: optionalText(b.sender) ?? null,
      operator: optionalText(b.operator) ?? null,
      availableSmscIds: availableSmscIds ?? null,
      rotation,
      at,
    });
  }

  @Get('routes/:id') @RequirePermissions('routes.view') get(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.getRoute(actor(r), uuid(id, 'id'));
  }

  @Patch('routes/:id') @RequirePermissions('routes.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const value = this.parseInput(b, false);
    return this.repository.updateRoute(actor(r), uuid(id, 'id'), value);
  }

  @Delete('routes/:id') @RequirePermissions('routes.manage') archive(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.repository.archiveRoute(actor(r), uuid(id, 'id'), optionalText(b?.reason));
  }

  @Get('routes/:id/versions') @RequirePermissions('routes.view') versions(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.listVersions(actor(r), uuid(id, 'id'));
  }

  @Get('routes/:id/versions/:version') @RequirePermissions('routes.view') version(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1)
      throw new BadRequestException('version must be a positive integer');
    return this.repository.getVersion(actor(r), uuid(id, 'id'), n);
  }

  /** Shared body parser; `requireCore` enforces the fields needed to create. */
  private parseInput(b: any, requireCore: boolean): Partial<RouteInput> {
    const value: Partial<RouteInput> = {
      name: requireCore ? text(b.name, 'name') : optionalText(b.name),
      priority: requireCore
        ? (optionalPriority(b.priority) ??
          (() => {
            throw new BadRequestException('priority is required');
          })())
        : optionalPriority(b.priority),
      enabled: b.enabled === undefined ? undefined : Boolean(b.enabled),
      routeType: optionalRouteType(b.routeType),
      strategy: optionalStrategy(b.strategy),
      matchPrefix: optionalText(b.matchPrefix),
      countryCode: optionalText(b.countryCode),
      operator: optionalText(b.operator),
      destinationPrefix: optionalText(b.destinationPrefix),
      sender: optionalText(b.sender),
      cost: optionalCost(b.cost, 'cost'),
      targetSmscId: requireCore
        ? uuid(b.targetSmscId, 'targetSmscId')
        : b.targetSmscId === undefined
          ? undefined
          : uuid(b.targetSmscId, 'targetSmscId'),
      fallbackSmscId:
        b.fallbackSmscId === undefined ? undefined : uuid(b.fallbackSmscId, 'fallbackSmscId'),
      windowStart: optionalTime(b.windowStart, 'windowStart'),
      windowEnd: optionalTime(b.windowEnd, 'windowEnd'),
      activeDays: optionalDays(b.activeDays),
      targets: optionalTargets(b.targets),
      reason: optionalText(b.reason),
    };
    if ((value.routeType ?? (requireCore ? 'static' : undefined)) === 'weighted') {
      if (requireCore && (!value.targets || value.targets.length === 0))
        throw new BadRequestException('a weighted route requires at least one target');
    }
    return value;
  }
}
