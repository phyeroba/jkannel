-- 044_content_filtering_and_mo_routing
--
-- Two additions, both tenant-scoped with forced row level security, matching
-- the pattern in 026/032/042.
--
-- 1. CONTENT FILTERING (messaging_content_rules)
--    The recipient blocklist from migration 032 answers "may I send to this
--    NUMBER". It cannot express "block anything mentioning LOAN", "only this
--    sender ID may use the MTN bind", or "no promotional keywords over that
--    carrier" — which is what an operator actually asks for. This table is the
--    unified rule model behind those questions: what to match on (body / sender
--    / recipient / any), how (substring / exact / prefix / regex), the action
--    (block or allow), optional SMSC and customer scope, an enabled flag, a
--    priority and an optional expiry.
--
--    PRECEDENCE IS DATA, NOT CODE. Rules are evaluated in
--    (priority ASC, created_at ASC, id ASC) order and the FIRST match decides —
--    the firewall/ACL model. That total order is also this table's default sort,
--    so the grid shows rules in the sequence the send path consults them. An
--    `allow` rule is an exemption and must be given a LOWER priority number than
--    the block it exempts. See backend/src/messaging-depth/content-filter.ts for
--    the justification.
--
--    `match_count` / `last_matched_at` are bumped only when a rule BLOCKS, so
--    the send path pays no write on a successful send. `quarantined_at` records
--    a regex rule the platform disabled itself after it blew its execution
--    budget (content-rule-regex.ts) — a hazardous rule is disabled loudly rather
--    than left able to hang the sender.
--
--    message_route_decisions gains content_rule_id / content_rule_name so
--    "which rule stopped this message?" is a query rather than a substring
--    search through the prose in `reason`.
--
-- 2. MO (INBOUND) ROUTING AND FAN-OUT
--    JKANNEL could not deliver one inbound message to several destinations
--    because it did not consume inbound messages at all. SQLBox records them as
--    engine-owned `sent_sms` rows with momt='MO' (sqlbox.conf,
--    `sql-log-table = sent_sms`), and the only sms-service group Kannel is
--    configured with is `keyword = default / text = "No service specified"` —
--    a canned auto-reply that forwards nothing. Nothing in the backend read
--    those rows beyond an operator-facing `?direction=MO` filter on the message
--    log.
--
--    mo_routing_rules match inbound traffic (receiving SMSC, destination short
--    code, sender prefix, body keyword); mo_rule_destinations are the several
--    places one match is delivered to (webhook / email / forwarded SMS);
--    mo_messages is every inbound message observed, INCLUDING the ones that
--    matched nothing; mo_deliveries is one row per destination per message, each
--    with its own status, attempt count and error, driven by one `api_jobs` row
--    each so a failing destination retries and dead-letters without touching the
--    others. mo_ingest_state carries the engine-sweep watermark and the polling
--    switch.
--
-- Idempotent throughout (IF NOT EXISTS / guarded DO blocks) so a partially
-- applied migration can be re-run.
BEGIN;

-- ==========================================================================
-- 1. CONTENT FILTERING
-- ==========================================================================
CREATE TABLE IF NOT EXISTS messaging_content_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text,
  -- What the pattern is compared against. 'any' tests body, then sender, then
  -- recipient, in that fixed order so a match is reproducible.
  match_field text NOT NULL CHECK (match_field IN ('body', 'sender', 'recipient', 'any')),
  -- How it is compared. 'regex' patterns are statically analysed and refused at
  -- write time when they can backtrack catastrophically.
  match_type text NOT NULL CHECK (match_type IN ('substring', 'exact', 'prefix', 'regex')),
  pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 512),
  case_sensitive boolean NOT NULL DEFAULT false,
  action text NOT NULL CHECK (action IN ('block', 'allow')),
  -- Engine-level SMSC id (smsc_definitions.engine_id). NULL = every carrier.
  -- Not a foreign key: engine_id is unique per tenant, not globally, and a rule
  -- must survive an SMSC being renamed rather than cascade-deleting silently.
  smsc_id text,
  -- NULL = every customer of the tenant.
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  -- Lower number = evaluated earlier. First match wins.
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  expires_at timestamptz,
  -- Operator-facing explanation returned with the refusal.
  reason text,
  -- Bumped only on a BLOCK; see the header note on send-path cost.
  match_count bigint NOT NULL DEFAULT 0 CHECK (match_count >= 0),
  last_matched_at timestamptz,
  -- Set when the platform disabled this rule itself (regex over budget).
  quarantined_at timestamptz,
  quarantine_reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- The evaluation order IS the hot read: enabled, unexpired, in precedence order.
