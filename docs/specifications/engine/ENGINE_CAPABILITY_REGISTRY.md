# JKANNEL Engine Capability Registry

Version: 2.0

Status: Master Engineering Specification

Project: JKANNEL

---

# Purpose

The Engine Capability Registry defines every capability that a messaging engine may advertise.

Business modules shall depend upon capabilities.

Never upon engine names.

The registry is the authoritative catalogue of engine functionality.

Capability identifiers use lower-case dotted names in new contracts. Existing camelCase and snake_case names are legacy aliases and must be normalized at the adapter boundary.

## Typed Capability Manifest

Capabilities are not unqualified booleans. Each manifest entry contains:

```text
id: canonical dotted capability ID
support: unknown | unsupported | partial | supported
owner: engine | adapter | platform | integration
source: native | extension | adapter-derived | platform-derived | operator-override
engineVersion / engineBuild / adapterVersion
constraints: structured limits and supported scopes
evidence: probe identifier and non-secret evidence reference
observedAt / expiresAt
safety: read-only or mutation metadata when applicable
```

`unknown` means not successfully probed. `unsupported` requires affirmative version/build evidence or a successful negative probe. Discovery failure, timeout, stale data, or an omitted field is always `unknown`.

Every manifest declares `registryVersion: 2.0` and contains an entry for every applicable canonical ID below; unprobed entries are `unknown`. The older camelCase category lists later in this document are migration input only and are not valid implementation identifiers.

## Canonical Capability Catalog

| ID | Definition | Default owner | Provider operation / probe |
|---|---|---|---|
| `protocol.smpp.client` | Connect to an SMPP server as client | engine | protocol handshake/build evidence |
| `observability.status.read` | Read normalized gateway state/counters | engine | `StatusProvider.readStatus` |
| `observability.health.native` | Engine-native health endpoint/command | engine | `StatusProvider.readNativeHealth` |
| `observability.metrics.runtime` | Runtime traffic/connection metrics | engine | `MetricsProvider.readRuntimeMetrics` |
| `observability.metrics.prometheus` | Prometheus exposition endpoint | engine | `MetricsProvider.scrapePrometheus` |
| `observability.logs.structured` | Structured engine log events | engine | `LogProvider.streamStructuredLogs` |
| `runtime.queue.inspect` | Inspect queue depth/state | engine | `QueueInspectionProvider.listQueues` |
| `runtime.bind.inspect` | Inspect SMSC/bind/session state | engine | `BindInspectionProvider.listBinds` |
| `runtime.gateway.restart` | Restart gateway runtime | integration | `LifecycleControlProvider.restart` |
| `runtime.gateway.shutdown` | Shut down gateway runtime | engine | `LifecycleControlProvider.shutdown` |
| `runtime.gateway.suspendResume` | Suspend/resume traffic | engine | `LifecycleControlProvider.suspend/resume` |
| `runtime.smsc.reconnect` | Reconnect a scoped SMSC/bind | engine | `SMSCControlProvider.reconnect` |
| `runtime.smsc.enableDisable` | Enable/disable scoped SMSC | engine | `SMSCControlProvider.enable/disable` |
| `runtime.queue.pauseResume` | Pause/resume queue processing | engine | `QueueControlProvider.pause/resume` |
| `runtime.queue.replay` | Replay selected queued items | adapter | `QueueControlProvider.replay` |
| `runtime.queue.purge` | Destructively purge selected queue data | engine | `QueueControlProvider.purge` |
| `runtime.config.reload` | Apply supported config changes without full restart | engine | `ReloadProvider.reload` |
| `runtime.config.deploy` | Deploy generated configuration | adapter | `ConfigurationDeploymentProvider.deploy` |
| `runtime.config.rollback` | Restore a prior deployed version | adapter | `RollbackProvider.rollback` |
| `runtime.config.driftDetect` | Compare desired and observed configuration | adapter | `ConfigurationDeploymentProvider.detectDrift` |
| `runtime.diagnostics.collect` | Collect engine diagnostic bundle | engine | `EngineDiagnosticsProvider.collect` |
| `runtime.remediation.automated` | Execute policy-authorized remediation | platform | orchestration policy probe |
| `runtime.container.inspect` | Inspect owning container state | integration | `ContainerRuntimeProvider.inspect` |
| `runtime.container.control` | Control owning container lifecycle | integration | `ContainerRuntimeProvider.control` |
| `configuration.validate.native` | Validate config using engine-native tooling | engine | `ConfigurationValidationProvider.validate` |
| `storage.sqlbox` | SQLBox extension is installed and reachable | extension | extension/process/schema probe |
| `storage.message.database` | Engine message store is database-backed | engine | backend/schema/read probe |
| `storage.dlr.external` | DLRs persist to an external backend | engine | backend/schema/read probe |
| `storage.mo.external` | MO messages persist to an external backend | engine | backend/schema/read probe |
| `api.rest` | Documented REST/JSON operational API | engine | versioned schema probe |
| `deployment.container.image` | Vendor/project publishes runnable image | integration | digest/version evidence |

