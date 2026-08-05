-- 047_delivery_failure_retry (down)
-- Reverses 047.
--
-- WHAT ROLLING BACK ACTUALLY DOES, stated rather than discovered:
--
--   * Delivery-failure retrying STOPS. Messages a carrier rejects will once
--     again be lost silently, with no second attempt on another bind. Nothing
--     warns about this at runtime, because the absence of a policy row is
--     indistinguishable from a policy that is switched off.
--
--   * Dropping message_delivery_retries / message_delivery_retry_attempts
--     discards the record of every retry ever made: which carriers a message
--     was tried on, what each attempt cost, and why a chain stopped. Billing
--     disputes about a double-charged message are unanswerable afterwards.
--     Export both tables before rolling back.
--
--   * Chains mid-flight are abandoned. A message whose retry was queued but not
--     yet submitted will never be submitted.
--
-- The queued scan and dispatch jobs are cancelled FIRST so the queue is not left
-- holding `delivery.retry.*` rows whose handler no longer exists and whose
-- target row no longer exists either — they would otherwise be dead-lettered one
-- by one on first claim, generating noise for a rollback that already knows what
-- it is doing. Same reasoning as migration 044's down file.
BEGIN;

-- Per tenant, because api_jobs carries FORCE ROW LEVEL SECURITY: a bare UPDATE
-- would match nothing with `app.tenant_id` unset unless the migration role
-- happens to bypass RLS.
DO $$
DECLARE t record;
BEGIN
  IF to_regclass('public.api_jobs') IS NULL THEN RETURN; END IF;
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE api_jobs
       SET status = 'cancelled',
           progress = 100,
           error = 'Delivery-failure retry cancelled: migration 047 rolled back.',
           last_error = 'Delivery-failure retry cancelled: migration 047 rolled back.',
           completed_at = now(),
           updated_at = now(),
           claimed_by = NULL,
           heartbeat_at = NULL
     WHERE type IN ('delivery.retry.scan', 'delivery.retry.dispatch')
       AND status IN ('queued', 'running');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Attempts first: they reference the chain.
DROP TABLE IF EXISTS message_delivery_retry_attempts;
DROP TABLE IF EXISTS message_delivery_retries;
DROP TABLE IF EXISTS delivery_retry_state;
DROP TABLE IF EXISTS delivery_retry_policies;

COMMIT;
