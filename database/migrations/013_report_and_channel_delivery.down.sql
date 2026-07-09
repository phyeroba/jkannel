BEGIN;
DELETE FROM notification_deliveries WHERE alert_id IS NULL;
ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_category_check;
ALTER TABLE notification_deliveries
  DROP COLUMN IF EXISTS category,
  ALTER COLUMN alert_id SET NOT NULL;
COMMIT;
