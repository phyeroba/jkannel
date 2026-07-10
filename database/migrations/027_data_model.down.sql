-- 027_data_model (down)
-- Reverses 027_data_model. Drops the archive/retention/demo tables, the audit
-- hash-chain trigger + functions, and the additive columns/indexes placed on the
-- core tables and audit_log. The core tables and audit_log themselves are
-- preserved. Archived history in *_archive tables is discarded on down-migration.
BEGIN;

-- Demo + retention + archive tables.
DROP TABLE IF EXISTS data_model_records;
DROP TABLE IF EXISTS data_model_retention_state;
DROP TABLE IF EXISTS gateway_request_log_archive;
DROP TABLE IF EXISTS notification_deliveries_archive;
DROP TABLE IF EXISTS audit_log_archive;

-- Audit hash-chain: trigger first, then the functions it depends on.
DROP TRIGGER IF EXISTS audit_log_sign_trg ON audit_log;
DROP FUNCTION IF EXISTS audit_log_sign();
DROP FUNCTION IF EXISTS data_model_verify_audit_chain(bigint);
DROP FUNCTION IF EXISTS data_model_audit_row_hash(text, bigint, text, text, text, text, jsonb, jsonb, text, timestamptz);

DROP INDEX IF EXISTS audit_log_chain_idx;
ALTER TABLE audit_log
  DROP COLUMN IF EXISTS row_hash,
  DROP COLUMN IF EXISTS prev_hash;

-- Soft-delete + optimistic-lock columns and their live-row indexes.
DROP INDEX IF EXISTS smsc_definitions_live_idx;
DROP INDEX IF EXISTS routing_rules_live_idx;
DROP INDEX IF EXISTS customers_live_idx;
DROP INDEX IF EXISTS alert_rules_live_idx;

ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS version;
ALTER TABLE routing_rules    DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS version;
ALTER TABLE customers        DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS version;
ALTER TABLE alert_rules      DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS version;

COMMIT;
