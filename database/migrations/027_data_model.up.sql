-- 027_data_model
-- Data-model completeness (SYSTEM_DATA_MODEL specification). Everything here is
-- ADDITIVE and backward-compatible: no existing table is recreated or dropped,
-- no existing column is removed, and existing queries keep working unchanged.
--
-- Four concerns are addressed:
--
--   1. Historical archive / retention. The high-volume log tables
--      (audit_log, notification_deliveries, gateway_request_log) get cold-storage
--      *_archive tables plus a per-tenant retention state table. A scheduled job
--      (backend DataModelRetentionService) copies rows older than a retention
--      window into the archive and — for the mutable logs — prunes them from the
--      source. audit_log is INTENTIONALLY copy-only: it is append-only (an
--      immutability trigger from migration 001 rejects UPDATE/DELETE) AND already
--      RANGE-partitioned by created_at, so genuine pruning of audit_log is done by
--      dropping old partitions at the DB/ops layer (see the note at the bottom of
--      this file), never by row DELETE from the app.
--
--   2. Soft-delete convention. deleted_at timestamptz (nullable) is added to the
--      mutable core domain tables. NULL = live; non-NULL = soft-deleted. Read
--      paths filter `deleted_at IS NULL`. This complements — does not replace —
--      the existing status-based archiving (e.g. customers.status='archived').
--
--   3. Optimistic locking. version integer NOT NULL DEFAULT 0 is added to the
--      same mutable core tables. The update pattern is
--      `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`;
--      zero rows updated => a concurrent modification => HTTP 409 (see
--      backend optimistic-lock.ts helper).
--
--   4. Audit tamper-evidence. audit_log gets a per-row hash chain: prev_hash +
--      row_hash where row_hash = sha256(prev_hash || canonical(row)), chained
--      per tenant. A BEFORE INSERT trigger signs every row (so ALL insert paths
--      are covered without touching application code), and
--      data_model_verify_audit_chain() walks the chain and reports the first
--      break. Signing and verification share ONE canonical hash function, so they
--      cannot drift.
--
-- Tenant isolation for the new tenant-scoped tables matches migrations
-- 011/012/016/018/019/020/021/025/026: ENABLE + tenant_isolation policy on
-- current_setting('app.tenant_id') + FORCE ROW LEVEL SECURITY + GRANT to
-- jkannel_app.
BEGIN;

-- ==========================================================================
-- 1. Additive columns on mutable core tables: soft-delete + optimistic lock
-- ==========================================================================
-- Idempotent (ADD COLUMN IF NOT EXISTS) so re-runs and hand-migrated databases
-- are safe. version defaults to 0 for every existing row.
ALTER TABLE smsc_definitions
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE routing_rules
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

