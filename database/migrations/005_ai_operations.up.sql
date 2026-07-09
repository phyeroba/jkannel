BEGIN;
CREATE TABLE ai_assistance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id), requested_by text NOT NULL,
  question text NOT NULL CHECK(length(question)<=1000), evidence jsonb NOT NULL DEFAULT '[]', result jsonb NOT NULL,
  status text NOT NULL, risk text NOT NULL, confidence integer NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  decision_reason text, decided_by text, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status IN ('advisory','approval_required','approved','rejected','insufficient_data')),
  CHECK(risk IN ('none','low','medium','high')), CHECK(jsonb_typeof(evidence)='array')
);
CREATE INDEX ai_assistance_tenant_created_idx ON ai_assistance_requests(tenant_id,created_at DESC);
ALTER TABLE ai_assistance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_assistance_tenant_isolation ON ai_assistance_requests USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::bigint);
COMMIT;
