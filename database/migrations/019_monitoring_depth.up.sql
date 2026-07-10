-- 019_monitoring_depth
-- Deepens the monitoring/alerting substrate:
--   * escalation_policies + alert_escalations drive time-based escalation chains
--     for alerts that stay open (unacknowledged) past each step's afterMinutes.
--   * maintenance_windows let operators suppress evaluation/escalation for a
--     scoped set of SMSCs/routes (or everything) during planned work.
--   * alert_instances gains correlation_group + dedup_count so related alerts can
--     be grouped and duplicates counted instead of reopening fresh incidents.
-- All new tables are tenant-scoped with forced row level security, matching the
-- pattern established in migrations 004/012/016.
BEGIN;

CREATE TABLE escalation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  -- Ordered array of {afterMinutes, channelType, target, severity?}. afterMinutes
  -- is minutes elapsed since the alert opened at which the step becomes due.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  CHECK (jsonb_typeof(steps) = 'array')
);

CREATE TABLE alert_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  alert_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  status text NOT NULL DEFAULT 'escalated'
    CHECK (status IN ('escalated', 'notified', 'failed', 'skipped', 'suppressed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  escalated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alert_id, policy_id, step_index),
  FOREIGN KEY (tenant_id, alert_id) REFERENCES alert_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES escalation_policies(tenant_id, id)
);
CREATE INDEX alert_escalations_alert_idx ON alert_escalations (tenant_id, alert_id, escalated_at DESC);

CREATE TABLE maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- {all?: boolean, smscs?: text[], routes?: text[]}. Empty/missing => matches nothing.
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (jsonb_typeof(scope) = 'object')
);
CREATE INDEX maintenance_windows_active_idx
  ON maintenance_windows (tenant_id, starts_at, ends_at);

-- Correlation + dedup columns on the existing alert table (idempotent adds).
ALTER TABLE alert_instances
  ADD COLUMN IF NOT EXISTS correlation_group text,
  ADD COLUMN IF NOT EXISTS dedup_count integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS alert_instances_correlation_idx
  ON alert_instances (tenant_id, correlation_group)
  WHERE correlation_group IS NOT NULL AND status <> 'resolved';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['escalation_policies', 'alert_escalations', 'maintenance_windows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON escalation_policies, alert_escalations, maintenance_windows TO jkannel_app;

COMMIT;
