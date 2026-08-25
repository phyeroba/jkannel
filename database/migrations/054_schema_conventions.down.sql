-- Reverses 054_schema_conventions.
--
-- WHAT REVERTING COSTS
-- --------------------------------------------------------------------------
-- Dropping `deleted_at` does not restore deleted rows — it DESTROYS them. Any
-- row soft-deleted while this migration was applied is carrying its tombstone
-- in that column, and removing the column removes the only record that the row
-- is gone. Worse, those rows then reappear as live, because "live" was defined
-- as `deleted_at IS NULL` and every row now satisfies it.
--
-- So this is not a safe rollback in the way most of them are. Before running
-- it, decide what should happen to soft-deleted rows: the honest options are to
-- hard-delete them first (they were deleted, after all) or to export them.
-- Reverting blind resurrects records an operator removed on purpose, which on
-- `users` or `messaging_blocklist` is a security event rather than an
-- inconvenience.
--
-- Dropping `version` is harmless by comparison: nothing but an optimistic-lock
-- check reads it, and losing the check reverts to last-write-wins, which is the
-- pre-054 behaviour.
--
-- The rows soft-deleted so far, if you want to look before dropping:
--
--   SELECT 'users' AS t, count(*) FROM users WHERE deleted_at IS NOT NULL
--   UNION ALL SELECT 'roles', count(*) FROM roles WHERE deleted_at IS NOT NULL;
--   -- ... and so on for the tables listed below.

DO $$
DECLARE
  t text;
  soft_delete_tables text[] := ARRAY[
    'api_gateway_clients', 'api_keys', 'backup_schedules', 'config_templates',
    'customer_quotas', 'customer_routes', 'delivery_retry_policies',
    'escalation_policies', 'maintenance_windows', 'messaging_blocklist',
    'messaging_content_rules', 'mo_routing_rules', 'mo_rule_destinations',
    'notification_channels', 'plugin_registrations', 'report_definitions',
    'roles', 'sender_ids', 'system_settings', 'tenants', 'users'
  ];
  version_tables text[] := ARRAY[
    'api_gateway_clients', 'api_keys', 'carriers', 'config_templates',
    'customer_quotas', 'customer_routes', 'delivery_retry_policies',
    'escalation_policies', 'maintenance_windows', 'messaging_blocklist',
    'messaging_content_rules', 'mo_routing_rules', 'mo_rule_destinations',
    'notification_channels', 'report_definitions', 'roles', 'sender_ids',
    'system_settings', 'tenants', 'users'
  ];
BEGIN
  FOREACH t IN ARRAY version_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_version', t);
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS version', t);
  END LOOP;

  FOREACH t IN ARRAY soft_delete_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP INDEX IF EXISTS public.%I', 'idx_' || t || '_live');
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS deleted_at', t);
  END LOOP;
END $$;

-- Left in place deliberately: `data_model_records` and the five other tables
-- that carried `version` before 054 still use it, so the function has callers.
-- DROP FUNCTION IF EXISTS bump_row_version();
