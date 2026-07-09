/**
 * Cross-tenant row-level-security proof.
 *
 * Runs only when RLS_TEST_DATABASE_URL (a connection string for the NON-OWNER
 * application role, jkannel_app) and RLS_TEST_OWNER_DATABASE_URL (the owner
 * role, used to seed fixtures) are set — for example against the Compose
 * PostgreSQL after `npm run migrate`. It is skipped otherwise so the unit
 * pipeline stays honest about what it verified.
 *
 *   RLS_TEST_OWNER_DATABASE_URL=postgresql://jkannel:...@localhost:5432/jkannel \
 *   RLS_TEST_DATABASE_URL=postgresql://jkannel_app:...@localhost:5432/jkannel \
 *   npm run test:integration
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const appUrl = process.env.RLS_TEST_DATABASE_URL;
const ownerUrl = process.env.RLS_TEST_OWNER_DATABASE_URL;
const describeRls = appUrl && ownerUrl ? describe : describe.skip;

describeRls('row level security (jkannel_app)', () => {
  let owner: Client;
  let app: Client;
  let tenantA: string;
  let tenantB: string;
  const marker = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl });
    app = new Client({ connectionString: appUrl });
    await owner.connect();
    await app.connect();
    const tenants = await owner.query(
      `INSERT INTO tenants (name, slug)
       VALUES ('RLS Test A ${marker}', 'rls-a-${marker}'), ('RLS Test B ${marker}', 'rls-b-${marker}')
       RETURNING id::text`,
    );
    tenantA = tenants.rows[0].id;
    tenantB = tenants.rows[1].id;
    await owner.query(
      `INSERT INTO smsc_definitions (tenant_id, engine_id, name, type, tps, created_by)
       VALUES ($1, 'rls-a-smsc-${marker}', 'Tenant A SMSC', 'fake', 10, 'rls-test'),
              ($2, 'rls-b-smsc-${marker}', 'Tenant B SMSC', 'fake', 10, 'rls-test')`,
      [tenantA, tenantB],
    );
    await owner.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id)
       VALUES ($1, 'rls-test', 'rls.probe', 'test', 'a-${marker}'),
              ($2, 'rls-test', 'rls.probe', 'test', 'b-${marker}')`,
      [tenantA, tenantB],
    );
  });

  afterAll(async () => {
    if (owner) {
      await owner
        .query('DELETE FROM smsc_definitions WHERE engine_id LIKE $1', [`rls-%-smsc-${marker}`])
        .catch(() => undefined);
      // audit_log is immutable by design; test rows remain as evidence.
      await owner.end();
    }
    if (app) await app.end();
  });

  async function asTenant<T>(tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await app.query(sql, params);
    await app.query('COMMIT');
    return result.rows as T[];
  }

  it('confirms FORCE ROW LEVEL SECURITY is active on tenant tables', async () => {
    const rows = await owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity AND NOT c.relforcerowsecurity`,
    );
    expect(rows.rows).toEqual([]);
  });

  it('shows a tenant only its own SMSC definitions', async () => {
    const visibleToA = await asTenant<{ engine_id: string }>(
      tenantA,
      'SELECT engine_id FROM smsc_definitions WHERE engine_id LIKE $1',
      [`rls-%-smsc-${marker}`],
    );
    expect(visibleToA.map((row) => row.engine_id)).toEqual([`rls-a-smsc-${marker}`]);
  });

  it('hides other tenants’ audit events', async () => {
    const visibleToB = await asTenant<{ entity_id: string }>(
      tenantB,
      "SELECT entity_id FROM audit_log WHERE action = 'rls.probe' AND entity_id LIKE $1",
      [`%-${marker}`],
    );
    expect(visibleToB.map((row) => row.entity_id)).toEqual([`b-${marker}`]);
  });

  it('returns nothing when no tenant context is set', async () => {
    const rows = await app.query('SELECT count(*)::int count FROM smsc_definitions');
    expect(rows.rows[0].count).toBe(0);
  });

  it('blocks writes into another tenant', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await expect(
      app.query(
        `INSERT INTO smsc_definitions (tenant_id, engine_id, name, type, tps, created_by)
         VALUES ($1, 'rls-cross-${marker}', 'Cross write', 'fake', 10, 'rls-test')`,
        [tenantB],
      ),
    ).rejects.toThrow(/row-level security/i);
    await app.query('ROLLBACK');
  });
});
