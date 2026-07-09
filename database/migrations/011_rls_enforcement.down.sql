-- Rollback of 011_rls_enforcement: relax FORCE back to plain RLS and remove
-- the application role's grants. The role itself is dropped only when nothing
-- else depends on it.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_auth') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM jkannel_auth;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM jkannel_auth;
    REVOKE USAGE ON SCHEMA public FROM jkannel_auth;
    BEGIN
      DROP ROLE jkannel_auth;
    EXCEPTION
      WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'jkannel_auth retained: dependent objects exist';
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM jkannel_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM jkannel_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM jkannel_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM jkannel_app;
    REVOKE USAGE ON SCHEMA public FROM jkannel_app;
    BEGIN
      DROP ROLE jkannel_app;
    EXCEPTION
      WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'jkannel_app retained: dependent objects exist';
    END;
  END IF;
END $$;

COMMIT;
