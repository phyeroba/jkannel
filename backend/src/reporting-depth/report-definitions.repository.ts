import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition, buildGridSql, parseListQuery } from '../platform/list-query';

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

/**
 * Catalog report kinds a saved definition may name and the scheduler can run.
 * Kept in sync with ReportingAnalyticsService.catalog() available kinds.
 */
export const REPORT_TYPES = [
  'daily_volume',
  'weekly_volume',
  'traffic_trend',
  'delivery_breakdown',
  'smsc_volume',
  'smsc_success',
  'route_volume',
  'route_performance',
  'hourly_heatmap',
  'latency_sla',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_SCHEDULES = ['hourly', 'daily', 'weekly'] as const;
export type ReportSchedule = (typeof REPORT_SCHEDULES)[number];
export const REPORT_FORMATS = ['csv', 'summary'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportDefinitionRow {
  id: string;
  name: string;
  report_type: string;
  parameters: Record<string, unknown>;
  schedule: string | null;
  format: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ReportDefinitionInput {
  name: string;
  reportType: ReportType;
  parameters?: Record<string, unknown>;
  schedule?: ReportSchedule | null;
  format?: ReportFormat;
  enabled?: boolean;
  reason?: string;
}

export interface ReportDefinitionPatch {
  name?: string;
  reportType?: ReportType;
  parameters?: Record<string, unknown>;
  schedule?: ReportSchedule | null;
  format?: ReportFormat;
  enabled?: boolean;
  reason?: string;
}

const DEFINITION_GRID: GridDefinition = {
  searchColumns: ['name', 'report_type'],
  sortColumns: {
    name: 'name',
    reportType: 'report_type',
    schedule: 'schedule',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  filterColumns: { reportType: 'report_type', schedule: 'schedule', enabled: 'enabled' },
  defaultOrderBy: 'name',
};

const COLUMNS =
  'id,name,report_type,parameters,schedule,format,enabled,created_by,created_at,updated_at';

/**
 * Persistence for saved report definitions (migration 021). Every access runs
 * inside a tenant transaction so PostgreSQL row level security enforces
 * isolation; every mutation writes an audit_log row.
 */
@Injectable()
export class ReportDefinitionsRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A report definition with that name already exists');
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
        'report_definition',
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  list(actor: Actor, query: Record<string, unknown> = {}): Promise<GridPage<ReportDefinitionRow>> {
    const parsed = parseListQuery(query, DEFINITION_GRID);
    const fragments = buildGridSql(parsed, DEFINITION_GRID, []);
    const where = fragments.andWhere ? `WHERE ${fragments.andWhere.slice(' AND '.length)}` : '';
    const sql = `SELECT ${COLUMNS}, count(*) OVER() AS __total FROM report_definitions ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      const result = await client.query<ReportDefinitionRow & { __total: string }>(
        sql,
        fragments.params,
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as ReportDefinitionRow);
      return {
        items,
        total,
        limit: parsed.limit,
        offset: parsed.offset,
      } satisfies GridPage<ReportDefinitionRow>;
    });
  }

  get(actor: Actor, id: string): Promise<ReportDefinitionRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<ReportDefinitionRow>(
          `SELECT ${COLUMNS} FROM report_definitions WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Report definition not found');
      return row;
    });
  }

  create(actor: Actor, value: ReportDefinitionInput): Promise<ReportDefinitionRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<ReportDefinitionRow>(
          `INSERT INTO report_definitions
             (tenant_id,name,report_type,parameters,schedule,format,enabled,created_by)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'csv'),COALESCE($7,true),$8)
           RETURNING ${COLUMNS}`,
          [
            actor.tenantId,
            value.name,
            value.reportType,
            JSON.stringify(value.parameters ?? {}),
            value.schedule ?? null,
            value.format ?? null,
            value.enabled ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'report_definition.created', row.id, null, row, value.reason);
      return row;
    });
  }

  update(actor: Actor, id: string, value: ReportDefinitionPatch): Promise<ReportDefinitionRow> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<ReportDefinitionRow>(
          `SELECT ${COLUMNS} FROM report_definitions WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Report definition not found');
      const row = (
        await client.query<ReportDefinitionRow>(
          `UPDATE report_definitions SET
             name=COALESCE($2,name),
             report_type=COALESCE($3,report_type),
             parameters=COALESCE($4,parameters),
             schedule=CASE WHEN $5::boolean THEN $6 ELSE schedule END,
             format=COALESCE($7,format),
             enabled=COALESCE($8,enabled),
             updated_at=now()
           WHERE id=$1 RETURNING ${COLUMNS}`,
          [
            id,
            value.name ?? null,
            value.reportType ?? null,
            value.parameters ? JSON.stringify(value.parameters) : null,
            value.schedule !== undefined,
            value.schedule ?? null,
            value.format ?? null,
            value.enabled ?? null,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'report_definition.updated', id, old, row, value.reason);
      return row;
    });
  }

  remove(actor: Actor, id: string): Promise<{ id: string; deleted: true }> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<ReportDefinitionRow>(
          `SELECT ${COLUMNS} FROM report_definitions WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Report definition not found');
      await client.query('DELETE FROM report_definitions WHERE id=$1', [id]);
      await this.audit(client, actor, 'report_definition.deleted', id, old, null);
      return { id, deleted: true as const };
    });
  }

  /** Recent run ledger for one definition (scheduled delivery history). */
  runs(actor: Actor, id: string, limit = 50) {
    const bounded = Math.min(Math.max(limit, 1), 200);
    return this.inTenant(actor, async (client) => {
      const rows = (
        await client.query(
          `SELECT id, status, detail, ran_at FROM report_definition_runs
            WHERE definition_id=$1 ORDER BY ran_at DESC LIMIT $2`,
          [id, bounded],
        )
      ).rows;
      return { items: rows };
    });
  }
}