---

# Capability Categories

Messaging

Routing

Protocols

Monitoring

Management

Configuration

Security

Storage

Automation

Operations

Deployment

Observability

Plugin Support

Artificial Intelligence

---

# Messaging Capabilities

supportsSmsSubmission

supportsBulkMessaging

supportsScheduledMessaging

supportsFlashSMS

supportsBinarySMS

supportsUnicode

supportsConcatenation

supportsDeliveryReports

supportsMobileOriginatedMessages

supportsLongMessages

supportsMessageTemplates

---

# Protocol Capabilities

supportsSMPPClient

supportsSMPPServer

supportsHTTP

supportsHTTPS

supportsCIMD2

supportsEMIUCP

supportsATModem

supportsSS7

supportsSIGTRAN

supportsFutureProtocols

---

# Routing Capabilities

supportsStaticRouting

supportsDynamicRouting

supportsWeightedRouting

supportsPriorityRouting

supportsLeastCostRouting

supportsCountryRouting

supportsOperatorRouting

supportsSenderRouting

supportsReceiverRouting

supportsRegexRouting

supportsFailoverRouting

supportsLoadBalancing

supportsStickyRouting

---

# Storage Capabilities

supportsSqlBox

supportsDatabaseStorage

supportsFileStorage

supportsRedisStorage

supportsExternalStorage

supportsDLRStorage

supportsMOStorage

supportsArchiveStorage

supportsHistoricalMetrics

---

# Configuration Capabilities

supportsConfigurationGeneration

supportsConfigurationValidation

supportsConfigurationDiff

supportsConfigurationVersioning

supportsRollback

supportsTemplateDeployment

supportsLiveReload

supportsHotReload

supportsSyntaxValidation

supportsCompatibilityValidation

---

# Runtime Capabilities

supportsRuntimeMetrics

supportsHealthChecks

supportsQueueInspection

supportsLiveBindStatus

supportsSessionMonitoring

supportsConnectionStatistics

supportsTrafficStatistics

supportsWorkerMonitoring

supportsContainerAwareness

The legacy names in this and the preceding category sections are retained solely for document migration. New code and manifests use the canonical catalog.

## Runtime Management Capabilities

Canonical IDs separate observation from mutation:

```text
runtime.gateway.restart
runtime.gateway.shutdown
runtime.gateway.suspendResume
runtime.smsc.reconnect
runtime.smsc.enableDisable
runtime.queue.pauseResume
runtime.queue.replay
runtime.queue.purge
runtime.config.reload
runtime.config.deploy
runtime.config.rollback
runtime.config.driftDetect
runtime.diagnostics.collect
runtime.remediation.automated
runtime.container.inspect
runtime.container.control
```

Every mutating entry includes scope, asynchronous behavior, idempotency, reversibility, approval requirement, expected traffic impact, and timeout. A broad lifecycle capability never authorizes a destructive sub-operation.

---

# Logging Capabilities

supportsStructuredLogs

supportsCentralizedLogging

supportsLogStreaming

supportsCorrelationIDs

supportsLogFiltering

supportsLogExport

supportsAuditLogging

supportsHistoricalLogs

---

# API Capabilities

supportsHTTPAdminAPI

supportsRESTAPI

supportsGraphQL

supportsWebSockets

supportsStreamingAPI

supportsWebhookCallbacks

supportsMetricsAPI

supportsConfigurationAPI

---

# Security Capabilities

supportsTLS

