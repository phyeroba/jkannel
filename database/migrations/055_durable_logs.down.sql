BEGIN;

DROP INDEX IF EXISTS log_entries_tenant_idx;
DROP INDEX IF EXISTS log_entries_level_idx;
DROP INDEX IF EXISTS log_entries_correlation_idx;
DROP INDEX IF EXISTS log_entries_occurred_idx;
DROP TABLE IF EXISTS log_entries;

COMMIT;
