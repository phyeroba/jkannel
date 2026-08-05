-- 042_scheduled_messages (down)
-- Reverses 042.
--
-- DATA LOSS WARNING, stated plainly rather than discovered: dropping
-- `scheduled_messages` discards every message still held for future delivery.
-- Those messages were accepted by the API and reported to the operator as
-- scheduled; after this runs they will never be sent and nothing will say so.
-- Cancel or release outstanding holds before rolling back
-- (GET /scheduled-messages?filter.status=pending).
--
-- The release jobs are cancelled first, so the queue does not fill with
-- `message.scheduled.release` rows whose handler no longer exists and whose
-- target row no longer exists either. Campaigns still parked in 'scheduled' are
-- returned to 'queued', which is the pre-042 behaviour (dispatch on the next
-- runner tick, with the deferral written onto the engine row).
BEGIN;

-- Per tenant, because api_jobs and bulk_send_jobs both carry FORCE ROW LEVEL
-- SECURITY: a bare UPDATE would match nothing with `app.tenant_id` unset unless
-- the migration role happens to bypass RLS. See the same note in the up file.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE api_jobs
       SET status = 'cancelled',
           progress = 100,
           error = 'Scheduled-message release cancelled: migration 042 rolled back.',
           last_error = 'Scheduled-message release cancelled: migration 042 rolled back.',
           completed_at = now(),
           updated_at = now(),
           claimed_by = NULL,
           heartbeat_at = NULL
     WHERE type = 'message.scheduled.release'
       AND status IN ('queued', 'running');
    UPDATE bulk_send_jobs SET status = 'queued' WHERE status = 'scheduled';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

DROP INDEX IF EXISTS scheduled_messages_bulk_job_idx;
DROP INDEX IF EXISTS scheduled_messages_tenant_created_idx;
DROP INDEX IF EXISTS scheduled_messages_pending_idx;
DROP INDEX IF EXISTS scheduled_messages_job_idx;

DROP TABLE IF EXISTS scheduled_messages;

COMMIT;
