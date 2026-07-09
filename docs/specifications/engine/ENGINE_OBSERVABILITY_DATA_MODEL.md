# Engine Observability Data Model

- Version: 1.0
- Status: Master data-model addendum

JKANNEL PostgreSQL persists normalized visibility and control history. Engine-owned SQLBox, message, MO, and DLR stores are external sources and never replace the JKANNEL system of record.

## Required entities

| Entity | Purpose |
|---|---|
| `engine_instances` | Stable engine registration, type, endpoint reference, desired state, tenant/scope |
| `adapter_instances` | Adapter implementation/version/build assigned to an engine instance |
| `engine_capability_snapshots` | Immutable discovered manifest, provenance, evidence, constraints, observed/expiry timestamps |
| `engine_runtime_snapshots` | Normalized health, state, counters, and source freshness |
| `engine_connection_snapshots` | SMSC/bind/session state and statistics |
| `engine_queue_snapshots` | Queue depth/state by queue/source without assuming message queryability |
| `engine_lifecycle_actions` | Requested control operation, approval, idempotency key, actor, scope, state |
| `engine_lifecycle_results` | Adapter response, normalized outcome, timestamps, rollback/result evidence |
| `engine_sync_cursors` | External-store/source cursor, watermark, lag, and last success/failure |

Capability snapshots must preserve `unknown` independently from `unsupported`. A version/build change invalidates the active manifest until re-probed. Last-known-good data may be displayed as stale but cannot authorize a mutating operation.

## Minimum relational contract

- Every table has a UUID primary key, `tenant_id`, `created_at`, and immutable audit metadata; tenant isolation uses PostgreSQL row-level security.
- `adapter_instances.engine_instance_id` references `engine_instances`; endpoint credentials are secret-manager references, never stored values.
- Each capability manifest has a snapshot header keyed by `(engine_instance_id, adapter_instance_id, registry_version, observed_at)` and immutable child entries keyed by `(snapshot_id, capability_id)` containing support, owner, source, JSON constraints, redacted evidence reference, and expiry.
- Only one non-expired snapshot may be selected by the active-manifest view for a matching engine version/build and adapter version/build. New snapshots supersede; they never update prior evidence.
- Runtime, connection, and queue snapshots reference engine, adapter, and capability snapshot IDs. Index `(tenant_id, engine_instance_id, observed_at desc)`; partition high-volume snapshots by observation time and apply documented retention.
- Lifecycle actions reference engine, adapter, capability snapshot, actor, approval record, idempotency key, operation ID, and scope. `(tenant_id, engine_instance_id, idempotency_key)` is unique.
- Action states are `requested -> awaiting_approval -> approved -> executing -> succeeded|failed|cancelled|rolled_back`; invalid transitions are rejected. Results correlate to one action and preserve normalized outcome plus redacted evidence.
- Sync cursors are unique by `(tenant_id, engine_instance_id, source_kind, source_identity)` and track last attempt, success, failure, watermark, and lag.

`engine_type` is used only by the adapter factory. Queries and business workflows are prohibited from using it for feature branching.

## Ownership boundary

External engine databases remain read-only unless a capability and approved workflow explicitly permit mutation. JKANNEL stores normalized observations and audit records; it does not silently import engine databases as configuration authority.
