BEGIN;
REVOKE SELECT, UPDATE ON api_keys FROM jkannel_auth;
DROP TABLE IF EXISTS gateway_request_log;
-- The api_keys gateway columns (rate_limit, allowed_ips, expires_at) predate this
-- migration (migration 017) and are shared with the identity subsystem, so they
-- are intentionally NOT dropped here.
COMMIT;
