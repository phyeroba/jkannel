-- 022_configuration_depth
-- Adds two tenant-scoped tables that give the Configuration Generator more
-- depth without touching the existing configuration_versions workflow:
--
--   config_templates    Reusable starting EngineConfiguration documents. A
--                       template's `content` jsonb mirrors the shape that
--                       ConfigurationGeneratorService.generate consumes, so the
--                       console can instantiate one into a fresh configuration
--                       version. `is_builtin` marks the seeded starter templates
--                       (a minimal Kamex gateway and a Kamex+SQLBox setup) that
--                       the repository seeds on first list.
--
--   config_drift_checks Audit trail of configuration drift checks: whether the
--                       live engine config file on disk still matches the
--                       currently-deployed version's rendered content.
--
-- Both tables follow the tenant isolation pattern used by migrations
-- 011/012/016/018/019/020: RLS ENABLE + tenant_isolation policy + FORCE + a
-- grant to the non-owner application role jkannel_app.
BEGIN;

CREATE TABLE config_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text,
  engine text NOT NULL DEFAULT 'kamex',
  content jsonb NOT NULL DEFAULT '{}',
  is_builtin boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Template names are unique per tenant so seeded built-ins are idempotent
  -- (INSERT ... ON CONFLICT (tenant_id,name) DO NOTHING).
  UNIQUE (tenant_id, name)
);
CREATE INDEX config_templates_tenant_idx ON config_templates (tenant_id, engine, name);

ALTER TABLE config_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_templates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE config_templates FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON config_templates TO jkannel_app;

CREATE TABLE config_drift_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- NULL when drift could not be determined (file missing, or no deployed
  -- version to compare against); true/false otherwise.
  in_sync boolean,
  deployed_checksum text,
  live_checksum text,
  detail jsonb NOT NULL DEFAULT '{}',
  checked_by text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_drift_checks_tenant_idx ON config_drift_checks (tenant_id, checked_at DESC);

ALTER TABLE config_drift_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_drift_checks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
ALTER TABLE config_drift_checks FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON config_drift_checks TO jkannel_app;

COMMIT;
