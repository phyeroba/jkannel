-- 040_messaging_scale
-- Two things a live deployment asked for, both additive:
--
--   1. SCHEDULED / DEFERRED SEND. A campaign can now carry a delivery instant
--      and a validity period. JKANNEL runs NO scheduler: these map onto the
--      engine's own `send_sms.deferred` / `send_sms.validity` columns (relative
--      minutes, converted by sqlbox to absolute instants at pickup and put on
--      the wire as submit_sm.schedule_delivery_time / validity_period). The
--      honest caveat is recorded in backend/src/messaging-depth/message-scheduling.ts
--      and repeated at the bottom of this file: a deferral is a request to the
--      CARRIER, and the `smsc = fake` bind this stack currently runs ignores it.
--
--   2. THE MISSING GRID INDEXES. A production audit of the live database found
--      `bulk_send_recipients` with no (tenant_id, created_at) index at all: an
--      EXPLAIN of the tenant-scoped grid query — ORDER BY created_at DESC
--      LIMIT 50 OFFSET 100000 — produced Seq Scan + Sort. The same shape
--      applied to `bulk_send_jobs`, whose only composite index leads with
--      `status` in the middle position and therefore cannot serve the unfiltered
--      default ordering. Both grids have since adopted keyset pagination; these
--      indexes are what make the keyset an index scan rather than a scan.
--
-- Engine-owned tables (`send_sms` / `sent_sms`) are NOT touched. Their indexes
-- are created idempotently by the application at boot
-- (KamexSqlboxRepository.ensureIndexesAtBoot) because those tables are created
-- by sqlbox on its first connection and may not exist when migrations run. The
-- partitioning runbook for `sent_sms` is documented in the footer, following
-- the pattern migration 027 established for `audit_log`.
--
-- RLS: no new tables, so no new policies. bulk_send_jobs and
-- bulk_send_recipients already carry ENABLE + FORCE ROW LEVEL SECURITY with a
-- tenant_isolation policy from migration 023, and the added columns inherit it.
BEGIN;

-- ==========================================================================
-- 1. Scheduling columns on bulk_send_jobs
-- ==========================================================================
ALTER TABLE bulk_send_jobs
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS validity_minutes integer;

COMMENT ON COLUMN bulk_send_jobs.scheduled_at IS
  'Absolute instant the campaign should be DELIVERED at, or NULL for as-soon-as-possible. '
  'Stored absolute (not as an offset) so a campaign that takes minutes to drain still '
  'targets one instant: the per-recipient send_sms.deferred offset is recomputed against '
  'this value at each engine INSERT. Not a JKANNEL-side hold — see the footer of this file.';

COMMENT ON COLUMN bulk_send_jobs.validity_minutes IS
  'Relative validity period in minutes, written verbatim to send_sms.validity for every '
  'recipient (submit_sm.validity_period on an SMPP bind). NULL leaves the carrier default.';

-- Bounded defensively, and guarded so a re-run (or a database that already has
-- the constraint) does not error — the pattern migration 025 uses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bulk_send_jobs_validity_minutes_check'
       AND conrelid = 'bulk_send_jobs'::regclass
  ) THEN
    ALTER TABLE bulk_send_jobs ADD CONSTRAINT bulk_send_jobs_validity_minutes_check
      -- 525600 minutes = 365 days; the application refuses anything larger, and
      -- SMPP renders these with a two-digit year.
      CHECK (validity_minutes IS NULL OR (validity_minutes >= 1 AND validity_minutes <= 525600));
  END IF;
END $$;

-- ==========================================================================
-- 2. 'scheduled' in the job status vocabulary
-- ==========================================================================
-- A queued job whose campaign carries a future scheduled_at. It is dispatched
-- on the SAME runner tick as a plain 'queued' job — the wait lives on each
-- recipient's engine row, not in a JKANNEL timer — so this value exists to make
-- the distinction visible and filterable in the grid, not to gate dispatch.
--
-- The CHECK was created inline by migration 023, so PostgreSQL named it
-- bulk_send_jobs_status_check and it has to be dropped and re-added rather than
-- altered. Constraints are found by DEFINITION rather than by name: adding a
-- second, permissive check while an older restrictive one survived under an
-- unexpected name would leave 'scheduled' rejected by a constraint nobody
-- looked at. Guarded throughout so the block is re-runnable.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'bulk_send_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%'
       AND pg_get_constraintdef(oid) LIKE '%queued%'
       AND pg_get_constraintdef(oid) NOT LIKE '%scheduled%'
  LOOP
    EXECUTE format('ALTER TABLE bulk_send_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bulk_send_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%scheduled%'
  ) THEN
    ALTER TABLE bulk_send_jobs ADD CONSTRAINT bulk_send_jobs_status_check
      CHECK (status IN ('queued', 'scheduled', 'running', 'completed', 'partial', 'failed'));
  END IF;
