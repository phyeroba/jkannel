-- 036_rbac (down)
--
-- Removes the eight seeded specification roles and the columns added by the up
-- migration. Deliberately does NOT delete any `permissions` row: the
-- development-operator seeder and the live `administrator` role's grants both
-- reference them, and DELETEing a permission cascades into role_permissions,
-- which would silently strip the live operator account. The catalogue rows are
-- harmless to leave behind; only `permissions.category` is dropped.
--
-- The lowercase `administrator` role is never deleted here for the same reason.
BEGIN;

-- FORCE RLS applies to the owner too; unbracket the deletes exactly as the up
-- migration does for its inserts.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

DELETE FROM role_permissions
 WHERE role_id IN (
   SELECT id FROM roles
    WHERE is_system
      AND name IN (
        'Super Administrator', 'Administrator', 'Network Engineer', 'Operations Engineer',
        'Support Engineer', 'Read Only', 'Auditor', 'API Client'
      )
 );
DELETE FROM user_roles
 WHERE role_id IN (
   SELECT id FROM roles
    WHERE is_system
      AND name IN (
        'Super Administrator', 'Administrator', 'Network Engineer', 'Operations Engineer',
        'Support Engineer', 'Read Only', 'Auditor', 'API Client'
      )
 );
DELETE FROM roles
 WHERE is_system
   AND name IN (
     'Super Administrator', 'Administrator', 'Network Engineer', 'Operations Engineer',
     'Support Engineer', 'Read Only', 'Auditor', 'API Client'
   );

ALTER TABLE roles DROP COLUMN IF EXISTS is_system;
ALTER TABLE roles DROP COLUMN IF EXISTS updated_at;
ALTER TABLE permissions DROP COLUMN IF EXISTS category;

DROP INDEX IF EXISTS role_permissions_permission_idx;
DROP INDEX IF EXISTS user_roles_role_idx;

ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

COMMIT;
