-- 047_delivery_failure_retry
--
-- WHY THIS MIGRATION EXISTS
-- =========================
-- JKANNEL already resends on a SEND failure: routing-depth/route-resolution
-- picks a fallback bind when the primary is not healthy at submit time and
-- message_route_decisions records `fallback_used`. That covers the case where
-- the platform can see the problem BEFORE the message leaves.
--
-- It does nothing at all for the far more common case: the engine ACCEPTS the
-- message, the carrier takes it, and minutes later a delivery report says the
-- message failed. Today that DLR is recorded in the engine's `sent_sms` table,
-- surfaced on the message grid as `failed`, and then nothing happens. The
-- message is simply lost, on one carrier, with a healthy alternative bind
-- sitting idle next to it.
--
-- These three tables are what a delivery-failure retry path needs and could not
-- express before:
--
--   1. delivery_retry_policies       WHEN a failure is worth retrying, per
--                                    tenant / per SMSC / per customer. Stored,
--                                    not hard-coded, because "retry a rejection"
--                                    is a commercial decision (it spends the
--                                    operator's carrier credit) and differs per
--                                    deployment.
--   2. message_delivery_retries      One row per ORIGINAL message that entered
--                                    retry. Its UNIQUE (tenant_id,
--                                    origin_message_ref) is the structural
--                                    guarantee that one message can never be
--                                    retried by two observers of the same DLR.
--   3. message_delivery_retry_attempts  One row per re-send, carrying the bind
--                                    used, the binds excluded and why, what it
--                                    cost, and the delivery outcome. This is
--                                    what answers "how many times did this go
--                                    out, on which carriers, and why".
--
-- Plus delivery_retry_state, the engine-sweep watermark and bookkeeping for the
-- DLR scanner (the same shape mo_ingest_state has, for the same reason).
--
-- WHY THE CORRELATION KEY IS `message_ref`
-- ========================================
-- sqlbox_pgsql.c stamps the consumed `send_sms.sql_id` into `foreign_id` ("we
-- abuse the foreign_id field in the message struct for our sql_id value"), so
-- every DLR the engine writes for a message carries that sql_id in its
-- `foreign_id`. MessageSendService already records the same sql_id as
-- `message_route_decisions.message_ref`. So `sent_sms(momt='DLR').foreign_id`
-- joins directly to `message_route_decisions.message_ref`, and to
-- `message_delivery_retry_attempts.message_ref` for a retry's own reports.
--
-- CRITICAL DISTINCTION, encoded in the CHECK on trigger_dlr_event: `dlr_mask` on
-- a DLR ROW is the EVENT that happened (1 delivered / 2 failed / 4 buffered /
-- 8 accepted / 16 rejected). On an MT ROW the same column is the mask the sender
-- REQUESTED (commonly 31 = "report everything"), which is a subscription and not
-- a status. Only 2 and 16 may open a retry chain; the CHECK makes an MT row's 31
-- unstorable rather than merely wrong.
--
-- Additive and idempotent throughout (IF NOT EXISTS / guarded DO blocks), with
-- forced row level security matching the pattern in 026/032/042/044.
BEGIN;

-- ==========================================================================
-- 1. POLICY — WHEN IS A DELIVERY FAILURE WORTH RESENDING?
-- ==========================================================================
-- Precedence is most-specific-wins: a customer-scope row overrides an
-- smsc-scope row overrides the tenant-scope row overrides the built-in
-- defaults. The winning row is used WHOLE — columns are not merged across
-- scopes, because every column is NOT NULL and there is no way to express
-- "inherit this one"; merging would silently attribute the tenant row's values
-- to a scoped row that never asked for them. The single exception is
-- max_retries_per_minute, which is always read from the tenant row (see its
-- own comment).
--
-- Absence of any enabled row means the feature is OFF, which is the
-- deliberate default: automatic resending spends the operator's carrier credit
-- and their customers' quota, and must be switched on knowingly.
CREATE TABLE IF NOT EXISTS delivery_retry_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('tenant', 'smsc', 'customer')),
  -- Engine-level SMSC id (smsc_definitions.engine_id) of the bind that FAILED,
  -- not the bind a retry would use. Not a foreign key: engine_id is unique per
  -- tenant rather than globally, and a policy must survive an SMSC rename
  -- instead of cascade-deleting silently (same reasoning as 044's rule tables).
  smsc_id text,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- RE-SENDS allowed, over and above the original submission. 1 means the
  -- message may go out at most twice in total.
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 5),
  -- DLR event 2. A carrier-side delivery failure is the case a second carrier
  -- plausibly fixes (congestion, a roaming gap, a temporarily unreachable
  -- handset), so this is on by default.
  retry_on_failed boolean NOT NULL DEFAULT true,
  -- DLR event 16. OFF by default, and that default is an argument, not caution:
  -- a rejection is usually the carrier saying the submission itself was
  -- unacceptable — invalid destination, unroutable prefix, blocked content,
  -- unregistered sender ID. Re-sending that to a different carrier burns credit
  -- on something that will be rejected again, and repeated rejected traffic is
  -- exactly the pattern an SMSC reads as spam and throttles or blocks the bind
  -- for. Operators whose carriers use 16 for transient conditions can turn it
  -- on; the platform will not assume it for them.
  retry_on_rejected boolean NOT NULL DEFAULT false,
  -- Delay between observing the failure DLR and submitting the retry. This is
  -- the window in which a late POSITIVE report can still arrive and cancel the
  -- retry, which is the main defence against double-delivering.
  min_delay_seconds integer NOT NULL DEFAULT 60 CHECK (min_delay_seconds BETWEEN 0 AND 3600),
  -- A failure older than this is not retried. An SMS delivered far outside its
  -- useful window can be worse than one never delivered — the same argument
  -- scheduled-send makes for its staleness ceiling.
  max_age_seconds integer NOT NULL DEFAULT 3600 CHECK (max_age_seconds BETWEEN 60 AND 604800),
  -- true: only a bind this message has never been tried on may carry the retry;
  -- if none exists the chain stops. false: the failing bind may be reused as a
  -- last resort, for single-carrier deployments where a transient failure is
  -- still worth one more attempt.
  require_different_bind boolean NOT NULL DEFAULT true,
  -- A retry is a second submission the carrier will invoice, so by default it is
  -- billed like any other: it goes through the normal send path and consumes
  -- quota and credit. Setting this false passes cost 0 into the send path, which
  -- suppresses the CREDIT DEBIT ONLY — quota is still consumed, because the
  -- shared send path has no bypass for it and inventing one here would put a
  -- second, divergent entitlement rule in the system.
  charge_credit_on_retry boolean NOT NULL DEFAULT true,
  -- STORM CONTROL. A carrier outage fails every in-flight message at once;
  -- retrying all of them onto the one surviving bind would take that bind down
  -- too. Read from the TENANT-scope row only — a per-customer override of a
  -- tenant-wide cap would defeat the cap.
  max_retries_per_minute integer NOT NULL DEFAULT 60
    CHECK (max_retries_per_minute BETWEEN 1 AND 10000),
  -- Per-target-bind ceiling: how many retries may be aimed at ONE bind per
  -- minute before it is excluded from the candidate set. Meaningful on the
  -- tenant row (the global default) and on an smsc row (that bind's own limit).
  bind_retries_per_minute integer NOT NULL DEFAULT 30
    CHECK (bind_retries_per_minute BETWEEN 1 AND 10000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A scoped row without its scoping key would silently behave as the tenant
  -- default and shadow it.
  CHECK (scope <> 'smsc' OR smsc_id IS NOT NULL),
  CHECK (scope <> 'customer' OR customer_id IS NOT NULL),
  CHECK (scope <> 'tenant' OR (smsc_id IS NULL AND customer_id IS NULL))
);

-- Partial uniques rather than one composite: PostgreSQL treats NULLs as
-- distinct, so a plain UNIQUE (tenant_id, scope, smsc_id, customer_id) would
-- happily accept two tenant-scope rows.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_retry_policies_tenant_uidx
  ON delivery_retry_policies (tenant_id) WHERE scope = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_retry_policies_smsc_uidx
  ON delivery_retry_policies (tenant_id, smsc_id) WHERE scope = 'smsc';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_retry_policies_customer_uidx
  ON delivery_retry_policies (tenant_id, customer_id) WHERE scope = 'customer';
CREATE INDEX IF NOT EXISTS delivery_retry_policies_enabled_idx
  ON delivery_retry_policies (tenant_id, enabled);

COMMENT ON TABLE delivery_retry_policies IS
  'When a negative delivery report is worth re-sending on another bind. Resolved most-specific-wins: customer scope, then smsc scope, then tenant scope, then built-in defaults. No enabled row = feature off.';
COMMENT ON COLUMN delivery_retry_policies.retry_on_rejected IS
  'DLR event 16. Off by default: a rejection is usually permanent (invalid destination, blocked content, unroutable prefix), so retrying it burns credit and looks like spam to the operator.';
COMMENT ON COLUMN delivery_retry_policies.charge_credit_on_retry IS
  'false suppresses the credit debit for a retry only. Quota is still consumed, because the retry goes through the shared send path.';
COMMENT ON COLUMN delivery_retry_policies.max_retries_per_minute IS
  'Tenant-wide storm cap. Read from the tenant-scope row only; scoped rows cannot raise it.';

-- ==========================================================================
-- 2. THE RETRY CHAIN — ONE ROW PER ORIGINAL MESSAGE
-- ==========================================================================
CREATE TABLE IF NOT EXISTS message_delivery_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- SQLBox send_sms.sql_id of the ORIGINAL submission, which is also the
  -- foreign_id every DLR for it carries. THE dedupe key: see the unique index.
  origin_message_ref text NOT NULL,
  -- message_route_decisions.id of the original send, when it could be found.
  -- Soft reference: the decision is an audit record and both must survive the
  -- other being pruned.
  origin_decision_id uuid,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- Channel of the ORIGINAL send, carried so reporting can tell an API-sourced
  -- retry from a campaign one. Retries themselves always submit as 'system'.
  origin_channel text,
  sender text,
  -- Canonical digits-only destination, as the original decision recorded it.
  destination text NOT NULL,
  -- The body to re-send, captured from the engine's own row so a retry cannot
  -- silently send different text from the message that failed.
  body text NOT NULL DEFAULT '',
  origin_smsc_id text,
  -- Every bind this message has been submitted on, original first. A candidate
  -- must not be in here, which is what makes ping-ponging between two binds
  -- impossible rather than merely unlikely.
  tried_smsc_ids text[] NOT NULL DEFAULT '{}',
  -- The DLR event that opened the chain. See the header note: only a DLR row's
  -- own mask is an event, and only 2 (failed) and 16 (rejected) are negative.
  trigger_dlr_event integer NOT NULL CHECK (trigger_dlr_event IN (2, 16)),
  trigger_dlr_sql_id bigint,
  trigger_dlr_at timestamptz,
  -- The carrier's own words from the DLR body, when it supplied any.
  trigger_detail text,
  --   pending   chain open, a dispatch is scheduled
  --   retrying  a dispatch has claimed it (see attempts, which is the fence)
  --   resent    a retry was submitted; its delivery outcome is not known yet
  --   delivered a positive report arrived for the original or for a retry
  --   exhausted no attempts left, or no untried healthy bind exists
  --   abandoned deliberately stopped (policy disabled, too old, already delivered)
  --   failed    the retry submission itself was refused and cannot be repeated
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'retrying', 'resent', 'delivered', 'exhausted', 'abandoned', 'failed')),
  -- Re-sends already committed. Incremented by the claim BEFORE the send, so a
  -- crash-loop can never exceed max_attempts submissions, and doubles as the
  -- fencing token guarding every write in that dispatch.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  -- Policy row that decided this chain's budget, for "why was it only retried
  -- once?". Soft reference for the same reason origin_decision_id is.
  policy_id uuid,
  -- The api_jobs row currently responsible for the next attempt.
  job_id uuid,
  last_error text,
  -- Why the chain stopped, in the operator's language. Populated for every
  -- terminal status including the successful ones.
  terminal_reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- THE duplicate-retry guard. Opening a chain is
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, so two observers of the same
-- failure — a re-scan after a watermark reset, two workers, a replayed job —
-- produce one chain and the loser gets no row back and stops. There is no
-- SELECT-then-INSERT window to lose.
CREATE UNIQUE INDEX IF NOT EXISTS message_delivery_retries_origin_uidx
  ON message_delivery_retries (tenant_id, origin_message_ref);
