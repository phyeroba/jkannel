-- Reverses 033_gateway_credentials.
BEGIN;

COMMENT ON TABLE api_gateway_clients IS NULL;
COMMENT ON COLUMN api_gateway_clients.secret_hash IS NULL;
COMMENT ON COLUMN api_gateway_clients.scopes IS NULL;
COMMENT ON COLUMN api_gateway_clients.rate_limit_per_min IS NULL;
COMMENT ON COLUMN api_gateway_clients.allowed_routes IS NULL;
DROP INDEX IF EXISTS api_gateway_clients_api_key_idx;
ALTER TABLE api_gateway_clients DROP COLUMN IF EXISTS api_key_id;

ALTER TABLE gateway_request_log DROP COLUMN IF EXISTS user_id;
ALTER TABLE gateway_request_log DROP COLUMN IF EXISTS duration_ms;

DROP INDEX IF EXISTS api_keys_customer_idx;
ALTER TABLE api_keys DROP COLUMN IF EXISTS customer_id;

COMMIT;
