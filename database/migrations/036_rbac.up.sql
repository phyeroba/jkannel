-- 036_rbac
--
-- Role-Based Access Control: catalogue + default role set.
--
-- Migration 003 created `roles`, `permissions`, `user_roles` and
-- `role_permissions` but never populated them. The only thing that ever wrote a
-- role was backend/src/security/create-development-operator.ts, a development
-- script that refuses to run in production and creates exactly one role
-- (`administrator`) with 21 permission codes. A fresh install therefore had one
-- all-permissions account and no way to make a restricted one, and the eight
-- default roles named in USER_MANAGEMENT_ENGINEERING_SPECIFICATION.md §8 did not
-- exist at all.
--
-- This migration:
--   1. Adds `roles.is_system` (undeletable catalogue roles), `roles.updated_at`
--      and `permissions.category` (the console groups the catalogue by it).
--   2. Seeds the FULL permission catalogue. Every code here is a string that
--      `@RequirePermissions('…')` actually enforces somewhere in backend/src
--      (verified by rbac-catalogue.spec.ts, which re-greps the source tree), plus
--      `dashboard.view`, which the console uses to gate navigation. The API-key
--      vocabulary in api-gateway/gateway-scopes.ts (`sms.send`, `sms.read`,
--      `routing.read`, `audit.read`) is deliberately NOT here: it is a separate
--      machine-credential vocabulary and must not be grantable to a human role.
--   3. Seeds the eight specification roles per tenant, marked `is_system`.
--   4. Marks the pre-existing lowercase `administrator` role as a system role so
--      it cannot be deleted out from under the live operator account.
--
-- SAFETY — the live operator account.
-- A production VPS is running with an `operator` user bound to the lowercase
-- `administrator` role holding 21 permission codes. Nothing below deletes a
-- role, deletes a permission, or deletes a role_permissions row. The only write
-- that touches `administrator` is `is_system = true`, which removes a way to
-- destroy it and grants nothing. `INSERT … ON CONFLICT DO NOTHING/DO UPDATE`
-- everywhere makes re-application a no-op, so the migration is idempotent.
--
-- RLS — `roles` and `role_permissions` already carry ENABLE + tenant_isolation
-- from migration 003, and migration-runner.ts's enforceRowLevelSecurity() has
-- since applied FORCE ROW LEVEL SECURITY to both. FORCE applies to the table
-- OWNER too, which is the role this migration runs as, so the seed below would
-- be silently filtered to zero rows (app.tenant_id is unset). The seed is
-- therefore bracketed by NO FORCE / FORCE inside the same transaction; the
-- tables are never unforced outside it.
BEGIN;

-- 1. Schema ------------------------------------------------------------------

ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'General';

CREATE INDEX IF NOT EXISTS role_permissions_permission_idx
  ON role_permissions (permission_id);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);

-- Seeding runs as the table owner; FORCE RLS would filter it to nothing.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

-- 2. Permission catalogue -----------------------------------------------------
-- `permissions` is global (no tenant_id, no RLS): the vocabulary is a property
-- of the software, not of a tenant. Only the grants in role_permissions are
-- tenant-scoped.

INSERT INTO permissions (code, description, category) VALUES
  ('dashboard.view',       'View the operations dashboard.',                                   'Dashboard'),
  ('messages.view',        'View message history, traces and delivery status.',                'Messaging'),
  ('messages.send',        'Submit messages, and requeue, reroute or resend spooled traffic.', 'Messaging'),
  ('messages.export',      'Export message history to CSV or PDF.',                            'Messaging'),
  ('smsc.view',            'View SMSC connections and their bind status.',                     'SMSC'),
  ('smsc.manage',          'Create, edit, archive and start/stop SMSC connections.',           'SMSC'),
  ('routes.view',          'View routing rules, versions and route simulations.',              'Routing'),
  ('routes.manage',        'Create, edit and delete routing rules.',                           'Routing'),
  ('configuration.view',   'View generated engine configuration, versions and drift.',         'Configuration'),
  ('configuration.manage', 'Generate, edit, validate and template engine configuration.',      'Configuration'),
  ('configuration.deploy', 'Deploy engine configuration and roll a deployment back.',          'Configuration'),
  ('monitoring.view',      'View monitoring dashboards, metrics and engine health.',           'Monitoring'),
  ('alerts.view',          'View alert rules, alert instances and notification channels.',     'Alerts'),
  ('alerts.acknowledge',   'Acknowledge alerts and trigger re-notification.',                  'Alerts'),
  ('reports.view',         'View, run and export reports and analytics.',                      'Reporting'),
  ('users.view',           'View users, roles, permissions and invitations.',                  'Identity'),
  ('users.manage',         'Create, edit and archive users, roles and role permissions.',      'Identity'),
  ('users.invite',         'Invite new users.',                                                'Identity'),
  ('users.sessions',       'View and revoke authentication sessions.',                         'Identity'),
  ('system.view',          'View system settings, the audit log and platform state.',          'System'),
  ('system.manage',        'Change system settings and platform configuration.',               'System')
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description,
      category    = EXCLUDED.category;

