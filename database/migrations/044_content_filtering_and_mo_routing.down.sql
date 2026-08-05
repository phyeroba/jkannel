-- 044_content_filtering_and_mo_routing (down)
-- Reverses 044.
--
-- DATA LOSS, stated plainly rather than discovered:
--
--   * Dropping `messaging_content_rules` removes every content filter. Traffic
--     an operator believes is being blocked WILL START GOING OUT the moment this
--     runs, silently, because the absence of a rule is indistinguishable from a
--     rule that allows. Export the rule set before rolling back.
--
--   * Dropping `mo_messages` / `mo_deliveries` discards the record of every
--     inbound message received and every fan-out attempt made. Deliveries still
--     pending will never be attempted.
--
-- The pending MO delivery and ingest jobs are cancelled FIRST, so the queue is
-- not left with `mo.delivery.dispatch` / `mo.ingest.poll` rows whose handler no
-- longer exists and whose target row no longer exists either — they would
-- otherwise be dead-lettered one by one on first claim, generating noise for a
-- rollback that already knows what it is doing.
BEGIN;

-- Per tenant, because api_jobs carries FORCE ROW LEVEL SECURITY: a bare UPDATE
-- would match nothing with `app.tenant_id` unset unless the migration role
-- happens to bypass RLS. Same note as migration 042's down file.
DO $$
DECLARE t record;
BEGIN
  IF to_regclass('public.api_jobs') IS NULL THEN RETURN; END IF;
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE api_jobs
       SET status = 'cancelled',
           progress = 100,
           error = 'MO fan-out cancelled: migration 044 rolled back.',
           last_error = 'MO fan-out cancelled: migration 044 rolled back.',
           completed_at = now(),
           updated_at = now(),
           claimed_by = NULL,
           heartbeat_at = NULL
     WHERE type IN ('mo.delivery.dispatch', 'mo.ingest.poll')
       AND status IN ('queued', 'running');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

DROP INDEX IF EXISTS message_route_decisions_content_rule_idx;
ALTER TABLE message_route_decisions DROP COLUMN IF EXISTS content_rule_name;
ALTER TABLE message_route_decisions DROP COLUMN IF EXISTS content_rule_id;

DROP TABLE IF EXISTS mo_deliveries;
DROP TABLE IF EXISTS mo_messages;
DROP TABLE IF EXISTS mo_rule_destinations;
DROP TABLE IF EXISTS mo_routing_rules;
DROP TABLE IF EXISTS mo_ingest_state;
DROP TABLE IF EXISTS messaging_content_rules;

COMMIT;
