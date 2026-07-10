import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { GridDefinition, buildGridSql, parseListQuery } from '../platform/list-query';
import { DEFAULT_SETTINGS } from './settings-defaults';

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
 * Grid definitions (search / sort / filter whitelists) per console resource.
 * Exported so controllers can reuse them for CSV/PDF exports.
 */
export const CONSOLE_GRIDS = {
  smscs: {
    searchColumns: ['s.name', 's.engine_id', 's.host', 's.description'],
    sortColumns: {
      name: 's.name',
      priority: 's.priority',
      type: 's.type',
      enabled: 's.enabled',
      lifecycleState: 's.lifecycle_state',
      createdAt: 's.created_at',
      updatedAt: 's.updated_at',
    },
    filterColumns: {
      type: 's.type',
      enabled: 's.enabled',
      lifecycleState: 's.lifecycle_state',
      engineId: 's.engine_id',
    },
    defaultOrderBy: 's.priority, s.name',
  },
  routes: {
    searchColumns: ['r.name', 'r.destination_prefix', 'r.sender', 's.name', 'f.name'],
    sortColumns: {
      name: 'r.name',
      priority: 'r.priority',
      enabled: 'r.enabled',
      deploymentState: 'r.deployment_state',
      createdAt: 'r.created_at',
      updatedAt: 'r.updated_at',
    },
    filterColumns: {
      enabled: 'r.enabled',
      deploymentState: 'r.deployment_state',
      targetSmscId: 'r.target_smsc_id',
    },
    defaultOrderBy: 'r.priority, r.name',
  },
  alerts: {
    searchColumns: ['a.summary', 'a.details', 'r.name'],
    sortColumns: {
      openedAt: 'a.opened_at',
      status: 'a.status',
      severity: 'a.severity',
    },
    filterColumns: {
      status: 'a.status',
      severity: 'a.severity',
      source: 'a.source',
      ruleId: 'a.rule_id',
    },
    defaultOrderBy: 'a.opened_at DESC',
  },
  alertRules: {
    searchColumns: ['name', 'metric'],
    sortColumns: { name: 'name', severity: 'severity', metric: 'metric', enabled: 'enabled' },
    filterColumns: { severity: 'severity', enabled: 'enabled', metric: 'metric' },
    defaultOrderBy: 'severity, name',
  },
  users: {
    searchColumns: ['u.username'],
    sortColumns: { username: 'u.username', status: 'u.status', createdAt: 'u.created_at' },
    filterColumns: { status: 'u.status' },
    defaultOrderBy: 'u.username',
  },
  invitations: {
    searchColumns: ['email'],
    sortColumns: { email: 'email', status: 'status', createdAt: 'created_at' },
    filterColumns: { status: 'status' },
    defaultOrderBy: 'created_at DESC',
  },
  configurations: {
    searchColumns: ['scope', 'change_reason'],
    sortColumns: {
      scope: 'scope',
      versionNumber: 'version_number',
      status: 'status',
      createdAt: 'created_at',
    },
    filterColumns: { scope: 'scope', status: 'status' },
    defaultOrderBy: 'scope, version_number DESC',
  },
  auditEvents: {
    searchColumns: ['action', 'entity_type', 'entity_id', 'actor_id', 'reason'],
    sortColumns: { createdAt: 'created_at', action: 'action', entityType: 'entity_type' },
    filterColumns: {
      action: 'action',
      entityType: 'entity_type',
      actorId: 'actor_id',
      entityId: 'entity_id',
    },
    defaultOrderBy: 'created_at DESC',
    maxLimit: 1000,
    defaultLimit: 100,
  },
  notifications: {
    searchColumns: ['title', 'body', 'category'],
    sortColumns: { createdAt: 'created_at', category: 'category' },
    filterColumns: {
      category: 'category',
      unread: "CASE WHEN read_at IS NULL THEN 'true' ELSE 'false' END",
    },
    defaultOrderBy: 'created_at DESC',
  },
  reportSnapshots: {
    searchColumns: ['scope_label'],
    sortColumns: {
      periodStart: 'period_start',
      messageCount: 'message_count',
      scope: 'scope',
    },
    filterColumns: { periodType: 'period_type', scope: 'scope' },
    defaultOrderBy: 'period_start DESC, scope, scope_label',
    maxLimit: 1000,
    defaultLimit: 100,
  },
} satisfies Record<string, GridDefinition>;

