BEGIN;

DROP INDEX IF EXISTS configuration_versions_scope_status_idx;

ALTER TABLE configuration_versions
  DROP COLUMN IF EXISTS deployed_at,
  DROP COLUMN IF EXISTS deployed_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by;

COMMIT;