CREATE INDEX IF NOT EXISTS messaging_content_rules_eval_idx
  ON messaging_content_rules (tenant_id, enabled, priority, created_at, id);
CREATE INDEX IF NOT EXISTS messaging_content_rules_smsc_idx
  ON messaging_content_rules (tenant_id, smsc_id) WHERE smsc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messaging_content_rules_customer_idx
  ON messaging_content_rules (tenant_id, customer_id) WHERE customer_id IS NOT NULL;

COMMENT ON TABLE messaging_content_rules IS
  'Content filter rules evaluated on every send. Precedence is first-match-wins over (priority ASC, created_at ASC, id ASC); no match = allowed.';
COMMENT ON COLUMN messaging_content_rules.priority IS
  'Lower number is evaluated earlier. An allow rule must have a LOWER priority number than the block it is meant to exempt.';
COMMENT ON COLUMN messaging_content_rules.quarantined_at IS
  'Set when the platform disabled this rule automatically because its regex exceeded the send-path execution budget.';

-- Structured record of which content rule decided a send.
ALTER TABLE message_route_decisions ADD COLUMN IF NOT EXISTS content_rule_id uuid;
ALTER TABLE message_route_decisions ADD COLUMN IF NOT EXISTS content_rule_name text;
CREATE INDEX IF NOT EXISTS message_route_decisions_content_rule_idx
  ON message_route_decisions (tenant_id, content_rule_id, created_at DESC)
  WHERE content_rule_id IS NOT NULL;
COMMENT ON COLUMN message_route_decisions.content_rule_id IS
  'messaging_content_rules.id of the rule that decided this message, when one did. Not a foreign key: the decision is an audit record and must outlive the rule.';

-- ==========================================================================
-- 2. MO ROUTING RULES
-- ==========================================================================
CREATE TABLE IF NOT EXISTS mo_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  -- All criteria are ANDed; NULL / 'any' means the criterion does not apply.
  -- Receiving bind (smsc_definitions.engine_id).
  match_smsc_id text,
  -- Short code / long number the subscriber texted.
  match_destination text,
  match_destination_type text NOT NULL DEFAULT 'any'
    CHECK (match_destination_type IN ('any', 'exact', 'prefix')),
  -- Prefix of the originating MSISDN's canonical digits.
  match_sender_prefix text,
  match_keyword text,
  match_keyword_type text NOT NULL DEFAULT 'any'
    CHECK (match_keyword_type IN ('any', 'first_word', 'substring', 'exact')),
  case_sensitive boolean NOT NULL DEFAULT false,
  -- false = first match wins and matching stops (the default). true = a
  -- non-terminal rule, so one message can be delivered by SEVERAL rules.
  continue_after_match boolean NOT NULL DEFAULT false,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  -- A criterion with a type but no value would silently mean "any".
  CHECK (match_destination_type = 'any' OR match_destination IS NOT NULL),
  CHECK (match_keyword_type = 'any' OR match_keyword IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mo_routing_rules_eval_idx
  ON mo_routing_rules (tenant_id, enabled, priority, created_at, id);

COMMENT ON TABLE mo_routing_rules IS
  'Rules matching inbound (MO) traffic. Evaluated in (priority, created_at, id) order; first match wins unless continue_after_match is set.';

CREATE TABLE IF NOT EXISTS mo_rule_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  rule_id uuid NOT NULL REFERENCES mo_routing_rules(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('webhook', 'email', 'sms')),
  -- URL, email address, or canonical MSISDN, validated per kind at write time.
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2048),
  enabled boolean NOT NULL DEFAULT true,
  -- Per-kind options: webhook {method, headers, secret}, email {subject},
  -- sms {sender, smscId, customerId}. Unknown keys are dropped on write.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_id, kind, target)
);
CREATE INDEX IF NOT EXISTS mo_rule_destinations_rule_idx
  ON mo_rule_destinations (tenant_id, rule_id, enabled);