@Injectable()
export class ConsoleRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A resource with that identity already exists');
      throw error;
    }
  }
  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    type: string,
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
        type,
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }
  private async list<T extends QueryResultRow>(actor: Actor, sql: string): Promise<T[]> {
    return this.inTenant(actor, async (c) => (await c.query<T>(sql)).rows);
  }

  /**
   * Runs a grid query (search/sort/filter/pagination) and returns the page
   * with a total count. `body.select` must not include ORDER BY/LIMIT, and
   * `body.where` (optional) must start with WHERE; grid clauses are appended.
   */
  private async grid<T extends QueryResultRow>(
    actor: Actor,
    body: { select: string; from: string; where?: string; params?: unknown[] },
    gridDef: GridDefinition,
    rawQuery: Record<string, unknown>,
  ): Promise<GridPage<T>> {
    const parsed = parseListQuery(rawQuery, gridDef);
    const fragments = buildGridSql(parsed, gridDef, body.params ?? []);
    const where = body.where
      ? `${body.where}${fragments.andWhere}`
      : fragments.andWhere
        ? `WHERE ${fragments.andWhere.slice(' AND '.length)}`
        : '';
    const sql = `${body.select}, count(*) OVER() AS __total ${body.from} ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (c) => {
      const result = await c.query<T & { __total: string }>(sql, fragments.params);
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as unknown as T);
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
  }

  /**
   * Engine-level SMSC identifiers owned by the tenant. SQLBox tables carry no
   * tenant column, so message/DLR/queue reads are restricted to these ids.
   */
  async listTenantSmscEngineIds(actor: Actor): Promise<string[]> {
    return this.inTenant(actor, async (c) =>
      (await c.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')).rows.map(
        (row) => row.engine_id,
      ),
    );
  }

  listSmscs(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          'SELECT s.id,s.engine_id,s.name,s.description,s.type,s.host,s.port,s.credential_secret_ref,s.tps,s.priority,s.tags,s.enabled,s.lifecycle_state,s.last_error,s.created_at,s.updated_at,(SELECT row_to_json(h) FROM (SELECT state,latency_ms,detail,observed_at FROM smsc_health WHERE smsc_id=s.id ORDER BY observed_at DESC LIMIT 1) h) health',
        from: 'FROM smsc_definitions s',
      },
      CONSOLE_GRIDS.smscs,
      query,
    );
  }
  async getSmsc(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (await c.query('SELECT * FROM smsc_definitions WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('SMSC not found');
      return row;
    });
  }
  async createSmsc(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO smsc_definitions(tenant_id,engine_id,name,description,type,host,port,credential_secret_ref,tps,priority,tags,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
          [
            actor.tenantId,
            value.engineId,
            value.name,
            value.description ?? null,
            value.type,
            value.host ?? null,
            value.port ?? null,
            value.credentialSecretRef ?? null,
            value.tps,
            value.priority ?? 100,
            value.tags ?? [],
            value.enabled ?? true,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'smsc.created', 'smsc', row.id, null, row);
      return row;
    });
  }
  async updateSmsc(actor: Actor, id: string, value: any) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM smsc_definitions WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('SMSC not found');
      const row = (
        await c.query(
          'UPDATE smsc_definitions SET name=COALESCE($2,name),host=COALESCE($3,host),port=COALESCE($4,port),tps=COALESCE($5,tps),enabled=COALESCE($6,enabled),updated_at=now() WHERE id=$1 RETURNING *',
          [
            id,
            value.name ?? null,
            value.host ?? null,
            value.port ?? null,
            value.tps ?? null,
            value.enabled ?? null,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'smsc.updated', 'smsc', id, old, row, value.reason);
      return row;
    });
  }
  async beginSmscOperation(
    actor: Actor,
    smscId: string,
    operation: string,
    idempotencyKey: string,
  ) {
    return this.inTenant(actor, async (c) => {
      const existing = (
        await c.query('SELECT * FROM smsc_deployments WHERE idempotency_key=$1', [idempotencyKey])
      ).rows[0];
      if (existing) return { ...existing, replayed: true };
      const row = (
        await c.query(
          "INSERT INTO smsc_deployments(tenant_id,smsc_id,operation,status,idempotency_key,requested_by) VALUES($1,$2,$3,'pending',$4,$5) RETURNING *",
          [actor.tenantId, smscId, operation, idempotencyKey, actor.userId],
        )
      ).rows[0];
      await this.audit(c, actor, `smsc.${operation}.requested`, 'smsc', smscId, null, row);
      return row;
    });
  }
  async completeSmscOperation(
    actor: Actor,
    deploymentId: string,
    smscId: string,
    operation: string,
    succeeded: boolean,
    detail: string,
    latencyMs?: number,
  ) {
    return this.inTenant(actor, async (c) => {
      const status = succeeded ? 'succeeded' : 'failed';
      const deployment = (
        await c.query(
          'UPDATE smsc_deployments SET status=$2,detail=$3,completed_at=now() WHERE id=$1 RETURNING *',
          [deploymentId, status, detail],
        )
      ).rows[0];
      const state =
        operation === 'disable'
          ? 'disabled'
          : succeeded
            ? operation === 'test'
              ? 'reachable'
              : 'active'
            : 'degraded';
      await c.query(
        'UPDATE smsc_definitions SET lifecycle_state=$2,enabled=CASE WHEN $3=$4 THEN false WHEN $3 IN ($5,$6) AND $7 THEN true ELSE enabled END,last_error=CASE WHEN $7 THEN NULL ELSE $8 END,updated_at=now() WHERE id=$1',
        [smscId, state, operation, 'disable', 'enable', 'reconnect', succeeded, detail],
      );
      await c.query(
        'INSERT INTO smsc_health(tenant_id,smsc_id,state,latency_ms,detail) VALUES($1,$2,$3,$4,$5)',
        [actor.tenantId, smscId, state, latencyMs ?? null, detail],
      );
      await this.audit(
        c,
        actor,
        `smsc.${operation}.${status}`,
        'smsc',
        smscId,
        null,
        deployment,
        detail,
      );
      return deployment;
    });
  }
  listSmscDeployments(actor: Actor, id: string) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            'SELECT * FROM smsc_deployments WHERE smsc_id=$1 ORDER BY created_at DESC LIMIT 100',
            [id],
          )
        ).rows,
    );
  }

  listRoutes(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select: 'SELECT r.*,s.name target_smsc_name,f.name fallback_smsc_name',
        from: 'FROM routing_rules r JOIN smsc_definitions s ON s.id=r.target_smsc_id LEFT JOIN smsc_definitions f ON f.id=r.fallback_smsc_id',
      },
      CONSOLE_GRIDS.routes,
      query,
    );
  }
  async getRoute(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (await c.query('SELECT * FROM routing_rules WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('Route not found');
      return row;
    });
  }
  async createRoute(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const conflict = (
        await c.query('SELECT id,name FROM routing_rules WHERE priority=$1 AND enabled=true', [
          value.priority,
        ])
      ).rows[0];
      if (conflict)
        throw new ConflictException(
          `Priority ${value.priority} is already used by ${conflict.name}`,
        );
      const row = (
        await c.query(
          'INSERT INTO routing_rules(tenant_id,name,priority,enabled,destination_prefix,sender,target_smsc_id,fallback_smsc_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            actor.tenantId,
            value.name,
            value.priority,
            value.enabled ?? true,
            value.destinationPrefix ?? null,
            value.sender ?? null,
            value.targetSmscId,
            value.fallbackSmscId ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'route.created', 'routing_rule', row.id, null, row);
      return row;
    });
  }
  async updateRoute(actor: Actor, id: string, value: any) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM routing_rules WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Route not found');
      const row = (
        await c.query(
          'UPDATE routing_rules SET name=COALESCE($2,name),priority=COALESCE($3,priority),enabled=COALESCE($4,enabled),destination_prefix=COALESCE($5,destination_prefix),sender=COALESCE($6,sender),target_smsc_id=COALESCE($7,target_smsc_id),fallback_smsc_id=COALESCE($8,fallback_smsc_id),updated_at=now() WHERE id=$1 RETURNING *',
          [
            id,
            value.name ?? null,
            value.priority ?? null,
            value.enabled ?? null,
            value.destinationPrefix ?? null,
            value.sender ?? null,
            value.targetSmscId ?? null,
            value.fallbackSmscId ?? null,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'route.updated', 'routing_rule', id, old, row, value.reason);
      return row;
    });
  }
  async routeSimulationData(actor: Actor) {
    return this.inTenant(actor, async (c) => {
      const routes = (
        await c.query(
          'SELECT id::text,priority,enabled,destination_prefix,sender,target_smsc_id::text,fallback_smsc_id::text FROM routing_rules ORDER BY priority,id',
        )
      ).rows;
      const smscs = (
        await c.query(
          "SELECT id::text FROM smsc_definitions WHERE enabled=true AND lifecycle_state NOT IN ('disabled','archived','degraded')",
        )
      ).rows;
      return { routes, smscs };
    });
  }
  async validateRoute(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const route = (await c.query('SELECT * FROM routing_rules WHERE id=$1', [id])).rows[0];
      if (!route) throw new NotFoundException('Route not found');
      const errors: string[] = [];
      const warnings: string[] = [];
      if (route.destination_prefix && !/^\+?[0-9]{1,20}$/.test(route.destination_prefix))
        errors.push('destinationPrefix must be an E.164-like prefix');
      if (route.fallback_smsc_id && route.fallback_smsc_id === route.target_smsc_id)
        errors.push('fallbackSmscId must differ from targetSmscId');
      const duplicate = (
        await c.query(
          "SELECT id,name FROM routing_rules WHERE id<>$1 AND enabled=true AND priority=$2 AND COALESCE(destination_prefix,'')=COALESCE($3,'') AND COALESCE(sender,'')=COALESCE($4,'') LIMIT 1",
          [id, route.priority, route.destination_prefix, route.sender],
        )
      ).rows[0];
      if (duplicate) errors.push(`priority conflicts with route ${duplicate.name}`);
      const primary = (
        await c.query('SELECT id,lifecycle_state,enabled FROM smsc_definitions WHERE id=$1', [
          route.target_smsc_id,
        ])
      ).rows[0];
      if (!primary) errors.push('targetSmscId does not reference an existing SMSC');
      else if (
        !primary.enabled ||
        ['disabled', 'archived', 'degraded'].includes(primary.lifecycle_state)
      )
        warnings.push('primary SMSC is not currently healthy/enabled');
      if (route.fallback_smsc_id) {
        const fallback = (
          await c.query('SELECT id,lifecycle_state,enabled FROM smsc_definitions WHERE id=$1', [
            route.fallback_smsc_id,
          ])
        ).rows[0];
        if (!fallback) errors.push('fallbackSmscId does not reference an existing SMSC');
        else if (
          !fallback.enabled ||
          ['disabled', 'archived', 'degraded'].includes(fallback.lifecycle_state)
        )
          warnings.push('fallback SMSC is not currently healthy/enabled');
      }
      const result = {
        valid: errors.length === 0,
        errors,
        warnings,
        checkedAt: new Date().toISOString(),
      };
      await c.query(
        "INSERT INTO route_deployments(tenant_id,route_id,operation,status,snapshot,result,reason,actor_id) VALUES($1,$2,'validate',$3,$4,$5,$6,$7)",
        [
          actor.tenantId,
          id,
          errors.length ? 'failed' : 'succeeded',
          JSON.stringify(route),
          JSON.stringify(result),
          reason ?? null,
          actor.userId,
        ],
      );
      if (!errors.length)
        await c.query(
          "UPDATE routing_rules SET deployment_state=CASE WHEN deployment_state='deployed' THEN deployment_state ELSE 'validated' END,updated_at=now() WHERE id=$1",
          [id],
        );
      await this.audit(
        c,
        actor,
        'route.validated',
        'routing_rule',
        id,
        route,
        { ...route, validation: result },
        reason,
      );
      return result;
    });
  }
  routeHistory(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) =>
      c
        .query(
          'SELECT * FROM route_deployments WHERE route_id=$1 ORDER BY created_at DESC LIMIT 100',
          [id],
        )
        .then((r) => r.rows),
    );
  }
  async deployRoute(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const route = (await c.query('SELECT * FROM routing_rules WHERE id=$1', [id])).rows[0];
      if (!route) throw new NotFoundException('Route not found');
      const duplicate = (
        await c.query(
          "SELECT id,name FROM routing_rules WHERE id<>$1 AND enabled=true AND priority=$2 AND COALESCE(destination_prefix,'')=COALESCE($3,'') AND COALESCE(sender,'')=COALESCE($4,'') LIMIT 1",
          [id, route.priority, route.destination_prefix, route.sender],
        )
      ).rows[0];
      if (duplicate) throw new ConflictException(`Route conflicts with ${duplicate.name}`);
      const updated = (
        await c.query(
          "UPDATE routing_rules SET deployment_state='deployed',deployed_at=now(),deployed_by=$2,updated_at=now() WHERE id=$1 RETURNING *",
          [id, actor.userId],
        )
      ).rows[0];
      const record = (
        await c.query(
          "INSERT INTO route_deployments(tenant_id,route_id,operation,status,snapshot,result,reason,actor_id) VALUES($1,$2,'deploy','succeeded',$3,$4,$5,$6) RETURNING *",
          [
            actor.tenantId,
            id,
            JSON.stringify(updated),
            JSON.stringify({ deployedAt: updated.deployed_at, state: updated.deployment_state }),
            reason ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'route.deployed', 'routing_rule', id, route, updated, reason);
      return { route: updated, deployment: record };
    });
  }
  async rollbackRoute(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const route = (await c.query('SELECT * FROM routing_rules WHERE id=$1', [id])).rows[0];
      if (!route) throw new NotFoundException('Route not found');
      const previous = (
        await c.query(
          "SELECT snapshot FROM route_deployments WHERE route_id=$1 AND operation='deploy' AND status='succeeded' ORDER BY created_at DESC OFFSET 1 LIMIT 1",
          [id],
        )
      ).rows[0]?.snapshot;
      let updated;
      if (previous) {
        updated = (
          await c.query(
            "UPDATE routing_rules SET name=$2,priority=$3,enabled=$4,destination_prefix=$5,sender=$6,target_smsc_id=$7,fallback_smsc_id=$8,deployment_state='rolled_back',updated_at=now() WHERE id=$1 RETURNING *",
            [
              id,
              previous.name,
              previous.priority,
              previous.enabled,
              previous.destination_prefix,
              previous.sender,
              previous.target_smsc_id,
              previous.fallback_smsc_id,
            ],
          )
        ).rows[0];
      } else {
        updated = (
          await c.query(
            "UPDATE routing_rules SET deployment_state='rolled_back',updated_at=now() WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
      }
      const record = (
        await c.query(
          "INSERT INTO route_deployments(tenant_id,route_id,operation,status,snapshot,result,reason,actor_id) VALUES($1,$2,'rollback','succeeded',$3,$4,$5,$6) RETURNING *",
          [
            actor.tenantId,
            id,
            JSON.stringify(updated),
            JSON.stringify({ rolledBackTo: previous?.id ?? null, state: updated.deployment_state }),
            reason ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'route.rolled_back', 'routing_rule', id, route, updated, reason);
      return { route: updated, deployment: record };
    });
  }

  listAlertRules(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      { select: 'SELECT *', from: 'FROM alert_rules' },
      CONSOLE_GRIDS.alertRules,
      query,
    );
  }
  listAlerts(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          'SELECT a.*,r.name rule_name,x.actor_id acknowledged_by,x.note acknowledgement_note,x.acknowledged_at',
        from: 'FROM alert_instances a LEFT JOIN alert_rules r ON r.id=a.rule_id LEFT JOIN alert_acknowledgements x ON x.alert_id=a.id',
      },
      CONSOLE_GRIDS.alerts,
      query,
    );
  }
  async createAlertRule(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO alert_rules(tenant_id,name,metric,operator,threshold,sustain_seconds,severity,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            actor.tenantId,
            value.name,
            value.metric,
            value.operator,
            value.threshold,
            value.sustainSeconds ?? 0,
            value.severity,
            value.enabled ?? true,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'alert_rule.created', 'alert_rule', row.id, null, row);
      return row;
    });
  }
  async acknowledge(actor: Actor, id: string, note?: string) {
    return this.inTenant(actor, async (c) => {
      const alert = (await c.query('SELECT * FROM alert_instances WHERE id=$1', [id])).rows[0];
      if (!alert) throw new NotFoundException('Alert not found');
      const ack = (
        await c.query(
          `INSERT INTO alert_acknowledgements(tenant_id,alert_id,actor_id,note) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,alert_id) DO UPDATE SET note=EXCLUDED.note,actor_id=EXCLUDED.actor_id,acknowledged_at=now() RETURNING *`,
          [actor.tenantId, id, actor.userId, note ?? null],
        )
      ).rows[0];
      await c.query(
        "UPDATE alert_instances SET status='acknowledged' WHERE id=$1 AND status='open'",
        [id],
      );
      await this.audit(
        c,
        actor,
        'alert.acknowledged',
        'alert',
        id,
        alert,
        { ...alert, status: 'acknowledged', acknowledgement: ack },
        note,
      );
      return ack;
    });
  }
  getAlert(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'SELECT a.*,r.severity rule_severity FROM alert_instances a LEFT JOIN alert_rules r ON r.id=a.rule_id WHERE a.id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Alert not found');
      return row;
    });
  }
  listNotificationChannels(actor: Actor) {
    return this.list(
      actor,
      'SELECT id,name,type,enabled,severities,config,created_at,updated_at FROM notification_channels ORDER BY enabled DESC,name',
    );
  }
  async createNotificationChannel(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO notification_channels(tenant_id,name,type,enabled,severities,config,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,type,enabled,severities,config,created_at',
          [
            actor.tenantId,
            value.name,
            value.type,
            value.enabled ?? true,
            value.severities ?? ['warning', 'critical'],
            JSON.stringify(value.config ?? {}),
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'notification_channel.created',
        'notification_channel',
        row.id,
        null,
        row,
      );
      return row;
    });
  }
  async notificationTargets(actor: Actor, channelId?: string) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            channelId
              ? 'SELECT * FROM notification_channels WHERE id=$1'
              : 'SELECT * FROM notification_channels WHERE enabled=true',
            channelId ? [channelId] : [],
          )
        ).rows,
    );
  }
  async recordNotificationDelivery(actor: Actor, alertId: string, attempt: any) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO notification_deliveries(tenant_id,alert_id,channel_id,channel_type,status,target,response,attempted_by,delivered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5=$9 THEN now() ELSE NULL END) RETURNING *',
          [
            actor.tenantId,
            alertId,
            attempt.channelId,
            attempt.channelType,
            attempt.status,
            attempt.target ?? null,
            JSON.stringify(attempt.response ?? {}),
            actor.userId,
            'succeeded',
          ],
        )
      ).rows[0];
      await this.audit(c, actor, `notification.${attempt.status}`, 'alert', alertId, null, row);
      return row;
    });
  }
  notificationDeliveries(actor: Actor, alertId: string) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            'SELECT d.*,c.name channel_name FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id WHERE d.alert_id=$1 ORDER BY d.created_at DESC LIMIT 100',
            [alertId],
          )
        ).rows,
    );
  }

  /**
   * Lists system settings, seeding the canonical defaults on first access and
   * decorating each row with its group, type, description and editability so the
   * console can render a grouped, documented settings screen.
   */
  async listSettings(actor: Actor) {
    return this.inTenant(actor, async (c) => {
      // Seed any missing defaults (idempotent; never overwrites operator values).
      for (const d of DEFAULT_SETTINGS) {
        await c.query(
          `INSERT INTO system_settings(tenant_id,key,value,is_secret,updated_by)
           VALUES($1,$2,$3,false,'system') ON CONFLICT(tenant_id,key) DO NOTHING`,
          [actor.tenantId, d.key, JSON.stringify(d.value)],
        );
      }
      const rows = (
        await c.query<{
          key: string;
          value: unknown;
          is_secret: boolean;
          updated_by: string;
          updated_at: Date;
        }>(
          `SELECT key,CASE WHEN is_secret THEN '"[redacted]"'::jsonb ELSE value END value,is_secret,updated_by,updated_at
             FROM system_settings ORDER BY key`,
        )
      ).rows;
      const meta = new Map(DEFAULT_SETTINGS.map((d) => [d.key, d]));
      const items = rows.map((row) => {
        const m = meta.get(row.key);
        return {
          ...row,
          group: m?.group ?? 'Other',
          type: m?.type ?? 'string',
          description: m?.description ?? '',
          editable: m ? m.editable : true,
        };
      });
      return { items, total: items.length, limit: items.length, offset: 0 };
    });
  }
  async putSetting(actor: Actor, key: string, value: any) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM system_settings WHERE key=$1', [key])).rows[0];
      const row = (
        await c.query(
          `INSERT INTO system_settings(tenant_id,key,value,is_secret,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value,is_secret=EXCLUDED.is_secret,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING key,CASE WHEN is_secret THEN '"[redacted]"'::jsonb ELSE value END value,is_secret,updated_by,updated_at`,
          [actor.tenantId, key, JSON.stringify(value.value), value.isSecret ?? false, actor.userId],
        )
      ).rows[0];
      await this.audit(c, actor, 'setting.updated', 'system_setting', key, old, row, value.reason);
      return row;
    });
  }

  listUsers(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          "SELECT u.id,u.username,u.status,u.created_at,u.updated_at,(SELECT COALESCE(array_agg(r.name),'{}') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) roles",
        from: 'FROM users u',
      },
      CONSOLE_GRIDS.users,
      query,
    );
  }
  listRoles(actor: Actor) {
    return this.list(
      actor,
      "SELECT r.id,r.name,r.description,(SELECT count(*)::int FROM user_roles ur WHERE ur.role_id=r.id) AS user_count,(SELECT COALESCE(array_agg(p.code),'{}') FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id) permissions FROM roles r ORDER BY r.name",
    );
  }
  async getUser(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          `SELECT u.id,u.username,u.status,u.failed_login_count,u.locked_until,u.created_at,u.updated_at,
                  (SELECT COALESCE(json_agg(json_build_object('id',r.id,'name',r.name)),'[]') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) roles,
                  (SELECT COALESCE(array_agg(DISTINCT p.code),'{}') FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id) permissions
             FROM users u WHERE u.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('User not found');
      return row;
    });
  }
  async createUser(
    actor: Actor,
    value: { username: string; passwordHash: string; roleIds?: string[]; status?: string },
  ) {
    return this.inTenant(actor, async (c) => {
      const user = (
        await c.query(
          'INSERT INTO users(tenant_id,username,password_hash,status) VALUES($1,$2,$3,$4) RETURNING id,username,status,created_at',
          [actor.tenantId, value.username, value.passwordHash, value.status ?? 'active'],
        )
      ).rows[0];
      for (const roleId of value.roleIds ?? []) {
        await c.query(
          'INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [actor.tenantId, user.id, roleId],
        );
      }
      await this.audit(c, actor, 'user.created', 'user', user.id, null, {
        username: user.username,
        roleIds: value.roleIds ?? [],
      });
      return user;
    });
  }
  async updateUser(
    actor: Actor,
    id: string,
    value: { status?: string; roleIds?: string[]; passwordHash?: string; reason?: string },
  ) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT id,username,status FROM users WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('User not found');
      if (value.status || value.passwordHash) {
        await c.query(
          `UPDATE users SET status=COALESCE($2,status),
             password_hash=COALESCE($3,password_hash),
             failed_login_count=CASE WHEN $2='active' THEN 0 ELSE failed_login_count END,
             locked_until=CASE WHEN $2='active' THEN NULL ELSE locked_until END,
             updated_at=now() WHERE id=$1`,
          [id, value.status ?? null, value.passwordHash ?? null],
        );
      }
      if (Array.isArray(value.roleIds)) {
        await c.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
        for (const roleId of value.roleIds) {
          await c.query(
            'INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [actor.tenantId, id, roleId],
          );
        }
      }
      const updated = (
        await c.query('SELECT id,username,status,updated_at FROM users WHERE id=$1', [id])
      ).rows[0];
      await this.audit(c, actor, 'user.updated', 'user', id, old, updated, value.reason);
      return updated;
    });
  }
  async archiveUser(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT id,username,status FROM users WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('User not found');
      if (old.id === actor.userId)
        throw new ConflictException('You cannot archive your own account');
      const updated = (
        await c.query(
          "UPDATE users SET status='archived',updated_at=now() WHERE id=$1 RETURNING id,username,status",
          [id],
        )
      ).rows[0];
      await c.query(
        'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [id],
      );
      await this.audit(c, actor, 'user.archived', 'user', id, old, updated);
      return updated;
    });
  }
  listInvitations(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select: 'SELECT id,email,role_id,status,expires_at,invited_by,created_at,accepted_at',
        from: 'FROM user_invitations',
      },
      CONSOLE_GRIDS.invitations,
      query,
    );
  }
  async invite(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const token = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(token).digest('hex');
      const row = (
        await c.query(
          "INSERT INTO user_invitations(tenant_id,email,role_id,token_hash,expires_at,invited_by) VALUES($1,lower($2),$3,$4,now()+interval '7 days',$5) RETURNING id,email,role_id,status,expires_at,created_at",
          [actor.tenantId, value.email, value.roleId ?? null, hash, actor.userId],
        )
      ).rows[0];
      await this.audit(c, actor, 'user.invited', 'user_invitation', row.id, null, row);
      return { ...row, invitationToken: token };
    });
  }
  listConfigurations(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          'SELECT uuid id,scope,version_number,status,content,checksum,change_reason,previous_version_id,created_by,created_at,approved_by,approved_at,deployed_by,deployed_at',
        from: 'FROM configuration_versions',
      },
      CONSOLE_GRIDS.configurations,
      query,
    );
  }
  listAuditEvents(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          'SELECT uuid id,actor_id,action,entity_type,entity_id,old_value,new_value,reason,correlation_id,source_ip,created_at',
        from: 'FROM audit_log',
      },
      CONSOLE_GRIDS.auditEvents,
      query,
    );
  }
  listReportSnapshots(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select:
          'SELECT id,period_type,period_start,period_end,scope,scope_key,scope_label,message_count,dlr_count,details,generated_at',
        from: 'FROM report_snapshots',
      },
      CONSOLE_GRIDS.reportSnapshots,
      query,
    );
  }
  listNotifications(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      {
        select: 'SELECT id,category,title,body,data,read_at,created_at',
        from: 'FROM user_notifications',
        where: 'WHERE user_id=$1',
        params: [actor.userId],
      },
      CONSOLE_GRIDS.notifications,
      query,
    );
  }
  async unreadNotificationCount(actor: Actor): Promise<number> {
    return this.inTenant(actor, async (c) => {
      const result = await c.query<{ count: string }>(
        'SELECT count(*)::text count FROM user_notifications WHERE user_id=$1 AND read_at IS NULL',
        [actor.userId],
      );
      return Number(result.rows[0].count);
    });
  }
  async markNotificationRead(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Notification not found');
      return row;
    });
  }
  /** Returns a notification's full detail and marks it read (open == read). */
  async openNotification(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const existing = (
        await c.query(
          'SELECT id,category,title,body,data,read_at,created_at FROM user_notifications WHERE id=$1 AND user_id=$2',
          [id, actor.userId],
        )
      ).rows[0];
      if (!existing) throw new NotFoundException('Notification not found');
      const wasUnread = !existing.read_at;
      const readAt = (
        await c.query(
          'UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING read_at',
          [id, actor.userId],
        )
      ).rows[0].read_at;
      return { ...existing, read_at: readAt, wasUnread };
    });
  }
  async markAllNotificationsRead(actor: Actor) {
    return this.inTenant(actor, async (c) => {
      const result = await c.query(
        'UPDATE user_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
        [actor.userId],
      );
      return { marked: result.rowCount ?? 0 };
    });
  }

  async getAuditEvent(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'SELECT uuid id,actor_id,action,entity_type,entity_id,old_value,new_value,reason,correlation_id,source_ip,created_at FROM audit_log WHERE uuid=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Audit event not found');
      return row;
    });
  }
  /** SMSC detail: definition, recent health samples, and recent operations. */
  async getSmscDetail(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const smsc = (await c.query('SELECT * FROM smsc_definitions WHERE id=$1', [id])).rows[0];
      if (!smsc) throw new NotFoundException('SMSC not found');
      const health = (
        await c.query(
          'SELECT state,latency_ms,detail,observed_at FROM smsc_health WHERE smsc_id=$1 ORDER BY observed_at DESC LIMIT 10',
          [id],
        )
      ).rows;
      const deployments = (
        await c.query(
          'SELECT id,operation,status,detail,created_at,completed_at FROM smsc_deployments WHERE smsc_id=$1 ORDER BY created_at DESC LIMIT 10',
          [id],
        )
      ).rows;
      return { ...smsc, health, deployments };
    });
  }

  async getConfiguration(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'SELECT uuid id,scope,version_number,status,content,checksum,change_reason,previous_version_id,created_by,created_at,approved_by,approved_at,deployed_by,deployed_at FROM configuration_versions WHERE uuid=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Configuration version not found');
      return row;
    });
  }
  async markConfigurationValidated(actor: Actor, id: string, result: any, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM configuration_versions WHERE uuid=$1', [id]))
        .rows[0];
      if (!old) throw new NotFoundException('Configuration version not found');
      if (!['draft', 'validated'].includes(old.status))
        throw new ConflictException('Only draft configurations can be validated');
      const content = { ...old.content, nativeValidation: result };
      const row = (
        await c.query(
          "UPDATE configuration_versions SET status='validated',content=$2 WHERE uuid=$1 RETURNING uuid id,scope,version_number,status,content,checksum,change_reason,previous_version_id,created_by,created_at,approved_by,approved_at,deployed_by,deployed_at",
          [id, JSON.stringify(content)],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'configuration.validated',
        'configuration_version',
        id,
        old,
        row,
        reason,
      );
      return row;
    });
  }
  async markConfigurationApproved(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM configuration_versions WHERE uuid=$1', [id]))
        .rows[0];
      if (!old) throw new NotFoundException('Configuration version not found');
      if (!['draft', 'validated', 'approved'].includes(old.status))
        throw new ConflictException('Only draft or validated configurations can be approved');
      const row = (
        await c.query(
          "UPDATE configuration_versions SET status='approved',approved_by=$2,approved_at=now() WHERE uuid=$1 RETURNING uuid id,scope,version_number,status,content,checksum,change_reason,previous_version_id,created_by,created_at,approved_by,approved_at,deployed_by,deployed_at",
          [id, actor.userId],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'configuration.approved',
        'configuration_version',
        id,
        old,
        row,
        reason,
      );
      return row;
    });
  }
  async markConfigurationDeployed(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM configuration_versions WHERE uuid=$1', [id]))
        .rows[0];
      if (!old) throw new NotFoundException('Configuration version not found');
      if (old.status !== 'approved')
        throw new ConflictException('Configuration must be approved before deployment');
      await c.query(
        "UPDATE configuration_versions SET status='superseded' WHERE scope=$1 AND status='deployed'",
        [old.scope],
      );
      const row = (
        await c.query(
          "UPDATE configuration_versions SET status='deployed',deployed_by=$2,deployed_at=now() WHERE uuid=$1 RETURNING uuid id,scope,version_number,status,content,checksum,created_at,approved_by,approved_at,deployed_by,deployed_at",
          [id, actor.userId],
        )
      ).rows[0];
      await this.audit(c, actor, 'configuration.deployed', 'configuration_version', id, old, row);
      return row;
    });
  }
  async createConfiguration(actor: Actor, value: any) {
    return this.inTenant(actor, async (c) => {
      const version = (
        await c.query<{ next: string }>(
          'SELECT COALESCE(max(version_number),0)+1 next FROM configuration_versions WHERE scope=$1',
          [value.scope],
        )
      ).rows[0].next;
      const checksum = createHash('sha256').update(JSON.stringify(value.content)).digest('hex');
      const previous = (
        await c.query(
          'SELECT id FROM configuration_versions WHERE scope=$1 ORDER BY version_number DESC LIMIT 1',
          [value.scope],
        )
      ).rows[0];
      const row = (
        await c.query(
          'INSERT INTO configuration_versions(tenant_id,scope,version_number,status,content,checksum,change_reason,previous_version_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING uuid id,scope,version_number,status,content,checksum,change_reason,created_by,created_at',
          [
            actor.tenantId,
            value.scope,
            version,
            'draft',
            JSON.stringify(value.content),
            checksum,
            value.reason,
            previous?.id ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'configuration.created',
        'configuration_version',
        row.id,
        null,
        row,
        value.reason,
      );
      return row;
    });
  }
}
