-- 041_smsc_resilience (down)
-- Reverses 041. Drops the connection-resilience columns and their check
-- constraints. smsc_definitions itself, its RLS policy, the migration 029
-- attribute columns and the generation index are preserved. Values stored in
-- the dropped columns are discarded; a configuration regenerated afterwards
-- reverts to a single bind per SMSC with the engine's own reconnect defaults.
BEGIN;

ALTER TABLE smsc_definitions
  DROP CONSTRAINT IF EXISTS smsc_connection_count_range,
  DROP CONSTRAINT IF EXISTS smsc_connection_timeout_range,
  DROP CONSTRAINT IF EXISTS smsc_wait_ack_expire_action_valid,
  DROP CONSTRAINT IF EXISTS smsc_routing_lists_separator_free;

ALTER TABLE smsc_definitions
  DROP COLUMN IF EXISTS connection_count,
  DROP COLUMN IF EXISTS connection_timeout_seconds,
  DROP COLUMN IF EXISTS wait_ack_expire_action,
  DROP COLUMN IF EXISTS retry_on_auth_failure,
  DROP COLUMN IF EXISTS allowed_smsc_ids,
  DROP COLUMN IF EXISTS denied_smsc_ids,
  DROP COLUMN IF EXISTS preferred_smsc_ids,
  DROP COLUMN IF EXISTS allowed_prefixes,
  DROP COLUMN IF EXISTS denied_prefixes,
  DROP COLUMN IF EXISTS preferred_prefixes;

COMMIT;
