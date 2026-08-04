-- 035_backup_hardening
-- Closes the "a backup that lies about itself" half of G17.
--
-- Three honesty problems are fixed at the schema level:
--
--  1. kind = 'incremental' was accepted and stored, but the code always ran a
--     FULL pg_dump. Nothing in this deployment configures WAL archiving
--     (archive_mode / archive_command), so a true incremental or PITR backup is
--     not possible, and the label misrepresented both recovery capability and
--     the operator's RPO arithmetic. The label is REMOVED rather than faked:
--     existing rows are rewritten to 'full' and the CHECK constraints no longer
--     admit it. The API coerces a requested 'incremental' to 'full' and says so
--     in the record's detail (see backup-dr.service.ts).
--
--  2. Only the database was captured. A restore that loses the gateway
--     configuration and TLS material is not a restore. backup_records gains
--     columns describing a companion, separately-encrypted configuration
--     artifact (paths captured, byte count, checksum) so an operator can see at
--     a glance whether a given backup can actually rebuild a host.
--
--  3. Backups never left the host and a failure paged nobody. offsite_location
--     / offsite_synced_at record replication to the configured destination, and
--     alert_instances.source gains 'backup' so a failed backup or a failed
--     verification opens a real alert in the operator's alert grid instead of
--     being discovered at restore time.
--
-- All changes are additive and idempotent. No table is recreated.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Retire the 'incremental' label
-- ---------------------------------------------------------------------------
UPDATE backup_records SET kind = 'full' WHERE kind = 'incremental';
UPDATE backup_schedules SET kind = 'full' WHERE kind = 'incremental';

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT rel.relname AS table_name, con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname IN ('backup_records', 'backup_schedules')
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%incremental%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.table_name, c.constraint_name);
  END LOOP;
END $$;

ALTER TABLE backup_records DROP CONSTRAINT IF EXISTS backup_records_kind_check;
ALTER TABLE backup_records
  ADD CONSTRAINT backup_records_kind_check CHECK (kind IN ('full', 'schema'));

ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_kind_check;
ALTER TABLE backup_schedules
  ADD CONSTRAINT backup_schedules_kind_check CHECK (kind IN ('full', 'schema'));

-- ---------------------------------------------------------------------------
-- 2. Configuration / certificate capture + offsite replication
-- ---------------------------------------------------------------------------
ALTER TABLE backup_records
  ADD COLUMN IF NOT EXISTS config_artifact_path text,
  ADD COLUMN IF NOT EXISTS config_artifact_checksum text,
  ADD COLUMN IF NOT EXISTS config_file_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS config_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offsite_location text,
  ADD COLUMN IF NOT EXISTS offsite_synced_at timestamptz,
  -- Non-fatal problems with an otherwise-completed backup (no configuration
  -- captured, no offsite destination configured, ...). Never silently null on a
  -- degraded backup: the service writes the reason here.
  ADD COLUMN IF NOT EXISTS warning text;

ALTER TABLE backup_records DROP CONSTRAINT IF EXISTS backup_records_config_counts_check;
ALTER TABLE backup_records
  ADD CONSTRAINT backup_records_config_counts_check
  CHECK (config_file_count >= 0 AND config_bytes >= 0);

CREATE INDEX IF NOT EXISTS backup_records_offsite_idx
  ON backup_records (tenant_id, offsite_synced_at DESC)
  WHERE offsite_location IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Backup failures become real alerts
-- ---------------------------------------------------------------------------
ALTER TABLE alert_instances DROP CONSTRAINT IF EXISTS alert_instances_source_check;
ALTER TABLE alert_instances
  ADD CONSTRAINT alert_instances_source_check
  CHECK (source IN ('rule', 'anomaly', 'engine', 'backup', 'job'));

-- ---------------------------------------------------------------------------
-- RLS: backup_records predates the forced-RLS convention. Enforce it here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE backup_records ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'backup_records' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE 'CREATE POLICY tenant_isolation ON backup_records USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE backup_records FORCE ROW LEVEL SECURITY';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON backup_records TO jkannel_app;
  END IF;
END $$;

COMMIT;
