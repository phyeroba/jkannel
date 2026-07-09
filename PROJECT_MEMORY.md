# Project Memory

## Product invariants

- JKANNEL manages telecommunications operations; it is not a fork of the visual-reference application's business domain.
- All gateway interaction crosses a generic Engine Adapter. Kannel is the first implementation.
- Upstream Kannel and Kamex are sibling adapter implementations with independently probed capabilities; fork ancestry never implies parity.
- Adapter core is limited to identity, discovery, transport health, and adapter self-diagnostics. Runtime visibility/control, storage, configuration, and engine diagnostics are optional providers.
- Engine-owned SQLBox/message/DLR stores are external sources; JKANNEL PostgreSQL retains capability/runtime snapshots and audit as its own system of record.
- SQLBox read models may provide pagination, traces and exports, but retention/partitioning must be handled as an engine-adjacent data-management policy and must not silently fork SQLBox data into JKANNEL-owned message tables.
- Route deployment records are JKANNEL control-plane policy history. Applying routing to a live Kamex/Kannel runtime must still go through the documented configuration generation, validation and adapter deployment path.
- Configuration deployment requires an approved immutable version. Rollback is represented as a new immutable version derived from the previous target, then approved and deployed, rather than mutating history in place.
- Monitoring-profile wiring is development/operations evidence, not proof of production SLOs. Email/SMS notification channels must remain `skipped`/unsupported until real provider adapters, secrets and delivery evidence exist.
- `Idempotency-Key` support is a platform retry primitive for authenticated mutating requests; domain workflows may still keep richer operation-history records when the action has telecommunications semantics.
- `api_jobs` is the tenant-scoped long-running operation ledger. It does not imply that worker execution, scheduler integration or large export processing is complete until those workers exist and are validated.
- PostgreSQL is the system of record; Redis supports cache, queues, and real-time coordination.
- The canonical backend direction is Node.js, NestJS, and TypeScript.
- The canonical frontend direction is Vue 3, TypeScript, Vite, and Tailwind CSS.
- Docker Compose is the first runtime target; designs should remain Kubernetes-compatible.
- `design/design_spec/` is the visual authority and must not be overwritten or directly transplanted.

## Documentation rules

- `JKANNEL_DOCUMENTATION_CATALOG.md` identifies canonical and archived material.
- Empty or missing specifications are tracked explicitly; absence must not be disguised with invented requirements.
- Architectural conflicts are resolved in `decisions/`.
