-- 028_audit_chain_fix
-- Fixes two defects introduced with the audit hash-chain in migration 027,
-- found during live integration:
--
--   1. audit_log_sign() (the BEFORE INSERT signing trigger) performs an internal
--      SELECT on audit_log to read the previous row's hash. It ran SECURITY
--      INVOKER, so that SELECT executed with the privileges of the inserting
--      role. The pre-authentication login path writes an audit row as the
--      least-privilege jkannel_auth role, which is granted INSERT but NOT SELECT
--      on audit_log — so the trigger's SELECT raised "permission denied for table
--      audit_log" and rolled back the whole login transaction (HTTP 500 on every
--      login). Making the function SECURITY DEFINER lets the signing read run as
--      the table owner regardless of the caller; tenant scoping is preserved by
--      the explicit `WHERE tenant_id = NEW.tenant_id` predicate (it never relied
--      on the caller's RLS), and search_path is pinned so the definer context is
--      safe. Writer roles no longer need SELECT on audit_log — jkannel_auth keeps
--      its narrow INSERT-only grant.
--
--   2. data_model_verify_audit_chain() declared an OUT column `reason` while its
--      FOR-loop SELECT also selected audit_log.reason — an ambiguous reference
--      that aborted the verifier with "column reference \"reason\" is ambiguous".
--      The loop now reads from an aliased table (al) with every column qualified,
--      removing the ambiguity.
--
-- Both are CREATE OR REPLACE of functions defined in 027; no table or data
-- changes. Idempotent and safe to re-run.
BEGIN;

-- 1. Sign as the table owner so the chain-head read does not require the writer
--    role to hold SELECT on audit_log.
CREATE OR REPLACE FUNCTION audit_log_sign() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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

-- 2. Qualify every column against an alias so the OUT parameter `reason` can no
--    longer collide with audit_log.reason.
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
    SELECT al.id, al.uuid, al.tenant_id, al.actor_id, al.action, al.entity_type,
           al.entity_id, al.old_value, al.new_value, al.reason AS row_reason,
           al.created_at, al.prev_hash, al.row_hash
      FROM audit_log al
     WHERE al.tenant_id = p_tenant AND al.row_hash IS NOT NULL
     ORDER BY al.created_at ASC, al.id ASC
  LOOP
    n := n + 1;
    IF expected_prev IS DISTINCT FROM r.prev_hash THEN
      RETURN QUERY SELECT false, n, r.id, r.uuid, 'prev_hash mismatch'::text;
      RETURN;
    END IF;
    expected_hash := data_model_audit_row_hash(
      r.prev_hash, r.tenant_id, r.actor_id, r.action, r.entity_type,
      r.entity_id, r.old_value, r.new_value, r.row_reason, r.created_at);
    IF expected_hash IS DISTINCT FROM r.row_hash THEN
      RETURN QUERY SELECT false, n, r.id, r.uuid, 'row_hash mismatch'::text;
      RETURN;
    END IF;
    expected_prev := r.row_hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::uuid, NULL::text;
END $$;

COMMIT;
