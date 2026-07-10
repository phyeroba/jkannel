-- 026_customers_depth
-- Deepens the Customer Domain (migration 020) with the business resources a
-- customer account carries: message quotas with a usage counter, a prepaid
-- credit balance backed by an append-only transaction ledger, per-customer
-- allowed sender IDs with an approval workflow, and per-customer route/SMSC
-- bindings. All tables are tenant-scoped with forced row level security,
-- matching the pattern in migrations 011/012/016/018/019/020/021.
--
-- These are additive: the existing customers table is left untouched. Balance
-- is stored in customer_balances (one row per customer, the lockable point of
-- truth) and every debit/credit appends a credit_transactions row recording the
-- resulting balance, so the ledger is a full, immutable-by-convention history.
BEGIN;

-- Per-customer message quota. One row per (customer, period); used_count is a
-- rolling counter reset when the window elapses. limit_count is the cap.
CREATE TABLE customer_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('daily', 'monthly')),
  limit_count bigint NOT NULL CHECK (limit_count >= 0),
  used_count bigint NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  window_start timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, period)
);
CREATE INDEX customer_quotas_customer_idx ON customer_quotas (tenant_id, customer_id);

-- Point-of-truth balance, one row per customer, locked FOR UPDATE when posting
-- a transaction so concurrent debits cannot race past a zero balance.
CREATE TABLE customer_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  balance numeric(18, 4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id)
);

-- Append-only ledger of debits and credits. balance_after captures the running
-- balance after this entry; reference optionally ties the entry to what caused
-- it (a bulk send job id, an invoice, a top-up id, ...).
CREATE TABLE credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount numeric(18, 4) NOT NULL CHECK (amount > 0),
  balance_after numeric(18, 4) NOT NULL,
  reason text,
  reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_transactions_customer_idx
  ON credit_transactions (tenant_id, customer_id, created_at DESC);

-- Per-customer allowed sender IDs with an approval lifecycle. A sender ID is
-- requested ('pending'), then 'approved' or 'rejected' by an operator.
CREATE TABLE sender_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sender_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, sender_id)
);
CREATE INDEX sender_ids_customer_idx ON sender_ids (tenant_id, customer_id, status);

-- Per-customer route bindings: which routing rules and/or SMSCs a customer is
-- entitled to use. Exactly one of route_id / smsc_id is set per binding.
CREATE TABLE customer_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  route_id uuid REFERENCES routing_rules(id) ON DELETE CASCADE,
  smsc_id uuid REFERENCES smsc_definitions(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0 CHECK (priority >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(route_id, smsc_id) = 1)
);
-- A customer may bind a given route or SMSC at most once (partial uniques so
-- the NULL side of each binding does not spuriously collide).
CREATE UNIQUE INDEX customer_routes_route_uidx
  ON customer_routes (tenant_id, customer_id, route_id) WHERE route_id IS NOT NULL;
CREATE UNIQUE INDEX customer_routes_smsc_uidx
  ON customer_routes (tenant_id, customer_id, smsc_id) WHERE smsc_id IS NOT NULL;
CREATE INDEX customer_routes_customer_idx ON customer_routes (tenant_id, customer_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customer_quotas', 'customer_balances', 'credit_transactions',
    'sender_ids', 'customer_routes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  customer_quotas, customer_balances, credit_transactions, sender_ids, customer_routes
  TO jkannel_app;

COMMIT;
