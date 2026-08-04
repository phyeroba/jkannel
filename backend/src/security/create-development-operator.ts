import { Pool } from 'pg';
import { PasswordHasher } from './password-hasher';

async function main() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development operator provisioning is disabled in production');
  const password = process.env.DEV_OPERATOR_PASSWORD;
  const username = process.env.DEV_OPERATOR_USERNAME ?? 'operator';
  const tenantSlug = process.env.DEV_TENANT_SLUG ?? 'default';
  if (!password || password.length < 12)
    throw new Error('DEV_OPERATOR_PASSWORD must contain at least 12 characters');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = (
      await client.query<{ id: string }>(
        `INSERT INTO tenants(name,slug) VALUES('JKANNEL Development', $1) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [tenantSlug],
      )
    ).rows[0];
    const hash = await new PasswordHasher().hash(password);
    const user = (
      await client.query<{ id: string }>(
        `INSERT INTO users(tenant_id,username,password_hash,status) VALUES($1,$2,$3,'active') ON CONFLICT(tenant_id,username) DO UPDATE SET password_hash=EXCLUDED.password_hash,status='active',failed_login_count=0,locked_until=NULL RETURNING id`,
        [tenant.id, username, hash],
      )
    ).rows[0];
    const role = (
      await client.query<{ id: string }>(
        `INSERT INTO roles(tenant_id,name,description) VALUES($1,'administrator','Development control-plane administrator') ON CONFLICT(tenant_id,name) DO UPDATE SET description=EXCLUDED.description RETURNING id`,
        [tenant.id],
      )
    ).rows[0];
    const codes = [
      'dashboard.view',
      'messages.view',
      'messages.export',
      // Required by the Live Queue console for spool reroute/cancel and for
      // resending failed traffic to another bind, as well as ad-hoc sends.
      'messages.send',
      'smsc.view',
      'smsc.manage',
      'routes.view',
      'routes.manage',
      'configuration.view',
      'configuration.manage',
      'configuration.deploy',
      'monitoring.view',
      'alerts.view',
      'alerts.acknowledge',
      'reports.view',
      'users.view',
      'users.manage',
      'users.invite',
      'users.sessions',
      'system.view',
      'system.manage',
    ];
    for (const code of codes) {
      const permission = (
        await client.query<{ id: string }>(
          `INSERT INTO permissions(code,description) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description RETURNING id`,
          [code, `JKANNEL permission: ${code}`],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO role_permissions(tenant_id,role_id,permission_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [tenant.id, role.id, permission.id],
      );
    }
    await client.query(
      'INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [tenant.id, user.id, role.id],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ tenant: tenantSlug, username, permissions: codes.length }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
void main();
