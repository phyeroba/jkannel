-- 045_bulk_send_priority
-- Campaign-level send priority for bulk jobs.
--
-- WHY THE BULK PATH IS WHERE PRIORITY ACTUALLY MATTERS
-- --------------------------------------------------------------------------
-- Priority reorders bearerbox's per-SMSC outbound queue, so it changes nothing
-- unless a backlog exists. On the single-message paths that is the uncommon
-- case: an idle bind drains in sub-second time and messages leave in arrival
-- order whatever their priority. A bulk campaign is the opposite — pushing
-- thousands of recipients at a bind whose `throughput` is capped is precisely
-- how a backlog gets created, and it is the traffic an operator most often
-- wants to sit BEHIND everything else.
--
-- Hence a column on the job rather than on the recipient: the whole campaign
-- shares one level, every recipient inherits it at dispatch, and the operator
-- sets it once when creating the campaign.
--
-- NULL vs 0 — these are different and neither defaults to the other. NULL is
-- "no preference", which the sqlbox driver decodes as MSG_PARAM_UNDEFINED and
-- which is how every pre-existing campaign already behaves. 0 is the real,
-- lowest SMPP level, and choosing it is a deliberate act of deprioritising a
-- campaign below unmarked traffic. Defaulting this column to 0 would silently
-- demote every historical job, so it is left nullable with no default.
--
-- The CHECK mirrors `parseMessagePriority` (backend/src/engine/
-- kamex-sqlbox.repository.ts) so a value that could never be honoured cannot be
-- stored: SMPP priority_flag is a 2-bit field, 0..3.
--
-- Additive: ADD COLUMN IF NOT EXISTS, nullable, no default, so no table
-- rewrite and no lock beyond the brief catalogue update — safe on a
-- bulk_send_jobs table of any size.
BEGIN;

ALTER TABLE bulk_send_jobs ADD COLUMN IF NOT EXISTS priority SMALLINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bulk_send_jobs_priority_range'
  ) THEN
    ALTER TABLE bulk_send_jobs
      ADD CONSTRAINT bulk_send_jobs_priority_range
      CHECK (priority IS NULL OR (priority >= 0 AND priority <= 3));
  END IF;
END $$;

COMMENT ON COLUMN bulk_send_jobs.priority IS
  'SMPP priority_flag 0..3 inherited by every recipient of this campaign; NULL = no preference. Only observable under backlog.';

COMMIT;
