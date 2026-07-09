BEGIN;
REVOKE SELECT, UPDATE ON user_invitations FROM jkannel_auth;
REVOKE INSERT ON user_roles FROM jkannel_auth;
REVOKE INSERT ON users FROM jkannel_auth;
DROP TABLE IF EXISTS password_reset_tokens;
COMMIT;
