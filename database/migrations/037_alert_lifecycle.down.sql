-- 037_alert_lifecycle (down)
-- Reverses the alert lifecycle extension. Rows sitting in one of the new
-- statuses are normalised first ('suppressed' -> 'open', 'closed' ->
-- 'resolved') so restoring the original CHECK cannot fail.
BEGIN;

DROP TABLE IF EXISTS alert_comments;

-- Collapse the escalation cycles back to one before restoring the narrower
-- unique key, or duplicate (alert, policy, step) rows would block it.
DELETE FROM alert_escalations a
 USING alert_escalations b
 WHERE a.tenant_id = b.tenant_id AND a.alert_id = b.alert_id
   AND a.policy_id = b.policy_id AND a.step_index = b.step_index
   AND a.cycle > b.cycle;

ALTER TABLE alert_escalations DROP CONSTRAINT IF EXISTS alert_escalations_step_cycle_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'alert_escalations'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%step_index)'
  ) THEN
    ALTER TABLE alert_escalations
      ADD CONSTRAINT alert_escalations_tenant_id_alert_id_policy_id_step_index_key
      UNIQUE (tenant_id, alert_id, policy_id, step_index);
  END IF;
END $$;
ALTER TABLE alert_escalations DROP COLUMN IF EXISTS cycle;

UPDATE alert_instances SET status = 'open' WHERE status = 'suppressed';
UPDATE alert_instances SET status = 'resolved' WHERE status = 'closed';

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'alert_instances'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%acknowledged%'
  LOOP
    EXECUTE format('ALTER TABLE alert_instances DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE alert_instances ADD CONSTRAINT alert_instances_status_check
    CHECK (status IN ('open', 'acknowledged', 'resolved'));
END $$;

ALTER TABLE alert_instances
  DROP CONSTRAINT IF EXISTS alert_instances_notification_state_check;

DROP INDEX IF EXISTS alert_instances_assigned_idx;
DROP INDEX IF EXISTS alert_instances_suppressed_idx;
DROP INDEX IF EXISTS alert_instances_notification_state_idx;

ALTER TABLE alert_instances
  DROP COLUMN IF EXISTS assigned_to,
  DROP COLUMN IF EXISTS assigned_to_username,
  DROP COLUMN IF EXISTS assigned_by,
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS suppressed_until,
  DROP COLUMN IF EXISTS suppressed_reason,
  DROP COLUMN IF EXISTS suppressed_by,
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS closed_by,
  DROP COLUMN IF EXISTS reopened_at,
  DROP COLUMN IF EXISTS reopen_count,
  DROP COLUMN IF EXISTS notification_state,
  DROP COLUMN IF EXISTS notification_detail,
  DROP COLUMN IF EXISTS escalated_at,
  DROP COLUMN IF EXISTS previous_severity,
  DROP COLUMN IF EXISTS escalation_cycle;

COMMIT;
