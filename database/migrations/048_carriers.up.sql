-- 048_carriers
-- The Carrier: an operational aggregation above the SMSC.
--
-- WHY THIS OBJECT DOES NOT EXIST YET, AND WHY IT HAS TO
-- --------------------------------------------------------------------------
-- `smsc_definitions` is flat. The word "carrier" appears in this codebase only
-- inside comments — there is no table, no column and no grouping concept. That
-- was survivable while an operator ran two loopback binds; it stops being
-- survivable the moment one mobile network is reached through several SMSCs,
-- which is the normal shape of a real estate and the shape the Kamex UI
-- Redesign Functional Specification is written around.
--
-- §4.1 defines the Carrier as "an operational aggregation object representing a
-- mobile network/operator and its associated SMSCs and sessions", and the whole
-- of §3 assumes an operator can ask "is MTN healthy?" rather than having to
-- know which four binds happen to serve MTN today. §21 makes the relationship
-- explicit: Carrier has many SMSCs; SMSC belongs to a carrier.
--
-- WHAT IS DELIBERATELY *NOT* HERE
-- --------------------------------------------------------------------------
-- No capacity, delivery %, DLR latency, TPS or open-alert counts as COLUMNS.
-- Every one of those is derived from telemetry that already exists elsewhere
-- (smsc_bind_snapshots, metric_samples, sent_sms, alert_instances) and storing
-- a second copy would create a number that can disagree with its own source.
-- They are computed by the aggregation read model instead. This table holds
-- only what an operator TYPES: identity and operational intent.
--
-- THE BACKFILL LEAVES EVERY EXISTING SMSC UNASSIGNED
-- --------------------------------------------------------------------------
-- `carrier_id` is nullable and nothing is guessed. Inferring a carrier from an
-- SMSC's name or host would be a guess written into the database as a fact, and
-- an SMSC filed under the wrong network is worse than one filed under none:
-- the first quietly corrupts every per-carrier figure, the second is visibly
-- incomplete and asks to be fixed. The console shows unassigned SMSCs as
-- exactly that.
BEGIN;

CREATE TABLE IF NOT EXISTS carriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- Operator-facing name: "MTN Uganda", not an engine id.
  name text NOT NULL,
  -- ISO 3166-1 alpha-2. The estate is multi-country and §4.1 asks for
  -- country/market on the carrier identity; the SMSC register scopes by it.
  country_code text,
  -- MCC+MNC, the unambiguous network identifier. Text rather than an integer
  -- because leading zeros are significant (MNC 01 is not MNC 1).
  network_code text,
  -- Operator intent, NOT observed health. Health is derived from bind
  -- telemetry and must never be settable by hand — an operator marking a
  -- carrier "active" would otherwise override what the engine is reporting.
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT carriers_status_check CHECK (status IN ('active', 'suspended', 'retired')),
  -- Two-letter uppercase, or absent. Rejecting "Uganda" here keeps the column
  -- joinable against any country reference later.
  CONSTRAINT carriers_country_check CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT carriers_network_check CHECK (network_code IS NULL OR network_code ~ '^[0-9]{4,6}$')
);

-- One name per tenant among LIVE rows only: a retired carrier keeps its name
-- so history stays readable, and the name becomes reusable after deletion.
CREATE UNIQUE INDEX IF NOT EXISTS carriers_tenant_name_idx
  ON carriers (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS carriers_tenant_network_idx
  ON carriers (tenant_id, network_code) WHERE deleted_at IS NULL AND network_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS carriers_tenant_country_idx
  ON carriers (tenant_id, country_code) WHERE deleted_at IS NULL;

-- ON DELETE SET NULL, not CASCADE: deleting a carrier must never delete the
-- SMSC definitions under it. Those carry engine ids, credentials and routing
-- references, and losing them would take live traffic down to tidy up an
-- organisational label.
ALTER TABLE smsc_definitions
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES carriers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS smsc_definitions_carrier_idx
  ON smsc_definitions (tenant_id, carrier_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE carriers IS
  'Operational aggregation above smsc_definitions (spec §4.1). Identity and intent only; all health, capacity and quality figures are derived from telemetry at read time.';
COMMENT ON COLUMN carriers.status IS
  'Operator intent (active/suspended/retired). NOT observed health, which is derived from bind state.';
COMMENT ON COLUMN smsc_definitions.carrier_id IS
  'Owning carrier, or NULL when unassigned. Never inferred: an SMSC filed under the wrong network silently corrupts every per-carrier figure.';

-- ==========================================================================
-- Row-level security, matching the pattern used by every tenant table here.
-- ==========================================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE carriers ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'carriers' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON carriers USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE carriers FORCE ROW LEVEL SECURITY';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON carriers TO jkannel_app;

COMMIT;
