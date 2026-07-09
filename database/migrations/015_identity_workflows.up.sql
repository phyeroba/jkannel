-- 015_identity_workflows
-- Self-service identity/security workflows: password reset tokens plus the
-- grants that let the pre-authentication jkannel_auth role complete password
-- resets and invitation acceptance (both happen before a tenant context
-- exists, so they run through the BYPASSRLS auth role rather than jkannel_app).
BEGIN;

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX password_reset_tokens_hash_idx ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (tenant_id, user_id, created_at DESC);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON password_reset_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO jkannel_app;

-- The auth role bypasses RLS but is granted narrowly; extend it so the
-- unauthenticated reset/invitation flows can create tokens, provision the
-- invited user, and mark the invitation accepted.
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO jkannel_auth;
GRANT INSERT ON users TO jkannel_auth;
GRANT INSERT ON user_roles TO jkannel_auth;
GRANT SELECT, UPDATE ON user_invitations TO jkannel_auth;

COMMIT;
