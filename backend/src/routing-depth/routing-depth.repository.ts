import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition, buildGridSql, parseListQuery } from '../platform/list-query';
import { CandidateRoute, RouteType, SelectionStrategy, TimeWindow } from './route-selection';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface GridPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** A weighted target as accepted from the API / stored in route_targets. */
export interface TargetInput {
  smscId: string;
  weight?: number;
  cost?: number | null;
  enabled?: boolean;
}

/** Advanced route configuration input (create/update). */
export interface RouteInput {
  name: string;
  priority: number;
  enabled?: boolean;
  routeType?: RouteType;
  strategy?: SelectionStrategy;
  matchPrefix?: string | null;
  countryCode?: string | null;
  operator?: string | null;
  destinationPrefix?: string | null;
  sender?: string | null;
  cost?: number | null;
  targetSmscId: string;
  fallbackSmscId?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  activeDays?: number[] | null;
  targets?: TargetInput[];
  reason?: string;
}

interface RouteRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  route_type: RouteType;
  strategy: SelectionStrategy;
  match_prefix: string | null;
  country_code: string | null;
  operator: string | null;
  destination_prefix: string | null;
  sender: string | null;
  cost: string | null;
  target_smsc_id: string;
  fallback_smsc_id: string | null;
  window_start: string | null;
  window_end: string | null;
  active_days: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetRow extends QueryResultRow {
  id: string;
  route_id: string;
  smsc_id: string;
  weight: number;
  cost: string | null;
  enabled: boolean;
}

const ROUTE_COLUMNS =
  'id,tenant_id,name,priority,enabled,route_type,strategy,match_prefix,country_code,operator,destination_prefix,sender,cost,target_smsc_id,fallback_smsc_id,window_start,window_end,active_days,created_at,updated_at';

export const ROUTING_GRIDS = {
  routes: {
    searchColumns: ['name', 'match_prefix', 'country_code', 'operator'],
    sortColumns: {
      name: 'name',
      priority: 'priority',
      routeType: 'route_type',
      strategy: 'strategy',
      createdAt: 'created_at',
    },
    filterColumns: {
      routeType: 'route_type',
      strategy: 'strategy',
      enabled: 'enabled',
    },
    defaultOrderBy: 'priority, name',
  },
} satisfies Record<string, GridDefinition>;

/** "HH:MM:SS"/"HH:MM" -> "HH:MM"; null passthrough. */
function toHhmm(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : value;
}

/** "0,1,5" -> [0,1,5]; null/empty -> undefined. */
function parseActiveDays(value: string | null): number[] | undefined {
  if (!value) return undefined;
  const days = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? days : undefined;
}

/**
 * Persistence for advanced routing depth. Every access runs inside a tenant
 * transaction so row level security (migrations 004 / 025) enforces isolation;
 * every mutation writes a route_versions snapshot and an audit_log row.
 */
