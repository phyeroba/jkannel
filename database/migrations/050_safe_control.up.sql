-- 050_safe_control
-- Reason capture, operator-suspended traffic, and manual route failover.
--
-- §1.1 "Safe control": disruptive actions require permissions, impact warnings,
-- REASON CAPTURE and audit logging. §16 lists what every audited action must
-- record: actor, role, timestamp, target, previous state, requested action,
-- reason, result.
--
-- Today `smsc_deployments` records actor, action, target and result — and no
-- reason. An operator reading the audit trail after an incident can see that a
-- bind was reconnected at 03:12 and cannot see why, which is exactly the
-- question being asked at that point.
BEGIN;

-- ==========================================================================
-- 1. Reason on operator-initiated SMSC operations.
-- ==========================================================================
-- Nullable, because `smsc_deployments` already holds history that has no
-- reason and inventing one would be worse than an honest gap. New disruptive
-- operations require it at the API instead — a NOT NULL here would either
-- reject the backfill or force a placeholder into the historical rows.
ALTER TABLE smsc_deployments ADD COLUMN IF NOT EXISTS reason text;

COMMENT ON COLUMN smsc_deployments.reason IS
  'Why the operator performed this action (spec §16). Null on rows written before 050.';

-- ==========================================================================
-- 2. Operator-suspended traffic, distinct from a carrier-dropped bind.
-- ==========================================================================
-- UC-SMSC-02's UI requirement is explicit: "Clearly distinguish
-- operator-suspended from carrier-disconnected states."
--
-- Deliberately NOT reusing `enabled`. That column decides whether the SMSC is
-- rendered into the engine configuration at all, so toggling it to pause
-- traffic would rewrite and redeploy the engine config — a disruptive act, for
-- something an operator expects to be instant and instantly reversible.
-- Suspension is a JKANNEL-side hold on new submissions; the bind stays up, the
-- queue stays visible, and resuming needs no deployment.
ALTER TABLE smsc_definitions ADD COLUMN IF NOT EXISTS traffic_suspended_at timestamptz;
ALTER TABLE smsc_definitions ADD COLUMN IF NOT EXISTS traffic_suspended_by text;
ALTER TABLE smsc_definitions ADD COLUMN IF NOT EXISTS traffic_suspended_reason text;

COMMENT ON COLUMN smsc_definitions.traffic_suspended_at IS
  'Operator hold on NEW submissions (spec UC-SMSC-02). The bind stays connected; this is not `enabled`, which controls engine config rendering.';

CREATE INDEX IF NOT EXISTS smsc_definitions_suspended_idx
  ON smsc_definitions (tenant_id) WHERE traffic_suspended_at IS NOT NULL AND deleted_at IS NULL;

-- ==========================================================================
-- 3. Manual route failover.
-- ==========================================================================
-- `routing_rules.fallback_smsc_id` is declarative: the selector consults it
-- automatically when the target is unhealthy. UC-RTE-02 asks for something
-- different — an operator deliberately moving traffic, with a reason, that
-- HOLDS even while the primary looks healthy, because the carrier asked or
-- because the operator does not trust it yet.
--
-- A row here is an active override while `ended_at` is null. History is kept:
-- "always show current active path; never hide manual override state" is the
-- use case's UI requirement, and a failover that vanished on revert would make
-- the incident unreconstructable.
CREATE TABLE IF NOT EXISTS route_failovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  route_id uuid NOT NULL REFERENCES routing_rules(id) ON DELETE CASCADE,
  -- The target the route would otherwise have used, captured at the moment of
  -- the override so the audit reads correctly even if the route is later edited.
  from_smsc_id uuid REFERENCES smsc_definitions(id),
  to_smsc_id uuid NOT NULL REFERENCES smsc_definitions(id),
  reason text NOT NULL,
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_by text,
  ended_at timestamptz,
  end_reason text,
  CONSTRAINT route_failovers_reason_length CHECK (length(btrim(reason)) >= 3),
  -- A route cannot be failed over to the target it is already using; that is a
  -- no-op dressed as an intervention, and it would appear in the audit trail as
  -- a change that did not happen.
  CONSTRAINT route_failovers_distinct_target CHECK (from_smsc_id IS NULL OR from_smsc_id <> to_smsc_id)
);

-- One active override per route. A second would make "which target is live"
-- ambiguous, and the selector would have to guess.
CREATE UNIQUE INDEX IF NOT EXISTS route_failovers_active_idx
  ON route_failovers (route_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS route_failovers_tenant_time_idx
  ON route_failovers (tenant_id, started_at DESC);

COMMENT ON TABLE route_failovers IS
  'Manual operator override of a route target (spec UC-RTE-02). Active while ended_at is null; history retained so an incident stays reconstructable.';

-- ==========================================================================
-- 4. Test sends, tagged so they never pollute delivery reporting.
-- ==========================================================================
-- UC-TST-01: "Visually distinguish test traffic from production traffic in
-- traces/events."
--
-- A separate table rather than a column on `sent_sms`, because that table is
-- engine-owned: sqlbox creates it, and JKANNEL adding a column there is a thing
-- to avoid unless the engine itself reads it (migration 043 did so only because
-- the patched driver required it). The join key is `foreign_id`, the same
-- correlation key everything else uses.
CREATE TABLE IF NOT EXISTS test_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  foreign_id text NOT NULL,
  smsc_id uuid REFERENCES smsc_definitions(id),
  destination text NOT NULL,
  reason text,
  sent_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS test_sends_foreign_idx ON test_sends (tenant_id, foreign_id);
CREATE INDEX IF NOT EXISTS test_sends_time_idx ON test_sends (tenant_id, created_at DESC);

COMMENT ON TABLE test_sends IS
  'Operator test messages (spec §15, UC-TST-01), joined to engine rows by foreign_id so test traffic can be marked in traces and excluded from delivery reporting.';

-- ==========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['route_failovers', 'test_sends'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON route_failovers, test_sends TO jkannel_app;

COMMIT;
