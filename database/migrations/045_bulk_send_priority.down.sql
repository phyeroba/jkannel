-- Reverses 045_bulk_send_priority.
--
-- Dropping the column discards the priority chosen for any campaign that has
-- not yet dispatched; those jobs revert to "no preference" rather than failing.
-- Nothing outside the bulk dispatcher reads it, so no other table is affected.
BEGIN;

ALTER TABLE bulk_send_jobs DROP CONSTRAINT IF EXISTS bulk_send_jobs_priority_range;
ALTER TABLE bulk_send_jobs DROP COLUMN IF EXISTS priority;

COMMIT;
