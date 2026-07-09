BEGIN;

ALTER TABLE configuration_versions
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN deployed_by text,
  ADD COLUMN deployed_at timestamptz;

CREATE INDEX configuration_versions_scope_status_idx ON configuration_versions(tenant_id, scope, status, version_number DESC);

COMMIT;
