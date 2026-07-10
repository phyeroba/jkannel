-- 025_routing_depth
-- Advanced routing depth. ADDITIVE to the existing routing_rules table
-- (created in migration 004, extended for deployments in 007): this migration
-- adds the columns and side tables required to describe route TYPE (prefix /
-- country / operator / weighted), a selection STRATEGY (priority / least-cost /
-- load-balance / round-robin / time-based), multi-target weighted fan-out, and
-- a tenant-scoped version history with an audit trail.
--
-- Existing behaviour is preserved: a route whose route_type is left at the
-- default 'static' with strategy 'priority' resolves exactly as before (its
-- target_smsc_id, falling back to fallback_smsc_id). No existing column is
-- dropped or recreated and routing_rules itself is never re-created.
--
-- Tenant isolation matches the pattern in migrations 011/012/016/018/019/020/
-- 021/023: ENABLE + FORCE row level security with a tenant_isolation policy on
-- current_setting('app.tenant_id'), and GRANTs to the jkannel_app role.
BEGIN;

-- --------------------------------------------------------------------------
-- 1. Additive columns on routing_rules (idempotent; safe on hand-migrated DBs)
-- --------------------------------------------------------------------------
ALTER TABLE routing_rules
  ADD COLUMN IF NOT EXISTS route_type text NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS match_prefix text,
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS operator text,
  ADD COLUMN IF NOT EXISTS cost numeric(12, 6),
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'priority',
  -- Time-based windows: local time-of-day range and the weekdays it is active
  -- on (comma-separated 0-6, 0 = Sunday). NULL window_start means "always".
  ADD COLUMN IF NOT EXISTS window_start time,
  ADD COLUMN IF NOT EXISTS window_end time,
  ADD COLUMN IF NOT EXISTS active_days text;

-- Bounded vocabularies for route_type / strategy, added defensively so a
-- re-run (or a database that already has them) does not error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_route_type_check') THEN
    ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_route_type_check
      CHECK (route_type IN ('static', 'prefix', 'country', 'operator', 'weighted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_strategy_check') THEN
    ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_strategy_check
      CHECK (strategy IN ('priority', 'least-cost', 'load-balance', 'round-robin', 'time-based'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. route_targets: weighted multi-target fan-out for a single route
-- --------------------------------------------------------------------------
CREATE TABLE route_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  route_id uuid NOT NULL,
  smsc_id uuid NOT NULL,
  weight integer NOT NULL DEFAULT 1 CHECK (weight >= 0),
  cost numeric(12, 6),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Scope the route + SMSC references to the same tenant so a target can never
  -- point at another tenant's route or SMSC even with RLS disabled.
  FOREIGN KEY (tenant_id, route_id) REFERENCES routing_rules(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, smsc_id) REFERENCES smsc_definitions(tenant_id, id),
  UNIQUE (tenant_id, route_id, smsc_id)
);
CREATE INDEX route_targets_route_idx ON route_targets (tenant_id, route_id);

-- --------------------------------------------------------------------------
-- 3. route_versions: immutable version history + audit trail per route
-- --------------------------------------------------------------------------
CREATE TABLE route_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  route_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- Full snapshot of the route definition (routing_rules row + its targets) at
  -- the moment the version was captured, so a rollback can be reconstructed.
  definition jsonb NOT NULL,
  reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, route_id) REFERENCES routing_rules(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, route_id, version)
);
CREATE INDEX route_versions_history_idx
  ON route_versions (tenant_id, route_id, version DESC);

-- --------------------------------------------------------------------------
-- 4. Row level security (ENABLE + tenant_isolation policy + FORCE) and GRANTs
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['route_targets', 'route_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON route_targets, route_versions TO jkannel_app;

COMMIT;
