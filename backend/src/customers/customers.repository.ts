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

export interface CustomerRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
  contact_email: string | null;
  quota_daily: string | null;
  rate_limit_per_min: number | null;
  allowed_sender_ids: string[];
  notes: string | null;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerInput {
  name: string;
  code?: string;
  status?: string;
  contactEmail?: string;
  quotaDaily?: number;
  rateLimitPerMin?: number;
  allowedSenderIds?: string[];
  notes?: string;
  reason?: string;
}

/** Grid whitelist for the customer directory. */
export const CUSTOMER_GRIDS = {
  customers: {
    searchColumns: ['name', 'code', 'contact_email'],
    sortColumns: {
      name: 'name',
      status: 'status',
      createdAt: 'created_at',
    },
    filterColumns: { status: 'status', enabled: 'enabled' },
    defaultOrderBy: 'name',
  },
} satisfies Record<string, GridDefinition>;

const CUSTOMER_COLUMNS =
  'id,name,code,status,contact_email,quota_daily,rate_limit_per_min,allowed_sender_ids,notes,enabled,created_by,created_at,updated_at';

/**
 * Persistence for the Customer Domain. Every access runs inside a tenant
 * transaction so PostgreSQL row level security (migration 020) enforces
 * isolation; every mutation writes an audit_log row.
 */
@Injectable()
export class CustomersRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A customer with that code already exists');
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
        'customer',
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  private async grid<T extends QueryResultRow>(
    actor: Actor,
    select: string,
    from: string,
    gridDef: GridDefinition,
    rawQuery: Record<string, unknown>,
  ): Promise<GridPage<T>> {
    const parsed = parseListQuery(rawQuery, gridDef);
    const fragments = buildGridSql(parsed, gridDef, []);
    const where = fragments.andWhere ? `WHERE ${fragments.andWhere.slice(' AND '.length)}` : '';
    const sql = `${select}, count(*) OVER() AS __total ${from} ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      const result = await client.query<T & { __total: string }>(sql, fragments.params);
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as unknown as T);
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
  }

  listCustomers(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid<CustomerRow>(
      actor,
      `SELECT ${CUSTOMER_COLUMNS}`,
      'FROM customers',
      CUSTOMER_GRIDS.customers,
      query,
    );
  }

  async getCustomer(actor: Actor, id: string): Promise<CustomerRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<CustomerRow>(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      if (!row) throw new NotFoundException('Customer not found');
      return row;
    });
  }

  async createCustomer(actor: Actor, value: CustomerInput): Promise<CustomerRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<CustomerRow>(
          `INSERT INTO customers
             (tenant_id,name,code,status,contact_email,quota_daily,rate_limit_per_min,allowed_sender_ids,notes,created_by)
           VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7,$8,$9,$10)
           RETURNING ${CUSTOMER_COLUMNS}`,
          [
            actor.tenantId,
            value.name,
            value.code ?? null,
            value.status ?? null,
            value.contactEmail ?? null,
            value.quotaDaily ?? null,
            value.rateLimitPerMin ?? null,
            value.allowedSenderIds ?? [],
            value.notes ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'customer.created', row.id, null, row);
      return row;
    });
  }

  async updateCustomer(actor: Actor, id: string, value: CustomerInput): Promise<CustomerRow> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<CustomerRow>(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      if (!old) throw new NotFoundException('Customer not found');
      const row = (
        await client.query<CustomerRow>(
          `UPDATE customers SET
             name=COALESCE($2,name),
             code=COALESCE($3,code),
             status=COALESCE($4,status),
             contact_email=COALESCE($5,contact_email),
             quota_daily=COALESCE($6,quota_daily),
             rate_limit_per_min=COALESCE($7,rate_limit_per_min),
             allowed_sender_ids=COALESCE($8,allowed_sender_ids),
             notes=COALESCE($9,notes),
             updated_at=now()
           WHERE id=$1 RETURNING ${CUSTOMER_COLUMNS}`,
          [
            id,
            value.name ?? null,
            value.code ?? null,
            value.status ?? null,
            value.contactEmail ?? null,
            value.quotaDaily ?? null,
            value.rateLimitPerMin ?? null,
            value.allowedSenderIds ?? null,
            value.notes ?? null,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'customer.updated', id, old, row, value.reason);
      return row;
    });
  }

  /** Soft-delete: archive the customer (status='archived', enabled=false). */
  async archiveCustomer(actor: Actor, id: string): Promise<CustomerRow> {
    return this.inTenant(actor, async (client) => {
      const old = (
        await client.query<CustomerRow>(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      if (!old) throw new NotFoundException('Customer not found');
      const row = (
        await client.query<CustomerRow>(
          `UPDATE customers SET status='archived',enabled=false,updated_at=now()
            WHERE id=$1 RETURNING ${CUSTOMER_COLUMNS}`,
          [id],
        )
      ).rows[0];
      await this.audit(client, actor, 'customer.archived', id, old, row);
      return row;
    });
  }
}
