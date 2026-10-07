-- DLR FORWARDING
--
-- A caller that submits a message may supply a `dlrUrl`. Until now nothing
-- called it: JKANNEL injects through sqlbox, so a receipt returns to sqlbox
-- and is written to `sent_sms` as a DLR row, and there it stopped. In a
-- stock Kannel the fetch is smsbox's job, and smsbox is not in this path.
--
-- This table is the forwarder's ledger. It exists so that:
--
--   * a receipt is forwarded AT MOST ONCE — the unique index on
--     (tenant_id, engine_sql_id) is what guarantees it, not the sweep's
--     cleverness, so a double sweep or a second replica cannot double-send;
--   * a failure is visible afterwards rather than only in a log line;
--   * a URL whose host is not approved is RECORDED as refused rather than
--     silently dropped. "Nothing happened" and "we refused to call that"
--     are different facts and an operator has to be able to tell them apart.
--
-- The engine row id is text, not bigint: `sent_sms.sql_id` is the engine's
-- own key and JKANNEL does not own its type.

CREATE TABLE IF NOT EXISTS dlr_forward_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         BIGINT NOT NULL,
  -- The DLR row in sent_sms this attempt is for.
  engine_sql_id     TEXT NOT NULL,
  -- Substituted into the caller's URL in place of %d. Recorded so the
  -- forwarded value is auditable without re-reading the engine.
  dlr_mask          INTEGER,
  -- Host only. The full URL carries a per-message token and is never stored
  -- here; the allowlist decision is about the host and nothing else.
  url_host          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivered','failed','dead_letter','refused')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_status_code  INTEGER,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- One attempt row per receipt, per tenant. THIS is the idempotency: not the
-- sweep's bookkeeping, which a second replica would duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS dlr_forward_attempts_engine_row_idx
  ON dlr_forward_attempts (tenant_id, engine_sql_id);

-- The sweep asks "what is still pending", the console asks "what failed".
CREATE INDEX IF NOT EXISTS dlr_forward_attempts_status_idx
  ON dlr_forward_attempts (tenant_id, status, created_at DESC);

-- `NULLIF(..., '')` and not a bare cast: an unset `app.tenant_id` reads as the
-- empty string, and `''::bigint` raises rather than returning no rows, which
-- turns a missing tenant context into a 500 instead of an empty result.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE dlr_forward_attempts ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'dlr_forward_attempts' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON dlr_forward_attempts USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE dlr_forward_attempts FORCE ROW LEVEL SECURITY';
END $$;

-- No DELETE: these rows are evidence that a receipt was or was not passed on,
-- and a refund dispute is settled by reading them.
GRANT SELECT, INSERT, UPDATE ON dlr_forward_attempts TO jkannel_app;

COMMENT ON TABLE dlr_forward_attempts IS
  'One row per delivery receipt forwarded to a caller-supplied dlr_url. The '
  'unique index on (tenant_id, engine_sql_id) is what makes forwarding '
  'at-most-once; status=refused records a URL whose host was not allowlisted.';
