-- 013_report_and_channel_delivery
-- Allow notification_deliveries to record non-alert deliveries (scheduled
-- reports) and tag each delivery with its category. The composite FK uses the
-- default MATCH SIMPLE semantics, so a NULL alert_id skips the alert FK check.
BEGIN;

ALTER TABLE notification_deliveries
  ALTER COLUMN alert_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'alert';

ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_category_check
  CHECK (category IN ('alert', 'report'));

COMMIT;
