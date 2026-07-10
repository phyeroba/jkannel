-- 017_identity_depth
-- Depth for the identity subsystem: TOTP multi-factor authentication (devices +
-- single-use recovery codes), refresh-token family revocation columns on
-- auth_sessions, a login-history audit surface, password-reuse history, and
-- user-owned personal API keys. Every new table is tenant-scoped with forced
-- row level security. The pre-authentication jkannel_auth role (which runs the
-- login and password-reset flows before a tenant context exists) receives the
-- narrow grants it needs on the tables those flows touch.
BEGIN;

-- --------------------------------------------------------------------------
-- 1. TOTP multi-factor authentication
-- --------------------------------------------------------------------------
CREATE TABLE mfa_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Authenticator',
  secret_encrypted text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX mfa_devices_user_idx ON mfa_devices (tenant_id, user_id, created_at DESC);

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (tenant_id, user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX mfa_recovery_codes_hash_idx ON mfa_recovery_codes (tenant_id, user_id, code_hash);

-- --------------------------------------------------------------------------
-- 2. Refresh-token family revocation (rotation replay detection)
-- --------------------------------------------------------------------------
ALTER TABLE auth_sessions ADD COLUMN family_id uuid;
ALTER TABLE auth_sessions ADD COLUMN superseded_by uuid;
ALTER TABLE auth_sessions ADD COLUMN reused_at timestamptz;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (tenant_id, family_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- 3. Login history
-- --------------------------------------------------------------------------
CREATE TABLE login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  username text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'mfa_required')),
  ip_address inet,
  user_agent text,
  mfa_used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_history_tenant_created_idx ON login_history (tenant_id, created_at DESC);
CREATE INDEX login_history_user_idx ON login_history (tenant_id, user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- 4. Password history (reuse prevention)
-- --------------------------------------------------------------------------
CREATE TABLE password_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user_idx ON password_history (tenant_id, user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- 5. User-owned personal API keys
-- --------------------------------------------------------------------------
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_ips text[] NOT NULL DEFAULT '{}',
  rate_limit integer,
  expires_at timestamptz,
  last_used_at timestamptz,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_prefix_idx ON api_keys (key_prefix);
CREATE INDEX api_keys_user_idx ON api_keys (tenant_id, user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Row level security: tenant isolation on every new table (copy of the
-- migration 012 pattern; the runner also force-enables RLS as a safety net).
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mfa_devices', 'mfa_recovery_codes', 'login_history', 'password_history', 'api_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON mfa_devices, mfa_recovery_codes, login_history, password_history, api_keys
  TO jkannel_app;

-- The pre-authentication auth role runs the login and password-reset flows
-- before a tenant context exists (it BYPASSRLS but is granted narrowly). Login
-- reads/updates MFA state, writes login history, and the reset flow checks and
-- appends password history.
GRANT SELECT, UPDATE ON mfa_devices TO jkannel_auth;
GRANT SELECT, UPDATE ON mfa_recovery_codes TO jkannel_auth;
GRANT INSERT ON login_history TO jkannel_auth;
GRANT SELECT, INSERT ON password_history TO jkannel_auth;

COMMIT;
