-- Reverses 032_send_path.
-- The back-fill into customer_quotas / sender_ids is undone by matching on the
-- created_by stamp the up-migration wrote, so operator-authored rows survive.
BEGIN;

DELETE FROM sender_ids WHERE created_by = 'migration:032';
DELETE FROM customer_quotas WHERE created_by = 'migration:032';

COMMENT ON COLUMN customers.quota_daily IS NULL;
COMMENT ON COLUMN customers.allowed_sender_ids IS NULL;
COMMENT ON COLUMN customers.rate_limit_per_min IS NULL;

DROP TABLE IF EXISTS messaging_blocklist;
DROP TABLE IF EXISTS message_route_decisions;

DROP INDEX IF EXISTS bulk_send_jobs_customer_idx;
-- Restore the NOT NULL only when no routed (NULL) job remains; a job that was
-- deliberately left to the routing engine must not be destroyed by a rollback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bulk_send_jobs WHERE smsc_id IS NULL) THEN
    ALTER TABLE bulk_send_jobs ALTER COLUMN smsc_id SET NOT NULL;
  END IF;
END $$;
ALTER TABLE bulk_send_jobs DROP COLUMN IF EXISTS sender;
ALTER TABLE bulk_send_jobs DROP COLUMN IF EXISTS customer_id;

COMMIT;
