-- 014_alert_severity_and_anomaly
-- Give alert instances their own severity and source so anomaly-detected
-- alerts (which have no rule) sort/filter alongside rule-based ones, and add a
-- dedup key so the detector does not reopen the same anomaly every cycle.
BEGIN;

ALTER TABLE alert_instances
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'warning',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'rule',
  ADD COLUMN IF NOT EXISTS dedup_key text;

ALTER TABLE alert_instances
  ADD CONSTRAINT alert_instances_severity_check CHECK (severity IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT alert_instances_source_check CHECK (source IN ('rule', 'anomaly'));

-- Backfill existing instances' severity from their rule where possible.
UPDATE alert_instances a
   SET severity = r.severity
  FROM alert_rules r
 WHERE a.rule_id = r.id AND a.tenant_id = r.tenant_id;

-- At most one open alert per dedup key per tenant (partial unique index).
CREATE UNIQUE INDEX alert_instances_open_dedup_idx
  ON alert_instances (tenant_id, dedup_key)
  WHERE status <> 'resolved' AND dedup_key IS NOT NULL;

COMMIT;
