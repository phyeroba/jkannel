# JKANNEL TypeScript Plugin SDK

Version 1.0.0 foundation.

The authoritative typed contract currently lives in `backend/src/plugins/plugin.contracts.ts`; the host validator and coordinator live beside it. This boundary will be extracted as a separately published package without changing its public types once package publication is introduced.

## Security model

- Production manifests require a SHA-256 package checksum, an approved Ed25519 publisher key, and a valid detached signature.
- Unknown manifest fields, unsafe paths, wildcard permissions, incompatible schema/API versions, and undeclared engine adapters are blocking errors.
- Permissions and event publication are denied unless both declared and administrator-approved.
- Host APIs redact secret-like fields and namespace plugin metrics.
- The runtime coordinator accepts only worker-process proxies from the process supervisor. It does not import or evaluate plugin package code in the API process.
- Invocation timeouts and repeated failures trip the circuit breaker. The process supervisor is responsible for hard CPU, memory, filesystem, network, and termination limits.
- Engine plugins expose `engine.adapter.core` and the generic capability/provider contracts. They may not expose Kannel- or Kamex-specific operations to business modules.

See `docs/specifications/sdk/PLUGIN_DEVELOPMENT_SDK.md` for the complete package and lifecycle contract.
