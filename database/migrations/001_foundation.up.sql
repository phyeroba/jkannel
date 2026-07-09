BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  is_enabled boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE configuration_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  scope text NOT NULL,
  version_number bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  content jsonb NOT NULL,
  checksum text NOT NULL,
  change_reason text NOT NULL,
  previous_version_id bigint REFERENCES configuration_versions(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_status CHECK (status IN ('draft','validated','approved','deployed','superseded','rolled_back','failed')),
  CONSTRAINT configuration_version_positive CHECK (version_number > 0),
  CONSTRAINT configuration_version_unique UNIQUE (tenant_id, scope, version_number),
  CONSTRAINT configuration_checksum_unique UNIQUE (tenant_id, scope, checksum)
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY,
  uuid uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  correlation_id uuid,
  source_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT audit_log_uuid_unique UNIQUE (uuid, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC);
CREATE INDEX configuration_versions_tenant_status_idx ON configuration_versions (tenant_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

COMMIT;
