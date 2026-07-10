import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition, buildGridSql, parseListQuery } from '../platform/list-query';
import { EngineConfiguration } from '../configuration/configuration-generator.service';

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

export interface ConfigTemplateRow {
  id: string;
  name: string;
  description: string | null;
  engine: string;
  content: EngineConfiguration | Record<string, unknown>;
  is_builtin: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ConfigTemplateInput {
  name: string;
  description?: string;
  engine?: string;
  content: EngineConfiguration | Record<string, unknown>;
  reason?: string;
}

/** Grid whitelist for the configuration template library. */
export const CONFIG_TEMPLATE_GRIDS = {
  templates: {
    searchColumns: ['name', 'description', 'engine'],
    sortColumns: {
      name: 'name',
      engine: 'engine',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    filterColumns: { engine: 'engine', isBuiltin: 'is_builtin' },
    defaultOrderBy: 'is_builtin DESC, name',
  },
} satisfies Record<string, GridDefinition>;

const TEMPLATE_COLUMNS =
  'id,name,description,engine,content,is_builtin,created_by,created_at,updated_at';

/**
 * Built-in starter templates seeded on first list. Each `content` matches the
 * EngineConfiguration shape that ConfigurationGeneratorService.generate
 * consumes, mirroring the console's /configurations/baseline starter, so an
 * instantiated template can be rendered, validated and versioned unchanged.
 */
export const BUILTIN_TEMPLATES: Array<{
  name: string;
  description: string;
  engine: string;
  content: EngineConfiguration;
}> = [
  {
    name: 'Minimal Kamex gateway',
    description:
      'A minimal Kamex gateway: admin and SMSBox ports, JSON logging and a single ' +
      'fake SMSC for smoke tests. No SQLBox persistence. A safe starting point to ' +
      'clone and point at a real SMSC.',
    engine: 'kamex',
    content: {
      adminPort: 13000,
      smsboxPort: 13001,
      adminSecretRef: 'secret://kamex/admin-password',
      logLevel: 1,
      smsc: [{ id: 'fake-smsc', type: 'fake', enabled: true }],
    },
  },
  {
    name: 'Kamex + SQLBox',
    description:
      'A Kamex gateway with SQLBox PostgreSQL persistence enabled and one example ' +
      'SMPP SMSC. Mirrors the console baseline: replace the example SMSC id, host, ' +
      'port and credential reference with your own.',
    engine: 'kamex',
    content: {
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
          enabled: true,
        },
      ],
    },
  },
];

/**
 * Persistence for configuration templates. Every access runs inside a tenant
 * transaction so PostgreSQL row level security (migration 022) enforces
 * isolation; every mutation writes an audit_log row.
 */
@Injectable()
export class ConfigTemplatesRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A template with that name already exists');
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
        'config_template',
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  /**
   * Seeds the built-in templates for the tenant if they are absent. Idempotent
   * via the (tenant_id,name) unique constraint. Runs on first list so a tenant
   * always has starting points without a separate provisioning step.
   */
  private async ensureBuiltins(client: PoolClient, actor: Actor): Promise<void> {
    for (const template of BUILTIN_TEMPLATES) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_templates (tenant_id,name,description,engine,content,is_builtin,created_by)
           VALUES ($1,$2,$3,$4,$5,true,$6)
         ON CONFLICT (tenant_id,name) DO NOTHING
         RETURNING id`,
        [
          actor.tenantId,
          template.name,
          template.description,
          template.engine,
          JSON.stringify(template.content),
          actor.userId,
        ],
      );
      if (inserted.rows[0])
        await this.audit(client, actor, 'config_template.seeded', inserted.rows[0].id, null, {
          name: template.name,
          is_builtin: true,
        });
    }
  }

  async listTemplates(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<GridPage<ConfigTemplateRow>> {
    const parsed = parseListQuery(query, CONFIG_TEMPLATE_GRIDS.templates);
    const fragments = buildGridSql(parsed, CONFIG_TEMPLATE_GRIDS.templates, []);
    const where = fragments.andWhere ? `WHERE ${fragments.andWhere.slice(' AND '.length)}` : '';
    const sql = `SELECT ${TEMPLATE_COLUMNS}, count(*) OVER() AS __total FROM config_templates ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      await this.ensureBuiltins(client, actor);
      const result = await client.query<ConfigTemplateRow & QueryResultRow & { __total: string }>(
        sql,
        fragments.params,
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as unknown as ConfigTemplateRow);
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
  }

  async getTemplate(actor: Actor, id: string): Promise<ConfigTemplateRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<ConfigTemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM config_templates WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Template not found');
      return row;
    });
  }

  async createTemplate(actor: Actor, value: ConfigTemplateInput): Promise<ConfigTemplateRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<ConfigTemplateRow>(
          `INSERT INTO config_templates (tenant_id,name,description,engine,content,is_builtin,created_by)
             VALUES ($1,$2,$3,COALESCE($4,'kamex'),$5,false,$6)
           RETURNING ${TEMPLATE_COLUMNS}`,
          [
            actor.tenantId,
            value.name,
            value.description ?? null,
            value.engine ?? null,
            JSON.stringify(value.content),
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'config_template.created', row.id, null, row);
      return row;
    });
  }

  async updateTemplate(
    actor: Actor,
    id: string,
    value: Partial<ConfigTemplateInput>,
  ): Promise<ConfigTemplateRow> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<ConfigTemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM config_templates WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Template not found');
      if (old.is_builtin)
        throw new ConflictException('Built-in templates cannot be modified; clone one instead');
      const row = (
        await client.query<ConfigTemplateRow>(
          `UPDATE config_templates SET
             name=COALESCE($2,name),
             description=COALESCE($3,description),
             engine=COALESCE($4,engine),
             content=COALESCE($5,content),
             updated_at=now()
           WHERE id=$1 RETURNING ${TEMPLATE_COLUMNS}`,
          [
            id,
            value.name ?? null,
            value.description ?? null,
            value.engine ?? null,
            value.content ? JSON.stringify(value.content) : null,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'config_template.updated', id, old, row, value.reason);
      return row;
    });
  }

  async deleteTemplate(actor: Actor, id: string): Promise<{ id: string; deleted: true }> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<ConfigTemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM config_templates WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Template not found');
      if (old.is_builtin) throw new ConflictException('Built-in templates cannot be deleted');
      await client.query('DELETE FROM config_templates WHERE id=$1', [id]);
      await this.audit(client, actor, 'config_template.deleted', id, old, null);
      return { id, deleted: true };
    });
  }
}
