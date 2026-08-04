-- Reverses 035_backup_hardening. The 'incremental' kind is restored to the
-- CHECK constraints (rows previously rewritten to 'full' are NOT rewritten
-- back: their artifacts really are full dumps, and re-labelling them
-- 'incremental' would reintroduce exactly the lie this migration removed).
BEGIN;

DROP INDEX IF EXISTS backup_records_offsite_idx;

ALTER TABLE backup_records DROP CONSTRAINT IF EXISTS backup_records_config_counts_check;

ALTER TABLE backup_records
  DROP COLUMN IF EXISTS warning,
  DROP COLUMN IF EXISTS offsite_synced_at,
  DROP COLUMN IF EXISTS offsite_location,
  DROP COLUMN IF EXISTS config_bytes,
  DROP COLUMN IF EXISTS config_file_count,
  DROP COLUMN IF EXISTS config_artifact_checksum,
  DROP COLUMN IF EXISTS config_artifact_path;

ALTER TABLE backup_records DROP CONSTRAINT IF EXISTS backup_records_kind_check;
ALTER TABLE backup_records
  ADD CONSTRAINT backup_records_kind_check
  CHECK (kind IN ('full', 'schema', 'incremental'));

ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_kind_check;
ALTER TABLE backup_schedules
  ADD CONSTRAINT backup_schedules_kind_check
  CHECK (kind IN ('full', 'schema', 'incremental'));

DELETE FROM alert_instances WHERE source = 'backup' OR source = 'job';
ALTER TABLE alert_instances DROP CONSTRAINT IF EXISTS alert_instances_source_check;
ALTER TABLE alert_instances
  ADD CONSTRAINT alert_instances_source_check
  CHECK (source IN ('rule', 'anomaly', 'engine'));

COMMIT;