supportsmTLS

supportsCertificateManagement

supportsSecretsManagement

supportsRBAC

supportsAuditTrail

supportsEncryptionAtRest

supportsEncryptionInTransit

supportsRateLimiting

supportsIPWhitelisting

---

# Deployment Capabilities

supportsDocker

supportsDockerCompose

supportsKubernetes

supportsPodman

supportsRollingUpdates

supportsBlueGreenDeployment

supportsCanaryDeployment

supportsZeroDowntimeReload

---

# Monitoring Capabilities

supportsPrometheus

supportsOpenTelemetry

supportsGrafana

supportsSNMP

supportsHealthDashboard

supportsPerformanceDashboard

supportsAlertIntegration

supportsIncidentGeneration

---

# AI Capabilities

supportsOperationalTelemetry

supportsPrediction

supportsRecommendationEngine

supportsRootCauseAnalysis

supportsSelfHealing

supportsKnowledgeExport

supportsExplainability

supportsAnomalyDetection

---

# Plugin Capabilities

supportsPluginLifecycle

supportsPluginEvents

supportsPluginMenus

supportsPluginAPI

supportsPluginUI

supportsPluginPermissions

supportsPluginStorage

supportsPluginMonitoring

---

# Capability Discovery

Every Engine Adapter shall implement

discoverCapabilities()

The method returns a complete typed manifest for a specific engine instance, engine build, adapter build, and observation time.

Capabilities are never inferred from engine name. Missing, failed, expired, or not-probed capabilities are `unknown`, not unsupported. Manifests record whether facts are statically declared, runtime-probed, or operator-overridden. Version/build changes invalidate prior active manifests. Last-known-good manifests may support stale UI visibility but may not authorize mutations.

---

# Example

Engine: Kannel

Illustrative manifest (probe evidence still required):

```text
protocol.smpp.client             supported
api.rest                         unsupported
storage.sqlbox                   unknown (optional extension)
observability.runtime.metrics    partial
runtime.config.reload            unknown
observability.logs.structured    unknown
```

---

Engine: Kamex

Illustrative documented baseline (runtime probe still required):

```text
protocol.smpp.client             supported
api.rest                         supported
storage.sqlbox                   unknown (optional package)
observability.runtime.metrics    supported
runtime.config.reload            supported
observability.logs.structured    supported
```

---

# Engineering Rule

Business modules SHALL NOT contain logic such as

if engine == "Kamex"

or

if engine == "Kannel"

Instead

EngineAdapter.getCapabilities()

↓

Business Module

↓

Capability Evaluation

↓

Behavior Selection

---

# Future Expansion

The registry is expected to grow as new messaging engines and protocols are added.

No capability shall be removed without a formal Architecture Decision Record (ADR).

## Ownership and Persistence

Engine-native functionality must be distinguished from adapter normalization and JKANNEL platform features. Grafana dashboards, AI workflows, plugin menus, RBAC, orchestration strategies, and similar platform/integration functions must not be advertised as engine-native unless the engine itself supplies them.

JKANNEL persists immutable capability and runtime snapshots according to `ENGINE_OBSERVABILITY_DATA_MODEL.md`. Engine-owned SQLBox/message/DLR databases are external data sources; they do not become the JKANNEL system of record.

## Legacy Alias Mapping

| Legacy name | Canonical ID |
|---|---|
| `supportsSqlBox`, `supports_sqlbox` | `storage.sqlbox` |
| `supportsDatabaseStorage`, `supports_database_message_store` | `storage.message.database` |
| `supportsRuntimeMetrics`, `supports_runtime_metrics_api` | `observability.runtime.metrics` |
| `supportsQueueInspection`, `supports_queue_visibility` | `runtime.queue.inspect` |
| `supportsLiveBindStatus`, `supports_live_bind_status` | `runtime.bind.inspect` |
| `supportsHotReload`, `supports_config_hot_reload` | `runtime.config.reload` |
| `supportsHealthChecks`, `supports_native_healthcheck` | `observability.health.native` |
| `supportsDocker`, `supports_docker_native_runtime` | `deployment.container.image` |

The registry is the authoritative source for feature discovery across all messaging engines supported by JKANNEL.

End of ENGINE_CAPABILITY_REGISTRY.md
