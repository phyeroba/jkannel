-- Reverses 040_messaging_scale.
--
-- Order matters: any job still sitting in the 'scheduled' status has to be
-- returned to 'queued' BEFORE the CHECK constraint is narrowed again, or the
-- ALTER fails on its own data. 'scheduled' and 'queued' are dispatched
-- identically by the runner, so the rewrite loses only the label — no campaign
-- changes behaviour and none is lost.
--
-- The scheduling columns are dropped, which discards the delivery instant and
-- validity of any campaign that had not yet been dispatched. That is the
-- honest consequence of removing the feature: without the columns there is
-- nowhere to keep the intent, and the recipients of such a campaign will be
-- submitted immediately with no deferral on their next run.
BEGIN;

DROP INDEX IF EXISTS bulk_send_recipients_foreign_idx;
DROP INDEX IF EXISTS bulk_send_recipients_tenant_created_idx;
DROP INDEX IF EXISTS bulk_send_recipients_tenant_job_created_idx;
DROP INDEX IF EXISTS bulk_send_jobs_scheduled_idx;
DROP INDEX IF EXISTS bulk_send_jobs_tenant_created_idx;

UPDATE bulk_send_jobs SET status = 'queued' WHERE status = 'scheduled';

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'bulk_send_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%'
       AND pg_get_constraintdef(oid) LIKE '%queued%'
  LOOP
    EXECUTE format('ALTER TABLE bulk_send_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE bulk_send_jobs ADD CONSTRAINT bulk_send_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed'));
END $$;

ALTER TABLE bulk_send_jobs DROP CONSTRAINT IF EXISTS bulk_send_jobs_validity_minutes_check;
COMMENT ON COLUMN bulk_send_jobs.scheduled_at IS NULL;
COMMENT ON COLUMN bulk_send_jobs.validity_minutes IS NULL;
ALTER TABLE bulk_send_jobs DROP COLUMN IF EXISTS validity_minutes;
ALTER TABLE bulk_send_jobs DROP COLUMN IF EXISTS scheduled_at;

COMMIT;