-- Partial indexes so "live rows" scans stay cheap once soft-deletes accumulate.
CREATE INDEX IF NOT EXISTS smsc_definitions_live_idx
  ON smsc_definitions (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS routing_rules_live_idx
  ON routing_rules (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customers_live_idx
  ON customers (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS alert_rules_live_idx
  ON alert_rules (tenant_id, name) WHERE deleted_at IS NULL;

-- ==========================================================================
-- 2. audit_log tamper-evidence columns (hash chain)
-- ==========================================================================
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS row_hash text,
  ADD COLUMN IF NOT EXISTS prev_hash text;

-- Chain-walk support index (only signed rows participate in the chain).
CREATE INDEX IF NOT EXISTS audit_log_chain_idx
  ON audit_log (tenant_id, created_at, id) WHERE row_hash IS NOT NULL;

-- Canonical, deterministic hash of one audit row given the previous row's hash.
-- Fields are joined with the ASCII record-separator (chr(30)) so no field value
-- can forge a boundary. sha256() is a core PostgreSQL function (11+); no
-- extension is required. This single function is the ONLY definition of the
-- canonical form: both the signing trigger and the verifier call it, so they
-- can never diverge.
CREATE OR REPLACE FUNCTION data_model_audit_row_hash(
  p_prev        text,
  p_tenant      bigint,
  p_actor       text,
  p_action      text,
  p_entity_type text,
  p_entity_id   text,
  p_old         jsonb,
  p_new         jsonb,
  p_reason      text,
  p_created     timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    sha256(convert_to(
      coalesce(p_prev, '')        || chr(30) ||
      p_tenant::text              || chr(30) ||
      coalesce(p_actor, '')       || chr(30) ||
      coalesce(p_action, '')      || chr(30) ||
      coalesce(p_entity_type, '') || chr(30) ||
      coalesce(p_entity_id, '')   || chr(30) ||
      coalesce(p_old::text, '')   || chr(30) ||
      coalesce(p_new::text, '')   || chr(30) ||
      coalesce(p_reason, '')      || chr(30) ||
      to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'UTF8'
    )),
    'hex'
  );
$$;

-- BEFORE INSERT signer. A per-tenant transaction-level advisory lock serializes
-- signing so concurrent inserts chain deterministically. Column defaults
-- (created_at = now()) are already applied to NEW when a BEFORE row trigger
-- runs, so the signed timestamp matches the stored row.
CREATE OR REPLACE FUNCTION audit_log_sign() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(1635084, NEW.tenant_id::int);
  SELECT row_hash INTO v_prev
    FROM audit_log
   WHERE tenant_id = NEW.tenant_id AND row_hash IS NOT NULL
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := data_model_audit_row_hash(
    v_prev, NEW.tenant_id, NEW.actor_id, NEW.action, NEW.entity_type,
    NEW.entity_id, NEW.old_value, NEW.new_value, NEW.reason, NEW.created_at);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_sign_trg ON audit_log;
CREATE TRIGGER audit_log_sign_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_sign();

-- Chain verifier: walks a tenant's signed rows in (created_at, id) order and
-- returns the first row whose prev_hash or recomputed row_hash does not match.
-- Runs under the caller's RLS context; call it inside the tenant transaction so
-- app.tenant_id is set. ok=true and first_broken_id=NULL means the chain is intact.
CREATE OR REPLACE FUNCTION data_model_verify_audit_chain(p_tenant bigint)
RETURNS TABLE(ok boolean, checked_rows bigint, first_broken_id bigint,
              first_broken_uuid uuid, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r             record;
  expected_prev text := NULL;
  expected_hash text;
  n             bigint := 0;
BEGIN
  FOR r IN
    SELECT id, uuid, tenant_id, actor_id, action, entity_type, entity_id,
           old_value, new_value, reason, created_at, prev_hash, row_hash
      FROM audit_log
     WHERE tenant_id = p_tenant AND row_hash IS NOT NULL
     ORDER BY created_at ASC, id ASC
  LOOP
    n := n + 1;
    IF expected_prev IS DISTINCT FROM r.prev_hash THEN
      RETURN QUERY SELECT false, n, r.id, r.uuid, 'prev_hash mismatch'::text;
      RETURN;
    END IF;
    expected_hash := data_model_audit_row_hash(
      r.prev_hash, r.tenant_id, r.actor_id, r.action, r.entity_type,
      r.entity_id, r.old_value, r.new_value, r.reason, r.created_at);
    IF expected_hash IS DISTINCT FROM r.row_hash THEN
      RETURN QUERY SELECT false, n, r.id, r.uuid, 'row_hash mismatch'::text;
      RETURN;
    END IF;
    expected_prev := r.row_hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::uuid, NULL::text;
END $$;

-- ==========================================================================
-- 3. Cold-storage archive tables for the high-volume logs
-- ==========================================================================
-- Archive rows are keyed so re-copies are idempotent (ON CONFLICT DO NOTHING).
-- No FKs back to volatile parents (api_keys/alert_instances/...) so archived
-- history survives source deletions.

CREATE TABLE audit_log_archive (
  id            bigint NOT NULL,
  uuid          uuid PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id),
  actor_id      text NOT NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  correlation_id uuid,
  source_ip     inet,
  row_hash      text,
  prev_hash     text,
  created_at    timestamptz NOT NULL,
  archived_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_archive_tenant_idx
  ON audit_log_archive (tenant_id, created_at DESC);

CREATE TABLE notification_deliveries_archive (
  id            uuid PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id),
  alert_id      uuid,
  channel_id    uuid NOT NULL,
  channel_type  text NOT NULL,
  status        text NOT NULL,
  target        text,
  response      jsonb NOT NULL DEFAULT '{}',
  attempted_by  text NOT NULL,
  category      text NOT NULL DEFAULT 'alert',
  created_at    timestamptz NOT NULL,
  delivered_at  timestamptz,
  archived_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_archive_tenant_idx
  ON notification_deliveries_archive (tenant_id, created_at DESC);

CREATE TABLE gateway_request_log_archive (
  id            uuid PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id),
  api_key_id    uuid,
  key_prefix    text,
  route         text NOT NULL,
  method        text NOT NULL,
  status_code   integer NOT NULL,
  outcome       text NOT NULL,
  ip_address    text,
  correlation_id text,
  created_at    timestamptz NOT NULL,
  archived_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gateway_request_log_archive_tenant_idx
  ON gateway_request_log_archive (tenant_id, created_at DESC);

-- Per-tenant, per-source retention bookkeeping. watermark is the high-water
-- created_at already archived (used by the copy-only audit_log policy so it
-- never re-scans old rows); the counters are observability.
CREATE TABLE data_model_retention_state (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      bigint NOT NULL REFERENCES tenants(id),
  source_table   text NOT NULL,
  watermark      timestamptz,
  last_run_at    timestamptz,
  last_archived  integer NOT NULL DEFAULT 0,
  last_deleted   integer NOT NULL DEFAULT 0,
  total_archived bigint NOT NULL DEFAULT 0,
  total_deleted  bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_table)
);

-- ==========================================================================
-- 4. Demonstration table for the soft-delete + optimistic-lock conventions
-- ==========================================================================
-- A minimal owned domain table used by DataModelRecordsService to exercise the
-- conventions end-to-end (live-only read path + versioned update -> 409) without
-- editing another module's files. Carries both new columns.
CREATE TABLE data_model_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   bigint NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     integer NOT NULL DEFAULT 0,
  deleted_at  timestamptz,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Key is unique among LIVE rows only, so a soft-deleted key can be reused.
CREATE UNIQUE INDEX data_model_records_key_uidx
  ON data_model_records (tenant_id, key) WHERE deleted_at IS NULL;

-- ==========================================================================
-- 5. Row level security (ENABLE + tenant_isolation + FORCE) and GRANTs
-- ==========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_log_archive', 'notification_deliveries_archive',
    'gateway_request_log_archive', 'data_model_retention_state',
    'data_model_records'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  audit_log_archive, notification_deliveries_archive,
  gateway_request_log_archive, data_model_retention_state, data_model_records
  TO jkannel_app;

COMMIT;

-- ==========================================================================
-- NOTE — adopting native declarative partitioning for retention going forward
-- ==========================================================================
-- audit_log is already declaratively partitioned BY RANGE (created_at) with a
-- single default partition (migration 001). The recommended, non-destructive
-- path to true time-based retention (run by a DBA / ops migration, NOT the app,
-- since it is DDL and the jkannel_app role is intentionally not a table owner):
--
--   1. Create monthly partitions ahead of time, e.g.
--        CREATE TABLE audit_log_y2026m07 PARTITION OF audit_log
--          FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
--      New rows route into the month partition; audit_log_default catches gaps.
--   2. To retain N months: DETACH the oldest partition, copy it into
--      audit_log_archive (or an external cold store) via the retention job, then
--        DROP TABLE audit_log_y2026m01;
--      DROP TABLE of a partition is DDL — it does NOT fire the row-level
--      immutability trigger, so it is the only sanctioned way to reclaim
--      audit_log space while preserving append-only guarantees for live rows.
--
-- The same pattern applies to notification_deliveries / gateway_request_log if
-- their volume warrants partitioning; until then the app-level archive+prune
-- (DataModelRetentionService) handles them, and audit_log is archived copy-only.
