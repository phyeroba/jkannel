-- 049_operational_events
-- A system-originated operational event stream, and the correlation id that
-- threads it to everything else.
--
-- WHY audit_log IS NOT THIS
-- --------------------------------------------------------------------------
-- `audit_log` records what a PERSON did: actor, action, entity, reason. §12.1
-- asks for something different — what the SYSTEM observed. Connection lost and
-- restored, bind failed, session flapping, enquire-link timeout, SMSC suspended
-- or resumed, route failover, queue threshold crossed, DLR degradation, service
-- restart. None of those have an actor, and forcing them into audit_log would
-- either require a fake one or make "who did this" meaningless on half the rows.
--
-- The only system stream that exists today is `smsc_bind_transitions`, which
-- covers connection and bind changes at SMSC granularity, in Kannel's
-- vocabulary, with no severity and no correlation id — and has no HTTP endpoint
-- at all. It stays as the raw observation record; this table is the operator-
-- facing event stream, and the bind poller writes to both.
--
-- CORRELATION IS A COLUMN HERE, NOT A LATER MIGRATION
-- --------------------------------------------------------------------------
-- `correlation_id` already exists on `audit_log`, on `gateway_request_log` and
-- on the structured logs, so today an operator can go audit <-> logs. They
-- cannot go alert -> event -> message, which is the path §12 is actually about.
-- Adding the column to `alert_instances` in the same migration means the thread
-- is complete the moment anything starts writing it, rather than being a
-- half-built feature that reads as broken.
BEGIN;

CREATE TABLE IF NOT EXISTS operational_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  -- Dotted, hierarchical, and NOT constrained to an enum on purpose: a CHECK
  -- here would mean a migration every time a new emitter is added, and the
  -- pressure that creates is to reuse a nearly-right type rather than add the
  -- correct one. The index below makes prefix queries cheap.
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  -- One line, already written for a human. Events are read in a list.
  summary text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The object this is about, so an event can be filtered to one carrier, bind
  -- or route without parsing `detail`.
  subject_type text,
  subject_id text,
  /**
   * Threads this event to the alert, log lines and audit entries for the same
   * incident. Nullable: a spontaneous observation has no correlation until
   * something groups it, and inventing one per event would make the column
   * useless for grouping.
   */
  correlation_id uuid,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_events_severity_check
    CHECK (severity IN ('info', 'warning', 'critical'))
);

-- The list is always time-ordered and usually scoped, so these three cover the
-- real access patterns: recent events, events for one object, one incident.
CREATE INDEX IF NOT EXISTS operational_events_tenant_time_idx
  ON operational_events (tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_subject_idx
  ON operational_events (tenant_id, subject_type, subject_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_correlation_idx
  ON operational_events (correlation_id, observed_at)
  WHERE correlation_id IS NOT NULL;
-- text_pattern_ops so `kind LIKE 'smsc.bind.%'` uses the index.
CREATE INDEX IF NOT EXISTS operational_events_kind_idx
  ON operational_events (tenant_id, kind text_pattern_ops, observed_at DESC);

-- The missing half of the thread. Alerts could not previously be joined to
-- anything: they carry a dedup key and no correlation id.
ALTER TABLE alert_instances ADD COLUMN IF NOT EXISTS correlation_id uuid;
CREATE INDEX IF NOT EXISTS alert_instances_correlation_idx
  ON alert_instances (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE operational_events IS
  'System-observed operational events (spec §12.1). Distinct from audit_log, which records what a person did.';
COMMENT ON COLUMN operational_events.correlation_id IS
  'Threads alert -> event -> log -> audit for one incident. Null until something groups the event.';

DO $$
BEGIN
  EXECUTE 'ALTER TABLE operational_events ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
      AND tablename = 'operational_events' AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON operational_events USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint)';
  END IF;
  EXECUTE 'ALTER TABLE operational_events FORCE ROW LEVEL SECURITY';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON operational_events TO jkannel_app;

COMMIT;
