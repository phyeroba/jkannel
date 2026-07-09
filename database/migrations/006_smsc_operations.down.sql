BEGIN;
DROP TABLE IF EXISTS smsc_deployments;
DROP TABLE IF EXISTS smsc_health;
DROP INDEX IF EXISTS smsc_definitions_tenant_engine_id_idx;
ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS engine_id,DROP COLUMN IF EXISTS description,DROP COLUMN IF EXISTS lifecycle_state,DROP COLUMN IF EXISTS priority,DROP COLUMN IF EXISTS tags,DROP COLUMN IF EXISTS last_error;
COMMIT;