-- 3. Default roles, per tenant ------------------------------------------------
-- USER_MANAGEMENT_ENGINEERING_SPECIFICATION.md §8 names eight default roles and
-- says "Roles shall be configurable"; it does not enumerate their permission
-- sets, so the sets below are a least-privilege reading of §3 (user types) and
-- of what each job actually needs from the shipped route table. They are
-- editable through PATCH /users/roles/:id.

INSERT INTO roles (tenant_id, name, description, is_system)
SELECT t.id, r.name, r.description, true
  FROM tenants t
  CROSS JOIN (VALUES
    ('Super Administrator', 'Unrestricted access to every console capability, including platform settings.'),
    ('Administrator',       'Full operational and identity administration; cannot change platform system settings.'),
    ('Network Engineer',    'Owns SMSC connectivity, routing and engine configuration, including deployment.'),
    ('Operations Engineer', 'Runs day-to-day traffic: sends and inspects messages, watches monitoring, acknowledges alerts.'),
    ('Support Engineer',    'Customer-facing triage: read and export message history, watch monitoring, acknowledge alerts.'),
    ('Read Only',           'Read-only view of operational data. No mutations, no identity data, no audit log.'),
    ('Auditor',             'Read-only oversight: audit log, system settings, user directory, reports and exports.'),
    ('API Client',          'Minimal console identity for a machine account. Real API access is granted by api_keys scopes, not by this role.')
  ) AS r(name, description)
ON CONFLICT (tenant_id, name) DO UPDATE
  SET description = EXCLUDED.description,
      is_system   = true,
      updated_at  = now();

-- The role the live operator account is bound to. Marked system so it cannot be
-- deleted; its permission grants are deliberately left exactly as they are.
UPDATE roles SET is_system = true WHERE name = 'administrator' AND NOT is_system;

