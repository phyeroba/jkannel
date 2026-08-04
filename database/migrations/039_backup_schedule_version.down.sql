-- Reverses 039_backup_schedule_version. Dropping the column removes the
-- optimistic-concurrency guard; If-Match on a backup schedule then becomes a
-- 400 ("carries no version column") rather than a silently ignored header, so
-- no client is misled into thinking it still has a precondition.
BEGIN;

ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_version_check;
ALTER TABLE backup_schedules DROP COLUMN IF EXISTS version;

COMMIT;
