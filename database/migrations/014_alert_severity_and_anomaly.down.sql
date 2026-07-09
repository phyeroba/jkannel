BEGIN;
DROP INDEX IF EXISTS alert_instances_open_dedup_idx;
ALTER TABLE alert_instances
  DROP CONSTRAINT IF EXISTS alert_instances_severity_check,
  DROP CONSTRAINT IF EXISTS alert_instances_source_check;
ALTER TABLE alert_instances
  DROP COLUMN IF EXISTS severity,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS dedup_key;
COMMIT;
