BEGIN;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  username text NOT NULL, password_hash text NOT NULL, status text NOT NULL DEFAULT 'pending',
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0), locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username), CONSTRAINT user_status CHECK (status IN ('pending','active','disabled','locked','expired','archived','deleted'))
);
CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id), name text NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,name));
CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE user_roles (tenant_id bigint NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id,role_id));
CREATE TABLE role_permissions (tenant_id bigint NOT NULL REFERENCES tenants(id), role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, PRIMARY KEY(role_id,permission_id));
CREATE TABLE auth_sessions (id uuid PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), refresh_token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, revoked_at timestamptz, ip_address inet, user_agent text, CHECK(expires_at>created_at));
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions(tenant_id,user_id,expires_at) WHERE revoked_at IS NULL;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['users','roles','user_roles','role_permissions','auth_sessions'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::bigint)',t); END LOOP; END $$;
COMMIT;
