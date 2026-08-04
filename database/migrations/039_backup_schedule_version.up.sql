-- 039_backup_schedule_version
-- Optimistic concurrency for backup schedules.
--
-- Migration 027 added `version integer NOT NULL DEFAULT 0` to smsc_definitions,
-- routing_rules, customers and alert_rules, and `platform/etag.ts` implemented
-- the HTTP half of optimistic concurrency (ETag / If-Match / 412). But no
-- resource ever wired the two together, so the concurrency guard protected
-- nothing: two operators editing the same record still last-write-wins.
--
-- backup_schedules is the resource that most needs it. A schedule is edited
-- rarely and by more than one person (an operator widening a retention window
-- while another disables the job during maintenance); a lost update there does
-- not surface as a visible error, it surfaces months later as a missing backup.
--
-- Additive and idempotent: existing rows start at version 0, and every existing
-- client — none of which sends If-Match — keeps working unchanged, because the
-- precondition is only enforced when the header is present.
BEGIN;

ALTER TABLE backup_schedules
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_version_check;
ALTER TABLE backup_schedules
  ADD CONSTRAINT backup_schedules_version_check CHECK (version >= 0);

COMMIT;
