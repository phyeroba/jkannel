-- Reverses 052_route_actions_and_overrides.
--
-- BEFORE RUNNING THIS, KNOW WHAT IT TURNS BACK ON.
--
-- Dropping `action` makes every rule a routing rule again. Any rule that was
-- DROPPING traffic — unknown networks, abusive content — silently starts
-- submitting it instead, to whatever target_smsc_id happens to be set. That is
-- the opposite of a safe default. Check first:
--
--   SELECT name, drop_reason FROM routing_rules
--    WHERE action = 'drop' AND deleted_at IS NULL;
--
-- Dropping the override columns reverts senders to whatever the submitting
-- application sends, which for a sender-id failover means going straight back
-- to the blocked one.
--
-- The decision columns are dropped too, so the record of which messages were
-- rewritten or dropped is lost. Export it if any exists:
--
--   SELECT message_ref, applied_overrides, dropped_by_rule
--     FROM message_route_decisions
--    WHERE applied_overrides IS NOT NULL OR dropped_by_rule IS NOT NULL;
BEGIN;

DROP INDEX IF EXISTS routing_rules_action_idx;

-- Narrowing route_type back would fail against any wildcard rule that exists,
-- which is the right outcome: those rules would stop matching anything and
-- their traffic would fall through to whatever rule is next. Convert them
-- first, then revert.
--
--   SELECT name, match_prefix FROM routing_rules
--    WHERE route_type = 'wildcard' AND deleted_at IS NULL;
DO $$
BEGIN
  ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS routing_rules_route_type_check;
  ALTER TABLE routing_rules
    ADD CONSTRAINT routing_rules_route_type_check
    CHECK (route_type IN ('static', 'prefix', 'country', 'operator', 'weighted'));
END $$;

ALTER TABLE routing_rules
  DROP CONSTRAINT IF EXISTS routing_rules_action_valid,
  DROP CONSTRAINT IF EXISTS routing_rules_drop_has_no_overrides,
  DROP CONSTRAINT IF EXISTS routing_rules_drop_states_reason,
  DROP CONSTRAINT IF EXISTS routing_rules_overrides_not_blank;

ALTER TABLE routing_rules
  DROP COLUMN IF EXISTS action,
  DROP COLUMN IF EXISTS override_sender,
  DROP COLUMN IF EXISTS override_recipient,
  DROP COLUMN IF EXISTS override_text,
  DROP COLUMN IF EXISTS drop_reason;

ALTER TABLE message_route_decisions
  DROP COLUMN IF EXISTS applied_overrides,
  DROP COLUMN IF EXISTS dropped_by_rule;

COMMIT;
