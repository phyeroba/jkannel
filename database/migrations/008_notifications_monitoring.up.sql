BEGIN;

CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  severities text[] NOT NULL DEFAULT ARRAY['warning','critical']::text[],
  config jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  CHECK (type IN ('dashboard','webhook','email','sms')),
  CHECK (severities <@ ARRAY['info','warning','critical']::text[])
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  alert_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  channel_type text NOT NULL,
  status text NOT NULL,
  target text,
  response jsonb NOT NULL DEFAULT '{}',
  attempted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (status IN ('succeeded','failed','skipped')),
  FOREIGN KEY (tenant_id, alert_id) REFERENCES alert_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES notification_channels(tenant_id, id)
);

CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries(tenant_id, alert_id, created_at DESC);
CREATE INDEX notification_channels_type_idx ON notification_channels(tenant_id, enabled, type);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['notification_channels','notification_deliveries'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint)',t);
END LOOP; END $$;

COMMIT;
