-- Reverses 050_safe_control.
--
-- Dropping route_failovers discards any ACTIVE override, so a route reverts to
-- its configured target the moment this runs. That is the safe direction —
-- traffic returns to the declared configuration rather than to an override
-- nothing can any longer see — but it happens silently, so check for active
-- rows before reverting:
--
--   SELECT route_id, to_smsc_id, reason FROM route_failovers WHERE ended_at IS NULL;
--
-- Suspensions are likewise cleared, which RESUMES traffic on any suspended
-- SMSC. Check first:
--
--   SELECT engine_id, traffic_suspended_reason FROM smsc_definitions
--    WHERE traffic_suspended_at IS NOT NULL;
BEGIN;

DROP TABLE IF EXISTS route_failovers;
DROP TABLE IF EXISTS test_sends;

ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS traffic_suspended_reason;
ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS traffic_suspended_by;
ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS traffic_suspended_at;

-- Reasons recorded against past operations are lost. The operations themselves
-- survive in smsc_deployments and audit_log.
ALTER TABLE smsc_deployments DROP COLUMN IF EXISTS reason;

COMMIT;
