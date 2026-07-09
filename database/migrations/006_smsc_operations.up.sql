BEGIN;

ALTER TABLE smsc_definitions
  ADD COLUMN engine_id text,
  ADD COLUMN description text,
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'draft',
  ADD COLUMN priority integer NOT NULL DEFAULT 100,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN last_error text,
  ADD CONSTRAINT smsc_engine_id_format CHECK (engine_id IS NULL OR engine_id ~ '^[a-z0-9][a-z0-9._-]*$'),
  ADD CONSTRAINT smsc_lifecycle_state CHECK (lifecycle_state IN ('draft','validated','approved','deployed','active','degraded','disabled','archived')),
  ADD CONSTRAINT smsc_priority_nonnegative CHECK (priority >= 0);

UPDATE smsc_definitions SET engine_id='smsc-' || replace(id::text,'-','') WHERE engine_id IS NULL;
ALTER TABLE smsc_definitions ALTER COLUMN engine_id SET NOT NULL;
CREATE UNIQUE INDEX smsc_definitions_tenant_engine_id_idx ON smsc_definitions(tenant_id,engine_id);

CREATE TABLE smsc_health (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id), smsc_id uuid NOT NULL,
  state text NOT NULL, latency_ms integer, detail text, observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,smsc_id) REFERENCES smsc_definitions(tenant_id,id),
  CHECK (state IN ('unknown','reachable','unreachable','active','degraded','disabled'))
);
CREATE INDEX smsc_health_latest_idx ON smsc_health(tenant_id,smsc_id,observed_at DESC);

CREATE TABLE smsc_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id), smsc_id uuid NOT NULL,
  operation text NOT NULL, status text NOT NULL, idempotency_key text NOT NULL,
  requested_by text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY (tenant_id,smsc_id) REFERENCES smsc_definitions(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key), CHECK(operation IN ('validate','deploy','enable','disable','reconnect','test')),
  CHECK(status IN ('pending','succeeded','failed'))
);

ALTER TABLE smsc_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE smsc_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON smsc_health USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint);
CREATE POLICY tenant_isolation ON smsc_deployments USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint);

COMMIT;
