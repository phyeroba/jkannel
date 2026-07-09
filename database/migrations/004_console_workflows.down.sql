BEGIN;
DROP POLICY IF EXISTS configuration_versions_tenant_isolation ON configuration_versions;
DROP TABLE IF EXISTS user_invitations,system_settings,alert_acknowledgements,alert_instances,alert_rules,routing_rules,smsc_definitions CASCADE;
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_tenant_id_id_unique;
COMMIT;