END $$;

-- ==========================================================================
-- 3. Grid indexes — each one named with the query it serves
-- ==========================================================================
-- Every predicate below leads with tenant_id because RLS puts
--   tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint
-- on EVERY plan for these tables, whether or not the emitted SQL mentions it.
-- An index that does not lead with tenant_id cannot be used for the ordering.

-- BulkSendService.listJobs, default ordering (no status filter):
--   SELECT ... FROM bulk_send_jobs WHERE <rls> ORDER BY created_at DESC LIMIT n OFFSET m
-- and its keyset form:
--   ... AND (created_at < $v OR (created_at = $v AND id < $i))
--       ORDER BY created_at DESC, id DESC LIMIT n+1
-- Before: the only composite index was (tenant_id, status, created_at DESC).
-- With no status filter, status is an unconstrained middle column, so the index
-- is not ordered by created_at within the tenant -> Seq Scan + Sort.
-- After: leading equality on tenant_id, then created_at DESC in the ORDER BY's
-- own direction, then id as the keyset tiebreaker -> Index Scan, no Sort node,
-- and the keyset predicate becomes an index seek instead of a discard-m-rows
-- OFFSET walk.
CREATE INDEX IF NOT EXISTS bulk_send_jobs_tenant_created_idx
  ON bulk_send_jobs (tenant_id, created_at DESC, id);

-- BulkSendService.listJobs sorted by, or filtered to, scheduled campaigns:
--   ... WHERE <rls> AND status='scheduled' ORDER BY scheduled_at
-- Partial so it stays small: the overwhelming majority of jobs are immediate
-- and carry scheduled_at IS NULL, and those rows are of no interest here.
CREATE INDEX IF NOT EXISTS bulk_send_jobs_scheduled_idx
  ON bulk_send_jobs (tenant_id, scheduled_at)
  WHERE scheduled_at IS NOT NULL;

-- BulkSendService.listRecipients, the job-scoped grid:
--   SELECT ... FROM bulk_send_recipients WHERE job_id=$1 AND <rls>
--    ORDER BY created_at ASC, id ASC LIMIT n OFFSET m
-- Before: (job_id, status, created_at) — again status in the middle, so an
-- unfiltered page could not read the ordering off the index.
-- After: tenant_id and job_id are both equalities, leaving created_at then id
-- as an ordered suffix -> Index Scan, no Sort, and the keyset predicate seeks.
CREATE INDEX IF NOT EXISTS bulk_send_recipients_tenant_job_created_idx
  ON bulk_send_recipients (tenant_id, job_id, created_at, id);

-- The exact query the production audit EXPLAINed: a tenant-wide recipient
-- sweep, not scoped to one job.
--   SELECT ... FROM bulk_send_recipients WHERE <rls>
--    ORDER BY created_at DESC LIMIT 50 OFFSET 100000
-- Before: Seq Scan on bulk_send_recipients + Sort (the table had no
-- tenant/created_at index at all).
-- After: Index Scan on this index. NOTE the OFFSET is still an OFFSET — the
-- index removes the sort and the heap sweep, it does not make the 100000
-- skipped rows free. That half of the problem is fixed by the cursor
-- pagination the grid now supports, not by an index.
CREATE INDEX IF NOT EXISTS bulk_send_recipients_tenant_created_idx
  ON bulk_send_recipients (tenant_id, created_at DESC, id);

