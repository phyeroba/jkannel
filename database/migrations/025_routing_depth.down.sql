-- 025_routing_depth (down)
-- Reverses 025_routing_depth. Drops the side tables and the additive columns /
-- constraints placed on routing_rules. routing_rules itself is preserved.
BEGIN;

DROP TABLE IF EXISTS route_versions;
DROP TABLE IF EXISTS route_targets;

ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS routing_rules_route_type_check;
ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS routing_rules_strategy_check;

ALTER TABLE routing_rules
  DROP COLUMN IF EXISTS route_type,
  DROP COLUMN IF EXISTS match_prefix,
  DROP COLUMN IF EXISTS country_code,
  DROP COLUMN IF EXISTS operator,
  DROP COLUMN IF EXISTS cost,
  DROP COLUMN IF EXISTS strategy,
  DROP COLUMN IF EXISTS window_start,
  DROP COLUMN IF EXISTS window_end,
  DROP COLUMN IF EXISTS active_days;

COMMIT;
