-- 043_send_sms_priority (down)
-- Removes the `priority` column from the SQLBox spool/log tables.
--
-- READ THIS BEFORE RUNNING IT
-- --------------------------------------------------------------------------
-- This rollback is only safe alongside a sqlbox image built WITHOUT the
-- priority parity patch in infrastructure/kannel/sqlbox/Dockerfile. The patched
-- driver names `priority` in SQLBOX_PGSQL_SELECT_QUERY and in
-- SQLBOX_PGSQL_INSERT_QUERY, both fixed strings compiled into the binary. Drop
-- the column while that binary is running and:
--
--   * every send_sms poll fails ("column priority does not exist"), so NOTHING
--     is sent — the spool fills and nothing drains it;
--   * every sent_sms write fails, so no message history is recorded.
--
-- Roll the sqlbox image back FIRST, then run this. There is no way for a SQL
-- migration to detect which binary is deployed, so this is a warning rather
-- than a guard.
--
-- Dropping the column discards the recorded priority of past messages. It does
-- not affect any message's delivery: priority was only ever an ordering hint
-- for bearerbox's per-SMSC queue, never part of the message itself.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.send_sms') IS NOT NULL THEN
    ALTER TABLE send_sms DROP COLUMN IF EXISTS priority;
  END IF;
  IF to_regclass('public.sent_sms') IS NOT NULL THEN
    ALTER TABLE sent_sms DROP COLUMN IF EXISTS priority;
  END IF;
END $$;

COMMIT;
