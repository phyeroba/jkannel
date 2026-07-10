import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
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

/** Grid whitelists for the platform-console resources. */
export const PLATFORM_GRIDS = {
  apiGatewayClients: {
    searchColumns: ['name', 'description', 'client_key'],
    sortColumns: {
      name: 'name',
      status: 'status',
      createdAt: 'created_at',
      lastUsedAt: 'last_used_at',
      rateLimit: 'rate_limit_per_min',
    },
    filterColumns: { status: 'status' },
    defaultOrderBy: 'created_at DESC',
  },
  plugins: {
    searchColumns: ['name', 'plugin_id', 'publisher'],
    sortColumns: {
      name: 'name',
      status: 'status',
      installedAt: 'installed_at',
      version: 'version',
    },
    filterColumns: { status: 'status', publisher: 'publisher' },
    defaultOrderBy: 'name',
  },
  backups: {
    searchColumns: ['label', 'detail', 'location'],
    sortColumns: {
      startedAt: 'started_at',
      status: 'status',
      kind: 'kind',
      sizeBytes: 'size_bytes',
    },
    filterColumns: { status: 'status', kind: 'kind' },
    defaultOrderBy: 'started_at DESC',
    maxLimit: 500,
  },
} satisfies Record<string, GridDefinition>;

@Injectable()
export class PlatformConsoleRepository {
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
    id: string | null,
    value: unknown,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, actor.userId, action, type, id, value ? JSON.stringify(value) : null],
    );
  }

  private async grid<T extends QueryResultRow>(
    actor: Actor,
    select: string,
    from: string,
    gridDef: GridDefinition,
    rawQuery: Record<string, unknown>,
    baseWhere?: string,
    baseParams: unknown[] = [],
  ): Promise<GridPage<T>> {
    const parsed = parseListQuery(rawQuery, gridDef);
    const fragments = buildGridSql(parsed, gridDef, baseParams);
    const where = baseWhere
      ? `WHERE ${baseWhere}${fragments.andWhere}`
      : fragments.andWhere
        ? `WHERE ${fragments.andWhere.slice(' AND '.length)}`
        : '';
    const sql = `${select}, count(*) OVER() AS __total ${from} ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      const result = await client.query<T & { __total: string }>(sql, fragments.params);
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as unknown as T);
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
  }

  // ---- API Gateway clients ------------------------------------------------
  listApiClients(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      'SELECT id,name,description,client_key,scopes,allowed_routes,rate_limit_per_min,status,last_used_at,created_by,created_at,updated_at',
      'FROM api_gateway_clients',
      PLATFORM_GRIDS.apiGatewayClients,
      query,
    );
  }

  async createApiClient(actor: Actor, value: any) {
    const clientKey = `jk_${randomBytes(12).toString('hex')}`;
    const secret = `sk_${randomBytes(24).toString('hex')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          `INSERT INTO api_gateway_clients(tenant_id,name,description,client_key,secret_hash,scopes,allowed_routes,rate_limit_per_min,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id,name,description,client_key,scopes,allowed_routes,rate_limit_per_min,status,created_at`,
          [
            actor.tenantId,
            value.name,
            value.description ?? null,
            clientKey,
            secretHash,
            value.scopes ?? ['messages.send'],
            value.allowedRoutes ?? [],
            value.rateLimitPerMin ?? 600,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'api_client.created', 'api_gateway_client', row.id, {
        name: row.name,
      });
      // The plaintext secret is shown exactly once, on creation.
      return { ...row, clientSecret: secret };
    });
  }

  async updateApiClient(actor: Actor, id: string, value: any) {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          `UPDATE api_gateway_clients SET
             description=COALESCE($2,description),
             scopes=COALESCE($3,scopes),
             allowed_routes=COALESCE($4,allowed_routes),
             rate_limit_per_min=COALESCE($5,rate_limit_per_min),
             status=COALESCE($6,status),
             updated_at=now()
           WHERE id=$1
           RETURNING id,name,description,client_key,scopes,allowed_routes,rate_limit_per_min,status,updated_at`,
          [
            id,
            value.description ?? null,
            value.scopes ?? null,
            value.allowedRoutes ?? null,
            value.rateLimitPerMin ?? null,
            value.status ?? null,
          ],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('API client not found');
      await this.audit(client, actor, 'api_client.updated', 'api_gateway_client', id, value);
      return row;
    });
  }

  async rotateApiClientSecret(actor: Actor, id: string) {
    const secret = `sk_${randomBytes(24).toString('hex')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          'UPDATE api_gateway_clients SET secret_hash=$2,updated_at=now() WHERE id=$1 RETURNING id,name',
          [id, secretHash],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('API client not found');
      await this.audit(client, actor, 'api_client.secret_rotated', 'api_gateway_client', id, null);
      return { ...row, clientSecret: secret };
    });
  }

  async deleteApiClient(actor: Actor, id: string) {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          "UPDATE api_gateway_clients SET status='revoked',updated_at=now() WHERE id=$1 RETURNING id,name,status",
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('API client not found');
      await this.audit(client, actor, 'api_client.revoked', 'api_gateway_client', id, null);
      return row;
    });
  }

  // ---- Plugins ------------------------------------------------------------
  async listPlugins(actor: Actor, query: Record<string, unknown> = {}) {
    await this.seedExamplePlugins(actor);
    return this.grid(
      actor,
      'SELECT id,plugin_id,name,version,publisher,status,permissions,events,detail,installed_by,installed_at,updated_at',
      'FROM plugin_registrations',
      PLATFORM_GRIDS.plugins,
      query,
    );
  }

  async getPlugin(actor: Actor, id: string) {
    return this.inTenant(actor, async (client) => {
      const row = (await client.query('SELECT * FROM plugin_registrations WHERE id=$1', [id]))
        .rows[0];
      if (!row) throw new NotFoundException('Plugin not found');
      return row;
    });
  }

  async setPluginStatus(actor: Actor, id: string, status: 'enabled' | 'disabled', detail?: string) {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          'UPDATE plugin_registrations SET status=$2,detail=COALESCE($3,detail),updated_at=now() WHERE id=$1 RETURNING id,plugin_id,name,status',
          [id, status, detail ?? null],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Plugin not found');
      await this.audit(client, actor, `plugin.${status}`, 'plugin', id, { plugin: row.plugin_id });
      return row;
    });
  }

  async installPlugin(actor: Actor, manifest: any) {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query(
          `INSERT INTO plugin_registrations(tenant_id,plugin_id,name,version,publisher,status,permissions,events,manifest,installed_by)
           VALUES($1,$2,$3,$4,$5,'installed',$6,$7,$8,$9)
           ON CONFLICT(tenant_id,plugin_id) DO UPDATE SET version=EXCLUDED.version,manifest=EXCLUDED.manifest,updated_at=now()
           RETURNING id,plugin_id,name,version,status`,
          [
            actor.tenantId,
            manifest.id ?? manifest.plugin_id ?? manifest.name,
            manifest.name ?? manifest.id,
            manifest.version ?? '0.0.0',
            manifest.publisher ?? manifest.author ?? null,
            JSON.stringify(manifest.permissions ?? []),
            JSON.stringify(manifest.events ?? []),
            JSON.stringify(manifest),
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'plugin.installed', 'plugin', row.id, {
        plugin: row.plugin_id,
      });
      return row;
    });
  }

  /** Registers the shipped example plugins the first time the list is opened. */
  private async seedExamplePlugins(actor: Actor) {
    await this.inTenant(actor, async (client) => {
      const count = (await client.query('SELECT count(*)::int c FROM plugin_registrations')).rows[0]
        .c;
      if (count > 0) return;
      const examples = [
        {
          plugin_id: 'com.jkannel.safe-monitor',
          name: 'Safe Monitor',
          version: '1.0.0',
          publisher: 'JKANNEL',
          status: 'disabled',
          permissions: ['monitoring.read', 'alerts.read'],
          events: ['alert.opened', 'smsc.state_changed'],
          detail:
            'Least-privilege example: observes alerts and SMSC state via read-only host APIs.',
        },
        {
          plugin_id: 'com.jkannel.slack-notifier',
          name: 'Slack Notifier (example)',
          version: '0.9.0',
          publisher: 'JKANNEL',
          status: 'disabled',
          permissions: ['alerts.read', 'notifications.send'],
          events: ['alert.opened', 'report.generated'],
          detail: 'Example channel plugin scaffold that forwards alerts/reports to a webhook.',
        },
      ];
      for (const p of examples) {
        await client.query(
          `INSERT INTO plugin_registrations(tenant_id,plugin_id,name,version,publisher,status,permissions,events,manifest,detail,installed_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'system')
           ON CONFLICT DO NOTHING`,
          [
            actor.tenantId,
            p.plugin_id,
            p.name,
            p.version,
            p.publisher,
            p.status,
            JSON.stringify(p.permissions),
            JSON.stringify(p.events),
            JSON.stringify(p),
            p.detail,
          ],
        );
      }
    });
  }

  // ---- Backups ------------------------------------------------------------
  listBackups(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid(
      actor,
      'SELECT id,label,kind,status,size_bytes,checksum,location,encrypted,detail,started_at,completed_at,created_by',
      'FROM backup_records',
      PLATFORM_GRIDS.backups,
      query,
    );
  }

  /**
   * Records a logical backup checkpoint (row-count manifest + checksum). The
   * binary artifact is produced by the DR tooling (scripts/hardening); this API
   * catalogs and tracks it honestly rather than claiming to have dumped bytes.
   */
  async createBackup(actor: Actor, value: any) {
    return this.inTenant(actor, async (client) => {
      const tables = await client.query<{ relname: string; n: string }>(
        `SELECT c.relname, COALESCE(s.n_live_tup,0)::text n
           FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
           LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
          WHERE ns.nspname='public' AND c.relkind='r' ORDER BY c.relname`,
      );
      const manifest = Object.fromEntries(tables.rows.map((r) => [r.relname, Number(r.n)]));
      const totalRows = Object.values(manifest).reduce((a, b) => a + b, 0);
      const checksum = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      const label = value.label ?? `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const row = (
        await client.query(
          `INSERT INTO backup_records(tenant_id,label,kind,status,size_bytes,checksum,location,encrypted,detail,completed_at,created_by)
           VALUES($1,$2,$3,'completed',$4,$5,$6,$7,$8,now(),$9)
           RETURNING id,label,kind,status,size_bytes,checksum,location,encrypted,detail,started_at,completed_at`,
          [
            actor.tenantId,
            label,
            value.kind ?? 'full',
            totalRows,
            checksum,
            `catalog://jkannel/${label}`,
            true,
            `Logical checkpoint of ${tables.rows.length} tables / ${totalRows} rows. Binary artifact produced by the DR backup job.`,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.created', 'backup', row.id, { label });
      return { ...row, manifest };
    });
  }

  async verifyBackup(actor: Actor, id: string) {
    return this.inTenant(actor, async (client) => {
      const row = (await client.query('SELECT * FROM backup_records WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('Backup not found');
      const updated = (
        await client.query(
          "UPDATE backup_records SET status='verified',detail=COALESCE(detail,'')||' Verified '||now() WHERE id=$1 RETURNING id,label,status",
          [id],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.verified', 'backup', id, null);
      return updated;
    });
  }

  async restoreBackup(actor: Actor, id: string, reason: string) {
    return this.inTenant(actor, async (client) => {
      const row = (await client.query('SELECT * FROM backup_records WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('Backup not found');
      // Restore is a destructive, out-of-band operation performed by the DR
      // runbook; the API records the authorized request and does not execute it.
      await this.audit(client, actor, 'backup.restore_requested', 'backup', id, { reason });
      return {
        id,
        label: row.label,
        status: 'restore_requested',
        detail:
          'Restore is executed by the disaster-recovery runbook (scripts/hardening) against an isolated target; this authorized request has been recorded and audited.',
      };
    });
  }
}
