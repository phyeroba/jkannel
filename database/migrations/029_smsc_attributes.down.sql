-- 029_smsc_attributes (down)
-- Reverses 029. Drops the SMSC connection attribute columns, their check
-- constraints and the generation index. smsc_definitions itself, its RLS
-- policy and the pre-existing columns (including credential_secret_ref and
-- tps) are preserved. Attribute values stored in the dropped columns are
-- discarded on down-migration.
BEGIN;

DROP INDEX IF EXISTS smsc_definitions_generation_idx;

ALTER TABLE smsc_definitions
  DROP CONSTRAINT IF EXISTS smsc_bind_mode,
  DROP CONSTRAINT IF EXISTS smsc_interface_version,
  DROP CONSTRAINT IF EXISTS smsc_receive_port_range,
  DROP CONSTRAINT IF EXISTS smsc_addr_ton_npi_range,
  DROP CONSTRAINT IF EXISTS smsc_window_size_range,
  DROP CONSTRAINT IF EXISTS smsc_keepalive_range,
  DROP CONSTRAINT IF EXISTS smsc_reconnect_delay_range,
  DROP CONSTRAINT IF EXISTS smsc_wait_ack_range,
  DROP CONSTRAINT IF EXISTS smsc_max_error_count_nonnegative,
  DROP CONSTRAINT IF EXISTS smsc_username_secret_ref_format;

ALTER TABLE smsc_definitions
  DROP COLUMN IF EXISTS system_id,
  DROP COLUMN IF EXISTS username_secret_ref,
  DROP COLUMN IF EXISTS system_type,
  DROP COLUMN IF EXISTS bind_mode,
  DROP COLUMN IF EXISTS receive_port,
  DROP COLUMN IF EXISTS interface_version,
  DROP COLUMN IF EXISTS address_range,
  DROP COLUMN IF EXISTS source_addr_ton,
  DROP COLUMN IF EXISTS source_addr_npi,
  DROP COLUMN IF EXISTS dest_addr_ton,
  DROP COLUMN IF EXISTS dest_addr_npi,
  DROP COLUMN IF EXISTS window_size,
  DROP COLUMN IF EXISTS keepalive_seconds,
  DROP COLUMN IF EXISTS reconnect_delay_seconds,
  DROP COLUMN IF EXISTS wait_ack_seconds,
  DROP COLUMN IF EXISTS max_error_count,
  DROP COLUMN IF EXISTS use_tls,
  DROP COLUMN IF EXISTS alt_charset,
  DROP COLUMN IF EXISTS send_url,
  DROP COLUMN IF EXISTS notes;

COMMIT;
