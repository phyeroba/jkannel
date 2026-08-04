-- 029_smsc_attributes
-- Completes the SMSC connection attribute set required by
-- SMSC_MANAGER_SPEC_03 ("Connection Attributes") so that a configuration
-- generated from the database can actually bind to a real carrier.
--
-- Before this migration smsc_definitions carried only name/type/host/port/
-- credential_secret_ref/tps/priority/tags. The SMPP bind parameters an
-- authenticated carrier session needs (system id, system type, bind mode,
-- TON/NPI, window, keepalive, reconnect/ack timeouts, TLS) had nowhere to
-- live, so ConfigurationGeneratorService could not emit them.
--
-- Additive only: every column uses ADD COLUMN IF NOT EXISTS with a default
-- that reproduces today's behaviour, so existing rows keep working and the
-- migration is safe to re-run. credential_secret_ref remains the password
-- mechanism (a secret:// reference resolved at render time) -- no credential
-- material is ever stored here.
--
-- RLS: smsc_definitions already has tenant_isolation ENABLE/FORCE ROW LEVEL
-- SECURITY from migrations 004 and 011, and privileges are table-level, so new
-- columns inherit both. The GRANT below is restated (idempotent) to match the
-- pattern used by 026_customers_depth and to keep hand-migrated databases
-- correct.
BEGIN;

ALTER TABLE smsc_definitions
  -- Identity on the carrier link. system_id is the SMPP system_id
  -- (Kannel/Kamex `smsc-username`); it is an account identifier, not a
  -- credential, so it is stored literally. Deployments that treat it as
  -- sensitive can instead set username_secret_ref and leave system_id NULL.
  ADD COLUMN IF NOT EXISTS system_id text,
  ADD COLUMN IF NOT EXISTS username_secret_ref text,
  ADD COLUMN IF NOT EXISTS system_type text,

  -- Bind shape. 'transceiver' renders `transceiver-mode = 1`; the split modes
  -- render `transceiver-mode = 0` and, for 'receiver', a `receive-port`.
  ADD COLUMN IF NOT EXISTS bind_mode text NOT NULL DEFAULT 'transceiver',
  ADD COLUMN IF NOT EXISTS receive_port integer,
  ADD COLUMN IF NOT EXISTS interface_version smallint NOT NULL DEFAULT 34,
  ADD COLUMN IF NOT EXISTS address_range text,

  -- Addressing. Defaults match the Kannel/Kamex defaults: unknown source TON
  -- with ISDN NPI, international destination TON with ISDN NPI.
  ADD COLUMN IF NOT EXISTS source_addr_ton smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_addr_npi smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dest_addr_ton smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dest_addr_npi smallint NOT NULL DEFAULT 1,

  -- Flow control and liveness. Throughput is derived from the existing `tps`
  -- column, so no duplicate column is introduced here.
  ADD COLUMN IF NOT EXISTS window_size integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS keepalive_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reconnect_delay_seconds integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS wait_ack_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS max_error_count integer NOT NULL DEFAULT 10,

  -- Transport / encoding / HTTP adapter.
  ADD COLUMN IF NOT EXISTS use_tls boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alt_charset text,
  ADD COLUMN IF NOT EXISTS send_url text,

  -- SMSC_MANAGER_SPEC_03 lists Notes separately from Description.
  ADD COLUMN IF NOT EXISTS notes text;

-- Constraints are added through a guard because PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS; this keeps the migration re-runnable.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('smsc_bind_mode',
       $c$CHECK (bind_mode IN ('transceiver','transmitter','receiver'))$c$),
      ('smsc_interface_version',
       $c$CHECK (interface_version IN (33,34,50))$c$),
      ('smsc_receive_port_range',
       $c$CHECK (receive_port IS NULL OR receive_port BETWEEN 1 AND 65535)$c$),
      ('smsc_addr_ton_npi_range',
       $c$CHECK (source_addr_ton BETWEEN 0 AND 255 AND source_addr_npi BETWEEN 0 AND 255
                 AND dest_addr_ton BETWEEN 0 AND 255 AND dest_addr_npi BETWEEN 0 AND 255)$c$),
      ('smsc_window_size_range',
       $c$CHECK (window_size BETWEEN 1 AND 1000)$c$),
      ('smsc_keepalive_range',
       $c$CHECK (keepalive_seconds BETWEEN 0 AND 3600)$c$),
      ('smsc_reconnect_delay_range',
       $c$CHECK (reconnect_delay_seconds BETWEEN 0 AND 3600)$c$),
      ('smsc_wait_ack_range',
       $c$CHECK (wait_ack_seconds BETWEEN 1 AND 3600)$c$),
      ('smsc_max_error_count_nonnegative',
       $c$CHECK (max_error_count >= 0)$c$),
      -- Same guarantee credential_secret_ref carries in migration 004: a
      -- credential column may only ever hold a secret:// reference.
      ('smsc_username_secret_ref_format',
       $c$CHECK (username_secret_ref IS NULL OR username_secret_ref LIKE 'secret://%')$c$)
    ) AS s(name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname::text = spec.name
         AND conrelid = 'smsc_definitions'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE smsc_definitions ADD CONSTRAINT %I %s', spec.name, spec.definition);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN smsc_definitions.system_id IS
  'SMPP system_id / HTTP account name rendered as smsc-username. Not a credential.';
COMMENT ON COLUMN smsc_definitions.username_secret_ref IS
  'Optional secret:// reference used instead of system_id when the account name is sensitive.';
COMMENT ON COLUMN smsc_definitions.credential_secret_ref IS
  'secret:// reference for the bind password; resolved to an environment placeholder at render time. Never stores the value.';
COMMENT ON COLUMN smsc_definitions.bind_mode IS
  'transceiver | transmitter | receiver. Drives transceiver-mode and receive-port in the generated config.';
COMMENT ON COLUMN smsc_definitions.window_size IS
  'SMPP window; rendered as max-pending-submits.';
COMMENT ON COLUMN smsc_definitions.keepalive_seconds IS
  'Rendered as enquire-link-interval.';
COMMENT ON COLUMN smsc_definitions.wait_ack_seconds IS
  'Rendered as wait-ack: how long the engine waits for a submit_sm_resp.';

-- The configuration model builder scans live, enabled SMSCs in priority order.
CREATE INDEX IF NOT EXISTS smsc_definitions_generation_idx
  ON smsc_definitions (tenant_id, priority, engine_id)
  WHERE deleted_at IS NULL AND enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON smsc_definitions TO jkannel_app;

COMMIT;