-- Correlating a recipient back to the engine row it produced
--   ... WHERE <rls> AND foreign_id = $1
-- (grid filter.foreignId, and any support question of the form "which campaign
-- sent sql_id 12345?"). Partial: foreign_id is NULL until the recipient is
-- successfully submitted, and a NULL is never searched for.
CREATE INDEX IF NOT EXISTS bulk_send_recipients_foreign_idx
  ON bulk_send_recipients (tenant_id, foreign_id)
  WHERE foreign_id IS NOT NULL;

COMMIT;

-- ==========================================================================
-- OPS RUNBOOK — partitioning sent_sms
-- ==========================================================================
-- Following the pattern migration 027 established for audit_log, and for the
-- same reason: sent_sms is the fastest-growing table in the deployment (one row
-- per MT, MO and DLR event, forever) and the only retention it currently has is
-- an application-level DELETE (KamexSqlboxRepository.applyRetention). A bulk
-- DELETE on a table this size is the worst possible way to reclaim space: it
-- writes as much WAL as the rows it removes, leaves the heap bloated until
-- VACUUM catches up, and competes with sqlbox's inserts the whole time.
--
-- WHY THIS IS A RUNBOOK AND NOT A MIGRATION
-- -----------------------------------------
-- sent_sms is ENGINE-OWNED. sqlbox creates it on its first successful
-- connection and OWNS its shape; JKANNEL reads it and adds indexes to it, and
-- must never restructure it. There is also a hard mechanical constraint:
-- PostgreSQL cannot convert an existing plain table into a partitioned one in
-- place — a partitioned table must be created as such. So this cannot be an
-- ALTER, and it cannot be run by the application role, which is deliberately
-- not the table's owner. It is a planned, DBA-executed maintenance window.
--
-- PREREQUISITES
--   - sqlbox stopped (it is the only writer; a few minutes of spool backlog in
--     send_sms is harmless — send_sms is untouched by this procedure).
--   - Disk headroom for one full copy of sent_sms.
--   - Chosen partition key: `time` (bigint epoch seconds). RANGE partition on
--     it directly; do NOT add a generated timestamptz column, because that
--     changes the shape sqlbox writes to.
--
-- PROCEDURE (per-month partitions, one month retained beyond the window)
--   1. Create the partitioned parent under a new name:
--
--        CREATE TABLE sent_sms_partitioned (LIKE sent_sms INCLUDING DEFAULTS
--                                                         INCLUDING CONSTRAINTS)
--          PARTITION BY RANGE ("time");
--
--      Note: a partitioned table's PRIMARY KEY must contain the partition key.
--      sent_sms's key is sql_id, so the primary key becomes (sql_id, "time").
--      This is INVISIBLE to sqlbox, which never issues an ON CONFLICT and never
--      names the constraint — verify against your sqlbox version before the
--      window, and abort if it does.
--
--   2. Create the month partitions the existing data spans, plus at least three
--      ahead, plus a default so a gap can never reject an insert:
--
--        CREATE TABLE sent_sms_y2026m08 PARTITION OF sent_sms_partitioned
--          FOR VALUES FROM (1754006400) TO (1756684800);   -- 2026-08 .. 2026-09
--        CREATE TABLE sent_sms_default  PARTITION OF sent_sms_partitioned DEFAULT;
--
--      Generate the bounds with extract(epoch from date_trunc('month', ...)).
--
--   3. Copy, swap, and rebuild the indexes on the parent (they cascade to every
--      partition):
--
--        INSERT INTO sent_sms_partitioned SELECT * FROM sent_sms;
--        ALTER TABLE sent_sms RENAME TO sent_sms_preparted;
--        ALTER TABLE sent_sms_partitioned RENAME TO sent_sms;
--        -- then re-run the application's index set against the new parent:
--        --   POST /messages/indexes   (or restart the API; it ensures them at boot)
--
--   4. Restart sqlbox. Confirm new rows land in the current month's partition:
--
--        SELECT tableoid::regclass, count(*) FROM sent_sms GROUP BY 1;
--
--   5. Keep sent_sms_preparted until a full backup cycle has passed, then drop it.
--
-- ONGOING
--   - Create next month's partition ahead of time (a monthly cron; the DEFAULT
--     partition is a safety net, not a plan — rows in it cannot be dropped
--     cheaply and block the creation of a partition covering their range).
--   - Retention becomes a metadata operation instead of a DELETE:
--
--        ALTER TABLE sent_sms DETACH PARTITION sent_sms_y2025m08;
--        -- archive it (pg_dump -t, or COPY to cold storage), then:
--        DROP TABLE sent_sms_y2025m08;
--
--     Constant time, no WAL storm, no bloat, no contention with sqlbox.
--   - KamexSqlboxRepository.applyRetention stays correct and stays available;
--     once partitions are in place it should be left in dry-run mode and the
--     DETACH/DROP used instead. Its retentionStatus() report is still the right
--     way to decide which partition is next.
--
-- UNTIL THEN: the four indexes ensureIndexesAtBoot() creates are what keep
-- sent_sms queryable, and they are now created automatically on every start.
