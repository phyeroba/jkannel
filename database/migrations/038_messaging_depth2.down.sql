-- Reverses 038_messaging_depth2.
--
-- The customers.rate_limit_per_min comment is restored to the wording migration
-- 032 left, because rolling this migration back also rolls back the enforcement
-- that made the new wording true.
--
-- Note: values normalised from <= 0 to NULL by the up-migration are NOT
-- restored. There is nothing to restore them to (a 0 ceiling was never a
-- meaningful policy) and inventing one would be worse than leaving the column
-- unlimited, which is what a 0 already meant to every reader of it.
BEGIN;

DROP INDEX IF EXISTS message_route_decisions_customer_outcome_idx;
DROP INDEX IF EXISTS smsc_deployments_verification_idx;

ALTER TABLE smsc_deployments DROP CONSTRAINT IF EXISTS smsc_deployments_verification_level;
COMMENT ON COLUMN smsc_deployments.verification IS NULL;
ALTER TABLE smsc_deployments DROP COLUMN IF EXISTS verification;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_rate_limit_positive;
COMMENT ON COLUMN customers.rate_limit_per_min IS
  'Per-customer request rate limit. Kept as the single home for this policy (no normalised twin exists). NOT enforced on the send path yet.';

COMMIT;
