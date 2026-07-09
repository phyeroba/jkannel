# ADR-0007: Upstream Kannel and Kamex Engine Strategy

- Status: Accepted
- Date: 2026-07-06
- Authors: JKANNEL Architecture Team

## Context

Upstream Kannel and Kamex are related but independently versioned engines. Kamex is a maintained fork, not a deployment profile of upstream Kannel. Capability parity must never be inferred from ancestry or engine name.

The evidence baseline for this decision is upstream Kannel 1.4.5 documentation and Kamex 1.8.3 documentation as reviewed on 2026-07-06. Capabilities remain runtime-discovered because builds, optional boxes, configuration, and packaging change what a particular instance can do.

## Decision

JKANNEL exposes a small mandatory `EngineAdapterCore` port implemented by sibling adapters selected per engine instance:

```text
                    EngineAdapterCore
                     /      |      \
        KannelAdapter  KamexAdapter  FutureAdapter
```

The mandatory core is limited to identity/version, capability discovery, health, and diagnostics. All other operations are capability-scoped provider interfaces. An unsupported operation returns a normalized `UnsupportedCapability` result; it is not silently emulated.

Business modules query canonical capability IDs and never branch on `engineType == Kamex` or `engineType == Kannel`. Discovery records support level, ownership, provenance, evidence, constraints, and freshness. A failed probe yields `unknown`, not `unsupported`.

## Evidence-based distinction

| Area | Upstream Kannel baseline | Kamex baseline | Design consequence |
|---|---|---|---|
| Administrative status/control | HTTP admin status plus suspend, isolate, resume, shutdown and queue status | JSON status/health plus modern operational surfaces advertised by Kamex | Model read and mutation capabilities separately |
| SQLBox/database | Separate upstream `sqlbox` project/module; availability is build/deployment dependent | Separately packaged `kamex-sqlbox`; database queue storage remains optional | Never equate SQLBox with core-engine storage; probe it |
| DLR storage | Configurable storage support varies by build/backend | Kamex advertises Redis/Valkey, MySQL, PostgreSQL, and SQLite DLR backends | Record backend, queryability, ownership, and retention constraints |
| Observability | Text/HTML/XML/WML status and store status in documented baseline | Advertised JSON status, `/health`, `/metrics`, Prometheus metrics, structured JSON logs, dashboard | Expose format, granularity, and freshness metadata |
| Configuration/runtime | Admin lifecycle controls; deployment-specific reload behavior | Advertised SIGHUP hot reload and config validation | Separate validation, deploy, reload, and zero-downtime claims |
| Packaging | Source/distribution packaging varies | Advertised Docker images, RPMs, systemd units, reproducible builds | Packaging is not the same as controllable container lifecycle |

## Database-backed visibility

Engine-owned SQLBox/message/DLR stores remain external data sources. JKANNEL PostgreSQL remains the system of record for engine registrations, capability snapshots, runtime snapshots, lifecycle actions, provenance, freshness, and audit. Adapters normalize external observations; they do not make an engine database authoritative for JKANNEL configuration.

## First implementation path

1. Implement and contract-test `EngineAdapterCore` plus provider interfaces against fakes.
2. Keep upstream Kannel as the lowest-common-denominator contract fixture and adapter for external installations.
3. Implement Kamex as the first containerized sibling runtime under ADR-0008, using independently probed JSON health/status, metrics, structured logs, SQLBox integration, and reload capabilities.
4. Run the same contract suite with separate Kannel and Kamex fixtures; do not reuse a capability manifest.

## Consequences

- Multiple heterogeneous engine instances can coexist.
- Kamex improvements are available without leaking Kamex checks into business modules.
- The interface is more granular than a single all-capabilities adapter, requiring provider composition and explicit unsupported results.
- Capability evidence must be maintained for each supported version/build.

## Sources

- Kamex project documentation: https://kamex.dev/
- Kamex source and releases: https://github.com/vaska94/Kamex
- Upstream Kannel project and releases: https://www.kannel.org/
- Upstream Kannel user guide: https://www.kannel.org/download/kannel-userguide-snapshot/userguide.html
- Upstream Kannel project/module downloads: https://www.kannel.org/download.shtml
