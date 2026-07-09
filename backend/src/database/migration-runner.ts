/**
 * Deterministic PostgreSQL migration runner.
 *
 * Applies database/migrations/NNN_name.up.sql files in version order inside
 * transactions, records each application in schema_migrations (version,
 * checksum, applied_at), and refuses to run when an already-applied file has
 * been edited. `--down <version>` rolls a single migration back with its
 * .down.sql counterpart.
 *
 * Connects with the owner role (DATABASE_URL). After applying migrations it
 * enables LOGIN on the non-owner application role when POSTGRES_APP_PASSWORD
 * is configured, so the API can connect as jkannel_app (see migration 011).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ADVISORY_LOCK_KEY = 7_244_101; // arbitrary, unique to JKANNEL migrations

interface MigrationFile {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
}

function migrationsDirectory(): string {
  return resolve(process.env.MIGRATIONS_DIR ?? resolve(__dirname, '../../../database/migrations'));
}

function discoverMigrations(): MigrationFile[] {
  const directory = migrationsDirectory();
  const files = readdirSync(directory).filter((file) => file.endsWith('.up.sql'));
  return files
    .map((file) => {
      const base = file.replace(/\.up\.sql$/, '');
      const version = base.split('_')[0];
      return {
        version,
        name: base,
        upPath: resolve(directory, file),
        downPath: resolve(directory, `${base}.down.sql`),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

function checksumOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function appliedMigrations(client: Client): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function applyUp(client: Client, migration: MigrationFile): Promise<void> {
  const sql = readFileSync(migration.upPath, 'utf8');
  const checksum = checksumOf(migration.upPath);
  // Migration files manage their own BEGIN/COMMIT; run the bookkeeping insert
  // afterwards so a failed migration leaves no schema_migrations row.
  await client.query(sql);
  await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
    migration.name,
    checksum,
  ]);
  console.log(
    JSON.stringify({ level: 'info', message: 'migration applied', name: migration.name }),
  );
}

async function applyDown(client: Client, migration: MigrationFile): Promise<void> {
  const sql = readFileSync(migration.downPath, 'utf8');
  await client.query(sql);
  await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.name]);
  console.log(
    JSON.stringify({ level: 'info', message: 'migration rolled back', name: migration.name }),
  );
}

async function ensureRoleLogin(client: Client, roleName: string, password?: string): Promise<void> {
  if (!password) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: `${roleName} has no password configured; it remains NOLOGIN and the API falls back to the owner connection, which bypasses row level security.`,
      }),
    );
    return;
  }
  const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
  if (role.rowCount === 0) return; // migration 011 not applied yet
  if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) throw new Error(`Invalid role name: ${roleName}`);
  // Role name is validated above; the password is escaped as a SQL literal.
  await client.query(
    `ALTER ROLE ${roleName} WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`,
  );
  console.log(JSON.stringify({ level: 'info', message: `${roleName} login ensured` }));
}

async function enforceRowLevelSecurity(client: Client): Promise<void> {
  // Safety net: any table that enables RLS in a future migration is forced
  // automatically, so a forgotten FORCE cannot silently reopen the owner bypass.
  await client.query(`DO $$
    DECLARE t text;
    BEGIN
      FOR t IN
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity AND NOT c.relforcerowsecurity
      LOOP
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      END LOOP;
    END $$`);
}

export async function runMigrations(
  direction: 'up' | 'down' | 'baseline' = 'up',
  target?: string,
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    const migrations = discoverMigrations();
    const applied = await appliedMigrations(client);

    if (direction === 'baseline') {
      // Brownfield adoption: mark migrations up to <target> as applied without
      // executing them, for databases whose schema was created manually before
      // the runner existed. Explicit and operator-invoked only.
      if (!target) throw new Error('--baseline requires a version (e.g. --baseline 010)');
      for (const migration of migrations) {
        if (migration.version > target) break;
        if (applied.has(migration.name)) continue;
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [migration.name, checksumOf(migration.upPath)],
        );
        console.log(
          JSON.stringify({ level: 'info', message: 'migration baselined', name: migration.name }),
        );
      }
      return;
    }

    if (direction === 'down') {
      if (!target) throw new Error('--down requires a migration version (e.g. --down 011)');
      const migration = migrations.find(
        (candidate) => candidate.version === target || candidate.name === target,
      );
      if (!migration) throw new Error(`Unknown migration: ${target}`);
      if (!applied.has(migration.name)) throw new Error(`${migration.name} is not applied`);
      await applyDown(client, migration);
      return;
    }

    for (const migration of migrations) {
      const appliedChecksum = applied.get(migration.name);
      if (appliedChecksum) {
        const currentChecksum = checksumOf(migration.upPath);
        if (appliedChecksum !== currentChecksum && process.env.MIGRATIONS_ALLOW_DRIFT !== 'true') {
          throw new Error(
            `${migration.name} was modified after being applied ` +
              '(set MIGRATIONS_ALLOW_DRIFT=true to override at your own risk)',
          );
        }
        continue;
      }
      await applyUp(client, migration);
    }
    await enforceRowLevelSecurity(client);
    await ensureRoleLogin(client, 'jkannel_app', process.env.POSTGRES_APP_PASSWORD);
    await ensureRoleLogin(client, 'jkannel_auth', process.env.POSTGRES_AUTH_PASSWORD);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const downIndex = args.indexOf('--down');
  const baselineIndex = args.indexOf('--baseline');
  const direction = downIndex >= 0 ? 'down' : baselineIndex >= 0 ? 'baseline' : 'up';
  const target =
    downIndex >= 0 ? args[downIndex + 1] : baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;
  runMigrations(direction, target).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: String(error?.message ?? error) }));
    process.exitCode = 1;
  });
}
