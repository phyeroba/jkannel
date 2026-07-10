-- 023_messaging_depth
-- Messaging depth: bulk send / campaign jobs. A tenant queues one message body
-- to many recipients through one of its own SMSCs; a background processor submits
-- each recipient through the engine (SQLBox send_sms) and records per-recipient
-- outcome. Tenant-scoped with forced row level security, matching the pattern in
-- migrations 011/012/016/018/019/020.
--
-- The engine-owned SQLBox tables (send_sms/sent_sms) carry no tenant column and
-- are NOT touched here; isolation of the actual submissions is enforced by the
-- application restricting every job to the caller's own SMSC engine ids. These
-- two tables are the JKANNEL-side ledger of the bulk operation only.
BEGIN;

CREATE TABLE bulk_send_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  -- Engine-level SMSC identifier (smsc_definitions.engine_id), validated by the
  -- application to belong to the tenant before the job is created.
  smsc_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total integer NOT NULL DEFAULT 0,
  submitted integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  detail text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX bulk_send_jobs_tenant_status_idx
  ON bulk_send_jobs (tenant_id, status, created_at DESC);

CREATE TABLE bulk_send_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL REFERENCES bulk_send_jobs(id) ON DELETE CASCADE,
  receiver text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'failed')),
  -- SQLBox sql_id of the queued submission when successfully enqueued.
  foreign_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bulk_send_recipients_job_idx
  ON bulk_send_recipients (job_id, status, created_at);

ALTER TABLE bulk_send_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bulk_send_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE bulk_send_jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE bulk_send_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bulk_send_recipients
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE bulk_send_recipients FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_send_jobs TO jkannel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_send_recipients TO jkannel_app;

COMMIT;
