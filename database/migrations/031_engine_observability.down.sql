-- Reverses 031_engine_observability.
BEGIN;

DELETE FROM escalation_policies WHERE created_by = 'migration-031';
DELETE FROM notification_channels WHERE created_by = 'migration-031';

DROP TABLE IF EXISTS metric_samples;
DROP TABLE IF EXISTS smsc_bind_transitions;
DROP TABLE IF EXISTS smsc_bind_state;
DROP TABLE IF EXISTS smsc_bind_snapshots;
DROP TABLE IF EXISTS engine_poll_snapshots;

-- Poller-sourced alerts must go before the CHECK is narrowed again, or the
-- constraint would fail to validate.
DELETE FROM alert_instances WHERE source = 'engine';
ALTER TABLE alert_instances DROP CONSTRAINT IF EXISTS alert_instances_source_check;
ALTER TABLE alert_instances
  ADD CONSTRAINT alert_instances_source_check CHECK (source IN ('rule', 'anomaly'));

COMMIT;