-- ==========================================================================
-- 3. RECEIVED INBOUND MESSAGES AND THEIR DELIVERIES
-- ==========================================================================
CREATE TABLE IF NOT EXISTS mo_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  source text NOT NULL CHECK (source IN ('sqlbox', 'http')),
  -- 'sqlbox:<sent_sms.sql_id>' or 'http:<externalRef>'. The uniqueness of this
  -- column, not the sweep watermark, is what makes ingest idempotent.
  dedupe_key text,
  engine_message_id text,
  external_ref text,
  smsc_id text,
  sender text NOT NULL,
  receiver text NOT NULL,
  -- Canonical digits stored ALONGSIDE the raw values: a short code or an
  -- alphanumeric originator is not an MSISDN but is still a real message.
  sender_digits text,
  receiver_digits text,
  body text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  matched_rule_ids uuid[] NOT NULL DEFAULT '{}',
  fanout_count integer NOT NULL DEFAULT 0 CHECK (fanout_count >= 0),
  -- 'no_match' rows are KEPT: a message that fell through every rule is the
  -- evidence an operator needs when a short code "stops working".
  status text NOT NULL DEFAULT 'no_match' CHECK (status IN ('matched', 'no_match')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mo_messages_dedupe_uidx
  ON mo_messages (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mo_messages_received_idx
  ON mo_messages (tenant_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mo_messages_status_idx
  ON mo_messages (tenant_id, status, received_at DESC);

CREATE TABLE IF NOT EXISTS mo_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  mo_message_id uuid NOT NULL REFERENCES mo_messages(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: the delivery record is history and must outlive the
  -- rule that produced it. rule_name is denormalised for the same reason.
  rule_id uuid REFERENCES mo_routing_rules(id) ON DELETE SET NULL,
  rule_name text NOT NULL,
  destination_id uuid REFERENCES mo_rule_destinations(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('webhook', 'email', 'sms')),
  target text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'delivered', 'failed', 'dead_letter', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  manual_retries integer NOT NULL DEFAULT 0 CHECK (manual_retries >= 0),
  last_error text,
  response_code integer,
  response_detail text,
  -- The api_jobs row currently responsible for this delivery.
  job_id uuid,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mo_deliveries_message_idx
  ON mo_deliveries (tenant_id, mo_message_id, created_at);
CREATE INDEX IF NOT EXISTS mo_deliveries_status_idx
  ON mo_deliveries (tenant_id, status, created_at DESC);

COMMENT ON TABLE mo_deliveries IS
  'One row per fan-out destination per inbound message. Each is driven by its own api_jobs row, so one failing destination retries and dead-letters without affecting the others.';

-- ==========================================================================
-- 4. ENGINE SWEEP STATE
-- ==========================================================================
CREATE TABLE IF NOT EXISTS mo_ingest_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- Highest engine sent_sms.sql_id ingested. An optimisation only; correctness
  -- comes from mo_messages_dedupe_uidx.
  watermark_sql_id bigint NOT NULL DEFAULT 0 CHECK (watermark_sql_id >= 0),
  polling_enabled boolean NOT NULL DEFAULT false,
  poll_interval_seconds integer NOT NULL DEFAULT 30
    CHECK (poll_interval_seconds BETWEEN 5 AND 3600),
  last_polled_at timestamptz,
  last_error text,
  ingested_total bigint NOT NULL DEFAULT 0 CHECK (ingested_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ==========================================================================
-- 5. TENANT ISOLATION
-- ==========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messaging_content_rules', 'mo_routing_rules', 'mo_rule_destinations',
    'mo_messages', 'mo_deliveries', 'mo_ingest_state'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
        AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
        t
      );
    END IF;
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  messaging_content_rules, mo_routing_rules, mo_rule_destinations,
  mo_messages, mo_deliveries, mo_ingest_state
  TO jkannel_app;

COMMIT;
