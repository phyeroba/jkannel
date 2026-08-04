-- 032_send_path
-- Puts the routing engine and the customer entitlement model ON the send path.
--
-- Until now `selectRoute()` (routing-depth) had exactly one non-test caller —
-- the /routing/resolve preview — and every production send took its target SMSC
-- straight from the caller, so disabling a route changed nothing. Likewise the
-- customer quota / credit / sender-ID / route-binding primitives (migration 026)
-- were called only by their own admin endpoints, and `bulk_send_jobs` had no
-- customer column at all, so traffic could not even be attributed.
--
-- This migration adds the three things the send path needs to be real:
--
--   1. customer attribution and a real sender on bulk_send_jobs, plus an
--      optional smsc_id so the routing engine (not the job author) may pick the
--      bind at dispatch time;
--   2. message_route_decisions — an audit of every routing decision, so an
--      operator can answer "why did this message go out on that carrier?"
--      (ROUTING_ENGINE_SPEC_04 step 9, "audit the decision");
--   3. messaging_blocklist — the blacklist / whitelist / DND list the routing
--      spec requires to be evaluated before a route is chosen.
--
-- It also reconciles the duplicate policy columns on `customers`. The normalised
-- tables from migration 026 (customer_quotas, sender_ids) are the point of
-- truth; customers.quota_daily and customers.allowed_sender_ids are back-filled
-- into them once and then marked deprecated. customers.rate_limit_per_min has no
-- normalised twin and is left as the single home for per-customer rate limiting.
--
-- Tenant-scoped with forced row level security throughout, matching migration 026.
BEGIN;

-- --------------------------------------------------------------------------
-- 1. bulk_send_jobs: customer attribution, a real sender, routable smsc_id
-- --------------------------------------------------------------------------
-- Nullable: a job created by an operator with no customer context behaves
-- exactly as before (no entitlement is consumed).
ALTER TABLE bulk_send_jobs
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
-- Campaign messages previously went out with sender = '' (hard-coded).
ALTER TABLE bulk_send_jobs ADD COLUMN IF NOT EXISTS sender text;
-- NULL smsc_id now means "let the routing engine choose per recipient".
ALTER TABLE bulk_send_jobs ALTER COLUMN smsc_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS bulk_send_jobs_customer_idx
  ON bulk_send_jobs (tenant_id, customer_id, created_at DESC);

COMMENT ON COLUMN bulk_send_jobs.smsc_id IS
  'Engine-level SMSC id (smsc_definitions.engine_id) pinned by the job author. NULL = resolved per recipient by the routing engine at dispatch time.';
COMMENT ON COLUMN bulk_send_jobs.sender IS
  'Sender ID every message in this campaign is submitted with. Validated against the customer''s approved sender_ids when the job carries a customer.';

-- --------------------------------------------------------------------------
-- 2. message_route_decisions — why this message went out on that carrier
-- --------------------------------------------------------------------------
CREATE TABLE message_route_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- SQLBox send_sms.sql_id once the submission succeeded; NULL for a rejection.
  message_ref text,
  -- Correlation id carried into the engine (send_sms.foreign_id).
  foreign_id text,
  -- Which send path produced this decision.
  channel text NOT NULL
    CHECK (channel IN ('console', 'api', 'bulk', 'replay', 'system')),
  sender text,
  -- Normalised E.164 destination (digits, no '+') and what the caller supplied.
  destination text NOT NULL,
  destination_raw text,
  -- The controlling route, when one was selected. Kept as a soft reference so
  -- deleting a route never erases the history of what it once decided.
  route_id uuid REFERENCES routing_rules(id) ON DELETE SET NULL,
  route_name text,
  strategy text,
  -- Engine-level bind the message was submitted through.
  smsc_id text,
  -- Explicit bind the caller asked for, when any (so overrides are visible).
  requested_smsc_id text,
  fallback_used boolean NOT NULL DEFAULT false,
  outcome text NOT NULL
    CHECK (outcome IN ('routed', 'explicit', 'rerouted', 'rejected')),
  reason text NOT NULL,
  -- The health-derived candidate set the decision was made against.
  available_smsc_ids text[] NOT NULL DEFAULT '{}',
  candidates_considered integer NOT NULL DEFAULT 0,
  -- Ordered selectRoute() trace, verbatim.
  trace jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_route_decisions_tenant_created_idx
  ON message_route_decisions (tenant_id, created_at DESC);
CREATE INDEX message_route_decisions_message_idx
  ON message_route_decisions (tenant_id, message_ref);
