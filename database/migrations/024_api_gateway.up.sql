-- 024_api_gateway
-- API Gateway depth: real per-client controls for API-key-authenticated traffic.
--
-- 1. Ensures the api_keys credential table (created by migration 017) carries the
--    three gateway columns the guard enforces. These already exist under their
--    canonical names — rate_limit (requests per window), allowed_ips (IP/CIDR
--    allowlist) and expires_at (hard expiry) — so the ADD COLUMN IF NOT EXISTS
--    statements are defensive no-ops on a current schema. We deliberately REUSE
--    the existing columns rather than duplicate them as rate_limit_per_min /
--    ip_allowlist, which would fragment the credential model.
-- 2. Introduces gateway_request_log: a per-request audit surface for gateway-
--    authenticated traffic (api key, tenant, route, method, status, ip, ts).
--    Tenant-scoped with forced row level security, matching migrations 017/020.
-- 3. Grants jkannel_auth SELECT/UPDATE on api_keys so the gateway can resolve a
--    presented key to its tenant before a tenant context exists (the same
--    cross-tenant, pre-context pattern the login flow uses; jkannel_auth
--    BYPASSRLS but is granted narrowly).
BEGIN;

-- --------------------------------------------------------------------------
-- 1. Gateway columns on the existing api_keys credential table (defensive)
-- --------------------------------------------------------------------------
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit integer;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_ips text[] NOT NULL DEFAULT '{}';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- --------------------------------------------------------------------------
-- 2. Per-request gateway audit log
-- --------------------------------------------------------------------------
CREATE TABLE gateway_request_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  key_prefix text,
  route text NOT NULL,
  method text NOT NULL,
  status_code integer NOT NULL,
  outcome text NOT NULL DEFAULT 'allowed'
    CHECK (outcome IN ('allowed', 'rate_limited', 'ip_blocked', 'unauthorized', 'error')),
  ip_address text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gateway_request_log_tenant_created_idx
  ON gateway_request_log (tenant_id, created_at DESC);
CREATE INDEX gateway_request_log_key_idx
  ON gateway_request_log (tenant_id, api_key_id, created_at DESC);

ALTER TABLE gateway_request_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gateway_request_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE gateway_request_log FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_request_log TO jkannel_app;

-- --------------------------------------------------------------------------
-- 3. Cross-tenant key resolution for the gateway (pre-context, like login)
-- --------------------------------------------------------------------------
GRANT SELECT, UPDATE ON api_keys TO jkannel_auth;

COMMIT;
