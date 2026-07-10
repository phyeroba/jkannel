-- Revert 028: restore the migration-027 definitions (SECURITY INVOKER signer and
-- the unqualified verifier). Note this reintroduces the known defects; provided
-- only for migration symmetry.
BEGIN;

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

COMMIT;
