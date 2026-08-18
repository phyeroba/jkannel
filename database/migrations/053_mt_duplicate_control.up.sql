-- 053_mt_duplicate_control
-- Outbound duplicate suppression (SMS STUDIO Features, pages 3 and 7:
-- "duplication control", and an Inbox status of "Aborted (in case seen as
-- duplicate)").
--
-- WHAT WAS MISSING
-- --------------------------------------------------------------------------
-- Inbound already has this: `mo_messages.dedupe_key` carries a UNIQUE index, so
-- the same MO arriving twice produces one row and one fan-out. Outbound had
-- nothing. A client that retried a submission because our response was slow
-- sent the subscriber two messages and was billed for two, and the only way to
-- find out was the subscriber complaining.
--
-- WHY A WINDOW AND NOT A UNIQUE INDEX
-- --------------------------------------------------------------------------
-- An unconditional unique index on (sender, recipient, body) would be wrong:
-- "Your OTP is 448120" to the same number an hour later is a DIFFERENT message
-- that must go. What is a duplicate is the same content to the same recipient
-- within a short window — a retry, not a resend. So this records submissions
-- with an expiry and suppresses only inside it.
--
-- The window is per tenant and configurable, defaulting to 60 seconds, which is
-- comfortably longer than any sane client timeout and far shorter than any
-- legitimate repeat.
--
-- HOW A CALLER OPTS OUT
-- --------------------------------------------------------------------------
-- By setting the window to 0, and by supplying distinct `foreign_id`s: an
-- explicit client reference always wins over content hashing, because a client
-- that says "these are two different messages" knows better than we do.
BEGIN;

CREATE TABLE IF NOT EXISTS mt_dedupe_keys (
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  /**
   * sha256 of tenant + sender + recipient + body, or of the caller's explicit
   * client reference when one was given.
   *
   * Hashed rather than stored raw on purpose: this table would otherwise be a
   * second, unmasked copy of every message body, outside the Phase 6 read
   * paths entirely. A hash suppresses duplicates just as well and discloses
   * nothing.
   */
  dedupe_key text NOT NULL,
  /** The submission this key was first claimed by, for the audit answer. */
  first_sql_id text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  /** Times a duplicate was suppressed against this key. */
  suppressed_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, dedupe_key),
  CONSTRAINT mt_dedupe_window CHECK (expires_at > claimed_at)
);

-- Drives expiry sweeps. Not partial: every row expires eventually, so a
-- predicate would exclude nothing and cost maintenance for nothing.
CREATE INDEX IF NOT EXISTS mt_dedupe_expiry_idx ON mt_dedupe_keys (expires_at);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE mt_dedupe_keys ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'mt_dedupe_keys' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON mt_dedupe_keys USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE mt_dedupe_keys FORCE ROW LEVEL SECURITY';
END $$;

-- DELETE is required here, unlike on pii_reveal_grants: these rows are a cache
-- with a TTL, not evidence, and the sweep that expires them runs as this role.
GRANT SELECT, INSERT, UPDATE, DELETE ON mt_dedupe_keys TO jkannel_app;

-- Per-tenant window. 0 disables suppression entirely, which is the correct
-- setting for a tenant whose traffic is legitimately repetitive.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS mt_dedupe_window_seconds integer NOT NULL DEFAULT 60;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_mt_dedupe_window_sane'
  ) THEN
    -- Capped at an hour. A longer window would start suppressing legitimate
    -- repeat traffic, and the failure mode there — a subscriber who never got
    -- their second OTP — is worse than the one it prevents.
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_mt_dedupe_window_sane
      CHECK (mt_dedupe_window_seconds >= 0 AND mt_dedupe_window_seconds <= 3600);
  END IF;
END $$;

COMMENT ON TABLE mt_dedupe_keys IS
  'Short-lived outbound duplicate suppression (SMS Studio "duplication control"). Keys are hashes, never message content.';
COMMENT ON COLUMN tenants.mt_dedupe_window_seconds IS
  'Seconds within which an identical submission is treated as a retry and suppressed. 0 disables it.';

COMMIT;
