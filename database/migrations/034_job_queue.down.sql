-- Reverses 034_job_queue. api_jobs itself is left in place (it predates this
-- migration); only the queue columns, constraints and indexes are removed and
-- the original status CHECK restored. Rows sitting in 'dead_letter' would
-- violate that narrower CHECK, so they are moved to 'failed' first.
BEGIN;

UPDATE api_jobs SET status = 'failed' WHERE status = 'dead_letter';

DROP INDEX IF EXISTS api_jobs_running_idx;
DROP INDEX IF EXISTS api_jobs_claim_idx;

ALTER TABLE api_jobs DROP CONSTRAINT IF EXISTS api_jobs_status_check;
ALTER TABLE api_jobs DROP CONSTRAINT IF EXISTS api_jobs_attempts_check;

ALTER TABLE api_jobs
  ADD CONSTRAINT api_jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

ALTER TABLE api_jobs
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS attempts;

COMMIT;
