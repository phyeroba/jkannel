-- 021_reporting_depth
-- Saved report definitions (named, re-runnable reports the user can schedule)
-- and a run ledger recording each scheduled delivery attempt. Tenant-scoped
-- with forced row level security, matching the pattern in migrations
-- 011/012/016/018/019/020.
--
-- A report_definition names one catalog report kind (report_type) plus the
-- parameters to run it with; an optional schedule ('hourly'/'daily'/'weekly')
-- opts it into scheduled export delivery (see ReportScheduleService). Every
-- delivery attempt appends a report_definition_runs row so operators can see
-- whether a scheduled report was delivered, delivered in-app only, or skipped.
BEGIN;

CREATE TABLE report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  report_type text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule text CHECK (schedule IS NULL OR schedule IN ('hourly', 'daily', 'weekly')),
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'summary')),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A report name is unique within a tenant so the directory has stable keys.
  UNIQUE (tenant_id, name)
);
CREATE INDEX report_definitions_tenant_idx ON report_definitions (tenant_id, name);
CREATE INDEX report_definitions_scheduled_idx
  ON report_definitions (tenant_id, schedule)
  WHERE enabled AND schedule IS NOT NULL;

CREATE TABLE report_definition_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  definition_id uuid NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('succeeded', 'in-app-only', 'skipped', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ran_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_definition_runs_def_idx
  ON report_definition_runs (tenant_id, definition_id, ran_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_definitions', 'report_definition_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON report_definitions, report_definition_runs TO jkannel_app;

COMMIT;
