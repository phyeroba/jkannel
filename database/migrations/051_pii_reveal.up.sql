-- 051_pii_reveal
-- Time-limited, audited permission to see unmasked subscriber data.
--
-- §10: "Mask message content and MSISDN by default; privileged reveal is
-- time-limited and audited." §18 repeats it as a non-functional requirement.
--
-- WHY A GRANT AND NOT JUST A PERMISSION
-- --------------------------------------------------------------------------
-- A permission alone is not time-limited. An operator who needs to read one
-- subscriber's number during one investigation would otherwise hold the ability
-- to read every number, permanently, and the audit trail would show a
-- indistinguishable stream of ordinary reads.
--
-- A grant makes the reveal an EVENT with a beginning, an end and a reason. It
-- also means the audit answers the question that actually gets asked after a
-- privacy incident — "who could see this, and when" — rather than only "who
-- has the role".
BEGIN;

CREATE TABLE IF NOT EXISTS pii_reveal_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- Who may reveal. Grants are personal: a shared grant would make the audit
  -- trail unable to say which operator actually looked.
  user_id text NOT NULL,
  reason text NOT NULL,
  /**
   * Optional narrowing to one investigation. When set, only rows matching this
   * message reference may be revealed — so "I need to see this one message" does
   * not become "I may read every subscriber for fifteen minutes".
   */
  scope_message_ref text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  /** Incremented on each use, so an unused grant is visibly different. */
  reveal_count integer NOT NULL DEFAULT 0,
  CONSTRAINT pii_reveal_reason_length CHECK (length(btrim(reason)) >= 3),
  CONSTRAINT pii_reveal_window CHECK (expires_at > granted_at)
);

CREATE INDEX IF NOT EXISTS pii_reveal_active_idx
  ON pii_reveal_grants (tenant_id, user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE pii_reveal_grants IS
  'Time-limited authority to view unmasked MSISDNs and message bodies (spec §10, §18). Every use is audited separately.';
COMMENT ON COLUMN pii_reveal_grants.reveal_count IS
  'Times the grant was actually used. Distinguishes "was authorised" from "looked", which is the question an incident asks.';

-- ==========================================================================
-- Row-level security, matching the pattern used by every tenant table here.
--
-- It matters more here than elsewhere: without it, one tenant''s operator
-- could hold a grant that the backend then honoured while reading another
-- tenant''s rows, which would turn the audit mechanism itself into the
-- disclosure path.
-- ==========================================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pii_reveal_grants ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'pii_reveal_grants' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON pii_reveal_grants USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE pii_reveal_grants FORCE ROW LEVEL SECURITY';
END $$;

-- A grant is evidence: revocation sets revoked_at, and the row must stay so the
-- trail of who could see what cannot be erased by the very role that did the
-- looking.
--
-- The REVOKE is not redundant. Migration 011 set ALTER DEFAULT PRIVILEGES to
-- grant SELECT, INSERT, UPDATE **and DELETE** on every table created afterwards
-- in this schema, so a bare GRANT of three privileges leaves DELETE in place —
-- verified against a full chain apply, where the effective grant came back as
-- DELETE,INSERT,SELECT,UPDATE. Withholding it has to be explicit.
GRANT SELECT, INSERT, UPDATE ON pii_reveal_grants TO jkannel_app;
REVOKE DELETE, TRUNCATE ON pii_reveal_grants FROM jkannel_app;

-- ==========================================================================
-- The permission to ASK for a reveal.
--
-- Split from messages.view on purpose. messages.view is held by nearly every
-- operator because it is also what lets them see that a message exists at all;
-- if it carried the subscriber's number too, masking would protect nobody.
-- ==========================================================================
INSERT INTO permissions (code, description, category) VALUES
  ('messages.reveal', 'Request a time-limited, audited window to view unmasked MSISDNs and message content.', 'Messaging')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

-- Granted to the roles whose job actually requires reading a subscriber's
-- number: administration, and the two triage roles that answer "which customer
-- is complaining". NOT Read Only (no operational need), NOT Auditor (an
-- auditor reads the trail, not the traffic), NOT API Client (a machine account
-- cannot give a reason), NOT Network Engineer (works on binds, not subscribers).
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r
  JOIN (VALUES
    ('Super Administrator'),
    ('Administrator'),
    ('Operations Engineer'),
    ('Support Engineer')
  ) AS g(role_name) ON g.role_name = r.name
  JOIN permissions p ON p.code = 'messages.reveal'
 WHERE r.is_system
ON CONFLICT DO NOTHING;

COMMIT;