@Injectable()
export class RoutingDepthRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A route with that name or priority already exists');
      throw error;
    }
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    id: string,
    oldValue: unknown,
    newValue: unknown,
    reason?: string,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.tenantId,
        actor.userId,
        action,
        'route',
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  private async loadTargets(client: PoolClient, routeId: string): Promise<TargetRow[]> {
    return (
      await client.query<TargetRow>(
        'SELECT id,route_id,smsc_id,weight,cost,enabled FROM route_targets WHERE route_id=$1 ORDER BY created_at,id',
        [routeId],
      )
    ).rows;
  }

  /** Replace the weighted targets of a route with the provided set. */
  private async replaceTargets(
    client: PoolClient,
    actor: Actor,
    routeId: string,
    targets: TargetInput[],
  ): Promise<void> {
    await client.query('DELETE FROM route_targets WHERE route_id=$1', [routeId]);
    for (const target of targets) {
      await client.query(
        'INSERT INTO route_targets(tenant_id,route_id,smsc_id,weight,cost,enabled) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          routeId,
          target.smscId,
          target.weight ?? 1,
          target.cost ?? null,
          target.enabled ?? true,
        ],
      );
    }
  }

  /** Capture the next route_versions snapshot for a route (returns the version). */
  private async snapshotVersion(
    client: PoolClient,
    actor: Actor,
    routeId: string,
    reason: string | undefined,
  ): Promise<number> {
    const route = (
      await client.query<RouteRow>(`SELECT ${ROUTE_COLUMNS} FROM routing_rules WHERE id=$1`, [
        routeId,
      ])
    ).rows[0];
    const targets = await this.loadTargets(client, routeId);
    const version =
      (
        await client.query<{ next: number }>(
          'SELECT COALESCE(MAX(version),0)+1 AS next FROM route_versions WHERE route_id=$1',
          [routeId],
        )
      ).rows[0].next ?? 1;
    await client.query(
      'INSERT INTO route_versions(tenant_id,route_id,version,definition,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenantId,
        routeId,
        version,
        JSON.stringify({ route, targets }),
        reason ?? null,
        actor.userId,
      ],
    );
    return version;
  }

  private mapRoute(route: RouteRow, targets: TargetRow[]) {
    return {
      id: route.id,
      name: route.name,
      priority: route.priority,
      enabled: route.enabled,
      routeType: route.route_type,
      strategy: route.strategy,
      matchPrefix: route.match_prefix,
      countryCode: route.country_code,
      operator: route.operator,
      destinationPrefix: route.destination_prefix,
      sender: route.sender,
      cost: route.cost === null ? null : Number(route.cost),
      targetSmscId: route.target_smsc_id,
      fallbackSmscId: route.fallback_smsc_id,
      window: {
        start: toHhmm(route.window_start),
        end: toHhmm(route.window_end),
        days: parseActiveDays(route.active_days) ?? null,
      },
      targets: targets.map((t) => ({
        id: t.id,
        smscId: t.smsc_id,
        weight: t.weight,
        cost: t.cost === null ? null : Number(t.cost),
        enabled: t.enabled,
      })),
      createdAt: route.created_at,
      updatedAt: route.updated_at,
    };
  }

  async listRoutes(actor: Actor, query: Record<string, unknown> = {}): Promise<GridPage<unknown>> {
    const parsed = parseListQuery(query, ROUTING_GRIDS.routes);
    const fragments = buildGridSql(parsed, ROUTING_GRIDS.routes, []);
    const where = fragments.andWhere ? `WHERE ${fragments.andWhere.slice(' AND '.length)}` : '';
    const sql = `SELECT ${ROUTE_COLUMNS}, count(*) OVER() AS __total FROM routing_rules ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      const result = await client.query<RouteRow & { __total: string }>(sql, fragments.params);
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = await Promise.all(
        result.rows.map(async ({ __total, ...row }) => {
          const targets =
            row.route_type === 'weighted' ? await this.loadTargets(client, row.id) : [];
          return this.mapRoute(row as RouteRow, targets);
        }),
      );
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
  }

  async getRoute(actor: Actor, id: string) {
    return this.inTenant(actor, async (client) => {
      const route = (
        await client.query<RouteRow>(`SELECT ${ROUTE_COLUMNS} FROM routing_rules WHERE id=$1`, [id])
      ).rows[0];
      if (!route) throw new NotFoundException('Route not found');
      const targets = await this.loadTargets(client, id);
      return this.mapRoute(route, targets);
    });
  }

  async createRoute(actor: Actor, value: RouteInput) {
    return this.inTenant(actor, async (client) => {
      const conflict = (
        await client.query<{ id: string; name: string }>(
          'SELECT id,name FROM routing_rules WHERE priority=$1 AND enabled=true',
          [value.priority],
        )
      ).rows[0];
      if (conflict && (value.enabled ?? true))
        throw new ConflictException(
          `Priority ${value.priority} is already used by ${conflict.name}`,
        );
      const route = (
        await client.query<RouteRow>(
          `INSERT INTO routing_rules
             (tenant_id,name,priority,enabled,destination_prefix,sender,target_smsc_id,fallback_smsc_id,
              route_type,strategy,match_prefix,country_code,operator,cost,window_start,window_end,active_days,created_by)
           VALUES ($1,$2,$3,COALESCE($4,true),$5,$6,$7,$8,
                   COALESCE($9,'static'),COALESCE($10,'priority'),$11,$12,$13,$14,$15,$16,$17,$18)
           RETURNING ${ROUTE_COLUMNS}`,
          [
            actor.tenantId,
            value.name,
            value.priority,
            value.enabled ?? null,
            value.destinationPrefix ?? null,
            value.sender ?? null,
            value.targetSmscId,
            value.fallbackSmscId ?? null,
            value.routeType ?? null,
            value.strategy ?? null,
            value.matchPrefix ?? null,
            value.countryCode ?? null,
            value.operator ?? null,
            value.cost ?? null,
            value.windowStart ?? null,
            value.windowEnd ?? null,
            value.activeDays && value.activeDays.length ? value.activeDays.join(',') : null,
            actor.userId,
          ],
        )
      ).rows[0];
      if (value.targets && value.targets.length)
        await this.replaceTargets(client, actor, route.id, value.targets);
      await this.snapshotVersion(client, actor, route.id, value.reason ?? 'created');
      await this.audit(
        client,
        actor,
        'route.advanced.created',
        route.id,
        null,
        route,
        value.reason,
      );
      const targets = await this.loadTargets(client, route.id);
      return this.mapRoute(route, targets);
    });
  }

  async updateRoute(actor: Actor, id: string, value: Partial<RouteInput>) {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<RouteRow>(`SELECT ${ROUTE_COLUMNS} FROM routing_rules WHERE id=$1`, [id])
      ).rows[0];
      if (!old) throw new NotFoundException('Route not found');
      const route = (
        await client.query<RouteRow>(
          `UPDATE routing_rules SET
             name=COALESCE($2,name),
             priority=COALESCE($3,priority),
             enabled=COALESCE($4,enabled),
             destination_prefix=COALESCE($5,destination_prefix),
             sender=COALESCE($6,sender),
             target_smsc_id=COALESCE($7,target_smsc_id),
             fallback_smsc_id=COALESCE($8,fallback_smsc_id),
             route_type=COALESCE($9,route_type),
             strategy=COALESCE($10,strategy),
             match_prefix=COALESCE($11,match_prefix),
             country_code=COALESCE($12,country_code),
             operator=COALESCE($13,operator),
             cost=COALESCE($14,cost),
             window_start=COALESCE($15,window_start),
             window_end=COALESCE($16,window_end),
             active_days=COALESCE($17,active_days),
             updated_at=now()
           WHERE id=$1 RETURNING ${ROUTE_COLUMNS}`,
          [
            id,
            value.name ?? null,
            value.priority ?? null,
            value.enabled ?? null,
            value.destinationPrefix ?? null,
            value.sender ?? null,
            value.targetSmscId ?? null,
            value.fallbackSmscId ?? null,
            value.routeType ?? null,
            value.strategy ?? null,
            value.matchPrefix ?? null,
            value.countryCode ?? null,
            value.operator ?? null,
            value.cost ?? null,
            value.windowStart ?? null,
            value.windowEnd ?? null,
            value.activeDays && value.activeDays.length ? value.activeDays.join(',') : null,
          ],
        )
      ).rows[0];
      if (value.targets) await this.replaceTargets(client, actor, id, value.targets);
      await this.snapshotVersion(client, actor, id, value.reason ?? 'updated');
      await this.audit(client, actor, 'route.advanced.updated', id, old, route, value.reason);
      const targets = await this.loadTargets(client, id);
      return this.mapRoute(route, targets);
    });
  }

  /** Soft archive: disable the route and record a version. */
  async archiveRoute(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<RouteRow>(`SELECT ${ROUTE_COLUMNS} FROM routing_rules WHERE id=$1`, [id])
      ).rows[0];
      if (!old) throw new NotFoundException('Route not found');
      const route = (
        await client.query<RouteRow>(
          `UPDATE routing_rules SET enabled=false,updated_at=now() WHERE id=$1 RETURNING ${ROUTE_COLUMNS}`,
          [id],
        )
      ).rows[0];
      await this.snapshotVersion(client, actor, id, reason ?? 'archived');
      await this.audit(client, actor, 'route.advanced.archived', id, old, route, reason);
      return this.mapRoute(route, await this.loadTargets(client, id));
    });
  }

  async listVersions(actor: Actor, routeId: string) {
    return this.inTenant(actor, async (client) => {
      const exists = (await client.query('SELECT 1 FROM routing_rules WHERE id=$1', [routeId]))
        .rowCount;
      if (!exists) throw new NotFoundException('Route not found');
      const rows = (
        await client.query(
          'SELECT id,route_id,version,reason,created_by,created_at FROM route_versions WHERE route_id=$1 ORDER BY version DESC',
          [routeId],
        )
      ).rows;
      return { items: rows };
    });
  }

  async getVersion(actor: Actor, routeId: string, version: number) {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          'SELECT id,route_id,version,definition,reason,created_by,created_at FROM route_versions WHERE route_id=$1 AND version=$2',
          [routeId, version],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Route version not found');
      return row;
    });
  }

  /** All enabled routes mapped to the pure selector's CandidateRoute shape. */
  async candidateRoutes(actor: Actor): Promise<CandidateRoute[]> {
    return this.inTenant(actor, async (client) => {
      const routes = (
        await client.query<RouteRow>(
          `SELECT ${ROUTE_COLUMNS} FROM routing_rules WHERE enabled=true ORDER BY priority, name`,
        )
      ).rows;
      return Promise.all(
        routes.map(async (route) => {
          const targets =
            route.route_type === 'weighted' ? await this.loadTargets(client, route.id) : [];
          const window: TimeWindow | null =
            route.window_start && route.window_end
              ? {
                  start: toHhmm(route.window_start) as string,
                  end: toHhmm(route.window_end) as string,
                  days: parseActiveDays(route.active_days),
                }
              : null;
          const candidate: CandidateRoute = {
            id: route.id,
            name: route.name,
            priority: route.priority,
            enabled: route.enabled,
            routeType: route.route_type,
            strategy: route.strategy,
            matchPrefix: route.match_prefix,
            countryCode: route.country_code,
            operator: route.operator,
            destinationPrefix: route.destination_prefix,
            sender: route.sender,
            cost: route.cost === null ? null : Number(route.cost),
            targetSmscId: route.target_smsc_id,
            fallbackSmscId: route.fallback_smsc_id,
            targets: targets.map((t) => ({
              smscId: t.smsc_id,
              weight: t.weight,
              cost: t.cost === null ? null : Number(t.cost),
              enabled: t.enabled,
            })),
            window,
          };
          return candidate;
        }),
      );
    });
  }
}
