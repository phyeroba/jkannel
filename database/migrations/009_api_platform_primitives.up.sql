BEGIN;

CREATE TABLE api_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  response_status integer,
  response_body jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, method, route),
  UNIQUE (tenant_id, id),
  CHECK (status IN ('processing','completed','failed')),
  CHECK (char_length(key) BETWEEN 8 AND 128)
);

CREATE TABLE api_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '{}',
  result jsonb NOT NULL DEFAULT '{}',
  error text,
  requested_by text NOT NULL,
  idempotency_key text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, type, idempotency_key),
  CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CHECK (progress BETWEEN 0 AND 100),
  CHECK (type ~ '^[a-z][a-z0-9_.-]+$')
);

CREATE INDEX api_idempotency_records_lookup_idx ON api_idempotency_records(tenant_id, key, method, route);
CREATE INDEX api_jobs_status_idx ON api_jobs(tenant_id, status, created_at DESC);
CREATE INDEX api_jobs_type_idx ON api_jobs(tenant_id, type, created_at DESC);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['api_idempotency_records','api_jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint)',t);
END LOOP; END $$;

COMMIT;
