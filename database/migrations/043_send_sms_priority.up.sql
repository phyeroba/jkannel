-- 043_send_sms_priority
-- Adds the `priority` column to the two SQLBox spool/log tables.
--
-- THESE TABLES ARE ENGINE-OWNED, AND THAT IS DELIBERATE HERE
-- --------------------------------------------------------------------------
-- `send_sms` and `sent_sms` are created and maintained by sqlbox itself, not by
-- JKANNEL, and JKANNEL normally only reads them plus INSERTs into `send_sms`.
-- Adding a column to an engine table is therefore something that needs saying
-- out loud rather than doing quietly. It is legitimate in this one case because
-- the column is one the ENGINE ITSELF now reads and writes: the sqlbox image
-- this platform builds (infrastructure/kannel/sqlbox/Dockerfile) patches the
-- PostgreSQL driver to name `priority` in its SELECT, its INSERT and its two
-- CREATE TABLE statements, exactly as the driver's MySQL sibling in the same
-- upstream source tree already does. This migration is not JKANNEL claiming
-- space in an engine table; it is bringing an existing deployment's schema up
-- to what the engine binary now expects.
--
-- WHY A MIGRATION IS NEEDED AT ALL — verified, not assumed
-- --------------------------------------------------------------------------
-- sqlbox creates both tables at every start, in sqlbox_configure_pgsql()
-- (addons/sqlbox/gw/sqlbox_pgsql.c). But unlike the MySQL driver, the
-- PostgreSQL CREATE statements are plain `CREATE TABLE %S (...)` with NO
-- `IF NOT EXISTS`: on a database where the tables already exist the CREATE
-- fails, pgsql_update() logs "relation already exists" and carries on. The
-- patched CREATE therefore only ever helps a FRESH database. Without this
-- migration an existing deployment would keep the old 27-column tables, and:
--
--   * sqlbox's patched SELECT would name a column that does not exist, so
--     `pgsql_fetch_msg` would error on every poll and NOTHING would be sent;
--   * sqlbox's patched INSERT into `sent_sms` would fail the same way, so no
--     message history would be recorded.
--
-- That is why `sent_sms` is included and not just `send_sms`: the patched
-- driver writes `priority` on the way past as well as reading it.
--
-- WHAT THE COLUMN MEANS
-- --------------------------------------------------------------------------
-- SMPP `priority_flag`, 0..3, higher first. bearerbox holds each SMSC's
-- outbound messages in gw_prioqueue_create(sms_priority_compare)
-- (gw/smsc/smsc_smpp.c:246) — a max-heap on sms.priority then sms.time — and
-- puts the value on the wire at smsc_smpp.c:1154.
--
-- NULL means "no preference" and is decoded by the driver as
-- MSG_PARAM_UNDEFINED (-1), which is what every existing row already behaves
-- as. Nothing about current traffic changes: priority only reorders a queue
-- that has a backlog in it.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, no default, no rewrite,
-- no lock beyond the brief catalogue update.
BEGIN;

-- to_regclass guards the case where sqlbox has never run and the tables do not
-- exist yet; there it is a no-op and sqlbox's own patched CREATE will include
-- the column.
DO $$
BEGIN
  IF to_regclass('public.send_sms') IS NOT NULL THEN
    ALTER TABLE send_sms ADD COLUMN IF NOT EXISTS priority BIGINT NULL;
  END IF;
  IF to_regclass('public.sent_sms') IS NOT NULL THEN
    ALTER TABLE sent_sms ADD COLUMN IF NOT EXISTS priority BIGINT NULL;
  END IF;
END $$;

COMMIT;
