-- 037_alert_lifecycle
-- Gives alert_instances a real operator lifecycle and makes "nobody was told"
-- a detectable condition rather than a silent one.
--
-- Before this migration an alert could only be acknowledged or resolved by the
-- evaluator: there was no assignment, no suppression, no close/reopen and no
-- comment thread, so an operator could not record who owned an incident or why
-- it was parked. `status` was CHECK (status IN ('open','acknowledged',
-- 'resolved')) and the table carried no assignee or suppression column.
--
-- Everything here is ADDITIVE. alert_instances is never re-created: the status
-- vocabulary is widened with a guarded DO-block (the pattern from migration
-- 025) and the new columns use ADD COLUMN IF NOT EXISTS, so this is safe to
-- re-run and safe on a hand-migrated database.
--
-- Tenant isolation for the new alert_comments table matches migrations
-- 011/019/026: ENABLE + tenant_isolation policy + FORCE ROW LEVEL SECURITY,
-- with GRANTs to the jkannel_app role.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Lifecycle columns on alert_instances
-- ---------------------------------------------------------------------------
ALTER TABLE alert_instances
  -- Owner of the incident. Stored as the user id (uuid text) with the username
  -- kept alongside so a display name survives a user rename/deletion.
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS assigned_to_username text,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  -- Suppression parks an alert without hiding it: it stays visible in the open
  -- alert index and the correlation summary, but escalation skips it until
  -- suppressed_until has passed (at which point the escalation runner returns
  -- it to 'open').
  ADD COLUMN IF NOT EXISTS suppressed_until timestamptz,
  ADD COLUMN IF NOT EXISTS suppressed_reason text,
  ADD COLUMN IF NOT EXISTS suppressed_by text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by text,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0,
  -- Whether anyone was actually told about this alert. 'pending' until an
  -- escalation step runs; 'undeliverable' when a step had no channel it could
  -- reach, so a fresh install cannot look healthy while notifying nobody.
  ADD COLUMN IF NOT EXISTS notification_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS notification_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set when a deduplicated re-observation sharpened this alert (the condition
  -- degraded further, e.g. a bind going connecting -> disconnected).
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_severity text,
  -- Which notification cycle the alert is in. Bumped when the alert is
  -- sharpened or reopened, which lets the escalation chain run again for the
  -- new condition instead of being permanently exhausted by the milder one.
  ADD COLUMN IF NOT EXISTS escalation_cycle integer NOT NULL DEFAULT 0;

-- alert_escalations records which cycle each step belongs to, so step 0 can be
-- delivered again for cycle 1 without colliding with cycle 0's row.
ALTER TABLE alert_escalations
  ADD COLUMN IF NOT EXISTS cycle integer NOT NULL DEFAULT 0;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'alert_escalations'::regclass
       AND contype = 'u'
       -- The pre-037 key ends at step_index; the cycle-aware one ends at cycle.
       AND pg_get_constraintdef(oid) LIKE '%step_index)'
  LOOP
    EXECUTE format('ALTER TABLE alert_escalations DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'alert_escalations'::regclass
       AND conname = 'alert_escalations_step_cycle_key'
  ) THEN
    ALTER TABLE alert_escalations ADD CONSTRAINT alert_escalations_step_cycle_key
      UNIQUE (tenant_id, alert_id, policy_id, step_index, cycle);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Widen the status vocabulary (guarded; the original constraint was created
--    unnamed by migration 004, so drop by definition match, not by name only)
-- ---------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'alert_instances'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%acknowledged%'
  LOOP
    EXECUTE format('ALTER TABLE alert_instances DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE alert_instances ADD CONSTRAINT alert_instances_status_check
    CHECK (status IN ('open', 'acknowledged', 'suppressed', 'resolved', 'closed'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'alert_instances'::regclass
       AND conname = 'alert_instances_notification_state_check'
  ) THEN
    ALTER TABLE alert_instances ADD CONSTRAINT alert_instances_notification_state_check
      CHECK (notification_state IN ('pending', 'notified', 'undeliverable', 'suppressed'));
  END IF;
END $$;

-- Assignment and suppression are both operator work-queue filters.
CREATE INDEX IF NOT EXISTS alert_instances_assigned_idx
  ON alert_instances (tenant_id, assigned_to, opened_at DESC)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_instances_suppressed_idx
  ON alert_instances (tenant_id, suppressed_until)
  WHERE status = 'suppressed';
-- "Open alerts nobody was told about" — the query behind the readiness warning.
CREATE INDEX IF NOT EXISTS alert_instances_notification_state_idx
  ON alert_instances (tenant_id, notification_state)
  WHERE status NOT IN ('resolved', 'closed');

-- ---------------------------------------------------------------------------
-- 3. Comment thread. `kind` separates operator prose from the transition trail
--    the lifecycle endpoints append, so the thread reads as one history.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  alert_id uuid NOT NULL,
  author_id text NOT NULL,
  author_username text,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'transition')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, alert_id) REFERENCES alert_instances (tenant_id, id)
);
CREATE INDEX alert_comments_alert_idx
  ON alert_comments (tenant_id, alert_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON alert_comments TO jkannel_app;

-- ---------------------------------------------------------------------------
-- 4. Re-seed the default notification path.
--
-- Migration 031 seeded a dashboard channel and a default escalation policy for
-- the tenants that existed *then*. A tenant provisioned afterwards got neither,
-- so its alerts escalated to nobody. Re-run the seed here (idempotently) and
-- keep NotificationReadinessService doing the same at boot for tenants created
-- after this migration runs.
-- ---------------------------------------------------------------------------
INSERT INTO notification_channels (tenant_id, name, type, enabled, severities, config, created_by)
SELECT t.id, 'Default dashboard', 'dashboard', true,
       ARRAY['info', 'warning', 'critical']::text[],
       '{"categories": ["alert"]}'::jsonb, 'migration-037'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM notification_channels c
    WHERE c.tenant_id = t.id AND c.type = 'dashboard'
 );

INSERT INTO escalation_policies (tenant_id, name, steps, enabled, created_by)
SELECT t.id, 'Default escalation',
       '[{"afterMinutes": 0, "channelType": "dashboard", "target": "Default dashboard"},
         {"afterMinutes": 5, "channelType": "email", "target": ""},
         {"afterMinutes": 15, "channelType": "webhook", "target": ""}]'::jsonb,
       true, 'migration-037'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM escalation_policies p WHERE p.tenant_id = t.id AND p.enabled
 );

COMMIT;
