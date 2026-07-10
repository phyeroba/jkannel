-- 016_platform_modules
-- Backing tables for the Platform console modules: API Gateway clients, plugin
-- registrations, and backup records. Each is tenant-scoped with forced RLS.
BEGIN;

CREATE TABLE api_gateway_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text,
  client_key text NOT NULL,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_routes text[] NOT NULL DEFAULT '{}',
  rate_limit_per_min integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_min > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  last_used_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (client_key)
);

CREATE TABLE plugin_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  plugin_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  publisher text,
  status text NOT NULL DEFAULT 'installed'
    CHECK (status IN ('installed', 'validated', 'enabled', 'disabled', 'failed')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail text,
  installed_by text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plugin_id)
);

CREATE TABLE backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'schema', 'incremental')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'restored', 'verified')),
  size_bytes bigint,
  checksum text,
  location text,
  encrypted boolean NOT NULL DEFAULT true,
  detail text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text NOT NULL,
  UNIQUE (tenant_id, label)
);
CREATE INDEX backup_records_tenant_started_idx ON backup_records (tenant_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_gateway_clients', 'plugin_registrations', 'backup_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON api_gateway_clients, plugin_registrations, backup_records TO jkannel_app;

COMMIT;
