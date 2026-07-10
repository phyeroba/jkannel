BEGIN;
DROP INDEX IF EXISTS alert_instances_correlation_idx;
ALTER TABLE alert_instances
  DROP COLUMN IF EXISTS correlation_group,
  DROP COLUMN IF EXISTS dedup_count;
DROP TABLE IF EXISTS maintenance_windows;
DROP TABLE IF EXISTS alert_escalations;
DROP TABLE IF EXISTS escalation_policies;
COMMIT;
