-- 011_rls_enforcement
-- Tenant isolation was previously advisory: RLS policies existed but the
-- application connected as the table owner, which PostgreSQL exempts from RLS.
-- This migration introduces a dedicated non-owner application role and forces
-- row level security on every tenant-scoped table so the policies apply to
-- every role, including owners.
BEGIN;

-- Non-owner application login role. LOGIN and the password are enabled by the
-- migration runner from POSTGRES_APP_PASSWORD; the migration itself stays
-- deterministic and secret-free.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    CREATE ROLE jkannel_app NOLOGIN;
  END IF;
END $$;

-- Authentication role: identity lookups happen before a tenant context exists
-- (the tenant slug is user input), so this role bypasses RLS but is granted
-- access to identity tables only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_auth') THEN
    CREATE ROLE jkannel_auth NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO jkannel_auth;
GRANT SELECT ON tenants, roles, user_roles, role_permissions, permissions TO jkannel_auth;
GRANT SELECT, UPDATE ON users TO jkannel_auth;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO jkannel_auth;
GRANT INSERT ON audit_log TO jkannel_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jkannel_auth;

-- audit_log previously had no row security at all, so any role that could
-- read it saw every tenant's audit trail. Scope it like the other tables.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON audit_log
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO jkannel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jkannel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jkannel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jkannel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO jkannel_app;

-- Force RLS on every table that has row security enabled so even the table
-- owner is subject to the tenant_isolation policies.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

COMMIT;
