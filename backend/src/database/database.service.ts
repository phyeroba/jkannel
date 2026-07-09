import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

function applicationConnectionString(): string | undefined {
  // Prefer the non-owner role so row level security applies (see migration 011).
  const appUrl = process.env.DATABASE_APP_URL;
  if (appUrl) return appUrl;
  if (process.env.DATABASE_URL) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message:
          'DATABASE_APP_URL is not set; connecting with the owner role, which bypasses ' +
          'row level security. Configure the jkannel_app role for tenant isolation.',
      }),
    );
  }
  return process.env.DATABASE_URL;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: applicationConnectionString(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Authentication runs before a tenant context exists (the tenant slug is
  // user input), so it uses the dedicated jkannel_auth role, which bypasses
  // RLS but is granted access to identity tables only (migration 011).
  private readonly authPool = process.env.AUTH_DATABASE_URL
    ? new Pool({
        connectionString: process.env.AUTH_DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      })
    : undefined;

  query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  authQuery<T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return (this.authPool ?? this.pool).query<T>(text, values);
  }
  async tenantTransaction<T>(
    tenantId: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    await this.authPool?.end();
  }
}
