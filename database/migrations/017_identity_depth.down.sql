-- 017_identity_depth (rollback)
BEGIN;

REVOKE SELECT, INSERT ON password_history FROM jkannel_auth;
REVOKE INSERT ON login_history FROM jkannel_auth;
REVOKE SELECT, UPDATE ON mfa_recovery_codes FROM jkannel_auth;
REVOKE SELECT, UPDATE ON mfa_devices FROM jkannel_auth;

DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS password_history;
DROP TABLE IF EXISTS login_history;
DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS mfa_devices;

DROP INDEX IF EXISTS auth_sessions_family_idx;
ALTER TABLE auth_sessions DROP COLUMN IF EXISTS reused_at;
ALTER TABLE auth_sessions DROP COLUMN IF EXISTS superseded_by;
ALTER TABLE auth_sessions DROP COLUMN IF EXISTS family_id;

COMMIT;