CREATE INDEX message_route_decisions_foreign_idx
  ON message_route_decisions (tenant_id, foreign_id);
CREATE INDEX message_route_decisions_route_idx
  ON message_route_decisions (tenant_id, route_id, created_at DESC);

-- --------------------------------------------------------------------------
-- 3. messaging_blocklist — blacklist / whitelist / DND
-- --------------------------------------------------------------------------
-- Evaluated before route selection. `msisdn` is stored normalised (digits only,
-- no '+') by the shared E.164 normaliser so a number entered as +256700000000,
-- 256-700-000000 or 00256700000000 is one entry, not three.
--
-- customer_id NULL = a tenant-wide entry that applies to every customer.
-- list_type semantics:
--   blacklist — refuse the send outright
--   dnd       — refuse the send (do-not-disturb registry; distinct so the
--               refusal reason and the reporting can tell them apart)
--   whitelist — when ANY enabled whitelist entry is in scope, only whitelisted
--               destinations may be sent to (closed mode); with no whitelist
--               entries in scope the list is inert.
CREATE TABLE messaging_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  list_type text NOT NULL CHECK (list_type IN ('blacklist', 'whitelist', 'dnd')),
  msisdn text NOT NULL CHECK (msisdn ~ '^[0-9]{3,15}$'),
  reason text,
  source text,
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Partial uniques so the tenant-wide (customer_id IS NULL) side does not
-- spuriously collide under PostgreSQL's "NULLs are distinct" rule.
CREATE UNIQUE INDEX messaging_blocklist_customer_uidx
  ON messaging_blocklist (tenant_id, customer_id, list_type, msisdn)
  WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX messaging_blocklist_global_uidx
  ON messaging_blocklist (tenant_id, list_type, msisdn)
  WHERE customer_id IS NULL;
CREATE INDEX messaging_blocklist_lookup_idx
  ON messaging_blocklist (tenant_id, msisdn, list_type) WHERE enabled;

-- --------------------------------------------------------------------------
-- 4. Row level security + grants for the new tables
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_route_decisions', 'messaging_blocklist'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  message_route_decisions, messaging_blocklist
  TO jkannel_app;

-- --------------------------------------------------------------------------
-- 5. Reconcile the duplicate customer policy columns
-- --------------------------------------------------------------------------
-- customers.quota_daily -> customer_quotas(period='daily'). Only fills a gap;
-- an explicitly configured quota row always wins.
INSERT INTO customer_quotas (tenant_id, customer_id, period, limit_count, created_by)
SELECT c.tenant_id, c.id, 'daily', c.quota_daily, 'migration:032'
  FROM customers c
 WHERE c.quota_daily IS NOT NULL AND c.quota_daily >= 0
ON CONFLICT (tenant_id, customer_id, period) DO NOTHING;

-- customers.allowed_sender_ids -> sender_ids(status='approved'). An operator
-- had already allowed these, so they arrive approved rather than pending.
INSERT INTO sender_ids (tenant_id, customer_id, sender_id, status, reason, created_by)
SELECT c.tenant_id, c.id, s, 'approved', 'migrated from customers.allowed_sender_ids', 'migration:032'
  FROM customers c
 CROSS JOIN LATERAL unnest(c.allowed_sender_ids) AS s
 WHERE c.allowed_sender_ids IS NOT NULL AND array_length(c.allowed_sender_ids, 1) > 0
ON CONFLICT (tenant_id, customer_id, sender_id) DO NOTHING;

COMMENT ON COLUMN customers.quota_daily IS
  'DEPRECATED (migration 032): superseded by customer_quotas(period=''daily''), which the send path enforces. Retained read-only for existing consoles; not consulted by any enforcement code.';
COMMENT ON COLUMN customers.allowed_sender_ids IS
  'DEPRECATED (migration 032): superseded by sender_ids, which carries the approval workflow the send path enforces. Retained read-only for existing consoles.';
COMMENT ON COLUMN customers.rate_limit_per_min IS
  'Per-customer request rate limit. Kept as the single home for this policy (no normalised twin exists). NOT enforced on the send path yet.';

COMMENT ON TABLE message_route_decisions IS
  'One row per send-path routing decision (ROUTING_ENGINE_SPEC_04 step 9). Records the chosen bind, the controlling route, the strategy, whether the fallback was taken and why.';
COMMENT ON TABLE messaging_blocklist IS
  'Recipient blacklist / whitelist / DND, evaluated before route selection. msisdn is normalised digits-only E.164.';

COMMIT;
