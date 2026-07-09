-- 012_report_snapshots_notifications
-- Persisted message-volume report snapshots (daily/weekly, total and per
-- route/SMSC), the in-app user notification store, and idempotent report job
-- run records.
BEGIN;

CREATE TABLE report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  period_type text NOT NULL CHECK (period_type IN ('daily', 'weekly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  scope text NOT NULL CHECK (scope IN ('total', 'smsc', 'route')),
  scope_key text NOT NULL DEFAULT '',
  scope_label text NOT NULL DEFAULT '',
  message_count bigint NOT NULL DEFAULT 0,
  dlr_count bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_type, period_start, scope, scope_key)
);
CREATE INDEX report_snapshots_tenant_period_idx
  ON report_snapshots (tenant_id, period_type, period_start DESC);

CREATE TABLE user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_notifications_user_unread_idx
  ON user_notifications (tenant_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

-- One row per (tenant, period); the unique constraint makes report generation
-- idempotent across restarts and multiple backend replicas.
CREATE TABLE report_job_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  period_type text NOT NULL CHECK (period_type IN ('daily', 'weekly')),
  period_start date NOT NULL,
  status text NOT NULL DEFAULT 'succeeded',
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_type, period_start)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_snapshots', 'user_notifications', 'report_job_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON report_snapshots, user_notifications, report_job_runs TO jkannel_app;

COMMIT;
