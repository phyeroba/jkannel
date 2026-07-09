# JKANNEL Kamex Engine Capability Assessment

- Version: 2.0
- Status: Evidence baseline; runtime probing still required
- Reviewed: 2026-07-06
- Kamex baseline: 1.8.3 advertised release
- Upstream comparison baseline: Kannel 1.4.5 stable documentation

## Rule

Kamex is assessed as a separate engine implementation. Fork ancestry is not evidence of runtime parity. Each installed engine/build must supply a discovered manifest conforming to `ENGINE_CAPABILITY_REGISTRY.md`.

## Evidence matrix

`Supported` below means documented for the named baseline, not guaranteed for every installation. `Optional` requires a module, backend, build flag, or configuration. `Unknown` requires a probe before use.

| Capability | Upstream Kannel | Kamex | Evidence / qualification | Required probe |
|---|---|---|---|---|
| `observability.status.read` | Supported | Supported | Kannel documents status formats; Kamex advertises JSON status | Request endpoint, validate schema/version |
| `observability.health.native` | No native baseline evidence | Supported | Kamex advertises `/health` | Request endpoint and validate semantics |
| `observability.metrics.prometheus` | No native baseline evidence | Supported | Kamex advertises `/metrics` | Scrape and validate metric names |
| `observability.logs.structured` | No native baseline evidence | Supported | Kamex advertises JSON log format | Emit/parse representative events |
| `runtime.queue.inspect` | Partial | Supported/unknown depth | Kannel store-status; Kamex advertises real-time queues | Probe fields, pagination, freshness |
| `runtime.bind.inspect` | Partial | Supported/unknown depth | Status surfaces differ | Probe per-SMSC/session fields |
| `runtime.gateway.suspendResume` | Supported | Unknown until probed | Upstream admin commands documented | Safe non-production control probe |
| `runtime.config.reload` | Unknown/build dependent | Supported | Kamex advertises SIGHUP reload | Validate changed fields and interruption |
| `storage.sqlbox` | Optional separate project | Optional separate package | Both are deployment-dependent | Detect process/module and DB connectivity |
| `storage.dlr.external` | Optional | Optional | Kamex advertises multiple DLR backends | Detect backend, schema, read/write ownership |
| `deployment.container.image` | Distribution dependent | Supported | Kamex publishes container instructions/images | Inspect immutable image digest/version |
| `configuration.validate.native` | Unknown | Advertised | Kamex advertises config validation | Execute validation against safe fixture |

## Database-backed visibility

SQLBox and engine DLR/message databases are external engine-owned sources. They may improve operational visibility but do not replace JKANNEL PostgreSQL. The adapter reports:

- external store kind and schema/version;
- read/write/query support;
- message, DLR, and MO coverage;
- freshness cursor and last successful synchronization;
- retention and consistency constraints;
- whether an observation is native, optional extension, adapter-derived, or JKANNEL platform-derived.

JKANNEL persists normalized capability and runtime snapshots according to `ENGINE_OBSERVABILITY_DATA_MODEL.md`.

## Runtime-management benefits to capture

Kamex improvements are only usable when independently discovered: health and metrics endpoints, structured logs, live bind/queue visibility, configuration validation/hot reload, diagnostics, process/container awareness, and lifecycle controls. Read-only visibility and mutating controls use separate capability IDs. Destructive or traffic-affecting operations carry approval, idempotency, reversibility, and scope metadata.

## Risks

- Marketing/project documentation can describe features absent from a specific build.
- Optional SQLBox/database packages may be installed but unhealthy or schema-incompatible.
- Hot reload may support only part of the configuration model.
- A fork may diverge from upstream security fixes or protocol behavior.
- Runtime probe failure must become `unknown`/stale, never false capability certainty.

## Recommendation

Build the generic core and upstream Kannel reference adapter first, then a distinct Kamex adapter. Use separate fixtures, evidence, manifests, and compatibility tests. Kamex capabilities must not be added to the Kannel manifest merely because the engines share ancestry.

## Primary sources

- https://kamex.dev/
- https://github.com/vaska94/Kamex
- https://www.kannel.org/download/kannel-userguide-snapshot/userguide.html
- https://www.kannel.org/download.shtml
