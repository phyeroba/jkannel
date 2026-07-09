BEGIN;

DROP TABLE IF EXISTS route_deployments CASCADE;
ALTER TABLE routing_rules
  DROP CONSTRAINT IF EXISTS routing_rules_deployment_state_check,
  DROP COLUMN IF EXISTS deployed_by,
  DROP COLUMN IF EXISTS deployed_at,
  DROP COLUMN IF EXISTS deployment_state;

COMMIT;
