BEGIN;
DROP VIEW IF EXISTS active_engine_capability_manifests;
DROP TABLE IF EXISTS engine_sync_cursors, engine_lifecycle_results, engine_lifecycle_actions, engine_queue_snapshots, engine_connection_snapshots, engine_runtime_snapshots, engine_capability_entries, engine_capability_snapshots, adapter_instances, engine_instances CASCADE;
DROP FUNCTION IF EXISTS enforce_engine_action_transition();
DROP TYPE IF EXISTS engine_action_state;
DROP TYPE IF EXISTS engine_support_state;
COMMIT;
