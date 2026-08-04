-- 031_engine_observability
-- Closes the observability loop between the Kamex/Kannel bearerbox and the
-- control plane (gaps G3 / G6 / G14).
--
-- Until now nothing polled the engine: `smsc_health` was written only when an
-- operator clicked something, `alert_rules` were persisted but never evaluated
-- (there was no metric store to evaluate them against), and no SMS-level metric
-- ever reached Prometheus. These tables give the SmscStatusPoller somewhere to
-- record what it observed and give the AlertRuleEvaluatorScheduler a sample
-- stream to run the existing AlertEvaluatorService over.
--
--   engine_poll_snapshots  - one row per poll cycle per tenant: engine-wide
--                            totals plus the honest reachability of the poll.
--   smsc_bind_snapshots    - one row per poll cycle per bind: the typed
--                            per-bind observation (rolling, pruned).
--   smsc_bind_state        - exactly one row per bind: the current state, when
--                            it was entered and how many consecutive polls have
--                            confirmed it. This is the anti-flap anchor.
--   smsc_bind_transitions  - append-only bind history. KANNEL_ENGINE_ADAPTER
--                            Ch.22 requires that bind history is never deleted,
--                            so nothing prunes this table.
--   metric_samples         - generic rolling (metric, labels, value) stream the
--                            alert rule evaluator reads (rolling, pruned).
--
-- All tables are tenant-scoped with forced row level security, matching the
-- pattern in migrations 011/012/016/018/019/020/021/026.
BEGIN;

-- One row per poll cycle per tenant. Every engine-level counter is nullable
-- because an unreachable or partially parseable engine must never be recorded
-- as zero -- that is indistinguishable from a genuinely idle engine. In
-- particular bearerbox reports store_size = -1 when the store is disabled or
-- unknown; the adapter surfaces that as null and it is stored as NULL here.
CREATE TABLE engine_poll_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- 'ok' | 'degraded' | 'unavailable' -- the adapter's own honesty flag.
  source_status text NOT NULL CHECK (source_status IN ('ok', 'degraded', 'unavailable')),
  source_detail text NOT NULL,
  engine_status text NOT NULL,
  engine_version text,
  uptime_seconds bigint,
  sms_queued_out bigint,
  sms_queued_in bigint,
  dlr_queued bigint,
  store_size bigint,
  binds_total integer NOT NULL DEFAULT 0,
  binds_online integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_poll_snapshots_observed_idx
  ON engine_poll_snapshots (tenant_id, observed_at DESC);

-- One row per poll cycle per bind owned by the tenant. smsc_id is the owning
-- smsc_definitions row, resolved through smsc_definitions.engine_id; a bind the
-- engine reports that no tenant owns is never written here, so a tenant can
-- never read another tenant's topology out of this table.
CREATE TABLE smsc_bind_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  smsc_id uuid NOT NULL,
  engine_id text NOT NULL,
  state text NOT NULL,
  queued bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  sent bigint NOT NULL DEFAULT 0,
  received bigint NOT NULL DEFAULT 0,
  outbound_rate numeric(12, 3) NOT NULL DEFAULT 0,
  inbound_rate numeric(12, 3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, smsc_id) REFERENCES smsc_definitions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX smsc_bind_snapshots_observed_idx
  ON smsc_bind_snapshots (tenant_id, smsc_id, observed_at DESC);

-- Current state of each bind: the point of comparison the poller diffs against.
-- consecutive_observations counts how many successive polls have reported the
-- same state; alerting waits for it to reach the configured confirmation count
-- so a single blip cannot page anyone.
CREATE TABLE smsc_bind_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  smsc_id uuid NOT NULL,
  engine_id text NOT NULL,
  state text NOT NULL,
  previous_state text,
  consecutive_observations integer NOT NULL DEFAULT 1 CHECK (consecutive_observations > 0),
  failed_count bigint NOT NULL DEFAULT 0,
  queued_count bigint NOT NULL DEFAULT 0,
  entered_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, smsc_id),
  FOREIGN KEY (tenant_id, smsc_id) REFERENCES smsc_definitions(tenant_id, id) ON DELETE CASCADE
);

-- Append-only bind history. Never pruned (Ch.22: "bind history shall never be
-- deleted"). kind distinguishes a state change from a failure-count jump, which
-- is an event worth recording even though the state itself did not move.
CREATE TABLE smsc_bind_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  smsc_id uuid NOT NULL,
  engine_id text NOT NULL,
  kind text NOT NULL DEFAULT 'state_change'
    CHECK (kind IN ('state_change', 'failure_jump', 'first_observation')),
  from_state text,
  to_state text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, smsc_id) REFERENCES smsc_definitions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX smsc_bind_transitions_observed_idx
  ON smsc_bind_transitions (tenant_id, smsc_id, observed_at DESC);

-- Rolling metric sample stream. Deliberately generic (metric name + label set +
-- value) so the pure AlertEvaluatorService can be run over it unchanged, and so
-- future producers (platform metrics, DLR outcomes) can append to the same
-- stream without a schema change. Pruned by the poller.
CREATE TABLE metric_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  metric text NOT NULL,
  value numeric NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metric_samples_lookup_idx ON metric_samples (tenant_id, metric, observed_at DESC);

-- Alert instances may now originate from the engine poller (a bind transition),
-- which is neither a threshold rule nor a statistical anomaly.
ALTER TABLE alert_instances DROP CONSTRAINT IF EXISTS alert_instances_source_check;
ALTER TABLE alert_instances
  ADD CONSTRAINT alert_instances_source_check
  CHECK (source IN ('rule', 'anomaly', 'engine'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'engine_poll_snapshots', 'smsc_bind_snapshots', 'smsc_bind_state',
    'smsc_bind_transitions', 'metric_samples'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)',
      t
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  engine_poll_snapshots, smsc_bind_snapshots, smsc_bind_state,
  smsc_bind_transitions, metric_samples
  TO jkannel_app;

-- Seed a default notification channel and escalation policy for every existing
-- tenant. Without these a fresh deployment opens alerts that nobody is ever
-- told about: escalation_policies was empty, so AlertEscalationService had
-- nothing to run and no notification was ever sent automatically.
--
-- The chain is deliberately honest about what a default install can actually
-- do: step 0 is the dashboard channel (always deliverable), steps 1 and 2 are
-- email and webhook, which record "no enabled <type> channel" in
-- alert_escalations.detail until an operator configures one. Nothing pretends
-- to have paged someone it could not reach.
INSERT INTO notification_channels (tenant_id, name, type, enabled, severities, config, created_by)
SELECT t.id, 'Default dashboard', 'dashboard', true,
       ARRAY['info', 'warning', 'critical']::text[],
       '{"categories": ["alert"]}'::jsonb, 'migration-031'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM notification_channels c WHERE c.tenant_id = t.id AND c.name = 'Default dashboard'
 );

INSERT INTO escalation_policies (tenant_id, name, steps, enabled, created_by)
SELECT t.id, 'Default escalation',
       '[{"afterMinutes": 0, "channelType": "dashboard", "target": "Default dashboard"},
         {"afterMinutes": 5, "channelType": "email", "target": ""},
         {"afterMinutes": 15, "channelType": "webhook", "target": ""}]'::jsonb,
       true, 'migration-031'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM escalation_policies p WHERE p.tenant_id = t.id AND p.name = 'Default escalation'
 );

COMMIT;
