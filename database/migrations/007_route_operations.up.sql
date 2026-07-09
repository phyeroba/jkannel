BEGIN;

ALTER TABLE routing_rules
  ADD COLUMN deployment_state text NOT NULL DEFAULT 'draft',
  ADD COLUMN deployed_at timestamptz,
  ADD COLUMN deployed_by text,
  ADD CONSTRAINT routing_rules_deployment_state_check CHECK (deployment_state IN ('draft','validated','deployed','rolled_back','disabled','archived'));

-- Required by the composite foreign key below; the original migration relied
-- on a constraint that only existed in hand-migrated databases.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_tenant_id_id_key'
  ) THEN
    ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END $$;

CREATE TABLE route_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  route_id uuid NOT NULL,
  operation text NOT NULL,
  status text NOT NULL,
  snapshot jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  reason text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (operation IN ('validate','deploy','rollback')),
  CHECK (status IN ('accepted','succeeded','failed')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES routing_rules(tenant_id, id)
);

CREATE INDEX route_deployments_history_idx ON route_deployments(tenant_id, route_id, created_at DESC);

ALTER TABLE route_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON route_deployments
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint);

COMMIT;