-- 4. Role grants ---------------------------------------------------------------
-- Additive only (ON CONFLICT DO NOTHING). The join is on the seeded role names,
-- so the lowercase `administrator` role matches nothing here and is untouched.

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r
  JOIN (VALUES
    -- Super Administrator: the whole catalogue.
    ('Super Administrator', 'dashboard.view'),
    ('Super Administrator', 'messages.view'),
    ('Super Administrator', 'messages.send'),
    ('Super Administrator', 'messages.export'),
    ('Super Administrator', 'smsc.view'),
    ('Super Administrator', 'smsc.manage'),
    ('Super Administrator', 'routes.view'),
    ('Super Administrator', 'routes.manage'),
    ('Super Administrator', 'configuration.view'),
    ('Super Administrator', 'configuration.manage'),
    ('Super Administrator', 'configuration.deploy'),
    ('Super Administrator', 'monitoring.view'),
    ('Super Administrator', 'alerts.view'),
    ('Super Administrator', 'alerts.acknowledge'),
    ('Super Administrator', 'reports.view'),
    ('Super Administrator', 'users.view'),
    ('Super Administrator', 'users.manage'),
    ('Super Administrator', 'users.invite'),
    ('Super Administrator', 'users.sessions'),
    ('Super Administrator', 'system.view'),
    ('Super Administrator', 'system.manage'),
    -- Administrator: everything except changing platform system settings.
    ('Administrator', 'dashboard.view'),
    ('Administrator', 'messages.view'),
    ('Administrator', 'messages.send'),
    ('Administrator', 'messages.export'),
    ('Administrator', 'smsc.view'),
    ('Administrator', 'smsc.manage'),
    ('Administrator', 'routes.view'),
    ('Administrator', 'routes.manage'),
    ('Administrator', 'configuration.view'),
    ('Administrator', 'configuration.manage'),
    ('Administrator', 'configuration.deploy'),
    ('Administrator', 'monitoring.view'),
    ('Administrator', 'alerts.view'),
    ('Administrator', 'alerts.acknowledge'),
    ('Administrator', 'reports.view'),
    ('Administrator', 'users.view'),
    ('Administrator', 'users.manage'),
    ('Administrator', 'users.invite'),
    ('Administrator', 'users.sessions'),
    ('Administrator', 'system.view'),
    -- Network Engineer: connectivity, routing, configuration, deployment.
    ('Network Engineer', 'dashboard.view'),
    ('Network Engineer', 'messages.view'),
    ('Network Engineer', 'smsc.view'),
    ('Network Engineer', 'smsc.manage'),
    ('Network Engineer', 'routes.view'),
    ('Network Engineer', 'routes.manage'),
    ('Network Engineer', 'configuration.view'),
    ('Network Engineer', 'configuration.manage'),
    ('Network Engineer', 'configuration.deploy'),
    ('Network Engineer', 'monitoring.view'),
    ('Network Engineer', 'alerts.view'),
    ('Network Engineer', 'alerts.acknowledge'),
    ('Network Engineer', 'reports.view'),
    -- Operations Engineer: runs traffic; reads, never reconfigures.
    ('Operations Engineer', 'dashboard.view'),
    ('Operations Engineer', 'messages.view'),
    ('Operations Engineer', 'messages.send'),
    ('Operations Engineer', 'messages.export'),
    ('Operations Engineer', 'smsc.view'),
    ('Operations Engineer', 'routes.view'),
    ('Operations Engineer', 'configuration.view'),
    ('Operations Engineer', 'monitoring.view'),
    ('Operations Engineer', 'alerts.view'),
    ('Operations Engineer', 'alerts.acknowledge'),
    ('Operations Engineer', 'reports.view'),
    -- Support Engineer: triage. Reads and exports traffic; cannot send.
    ('Support Engineer', 'dashboard.view'),
    ('Support Engineer', 'messages.view'),
    ('Support Engineer', 'messages.export'),
    ('Support Engineer', 'smsc.view'),
    ('Support Engineer', 'routes.view'),
    ('Support Engineer', 'monitoring.view'),
    ('Support Engineer', 'alerts.view'),
    ('Support Engineer', 'alerts.acknowledge'),
    ('Support Engineer', 'reports.view'),
    -- Read Only: every operational read. No system.view (that exposes the audit
    -- log and system settings) and no identity data.
    ('Read Only', 'dashboard.view'),
    ('Read Only', 'messages.view'),
    ('Read Only', 'smsc.view'),
    ('Read Only', 'routes.view'),
    ('Read Only', 'configuration.view'),
    ('Read Only', 'monitoring.view'),
    ('Read Only', 'alerts.view'),
    ('Read Only', 'reports.view'),
    -- Auditor: oversight. system.view carries the audit log; users.view carries
    -- the directory. Deliberately no users.sessions -- that code also authorises
    -- session revocation, which is a mutation an auditor must not hold.
    ('Auditor', 'dashboard.view'),
    ('Auditor', 'messages.view'),
    ('Auditor', 'messages.export'),
    ('Auditor', 'smsc.view'),
    ('Auditor', 'routes.view'),
    ('Auditor', 'configuration.view'),
    ('Auditor', 'monitoring.view'),
    ('Auditor', 'alerts.view'),
    ('Auditor', 'reports.view'),
    ('Auditor', 'users.view'),
    ('Auditor', 'system.view'),
    -- API Client: the console footprint of a machine account, nothing more.
    ('API Client', 'messages.view'),
    ('API Client', 'messages.send')
  ) AS g(role_name, code) ON g.role_name = r.name
  JOIN permissions p ON p.code = g.code
 WHERE r.is_system
ON CONFLICT DO NOTHING;

-- 5. Row level security --------------------------------------------------------
-- Re-assert the full contract idempotently: ENABLE + tenant_isolation + FORCE +
-- GRANT on every tenant-scoped table this migration writes to.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'role_permissions', 'user_roles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
        t
      );
    END IF;
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON roles, role_permissions, user_roles TO jkannel_app;
    -- The catalogue itself is global and read-only to the application: roles may
    -- be granted permissions, never invent them.
    GRANT SELECT ON permissions TO jkannel_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_auth') THEN
    GRANT SELECT ON roles, role_permissions, user_roles, permissions TO jkannel_auth;
  END IF;
END $$;

COMMIT;
