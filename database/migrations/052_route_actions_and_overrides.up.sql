-- 052_route_actions_and_overrides
-- Route rules that can DROP traffic, and that can rewrite a message on the way
-- through (SMS STUDIO Features, pages 4 and 6-7).
--
-- WHAT WAS MISSING
-- --------------------------------------------------------------------------
-- A JKANNEL routing rule could only ever say "send this via that SMSC". The
-- SMS Studio rule set that operators here already work with does three more
-- things, and all three are load-bearing:
--
--   1. DROP. "Ordinal 1 : Unknown is dropping all traffic of unknown networks
--      by Prefix *** from ALL accounts." Without it, traffic to a network with
--      no route falls through to whatever the last rule is, and is submitted to
--      a carrier that will reject it — paid for, and counted as a failure
--      against that carrier's delivery rate.
--
--   2. OVERRIDE FROM. "SenderID overwritten to another one (sometimes a
--      failover)" and "Ordinal 2 Rule is set and ENABLED to act as a failover
--      for MTN traffic ... SenderID overwrites to 7077 for all MTN traffic."
--      This is the mechanism by which a blocked or throttled sender ID is
--      worked around WITHOUT touching every application that submits. Today
--      that change means editing each client.
--
--   3. OVERRIDE TO / OVERRIDE TEXT. Redirecting a recipient or rewriting a body
--      at the routing layer. Rarer, and deliberately the most audited of the
--      three: rewriting what a subscriber receives is not a routing decision
--      an operator should be able to make invisibly.
--
-- WHY ON THE ROUTE AND NOT IN THE ENGINE
-- --------------------------------------------------------------------------
-- Kannel can rewrite a sender per-SMSC with `alt-charset`-adjacent settings and
-- `sender-prefix`, but only per CONNECTION — every message over that bind gets
-- the same treatment. The whole point of the failover case above is that it
-- applies to MTN traffic specifically, evaluated in rule order, and can be
-- turned off again in one click. That is a control-plane decision (ADR-0008),
-- so it lives here and is applied before the message is spooled.
BEGIN;

ALTER TABLE routing_rules
  -- 'route' keeps every existing row behaving exactly as it does today, which
  -- is why it is the default rather than something more explicit.
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'route',
  ADD COLUMN IF NOT EXISTS override_sender text,
  ADD COLUMN IF NOT EXISTS override_recipient text,
  ADD COLUMN IF NOT EXISTS override_text text,
  -- Why this rule drops. Recorded on the decision, so a dropped message can be
  -- explained to a customer rather than merely reported as "not delivered".
  ADD COLUMN IF NOT EXISTS drop_reason text;

-- The SMS Studio wildcard grammar as a route type (`*`, `#`, `$`, `|`).
--
-- `route_type` is a CHECK-constrained enumeration, so adding the type in
-- TypeScript alone would have produced a rule the application happily builds
-- and PostgreSQL then refuses. Caught by proving this migration against a full
-- chain apply rather than by reading the code.
DO $$
BEGIN
  ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS routing_rules_route_type_check;
  ALTER TABLE routing_rules
    ADD CONSTRAINT routing_rules_route_type_check
    CHECK (route_type IN ('static', 'prefix', 'country', 'operator', 'weighted', 'wildcard'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_action_valid'
  ) THEN
    ALTER TABLE routing_rules
      ADD CONSTRAINT routing_rules_action_valid CHECK (action IN ('route', 'drop'));
  END IF;

  -- A dropping rule that also names overrides is incoherent: nothing is sent,
  -- so there is nothing to rewrite. Rejecting it at the schema stops a rule
  -- whose author believed it would do two things from silently doing one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_drop_has_no_overrides'
  ) THEN
    ALTER TABLE routing_rules
      ADD CONSTRAINT routing_rules_drop_has_no_overrides CHECK (
        action <> 'drop'
        OR (override_sender IS NULL AND override_recipient IS NULL AND override_text IS NULL)
      );
  END IF;

  -- A drop must say why. "Traffic vanished" with no explanation is the single
  -- worst failure mode this feature can produce.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_drop_states_reason'
  ) THEN
    ALTER TABLE routing_rules
      ADD CONSTRAINT routing_rules_drop_states_reason CHECK (
        action <> 'drop' OR length(btrim(coalesce(drop_reason, ''))) >= 3
      );
  END IF;

  -- An empty-string override is almost certainly a form that submitted a blank
  -- field, and would blank the sender on every matching message.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_rules_overrides_not_blank'
  ) THEN
    ALTER TABLE routing_rules
      ADD CONSTRAINT routing_rules_overrides_not_blank CHECK (
        (override_sender IS NULL OR length(btrim(override_sender)) > 0)
        AND (override_recipient IS NULL OR length(btrim(override_recipient)) > 0)
        AND (override_text IS NULL OR length(btrim(override_text)) > 0)
      );
  END IF;
END $$;

-- The route decision already recorded on every send now records what the rule
-- CHANGED, so a trace can show the sender the application asked for alongside
-- the one that went out. Without this the override is invisible after the fact
-- and a support question becomes unanswerable.
ALTER TABLE message_route_decisions
  ADD COLUMN IF NOT EXISTS applied_overrides jsonb,
  ADD COLUMN IF NOT EXISTS dropped_by_rule text;

COMMENT ON COLUMN routing_rules.action IS
  'route (submit via target_smsc_id) or drop (refuse, with drop_reason). Default route, so existing rules are unchanged.';
COMMENT ON COLUMN routing_rules.override_sender IS
  'Sender id written onto a matching message before spooling. The failover mechanism for a blocked or throttled sender id (SMS Studio pages 6-7).';
COMMENT ON COLUMN message_route_decisions.applied_overrides IS
  'What the winning rule rewrote, as {field: {from, to}}. Makes an override visible in a trace after the fact.';

CREATE INDEX IF NOT EXISTS routing_rules_action_idx
  ON routing_rules (tenant_id, action)
  WHERE deleted_at IS NULL AND action <> 'route';

COMMIT;
