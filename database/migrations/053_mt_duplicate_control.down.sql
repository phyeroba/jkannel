-- Reverses 053_mt_duplicate_control.
--
-- Removing the table turns outbound duplicate suppression OFF. A client that
-- retries a slow submission will send the subscriber two messages again, and be
-- billed for two. That is the pre-053 behaviour, so reverting is safe in the
-- sense that nothing breaks — but it is a capability loss, not a no-op.
--
-- The keys themselves are short-lived hashes with a TTL and are not worth
-- exporting; the suppression EVENTS are in audit_log and are unaffected.
BEGIN;

DROP TABLE IF EXISTS mt_dedupe_keys;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_mt_dedupe_window_sane;
ALTER TABLE tenants DROP COLUMN IF EXISTS mt_dedupe_window_seconds;

COMMIT;