CREATE INDEX IF NOT EXISTS message_delivery_retries_status_idx
  ON message_delivery_retries (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS message_delivery_retries_created_idx
  ON message_delivery_retries (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS message_delivery_retries_customer_idx
  ON message_delivery_retries (tenant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE message_delivery_retries IS
  'One row per original message that a negative delivery report put into retry. UNIQUE (tenant_id, origin_message_ref) is what makes a duplicate retry structurally impossible rather than merely unlikely.';
COMMENT ON COLUMN message_delivery_retries.attempts IS
  'Re-sends committed. Incremented by the claim before the send, so it caps submissions even across a crash, and is the fencing token every write in a dispatch is guarded on.';
COMMENT ON COLUMN message_delivery_retries.tried_smsc_ids IS
  'Every bind this message has been submitted on, original first. A retry candidate must not appear here, which is what prevents ping-ponging between two binds.';

-- ==========================================================================
-- 3. THE ATTEMPTS — ONE ROW PER RE-SEND
-- ==========================================================================
CREATE TABLE IF NOT EXISTS message_delivery_retry_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  retry_id uuid NOT NULL REFERENCES message_delivery_retries(id) ON DELETE CASCADE,
  -- 1-based, and equal to the chain's `attempts` value at the moment of the
  -- claim. The unique index below turns the fence into a database constraint.
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  -- Bind this attempt went out on; NULL when no attempt could be made.
  smsc_id text,
  -- Binds ruled out for this attempt, so "why that carrier?" is answerable
  -- without reconstructing the health and rate-limit state of the time.
  excluded_smsc_ids text[] NOT NULL DEFAULT '{}',
  -- How the bind was picked: 'route' (the routing engine chose it and it was
  -- untried), 'least-loaded' (fallback across untried healthy binds),
  -- 'same-bind' (require_different_bind is off and nothing else was available).
  selection text,
  --   submitted the retry reached the engine
  --   refused   the send path rejected it (blocklist, quota, credit, filter)
  --   no_bind   no candidate bind survived exclusion
  --   skipped   the attempt was deliberately not made (already delivered, ...)
  --   error     an unexpected failure; the chain records last_error
  outcome text NOT NULL CHECK (outcome IN
    ('submitted', 'refused', 'no_bind', 'skipped', 'error')),
  -- New send_sms.sql_id, and therefore the foreign_id THIS attempt's own
  -- delivery reports will carry. The scanner joins on it to recognise a failing
  -- retry as a continuation of this chain rather than as a brand-new message.
  message_ref text,
  decision_id uuid,
  -- What this attempt cost the customer, as the send path reported it.
  charged numeric(14, 4) NOT NULL DEFAULT 0 CHECK (charged >= 0),
  -- Delivery outcome observed for this attempt, once one was (1/2/4/8/16).
  dlr_event integer,
  dlr_at timestamptz,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The fence as a constraint: a torn claim cannot record two attempts at the
-- same ordinal, so the chain's attempt history stays a true count of sends.
CREATE UNIQUE INDEX IF NOT EXISTS message_delivery_retry_attempts_no_uidx
  ON message_delivery_retry_attempts (tenant_id, retry_id, attempt_no);
-- One chain per engine message, in the other direction: a retry's sql_id maps
-- back to exactly one attempt, so a failing retry continues its own chain.
CREATE UNIQUE INDEX IF NOT EXISTS message_delivery_retry_attempts_ref_uidx
  ON message_delivery_retry_attempts (tenant_id, message_ref) WHERE message_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_delivery_retry_attempts_retry_idx
  ON message_delivery_retry_attempts (tenant_id, retry_id, attempt_no);
-- Serves the storm caps, which count attempts in the last minute overall and
-- per target bind.
CREATE INDEX IF NOT EXISTS message_delivery_retry_attempts_recent_idx
  ON message_delivery_retry_attempts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_delivery_retry_attempts_smsc_idx
  ON message_delivery_retry_attempts (tenant_id, smsc_id, created_at DESC)
  WHERE smsc_id IS NOT NULL;

COMMENT ON TABLE message_delivery_retry_attempts IS
  'One row per re-send: which bind carried it, which binds were excluded and why, what it cost, and how it was delivered. Answers "how many times did this go out, on which carriers, and why".';
COMMENT ON COLUMN message_delivery_retry_attempts.message_ref IS
  'send_sms.sql_id of this retry, which is the foreign_id its own delivery reports carry. Unique per tenant so a failing retry continues its chain instead of opening a new one.';

-- ==========================================================================
-- 4. SCANNER STATE
-- ==========================================================================
-- Same shape and same reasoning as mo_ingest_state (migration 044): the
-- watermark is an optimisation, not the correctness mechanism — that is
-- message_delivery_retries_origin_uidx. A watermark that goes backwards
-- (restored database, manual reset) re-reads reports and opens no chain twice.
CREATE TABLE IF NOT EXISTS delivery_retry_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- Highest engine sent_sms.sql_id examined for delivery reports.
  watermark_sql_id bigint NOT NULL DEFAULT 0 CHECK (watermark_sql_id >= 0),
  poll_interval_seconds integer NOT NULL DEFAULT 60
    CHECK (poll_interval_seconds BETWEEN 5 AND 3600),
  last_scanned_at timestamptz,
  last_error text,
  -- Lifetime counters, so an operator can see the feature working (or not)
  -- without aggregating the chain table.
  reports_seen bigint NOT NULL DEFAULT 0 CHECK (reports_seen >= 0),
  chains_opened bigint NOT NULL DEFAULT 0 CHECK (chains_opened >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ==========================================================================
-- 5. TENANT ISOLATION
-- ==========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'delivery_retry_policies', 'message_delivery_retries',
    'message_delivery_retry_attempts', 'delivery_retry_state'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
        AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
        t
      );
    END IF;
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  delivery_retry_policies, message_delivery_retries,
  message_delivery_retry_attempts, delivery_retry_state
  TO jkannel_app;

COMMIT;
