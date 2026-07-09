BEGIN;

ALTER TABLE roles ADD CONSTRAINT roles_tenant_id_id_unique UNIQUE(tenant_id,id);

CREATE TABLE smsc_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL, type text NOT NULL, host text, port integer, credential_secret_ref text,
  tps integer NOT NULL DEFAULT 10 CHECK (tps > 0 AND tps <= 100000), enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id,id), CHECK (type IN ('smpp','http','fake','at')),
  CHECK (type = 'fake' OR (host IS NOT NULL AND port BETWEEN 1 AND 65535)),
  CHECK (credential_secret_ref IS NULL OR credential_secret_ref LIKE 'secret://%')
);

CREATE TABLE routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL, priority integer NOT NULL CHECK (priority >= 0), enabled boolean NOT NULL DEFAULT true,
  destination_prefix text, sender text, target_smsc_id uuid NOT NULL,
  fallback_smsc_id uuid, created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), CHECK (fallback_smsc_id IS NULL OR fallback_smsc_id <> target_smsc_id),
  FOREIGN KEY (tenant_id,target_smsc_id) REFERENCES smsc_definitions(tenant_id,id),
  FOREIGN KEY (tenant_id,fallback_smsc_id) REFERENCES smsc_definitions(tenant_id,id)
);

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL, metric text NOT NULL, operator text NOT NULL, threshold numeric NOT NULL,
  sustain_seconds integer NOT NULL DEFAULT 0 CHECK (sustain_seconds >= 0), severity text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, name), UNIQUE(tenant_id,id),
  CHECK (operator IN ('gt','gte','lt','lte','eq')), CHECK (severity IN ('info','warning','critical'))
);

CREATE TABLE alert_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  rule_id uuid, status text NOT NULL DEFAULT 'open', summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}', opened_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  CHECK (status IN ('open','acknowledged','resolved')), UNIQUE(tenant_id,id),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES alert_rules(tenant_id,id)
);
CREATE TABLE alert_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  alert_id uuid NOT NULL, actor_id text NOT NULL, note text,
  acknowledged_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, alert_id),
  FOREIGN KEY (tenant_id,alert_id) REFERENCES alert_instances(tenant_id,id)
);

CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  key text NOT NULL, value jsonb NOT NULL, is_secret boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, key),
  CHECK (key ~ '^[a-z][a-z0-9_.-]+$')
);

CREATE TABLE user_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id),
  email text NOT NULL, role_id uuid, status text NOT NULL DEFAULT 'pending',
  token_hash text NOT NULL, expires_at timestamptz NOT NULL, invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
  CHECK (status IN ('pending','accepted','revoked','expired')), CHECK (expires_at > created_at),
  FOREIGN KEY (tenant_id,role_id) REFERENCES roles(tenant_id,id)
);
CREATE UNIQUE INDEX user_invitations_pending_email_idx ON user_invitations(tenant_id, lower(email)) WHERE status='pending';
CREATE INDEX routing_rules_order_idx ON routing_rules(tenant_id, enabled, priority, name);
CREATE INDEX alert_instances_open_idx ON alert_instances(tenant_id, opened_at DESC) WHERE status <> 'resolved';

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['smsc_definitions','routing_rules','alert_rules','alert_instances','alert_acknowledgements','system_settings','user_invitations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::bigint)',t);
END LOOP; END $$;
ALTER TABLE configuration_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY configuration_versions_tenant_isolation ON configuration_versions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint);

COMMIT;
