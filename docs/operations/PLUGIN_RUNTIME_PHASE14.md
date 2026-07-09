# Phase 14 Plugin Runtime Foundation

JKANNEL validates schema version `1.0` manifests before registration. The validator rejects unknown fields, path traversal, wildcard permissions, incompatible versions, undeclared engine contracts, checksum mismatches, and invalid production signatures.

The coordinator does not load or invoke plugin code in the API process. A trusted publisher and an explicit `PluginExecutor` whose isolation contract is `worker-process` are required. The executor owns process creation, IPC, resource limits, and timeout enforcement; the coordinator owns permission approval, event declarations, payload redaction, lifecycle state, and failure isolation. No production worker-process implementation is included in this foundation, so untrusted plugins must not be enabled yet.

Engine plugins must depend on the generic `engine-adapter` capability. Kannel- or Kamex-specific behavior remains behind the Engine Adapter boundary.

Validation:

```powershell
docker run --rm jkannel-backend npm test -- --runInBand
```

Production enablement additionally requires a reviewed executor implementation, package storage, publisher trust administration, OS-level resource controls, and adversarial isolation testing.
