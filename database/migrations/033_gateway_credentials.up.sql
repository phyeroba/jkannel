-- 033_gateway_credentials
-- Settles the API-gateway credential model on ONE table and gives an API key a
-- customer identity, so an API-key-authenticated submit can be entitlement-checked.
--
-- Two disjoint credential systems existed:
--
--   api_keys              (migration 017/024) — hashed secret, scopes,
--                          allowed_ips, rate_limit, expires_at. This is what
--                          ApiKeyAuthGuard actually authenticates against.
--   api_gateway_clients   (migration 016) — the portal-facing registry with its
--                          own client_key / secret_hash / scopes /
--                          allowed_routes / rate_limit_per_min, read by NO guard,
--                          so a client provisioned through the console could not
--                          call anything.
--
-- DECISION: api_keys is the single credential model. api_gateway_clients is
-- demoted to a non-authenticating registry: it keeps its console CRUD, gains an
-- api_key_id link so an existing registration can be backed by a real
-- credential, and is documented as deprecated. Nothing authenticates against
-- its secret_hash, and this migration makes that explicit rather than leaving
-- two plausible-looking credential tables side by side.
BEGIN;

-- --------------------------------------------------------------------------
-- 1. An API key can belong to a customer
-- --------------------------------------------------------------------------
-- Nullable: an operator/administrator key has no customer, and a keyless
-- (JWT) caller never had one. When set, the gateway resolves it as the customer
-- whose quota, credit, sender IDs and route bindings the send path enforces.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS api_keys_customer_idx ON api_keys (tenant_id, customer_id);

COMMENT ON COLUMN api_keys.customer_id IS
  'Customer this credential submits on behalf of. NULL = an operator key with no customer entitlements.';

-- --------------------------------------------------------------------------
-- 2. Richer gateway request audit (per-request duration and caller)
-- --------------------------------------------------------------------------
ALTER TABLE gateway_request_log ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE gateway_request_log ADD COLUMN IF NOT EXISTS user_id text;

COMMENT ON COLUMN gateway_request_log.duration_ms IS
  'Wall-clock handler duration in milliseconds; NULL when the request was rejected by the guard before the handler ran.';
COMMENT ON COLUMN gateway_request_log.user_id IS
  'api_keys.user_id of the credential that made the request.';

-- --------------------------------------------------------------------------
-- 3. Demote api_gateway_clients to a non-authenticating registry
-- --------------------------------------------------------------------------
ALTER TABLE api_gateway_clients
  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS api_gateway_clients_api_key_idx
  ON api_gateway_clients (tenant_id, api_key_id);

COMMENT ON TABLE api_gateway_clients IS
  'DEPRECATED (migration 033): a registry, NOT a credential store. No guard authenticates against client_key/secret_hash and no code enforces its scopes, allowed_routes or rate_limit_per_min. api_keys is the single credential model; link a registration to a real credential through api_key_id. Do not provision new clients here.';
COMMENT ON COLUMN api_gateway_clients.secret_hash IS
  'DEPRECATED (migration 033): never authenticated against. Issue an api_keys credential instead.';
COMMENT ON COLUMN api_gateway_clients.scopes IS
  'DEPRECATED (migration 033): enforcement reads api_keys.scopes. Kept so existing console rows still render.';
COMMENT ON COLUMN api_gateway_clients.rate_limit_per_min IS
  'DEPRECATED (migration 033): enforcement reads api_keys.rate_limit.';
COMMENT ON COLUMN api_gateway_clients.allowed_routes IS
  'DEPRECATED (migration 033): route authorisation is by api_keys.scopes + @RequirePermissions on the handler.';
COMMENT ON COLUMN api_gateway_clients.api_key_id IS
  'The api_keys credential that backs this registration, when one has been issued.';

COMMIT;
