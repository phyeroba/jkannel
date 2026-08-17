-- Reverses 049_operational_events.
--
-- Dropping the table discards the observed event history. `smsc_bind_transitions`
-- is untouched and still holds the raw bind observations, so the underlying
-- record of connection changes survives — what is lost is the operator-facing
-- stream and any correlation grouping built on it.
BEGIN;

DROP INDEX IF EXISTS alert_instances_correlation_idx;
ALTER TABLE alert_instances DROP COLUMN IF EXISTS correlation_id;
DROP TABLE IF EXISTS operational_events;

COMMIT;
