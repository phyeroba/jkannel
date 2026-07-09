\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenants(name,slug) VALUES ('Phase 3 Test','phase-3-test') RETURNING id AS tenant_id \gset
INSERT INTO configuration_versions(tenant_id,scope,version_number,content,checksum,change_reason,created_by) VALUES (:tenant_id,'global',1,'{}','phase3-checksum','test','test');
INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,created_at) VALUES (:tenant_id,'test','created','configuration',now());
INSERT INTO engine_instances(tenant_id,name,engine_type,endpoint_reference,created_by) VALUES (:tenant_id,'test-engine','kannel','secret://test','test') RETURNING id AS engine_id \gset
INSERT INTO adapter_instances(tenant_id,engine_instance_id,implementation,adapter_version,adapter_build,created_by) VALUES (:tenant_id,:'engine_id','kannel-adapter','1','test','test') RETURNING id AS adapter_id \gset
INSERT INTO engine_capability_snapshots(tenant_id,engine_instance_id,adapter_instance_id,registry_version,engine_version,engine_build,adapter_version,adapter_build,observed_at,expires_at,created_by) VALUES (:tenant_id,:'engine_id',:'adapter_id','1','1.4.5','test','1','test',now(),now()+interval '1 hour','test') RETURNING id AS snapshot_id \gset
INSERT INTO engine_capability_entries(tenant_id,snapshot_id,capability_id,support,owner,source,created_by) VALUES (:tenant_id,:'snapshot_id','runtime.status','unknown','adapter','probe','test');
INSERT INTO engine_lifecycle_actions(tenant_id,engine_instance_id,adapter_instance_id,capability_snapshot_id,actor_id,idempotency_key,operation_id,created_by) VALUES (:tenant_id,:'engine_id',:'adapter_id',:'snapshot_id','test','phase3-idempotency','runtime.restart','test') RETURNING id AS action_id \gset
UPDATE engine_lifecycle_actions SET state='approved' WHERE id=:'action_id';
DO $$ BEGIN
  BEGIN UPDATE engine_lifecycle_actions SET state='succeeded' WHERE id=(SELECT id FROM engine_lifecycle_actions WHERE idempotency_key='phase3-idempotency'); RAISE EXCEPTION 'invalid transition accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='invalid transition accepted' THEN RAISE; END IF; END;
END $$;
DO $$ BEGIN
  BEGIN UPDATE audit_log SET action='tampered' WHERE actor_id='test'; RAISE EXCEPTION 'audit mutation accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='audit mutation accepted' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
