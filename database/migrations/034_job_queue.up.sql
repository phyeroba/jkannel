-- 034_job_queue
-- Makes `api_jobs` (migration 009) a real, durable work queue rather than an
-- insert-only ledger.
--
-- Until this migration, rows were written by POST /jobs and consumed by nothing:
-- a submitted job reported `queued` forever and a caller polling for completion
-- waited indefinitely. The columns below give the executor
-- (backend/src/platform/job-worker.ts) everything it needs to be honest about
-- what happened to a unit of work:
--
--   attempts / max_attempts  bounded retry, so a poison job cannot spin forever
--   next_attempt_at          exponential backoff scheduling; also the claim predicate
--   last_error               the most recent failure text (error holds the terminal one)
--   claimed_at / claimed_by  which worker holds the row, for stuck-job forensics
--   dead_lettered_at         when the job exhausted its attempts
--   heartbeat_at             liveness of a running job, so a crashed worker's
--                            claim can be reaped instead of pinning the row
--
-- The `dead_letter` status is added to the status CHECK: it is terminal and
-- distinct from `failed`, which stays reserved for a job that failed with no
-- retries remaining by policy. Everything here is additive and idempotent
-- (ADD COLUMN IF NOT EXISTS); api_jobs itself is NOT recreated.
--
-- RLS: api_jobs already has ENABLE ROW LEVEL SECURITY plus a tenant_isolation
-- policy from migration 009; this migration adds the FORCE + GRANT that
-- migration 009 predates, matching the pattern in 018/026/027.
BEGIN;

ALTER TABLE api_jobs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

ALTER TABLE api_jobs DROP CONSTRAINT IF EXISTS api_jobs_attempts_check;
ALTER TABLE api_jobs
  ADD CONSTRAINT api_jobs_attempts_check
  CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 50 AND attempts <= max_attempts + 1);

-- The status CHECK was created inline by migration 009, so it carries a
-- generated name. Drop by discovered name, then re-add the widened set.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'api_jobs'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%queued%'
  LOOP
    EXECUTE format('ALTER TABLE api_jobs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE api_jobs
  ADD CONSTRAINT api_jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter'));

-- The claim predicate: queued rows whose backoff has elapsed, oldest first.
CREATE INDEX IF NOT EXISTS api_jobs_claim_idx
  ON api_jobs (tenant_id, next_attempt_at, created_at)
  WHERE status = 'queued';

-- Reaping stuck claims: running rows ordered by liveness.
CREATE INDEX IF NOT EXISTS api_jobs_running_idx
  ON api_jobs (tenant_id, heartbeat_at)
  WHERE status = 'running';

-- Migration 009 enabled RLS and created the tenant_isolation policy but did not
-- FORCE it (so a table owner bypassed it) and never granted the application
-- role. Both are corrected here, idempotently.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_jobs', 'api_idempotency_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
        t
      );
    END IF;
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON api_jobs, api_idempotency_records TO jkannel_app;
  END IF;
END $$;

COMMIT;
