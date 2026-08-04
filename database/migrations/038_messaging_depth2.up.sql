-- 038_messaging_depth2
-- Second messaging-depth pass. Three things, all additive:
--
--   1. customers.rate_limit_per_min is now ENFORCED. Migration 032 left a
--      comment saying it was not; that comment has become false, and a stale
--      "not enforced yet" note on a column that IS enforced is worse than no
--      note. The column also gains the constraint the enforcement assumes
--      (positive when set, NULL/absent = unlimited).
--
--   2. smsc_deployments.verification records WHAT an operation actually proved.
--      "Test connection" was a bare TCP connect() reported as if it were a bind,
--      and "reconnect" issued start-smsc alone and recorded success even when
--      nothing was cycled. Both now report their verification level, and this
--      column makes that level durable and queryable rather than prose buried in
--      `detail`.
--
--   3. An index for the per-customer send-refusal query an operator runs after a
--      429 ("what did we refuse for this customer, and when?").
--
-- ENGINE TABLES ARE NOT TOUCHED. The date-range, encoding and segmentation work
-- in this change reads send_sms / sent_sms, which live in the ENGINE's database
-- and are owned by it; the indexes serving those reads are created idempotently
-- by KamexSqlboxRepository.ensureIndexes(), not here.
--
-- RLS: no new tables are introduced, so no new policies are required.
-- smsc_deployments and customers already carry tenant_isolation with FORCE ROW
-- LEVEL SECURITY (migrations 006 and 020) and table-level grants, which a new
-- column inherits. The GRANTs below are restated idempotently to match the
-- pattern in 026_customers_depth and keep hand-migrated databases correct.
BEGIN;

-- --------------------------------------------------------------------------
-- 1. Per-customer rate limiting is real now
-- --------------------------------------------------------------------------
-- A zero or negative ceiling is not a policy anyone can mean: the enforcement
-- path reads <= 0 as "unlimited", so storing one would silently disable the
-- limit an operator thought they had set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'customers'::regclass AND conname = 'customers_rate_limit_positive'
  ) THEN
    -- Normalise any pre-existing 0/negative value to NULL first so the
    -- constraint can be added without failing on legacy data.
    UPDATE customers SET rate_limit_per_min = NULL WHERE rate_limit_per_min <= 0;
    ALTER TABLE customers ADD CONSTRAINT customers_rate_limit_positive
      CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min > 0);
  END IF;
END $$;

COMMENT ON COLUMN customers.rate_limit_per_min IS
  'Per-customer send ceiling in messages per minute. ENFORCED (migration 038) on THE send path (MessageSendService, via CustomerRateLimitService) with a Redis fixed-window counter keyed customer:<tenant>:<customer>. Distinct from per-API-key limiting: one customer may hold several keys. NULL means unlimited. Exceeding it refuses the send with HTTP 429; if Redis is unreachable the limiter FAILS OPEN and logs.';

-- --------------------------------------------------------------------------
-- 2. What an SMSC operation actually verified
-- --------------------------------------------------------------------------
ALTER TABLE smsc_deployments ADD COLUMN IF NOT EXISTS verification text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'smsc_deployments'::regclass
       AND conname = 'smsc_deployments_verification_level'
  ) THEN
    ALTER TABLE smsc_deployments ADD CONSTRAINT smsc_deployments_verification_level
      CHECK (verification IS NULL OR verification IN (
        -- test: an SMPP bind was attempted and the SMSC answered
        'smpp_bind',
        -- test: only a TCP socket was opened -- NOT a bind
        'tcp_socket',
        -- test: the SMSC has no network endpoint to verify (type 'fake')
        'not_applicable',
        -- reconnect: the bind was observed to drop and come back
        'bind_cycled',
        -- reconnect: both commands were accepted but the cycle was not observed
        'command_accepted'
      ));
  END IF;
END $$;

COMMENT ON COLUMN smsc_deployments.verification IS
  'The level a test/reconnect actually verified, never more: smpp_bind | tcp_socket | not_applicable | bind_cycled | command_accepted. NULL for operations that make no verification claim. Historical rows are NULL because what they verified was not recorded (a test before migration 038 was a bare TCP connect).';

CREATE INDEX IF NOT EXISTS smsc_deployments_verification_idx
  ON smsc_deployments (tenant_id, smsc_id, operation, created_at DESC);

-- --------------------------------------------------------------------------
-- 3. Per-customer refusal history
-- --------------------------------------------------------------------------
-- A rate-limit refusal is recorded as message_route_decisions.outcome='rejected'
-- by the send path's rejection recorder. This index makes "show me what we
-- refused for this customer" an index scan rather than a table scan.
CREATE INDEX IF NOT EXISTS message_route_decisions_customer_outcome_idx
  ON message_route_decisions (tenant_id, customer_id, outcome, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON customers, smsc_deployments, message_route_decisions
  TO jkannel_app;

COMMIT;
