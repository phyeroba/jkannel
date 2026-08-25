-- 054_schema_conventions
-- Soft delete and optimistic locking on the tables an operator edits.
--
-- WHAT WAS MISSING
-- --------------------------------------------------------------------------
-- The specification calls both conventions mandatory. The helpers were built
-- (`data-model/soft-delete.ts`, `data-model/optimistic-lock.ts`) and applied to
-- six tables, and then the next fifty tables were added without them. Measured
-- on 2026-08-25: `deleted_at` on 6 of 99 tables, `version` on 9.
--
-- WHY NOT ALL 99
-- --------------------------------------------------------------------------
-- Because that would be wrong, not merely expensive. Soft-deleting a metric
-- sample is meaningless — nobody deletes one, and it is an observation rather
-- than a record somebody owns. Optimistic locking an append-only event log is
-- meaningless for the same reason: there is no second writer to lose to.
--
-- The target is the tables an OPERATOR EDITS: configuration and reference
-- records with a lifecycle, where a delete can orphan a reference and two
-- people can hold the same row open. `scripts/schema-conventions.mjs` carries
-- the classification with a stated reason for every exclusion, and fails if a
-- table in the target set is missing either column — including a table added
-- after this migration, which is the failure mode that produced the gap.
--
-- WHY `version` GETS A TRIGGER
-- --------------------------------------------------------------------------
-- A `version` column that callers must remember to increment is a column that
-- lies the first time somebody forgets, and a lying version column is worse
-- than none: a caller compares against it and believes it holds a lock it does
-- not hold. The trigger makes the number true regardless of the write path.
--
-- Enforcement is then the caller's half — `WHERE version = $expected` plus
-- `assertVersionMatched` — and it is opt-in per endpoint. This migration makes
-- that possible and honest; it does not by itself make any endpoint safe.
--
-- WHY THIS IS SAFE TO APPLY TO LIVE DATA
-- --------------------------------------------------------------------------
-- Both columns are additive with defaults, so existing rows get `deleted_at
-- NULL` (live) and `version = 1`. No read changes behaviour until a caller
-- filters on the column. The partial indexes match the `deleted_at IS NULL`
-- predicate the shared grid reader now applies, so the common listing does not
-- lose its index.

-- The version maintainer. Unconditional on UPDATE, because a conditional one
-- ("only when something changed") makes the number depend on which columns a
-- caller happened to touch, and a lock whose counter sometimes does not move is
-- not a lock. A no-op UPDATE incrementing the version is the safe direction: it
-- costs a spurious conflict, never a silent overwrite.
CREATE OR REPLACE FUNCTION bump_row_version() RETURNS trigger AS $bump$
BEGIN
  NEW.version := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END;
$bump$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  -- Operator-editable tables missing soft delete. Kept as a literal list rather
  -- than a pattern: a pattern would silently pick up a table added later that
  -- nobody classified, and classification is a judgement, not a naming rule.
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
  FOREACH t IN ARRAY soft_delete_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %: table does not exist', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    -- Partial, because every live read carries `deleted_at IS NULL` and a
    -- partial index is both smaller and a better match for that predicate.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (id) WHERE deleted_at IS NULL',
      'idx_' || t || '_live', t
    );
  END LOOP;

  FOREACH t IN ARRAY version_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %: table does not exist', t;
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1', t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_version', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION bump_row_version()',
      'trg_' || t || '_version', t
    );
  END LOOP;
END $$;
