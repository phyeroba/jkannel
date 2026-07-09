# Engine Adapter Contract

- Version: 1.0
- Status: Master contract addendum

## Mandatory core

Every adapter implements only:

- `identify()` - engine, adapter, version, build, and instance identity;
- `discoverCapabilities()` - typed capability manifest with provenance and freshness;
- `health()` - normalized adapter transport/connectivity health; engine-native health is `unknown` unless its optional capability is current and supported;
- `coreDiagnostics()` - safe adapter self-diagnostics only, excluding engine diagnostic bundles.

Adapters are sibling implementations selected by an adapter registry/factory for each `engine_instance`. Multiple Kannel, Kamex, and future engines may coexist.

## Optional providers

Optional interfaces are composed only when the manifest supports them:

- `StatusProvider`, `MetricsProvider`, `LogProvider`, `QueueInspectionProvider`, `BindInspectionProvider`;
- `LifecycleControlProvider`, `SMSCControlProvider`, `QueueControlProvider`;
- `ConfigurationValidationProvider`, `ConfigurationDeploymentProvider`, `ReloadProvider`, `RollbackProvider`;
- `MessageStoreProvider`, `DLRStoreProvider`, `MOStoreProvider`;
- `ContainerRuntimeProvider` and `EngineDiagnosticsProvider`.

Methods in older adapter specifications that are not in the mandatory core are reclassified as optional provider operations. A provider may exist when only some methods are supported; every method independently gates against its canonical capability ID, constraints, scope, and freshness. `partial` permits only operations explicitly listed in that entry's constraints. Calling any unavailable operation returns a normalized `UnsupportedCapability` error containing the canonical capability ID, engine instance, adapter build, and latest discovery timestamp.

## Mutating operation safety

Every mutating capability declares scope, asynchronous behavior, idempotency, reversibility, approval requirement, expected traffic impact, timeout, and audit event type. Queue purge, shutdown, restart, and destructive configuration actions require explicit elevated authorization and cannot be inferred from a general lifecycle flag.

Immediately before execution, every mutation must re-read a non-expired capability snapshot matching the current engine and adapter build. The exact operation and requested scope must be `supported`; `partial`, `unknown`, stale, and operator-overridden entries are denied unless a separately documented policy explicitly permits that scope. Execution also requires authorization, any mandated approval, successful preflight, an idempotency key, and a final capability recheck to limit probe-to-operation races.
