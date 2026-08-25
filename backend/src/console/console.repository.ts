import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
      // Lets the Connectivity screens ask for one carrier's connections in one
      // request. Without it they had to fetch every SMSC and then call the
      // detail endpoint per row to discover its carrier and bind state.
      carrierId: 's.carrier_id',
      bindState: 'b.state',
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
        // The register's operational columns — carrier, throughput, capacity
        // headroom and the last connectivity event — come from data the poller
        // has been recording all along and nothing was reading:
        //
        //   smsc_bind_snapshots   one row per poll, with the engine's own
        //                         outbound/inbound rate, queue and counters
        //   smsc_bind_transitions append-only bind history, never pruned
        //   carriers              the network the connection belongs to
        //
        // All three are correlated subqueries rather than joins, because a join
        // to a per-poll history table multiplies the register by its own
        // sample count, and a DISTINCT ON large enough to fix that would sort
        // the whole snapshot table on every page of the grid.
        select:
          'SELECT s.id,s.engine_id,s.name,s.description,s.type,s.host,s.port,s.credential_secret_ref,s.tps,s.priority,s.tags,s.enabled,s.lifecycle_state,s.last_error,s.created_at,s.updated_at,s.carrier_id::text AS carrier_id,s.connection_count,s.traffic_suspended_at,s.traffic_suspended_reason,' +
          'b.state AS bind_state,b.observed_at AS bind_observed_at,b.queued_count,b.failed_count,' +
          'c.name AS carrier_name,c.country_code AS carrier_country,c.network_code AS carrier_network,' +
          // Latest sample only. NULL when the poller has never seen this bind,
          // which the console must render as "unknown" and never as zero.
          '(SELECT n.outbound_rate FROM smsc_bind_snapshots n WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC LIMIT 1) AS outbound_rate,' +
          '(SELECT n.inbound_rate FROM smsc_bind_snapshots n WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC LIMIT 1) AS inbound_rate,' +
          '(SELECT n.sent FROM smsc_bind_snapshots n WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC LIMIT 1) AS sent_total,' +
          '(SELECT n.received FROM smsc_bind_snapshots n WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC LIMIT 1) AS received_total,' +
          // QUEUE GROWTH needs two samples of the same bind, so the previous
          // snapshot's depth and age come back alongside the latest. The rate
          // is derived on the client rather than here because the two samples
          // are what makes it honest: a single reading cannot distinguish a
          // queue that is filling from one that has simply always been deep,
          // and OFFSET 1 returns nothing at all when only one poll has ever
          // run — which the console must render as unknown, not as zero growth.
          '(SELECT n.queued FROM smsc_bind_snapshots n WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC OFFSET 1 LIMIT 1) AS queued_previous,' +
          '(SELECT EXTRACT(EPOCH FROM (' +
          '   (SELECT a.observed_at FROM smsc_bind_snapshots a WHERE a.smsc_id=s.id ORDER BY a.observed_at DESC LIMIT 1) -' +
          '   (SELECT b.observed_at FROM smsc_bind_snapshots b WHERE b.smsc_id=s.id ORDER BY b.observed_at DESC OFFSET 1 LIMIT 1)' +
          '))) AS sample_gap_seconds,' +
          // The most recent thing that happened to this bind, for the design's
          // "Last event" column.
          "(SELECT concat_ws(' ', t.to_state, to_char(t.observed_at, 'YYYY-MM-DD HH24:MI')) FROM smsc_bind_transitions t WHERE t.smsc_id=s.id ORDER BY t.observed_at DESC LIMIT 1) AS last_event," +
          '(SELECT t.observed_at FROM smsc_bind_transitions t WHERE t.smsc_id=s.id ORDER BY t.observed_at DESC LIMIT 1) AS last_event_at,' +
          '(SELECT row_to_json(h) FROM (SELECT state,latency_ms,detail,observed_at FROM smsc_health WHERE smsc_id=s.id ORDER BY observed_at DESC LIMIT 1) h) health',
        // LEFT JOIN, so an SMSC that has never been observed still appears —
        // with a null bind state, which the console renders as 'never
        // observed' rather than as a down bind. Same for an unassigned carrier.
        from: 'FROM smsc_definitions s LEFT JOIN smsc_bind_state b ON b.smsc_id = s.id LEFT JOIN carriers c ON c.id = s.carrier_id',
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
      // The SMPP attribute columns (migration 029) are written with COALESCE-by
      // -default semantics: passing NULL keeps the column default, so a caller
      // that supplies only host/port still gets a bindable SMSC.
      const row = (
        await c.query(
          `INSERT INTO smsc_definitions(
             tenant_id,engine_id,name,description,type,host,port,credential_secret_ref,tps,
             priority,tags,enabled,created_by,notes,
             system_id,username_secret_ref,system_type,receive_port,address_range,alt_charset,send_url,
             bind_mode,interface_version,source_addr_ton,source_addr_npi,dest_addr_ton,dest_addr_npi,
             window_size,keepalive_seconds,reconnect_delay_seconds,wait_ack_seconds,max_error_count,use_tls,
             connection_count,connection_timeout_seconds,wait_ack_expire_action,retry_on_auth_failure,
             allowed_smsc_ids,denied_smsc_ids,preferred_smsc_ids,
             allowed_prefixes,denied_prefixes,preferred_prefixes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21,
                  COALESCE($22,'transceiver'),COALESCE($23,34),COALESCE($24,0),COALESCE($25,1),
                  COALESCE($26,1),COALESCE($27,1),COALESCE($28,10),COALESCE($29,30),
                  COALESCE($30,10),COALESCE($31,60),COALESCE($32,10),COALESCE($33,false),
                  -- Migration 041. The two nullable columns are inserted as-is
                  -- (NULL means "do not emit the directive"); the NOT NULL ones
                  -- are COALESCEd onto the same defaults the migration declares.
                  COALESCE($34,1),$35,$36,COALESCE($37,false),
                  COALESCE($38::text[],'{}'),COALESCE($39::text[],'{}'),COALESCE($40::text[],'{}'),
                  COALESCE($41::text[],'{}'),COALESCE($42::text[],'{}'),COALESCE($43::text[],'{}'))
           RETURNING *`,
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
            value.notes ?? null,
            value.systemId ?? null,
            value.usernameSecretRef ?? null,
            value.systemType ?? null,
            value.receivePort ?? null,
            value.addressRange ?? null,
            value.altCharset ?? null,
            value.sendUrl ?? null,
            value.bindMode ?? null,
            value.interfaceVersion ?? null,
            value.sourceAddrTon ?? null,
            value.sourceAddrNpi ?? null,
            value.destAddrTon ?? null,
            value.destAddrNpi ?? null,
            value.windowSize ?? null,
            value.keepaliveSeconds ?? null,
            value.reconnectDelaySeconds ?? null,
            value.waitAckSeconds ?? null,
            value.maxErrorCount ?? null,
            value.useTls ?? null,
            value.connectionCount ?? null,
            value.connectionTimeoutSeconds ?? null,
            value.waitAckExpireAction ?? null,
            value.retryOnAuthFailure ?? null,
            value.allowedSmscIds ?? null,
            value.deniedSmscIds ?? null,
            value.preferredSmscIds ?? null,
            value.allowedPrefixes ?? null,
            value.deniedPrefixes ?? null,
            value.preferredPrefixes ?? null,
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
          // Every column is COALESCE(new, existing), so a partial PATCH only
          // touches the fields the operator supplied.
          `UPDATE smsc_definitions SET
             name=COALESCE($2,name),host=COALESCE($3,host),port=COALESCE($4,port),
             tps=COALESCE($5,tps),enabled=COALESCE($6,enabled),
             description=COALESCE($7,description),notes=COALESCE($8,notes),
             credential_secret_ref=COALESCE($9,credential_secret_ref),
             system_id=COALESCE($10,system_id),
             username_secret_ref=COALESCE($11,username_secret_ref),
             system_type=COALESCE($12,system_type),receive_port=COALESCE($13,receive_port),
             address_range=COALESCE($14,address_range),alt_charset=COALESCE($15,alt_charset),
             send_url=COALESCE($16,send_url),bind_mode=COALESCE($17,bind_mode),
             interface_version=COALESCE($18,interface_version),
             source_addr_ton=COALESCE($19,source_addr_ton),
             source_addr_npi=COALESCE($20,source_addr_npi),
             dest_addr_ton=COALESCE($21,dest_addr_ton),
             dest_addr_npi=COALESCE($22,dest_addr_npi),
             window_size=COALESCE($23,window_size),
             keepalive_seconds=COALESCE($24,keepalive_seconds),
             reconnect_delay_seconds=COALESCE($25,reconnect_delay_seconds),
             wait_ack_seconds=COALESCE($26,wait_ack_seconds),
             max_error_count=COALESCE($27,max_error_count),
             use_tls=COALESCE($28,use_tls),
             -- Migration 041. Same COALESCE-on-NULL semantics as everything
             -- above: an omitted key leaves the stored value alone. The routing
             -- lists are cast explicitly because an empty JS array would
             -- otherwise reach PostgreSQL as an untyped parameter, and an
             -- explicitly-supplied [] is how a caller CLEARS a rule -- it is
             -- passed through as an empty array, not folded back to NULL.
             connection_count=COALESCE($29,connection_count),
             connection_timeout_seconds=COALESCE($30,connection_timeout_seconds),
             wait_ack_expire_action=COALESCE($31,wait_ack_expire_action),
             retry_on_auth_failure=COALESCE($32,retry_on_auth_failure),
             allowed_smsc_ids=COALESCE($33::text[],allowed_smsc_ids),
             denied_smsc_ids=COALESCE($34::text[],denied_smsc_ids),
             preferred_smsc_ids=COALESCE($35::text[],preferred_smsc_ids),
             allowed_prefixes=COALESCE($36::text[],allowed_prefixes),
             denied_prefixes=COALESCE($37::text[],denied_prefixes),
             preferred_prefixes=COALESCE($38::text[],preferred_prefixes),
             updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            id,
            value.name ?? null,
            value.host ?? null,
            value.port ?? null,
            value.tps ?? null,
            value.enabled ?? null,
            value.description ?? null,
            value.notes ?? null,
            value.credentialSecretRef ?? null,
            value.systemId ?? null,
            value.usernameSecretRef ?? null,
            value.systemType ?? null,
            value.receivePort ?? null,
            value.addressRange ?? null,
            value.altCharset ?? null,
            value.sendUrl ?? null,
            value.bindMode ?? null,
            value.interfaceVersion ?? null,
            value.sourceAddrTon ?? null,
            value.sourceAddrNpi ?? null,
            value.destAddrTon ?? null,
            value.destAddrNpi ?? null,
            value.windowSize ?? null,
            value.keepaliveSeconds ?? null,
            value.reconnectDelaySeconds ?? null,
            value.waitAckSeconds ?? null,
            value.maxErrorCount ?? null,
            value.useTls ?? null,
            value.connectionCount ?? null,
            value.connectionTimeoutSeconds ?? null,
            value.waitAckExpireAction ?? null,
            value.retryOnAuthFailure ?? null,
            value.allowedSmscIds ?? null,
            value.deniedSmscIds ?? null,
            value.preferredSmscIds ?? null,
            value.allowedPrefixes ?? null,
            value.deniedPrefixes ?? null,
            value.preferredPrefixes ?? null,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, 'smsc.updated', 'smsc', id, old, row, value.reason);
      return row;
    });
  }
  /**
   * Archives an SMSC (lifecycle_state='archived', enabled=false). Refuses with a
   * 409 if any routing rule still references it as a target or fallback, so an
   * SMSC in active use cannot be silently removed. Never hard-deletes.
   */
  async archiveSmsc(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM smsc_definitions WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('SMSC not found');
      const references = (
        await c.query<{ id: string; name: string; role: string }>(
          `SELECT id, name, 'target' role FROM routing_rules WHERE target_smsc_id=$1
             UNION ALL
           SELECT id, name, 'fallback' role FROM routing_rules WHERE fallback_smsc_id=$1
           ORDER BY name LIMIT 20`,
          [id],
        )
      ).rows;
      if (references.length) {
        const names = [...new Set(references.map((r) => r.name))].join(', ');
        throw new ConflictException(
          `This SMSC is referenced by ${references.length} routing rule(s) (${names}). ` +
            'Repoint or remove those routes before archiving it.',
        );
      }
      const row = (
        await c.query(
          "UPDATE smsc_definitions SET lifecycle_state='archived',enabled=false,updated_at=now() WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.audit(c, actor, 'smsc.archived', 'smsc', id, old, row);
      return row;
    });
  }
  async beginSmscOperation(
    actor: Actor,
    smscId: string,
    operation: string,
    idempotencyKey: string,
    reason: string | null = null,
  ) {
    return this.inTenant(actor, async (c) => {
      const existing = (
        await c.query('SELECT * FROM smsc_deployments WHERE idempotency_key=$1', [idempotencyKey])
      ).rows[0];
      if (existing) return { ...existing, replayed: true };
      const row = (
        await c.query(
          "INSERT INTO smsc_deployments(tenant_id,smsc_id,operation,status,idempotency_key,requested_by,reason) VALUES($1,$2,$3,'pending',$4,$5,$6) RETURNING *",
          [actor.tenantId, smscId, operation, idempotencyKey, actor.userId, reason],
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
    /**
     * WHAT the operation actually verified (migration 038), so a stored success
     * cannot be read as more than it was: `smpp_bind` / `tcp_socket` /
     * `not_applicable` for a test, `bind_cycled` / `command_accepted` for a
     * reconnect. NULL for operations that make no verification claim.
     */
    verification?: string,
  ) {
    return this.inTenant(actor, async (c) => {
      const status = succeeded ? 'succeeded' : 'failed';
      const deployment = (
        await c.query(
          'UPDATE smsc_deployments SET status=$2,detail=$3,verification=$4,completed_at=now() WHERE id=$1 RETURNING *',
          [deploymentId, status, detail, verification ?? null],
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
        // The design's "Last transition" and "Used / capacity" columns.
        //
        // Both are about the route's TARGET rather than the route, and both are
        // correlated subqueries for the same reason the SMSC register uses
        // them: joining a per-poll history table to the register would
        // multiply every route by its target's sample count.
        //
        // The rate is NULL, never 0, when the poller has never sampled the
        // target — an unobserved connection is not an idle one, and the console
        // renders the two differently.
        select:
          'SELECT r.*,s.name target_smsc_name,f.name fallback_smsc_name,' +
          's.tps AS target_tps,' +
          'GREATEST(COALESCE(s.connection_count,1),1) AS target_connections,' +
          '(SELECT n.outbound_rate FROM smsc_bind_snapshots n ' +
          '  WHERE n.smsc_id=s.id ORDER BY n.observed_at DESC LIMIT 1) AS target_outbound_rate,' +
          // The most recent failover on this route, ENDED ones included: the
          // question is "when did traffic last move", and a reverted move is
          // still a move.
          "(SELECT concat_ws(' ', CASE WHEN v.ended_at IS NULL THEN 'moved' ELSE 'reverted' END, " +
          "  to_char(COALESCE(v.ended_at, v.started_at), 'YYYY-MM-DD HH24:MI')) " +
          '   FROM route_failovers v WHERE v.route_id=r.id ' +
          '  ORDER BY COALESCE(v.ended_at, v.started_at) DESC LIMIT 1) AS last_transition',
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
  /**
   * The routes the simulator evaluates, and the ones it must warn about.
   *
   * This used to select EVERY row in `routing_rules`, while the send path takes
   * `deployedOnly: true` (see `route-resolution.service.ts`). The simulator
   * therefore predicted a winner from routes that were not in force: an
   * operator created a route, asked the simulator whether traffic would reach
   * it, was told yes, and then had every message refused with "no route
   * matched the destination". The preview an operator uses to decide whether a
   * change is safe was answering a different question from the one that
   * decides delivery.
   *
   * Deployed rows are returned for evaluation. The rest come back separately so
   * the answer can say "a route matches but is not deployed", which is the
   * actual situation and is far more useful than either a false match or a bare
   * "no route matched" moments after one was created.
   */
  async routeSimulationData(actor: Actor) {
    return this.inTenant(actor, async (c) => {
      const COLUMNS =
        'id::text,priority,enabled,destination_prefix,sender,target_smsc_id::text,fallback_smsc_id::text';
      const routes = (
        await c.query(
          `SELECT ${COLUMNS} FROM routing_rules WHERE deployment_state='deployed' ORDER BY priority,id`,
        )
      ).rows;
      const undeployed = (
        await c.query(
          `SELECT ${COLUMNS},deployment_state FROM routing_rules WHERE deployment_state<>'deployed' ORDER BY priority,id`,
        )
      ).rows;
      const smscs = (
        await c.query(
          "SELECT id::text FROM smsc_definitions WHERE enabled=true AND lifecycle_state NOT IN ('disabled','archived','degraded')",
        )
      ).rows;
      return { routes, undeployed, smscs };
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
        // `last_seen_at` comes from the audit trail rather than a column on
        // `users`, and that is deliberate. A `last_login_at` column has to be
        // written on every successful sign-in — a write on the hottest path in
        // the system, purely to display a timestamp — and it can drift from the
        // audit trail, which is the record anyone would actually be believed
        // over. Reading the trail means there is one answer and it is the
        // auditable one.
        //
        // NULL when the user has never signed in since auditing began, which
        // the console renders as "never seen" rather than as a date.
        select:
          "SELECT u.id,u.username,u.status,u.created_at,u.updated_at," +
          "(SELECT COALESCE(array_agg(r.name),'{}') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) roles," +
          "(SELECT max(a.created_at) FROM audit_log a " +
          "  WHERE a.actor_id = u.id::text AND a.action = 'login.succeeded') AS last_seen_at",
        from: 'FROM users u',
      },
      CONSOLE_GRIDS.users,
      query,
    );
  }
  // ---------------------------------------------------------------------------
  // Roles, permissions and role administration.
  //
  // Before migration 036 the whole surface here was one read-only SELECT: there
  // was no way to create a role or change what one grants, so least privilege
  // was unachievable and the console's Roles screen was a viewer. Everything
  // below is tenant-scoped (all queries run inside inTenant, so RLS applies) and
  // every mutation writes an audit_log row in the same transaction.
  //
  // The catalogue invariant -- a role may never be granted a permission that
  // does not exist -- is enforced twice: resolvePermissionIds rejects unknown
  // codes with a 400 that names them, and role_permissions.permission_id is a
  // foreign key into permissions, so even a bug cannot invent one.
  // ---------------------------------------------------------------------------

  /**
   * Column list for a role row in the shape the console API publishes:
   * camelCase `userCount`/`isSystem` and a sorted `permissions` code array.
   */
  private static readonly ROLE_SELECT = `SELECT r.id,r.name,r.description,r.is_system AS "isSystem",
      r.created_at AS "createdAt",r.updated_at AS "updatedAt",
      (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id=r.id) AS "userCount",
      COALESCE((SELECT array_agg(p.code ORDER BY p.code) FROM role_permissions rp
                  JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id),'{}') AS permissions
     FROM roles r`;

  listRoles(actor: Actor) {
    return this.list(actor, `${ConsoleRepository.ROLE_SELECT} ORDER BY r.name`);
  }

  /** The full permission catalogue (global, seeded by migration 036). */
  listPermissions(actor: Actor) {
    return this.list(
      actor,
      'SELECT code,description,category FROM permissions ORDER BY category,code',
    );
  }

  async getRole(actor: Actor, id: string) {
    return this.inTenant(actor, (c) => this.roleById(c, id));
  }

  private async roleById(client: PoolClient, id: string) {
    const row = (await client.query(`${ConsoleRepository.ROLE_SELECT} WHERE r.id=$1`, [id]))
      .rows[0];
    if (!row) throw new NotFoundException('Role not found');
    return row;
  }

  /**
   * Map permission codes to catalogue ids, rejecting the request with a 400 that
   * names every code that does not exist. Duplicates in the input collapse.
   */
  private async resolvePermissionIds(client: PoolClient, codes: string[]): Promise<string[]> {
    const wanted = [...new Set(codes)];
    if (!wanted.length) return [];
    const rows = (
      await client.query<{ id: string; code: string }>(
        'SELECT id,code FROM permissions WHERE code = ANY($1::text[])',
        [wanted],
      )
    ).rows;
    const known = new Map(rows.map((row) => [row.code, row.id]));
    const unknown = wanted.filter((code) => !known.has(code));
    if (unknown.length)
      throw new BadRequestException(`Unknown permission code(s): ${unknown.sort().join(', ')}`);
    return wanted.map((code) => known.get(code)!);
  }

  private async replaceRolePermissions(
    client: PoolClient,
    actor: Actor,
    roleId: string,
    permissionIds: string[],
  ): Promise<void> {
    await client.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
    for (const permissionId of permissionIds) {
      await client.query(
        'INSERT INTO role_permissions(tenant_id,role_id,permission_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [actor.tenantId, roleId, permissionId],
      );
    }
  }

  /** How many users currently hold `code` through any role, in this tenant. */
  private async holdersOf(client: PoolClient, code: string): Promise<number> {
    const row = (
      await client.query<{ count: string }>(
        `SELECT count(DISTINCT ur.user_id)::int AS count
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id=ur.role_id
           JOIN permissions p ON p.id=rp.permission_id
          WHERE p.code=$1`,
        [code],
      )
    ).rows[0];
    return Number(row?.count ?? 0);
  }

  /**
   * Refuse a change that would leave nobody able to administer roles again.
   * Only applies when somebody held `users.manage` beforehand, so a tenant that
   * never had an administrator is not frozen out of building one.
   */
  private async assertRoleAdministrationSurvives(
    client: PoolClient,
    before: number,
  ): Promise<void> {
    if (before === 0) return;
    if ((await this.holdersOf(client, 'users.manage')) === 0)
      throw new ConflictException(
        'That change would leave no user holding users.manage; role administration would become impossible',
      );
  }

  async createRole(
    actor: Actor,
    value: { name: string; description?: string; permissions: string[] },
  ) {
    return this.inTenant(actor, async (c) => {
      const permissionIds = await this.resolvePermissionIds(c, value.permissions);
      let roleId: string;
      try {
        roleId = (
          await c.query<{ id: string }>(
            'INSERT INTO roles(tenant_id,name,description,is_system) VALUES($1,$2,$3,false) RETURNING id',
            [actor.tenantId, value.name, value.description ?? null],
          )
        ).rows[0].id;
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('A role with that name already exists');
        throw error;
      }
      await this.replaceRolePermissions(c, actor, roleId, permissionIds);
      const created = await this.roleById(c, roleId);
      await this.audit(c, actor, 'role.created', 'role', roleId, null, created);
      return created;
    });
  }

  async updateRole(
    actor: Actor,
    id: string,
    value: { name?: string; description?: string; permissions?: string[]; reason?: string },
  ) {
    return this.inTenant(actor, async (c) => {
      const before = await this.roleById(c, id);
      const administrators = await this.holdersOf(c, 'users.manage');
      // A system role's name is part of the seeded catalogue and of migration
      // 036's idempotency key; renaming one would make a re-run create a
      // duplicate. Its description and permission set stay fully editable --
      // "roles shall be configurable" (USER_MANAGEMENT spec §8).
      if (before.isSystem && value.name !== undefined && value.name !== before.name)
        throw new ConflictException('A system role cannot be renamed');
      const permissionIds =
        value.permissions === undefined
          ? undefined
          : await this.resolvePermissionIds(c, value.permissions);
      if (value.name !== undefined || value.description !== undefined) {
        try {
          await c.query(
            'UPDATE roles SET name=COALESCE($2,name),description=COALESCE($3,description),updated_at=now() WHERE id=$1',
            [id, value.name ?? null, value.description ?? null],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505')
            throw new ConflictException('A role with that name already exists');
          throw error;
        }
      }
      if (permissionIds !== undefined) {
        await this.replaceRolePermissions(c, actor, id, permissionIds);
        await c.query('UPDATE roles SET updated_at=now() WHERE id=$1', [id]);
        await this.assertRoleAdministrationSurvives(c, administrators);
        // A privilege change must not survive in an already-issued session.
        // Mirrors updateUser: refresh re-resolves permissions, and revoking here
        // makes the demotion immediate for everyone holding this role.
        await c.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM user_roles WHERE role_id=$1)',
          [id],
        );
      }
      const updated = await this.roleById(c, id);
      await this.audit(c, actor, 'role.updated', 'role', id, before, updated, value.reason);
      return updated;
    });
  }

  async deleteRole(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const role = await this.roleById(c, id);
      if (role.isSystem)
        throw new ConflictException(
          'A system role cannot be deleted; edit its permissions instead',
        );
      if (Number(role.userCount) > 0)
        throw new ConflictException(
          `Role is assigned to ${role.userCount} user(s); reassign them before deleting it`,
        );
      const administrators = await this.holdersOf(c, 'users.manage');
      await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
      await c.query('DELETE FROM roles WHERE id=$1', [id]);
      await this.assertRoleAdministrationSurvives(c, administrators);
      await this.audit(c, actor, 'role.deleted', 'role', id, role, null);
      return { id, deleted: true };
    });
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
      // Privilege changes must not survive in an already-issued session.
      // AuthService.refresh now re-resolves status/roles from the database, so a
      // demoted user loses their extra permissions within one access-token
      // lifetime (15 min) even without this; revoking here makes it immediate
      // and matches archiveUser, which already did it. Triggers on:
      //   - a status change away from 'active' (disable/expire/lock/archive),
      //   - any role reassignment,
      //   - an admin-set password (the token-based reset path already revokes;
      //     this path previously did not).
      const deactivated = Boolean(value.status) && value.status !== 'active';
      const rolesChanged = Array.isArray(value.roleIds);
      if (deactivated || rolesChanged || value.passwordHash) {
        await c.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [id],
        );
      }
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
  /**
   * A report snapshot by uuid plus the other snapshots for the SAME period
   * (tenant + period_type + period_start): the total and per-SMSC / per-route
   * breakdown, so opening one snapshot shows the full period. RLS scopes both
   * queries to the caller's tenant.
   */
  async getReportSnapshotDetail(actor: Actor, id: string) {
    const columns =
      'id,period_type,period_start,period_end,scope,scope_key,scope_label,message_count,dlr_count,details,generated_at';
    return this.inTenant(actor, async (c) => {
      const snapshot = (await c.query(`SELECT ${columns} FROM report_snapshots WHERE id=$1`, [id]))
        .rows[0];
      if (!snapshot) throw new NotFoundException('Report snapshot not found');
      const related = (
        await c.query(
          `SELECT ${columns} FROM report_snapshots
            WHERE period_type=$1 AND period_start=$2 AND id<>$3
            ORDER BY scope, scope_label`,
          [snapshot.period_type, snapshot.period_start, id],
        )
      ).rows;
      return { snapshot, related };
    });
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
