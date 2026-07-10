-- 018_backup_dr
-- Real backup & disaster-recovery model. Extends the backup_records catalog
-- (migration 016) with artifact/verification/versioning columns and adds
-- backup_schedules and restore_operations. Every table is tenant-scoped with
-- forced row level security, matching the pattern in migrations 011/012/016.
--
-- Honesty note: the pg_dump artifact tracked here is a WHOLE-DATABASE dump; the
-- catalog row is per-tenant (the tenant that requested it). size_bytes/checksum
-- describe the logical dump, artifact_path points at the encrypted file at rest.
BEGIN;

-- Extend the existing backup_records table (idempotent: safe to re-run).
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'manual';
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS artifact_path text;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS platform_version text;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS database_version text;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS restore_of uuid;

CREATE INDEX IF NOT EXISTS backup_records_retention_idx
  ON backup_records (retention_class, started_at);

-- Backup schedules: either a cron expression or a fixed interval in minutes.
CREATE TABLE backup_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  cron text,
  interval_minutes integer CHECK (interval_minutes IS NULL OR interval_minutes > 0),
  kind text NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'schema', 'incremental')),
  retention_class text NOT NULL DEFAULT 'daily'
    CHECK (retention_class IN ('hourly', 'daily', 'weekly', 'monthly', 'yearly', 'manual')),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cron IS NOT NULL OR interval_minutes IS NOT NULL),
  UNIQUE (tenant_id, name)
);
CREATE INDEX backup_schedules_due_idx ON backup_schedules (enabled, next_run_at);

-- Restore operations: an audited log of restore/verify-restore runs. Restores
-- run against an isolated verification database, never the live database.
CREATE TABLE restore_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  backup_id uuid REFERENCES backup_records(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  detail text,
  target text,
  requested_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX restore_operations_tenant_idx ON restore_operations (tenant_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_schedules', 'restore_operations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON backup_schedules, restore_operations TO jkannel_app;

COMMIT;
