-- 020_customers
-- Introduces the Customer Domain: an organization/account that consumes
-- messaging through JKANNEL. A customer owns business resources (routes, sender
-- IDs, quotas, limits, reports) but never platform resources (Docker, Postgres,
-- Redis, the engine, platform settings) — see the SYSTEM_DATA_MODEL spec,
-- "CUSTOMER DOMAIN". Tenant-scoped with forced row level security, matching the
-- pattern in migrations 011/012/016/018/019.
--
-- Also extends backup_records with a `scope` column so the backup-dr module can
-- record whether an artifact is a whole-database ('full'/'database') dump or a
-- configuration-only ('configurations') dump.
BEGIN;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  contact_email text,
  quota_daily bigint,
  rate_limit_per_min integer,
  allowed_sender_ids text[] NOT NULL DEFAULT '{}',
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- code is unique per tenant when present; PostgreSQL treats NULLs as distinct,
  -- so customers without a code are unconstrained.
  UNIQUE (tenant_id, code)
);
CREATE INDEX customers_tenant_status_idx ON customers (tenant_id, status, name);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO jkannel_app;

-- Record the backup scope on the catalog row so config-only vs whole-database
-- dumps are queryable. Idempotent: safe to re-run.
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'full';

COMMIT;
