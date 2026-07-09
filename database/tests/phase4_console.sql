\set ON_ERROR_STOP on
INSERT INTO tenants(name,slug) VALUES('Console tenant','console-test') ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id AS tenant_id \gset
BEGIN;
SELECT set_config('app.tenant_id', :'tenant_id', true);
INSERT INTO smsc_definitions(tenant_id,name,type,tps,created_by) VALUES(:tenant_id,'simulator','fake',10,'test') RETURNING id AS smsc_id \gset
INSERT INTO routing_rules(tenant_id,name,priority,target_smsc_id,created_by) VALUES(:tenant_id,'default',100,:'smsc_id','test');
INSERT INTO alert_rules(tenant_id,name,metric,operator,threshold,severity,created_by) VALUES(:tenant_id,'queue high','queue.depth','gt',100,'warning','test') RETURNING id AS rule_id \gset
INSERT INTO alert_instances(tenant_id,rule_id,summary) VALUES(:tenant_id,:'rule_id','Queue exceeded threshold') RETURNING id AS alert_id \gset
INSERT INTO alert_acknowledgements(tenant_id,alert_id,actor_id,note) VALUES(:tenant_id,:'alert_id','test','investigating');
INSERT INTO system_settings(tenant_id,key,value,updated_by) VALUES(:tenant_id,'ui.timezone','"UTC"','test');
DO $$ BEGIN IF (SELECT count(*) FROM routing_rules) <> 1 THEN RAISE EXCEPTION 'tenant route visibility failed'; END IF; END $$;
ROLLBACK;
