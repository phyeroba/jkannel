# JKANNEL Plugin Development SDK

- Version: 1.0
- Status: Master SDK Specification
- Governing specifications: `PLUGIN_AND_EXTENSION_FRAMEWORK_ENGINEERING_SPECIFICATION.md`, `REST_API_ENGINEERING_STANDARD.md`, `SECURITY_ENGINEERING_SPECIFICATION.md`, and `ENGINE_ADAPTER_CONTRACT.md`

## 1. Purpose and engineering rules

The SDK is the stable contract for extending JKANNEL without modifying core modules. Plugins are first-class, independently versioned components. Every extension point is documented, versioned, audited, permission-aware, observable, upgradeable, and reversible.

Plugins extend platform behavior through declared contracts; they cannot replace, patch, or bypass core authentication, authorization, auditing, monitoring, deployment, routing, configuration, or data-ownership controls.

## 2. Plugin categories

Supported categories include communication, engine, authentication, notification, dashboard, analytics, reporting, import/export, monitoring, security, billing, workflow, automation, integration, AI, developer, theme, and UI-component plugins. Every plugin declares exactly one primary category and may declare additional typed capabilities.

Engine plugins implement `ENGINE_ADAPTER_CONTRACT.md`. They are sibling adapter implementations selected per engine instance and must use capability discovery and operation-level gating; declaring a general engine capability never implies Kannel/Kamex feature parity.

## 3. Deterministic package contract

A source package has this standard layout:

```text
plugin.json
README.md
CHANGELOG.md
LICENSE
src/
config/
assets/
translations/
migrations/
tests/
documentation/
```

A distributable package contains the manifest, compiled entry point, configuration schema, permission declarations, compatibility range, plugin-owned migrations, health implementation, tests and operator documentation. Builds must be reproducible: normalized paths and timestamps, stable file ordering, a locked dependency graph, and a published package checksum.

## 4. Manifest

```json
{
  "schemaVersion": "1.0",
  "id": "com.example.plugin",
  "uuid": "00000000-0000-4000-8000-000000000000",
  "name": "Example Plugin",
  "vendor": "Example Ltd",
  "version": "1.0.0",
  "description": "Example extension",
  "category": "integration",
  "sdkVersion": "^1.0.0",
  "jkannelVersion": { "min": "1.0.0", "max": "<2.0.0" },
  "entrypoint": "dist/index.js",
  "apiVersion": "v1",
  "dependencies": { "plugins": {}, "services": [] },
  "permissions": [],
  "events": { "subscribes": [], "publishes": [] },
  "capabilities": [],
  "migrations": [],
  "configurationSchema": "config/schema.json",
  "license": "Apache-2.0",
  "checksum": "sha256:<digest>",
  "signature": "<detached-signature>",
  "supportUrl": "https://example.com/support",
  "documentationUrl": "https://example.com/docs"
}
```

`id` is the immutable, globally unique reverse-domain identity used by APIs and dependencies. `uuid` is the immutable registry/database identity. This resolves the older specifications' ambiguous use of “Plugin ID” and “Plugin UUID”; neither may be reused. Plugin versions use semantic versioning. Unknown fields are rejected unless introduced by a compatible manifest schema version.

Production packages require publisher identity, checksum, and signature verification. References in older framework/API text to digital signatures as “Future” apply only to marketplace automation, not the production installation trust gate.

## 5. Validation and installation

Before writing plugin state, the Plugin Manager validates package integrity, manifest schema, publisher/signature, checksum, platform/SDK/API/database/engine compatibility, dependency graph, license policy, permissions, configuration schema, migrations, entrypoint, and security policy. Results are `pass`, `warning`, or `blocking-error`; any blocking error prevents installation. Warnings require an explicit recorded acknowledgement where policy permits installation.

Installation registers only declared and approved routes, menus, widgets, reports, services, background jobs, API endpoints, permissions, configuration, events, hooks, metrics, health checks, capabilities, and namespaced database objects. Registration is transactional or compensating and is recorded in the central plugin registry.

## 6. Lifecycle state machine

The canonical lifecycle is:

```text
install -> validate -> migrate -> register -> configure -> enable -> start
        -> health/monitor -> stop -> disable -> upgrade/rollback -> uninstall
```

The host, not plugin code, controls transitions. `install`, `migrate`, `enable`, `start`, `health`, `stop`, `disable`, `upgrade`, `rollback`, and `uninstall` operations must be idempotent or define tested compensation. Every transition emits audit, monitoring, event, and configured notification records with correlation and actor identity. A plugin failure is contained and cannot crash frontend, backend, core APIs, routing, configuration generation, or dashboard processes.

Uninstall disables and stops the plugin first. Plugin data is retained by default; purge requires a separate, explicitly authorized destructive operation.

## 7. Runtime and host API

The versioned, typed SDK exposes least-privilege host services for:

- structured logging, health, diagnostics, metrics, audit and notifications;
- validated configuration and secret references;
- event publication/subscription and declared hooks;
- scoped storage and plugin-owned migrations;
- policy-controlled outbound HTTP;
- UI route, menu, page, widget, dashboard, dialog, report, chart and form registration;
- background jobs and declared API routes;
- capability registration and discovery.

Plugins receive scoped host APIs, never raw access to core tables, the secret store, host filesystem, container runtime, or unrestricted network. Removed SDK behavior requires a published deprecation window and migration guide.

Events include an event ID, type, schema version, tenant, correlation ID, causation ID, producer, timestamp, and redacted payload. Plugins prefer events over direct plugin-to-plugin calls. Subscriptions and hooks must be declared in the manifest and are granted only when needed.

## 8. Permissions and isolation

Permissions are denied by default and require administrator approval. Network, filesystem, UI, event, engine, message, route, configuration deployment, report, user, Docker/deployment, alert, secret-reference, and administrative scopes remain distinct. Runtime enforcement must match the exact approved scope and tenant.

Plugins cannot bypass authentication or authorization, read secret values directly, disable auditing or monitoring, modify core permissions, edit application configuration files, or invoke container operations outside the Deployment Engine. Configuration secrets are stored as references and redacted from logs, events, diagnostics, exports, and errors.

Execution boundaries enforce time, memory, CPU, concurrency, payload-size and rate limits. Repeated failure or health-policy violation triggers circuit breaking and automatic isolation without affecting core availability.

## 9. Configuration and data ownership

Plugin configuration is schema-validated and stored in the database with version history, actor, timestamps, and audit linkage. It supports policy-controlled export, import, backup, restore, and rollback.

Plugins own namespaced tables and migrations and cannot alter core or another plugin's tables. Migrations are ordered, checksum-recorded, repeat-safe, transactional where supported, and include an upgrade and downgrade/forward-fix policy. Cross-domain data is accessed only through host APIs or versioned events.

## 10. UI contributions

UI contributions use JKANNEL's design system, accessibility rules, localization, route authorization, content-security policy, and frontend compatibility contract. Plugins cannot inject arbitrary global scripts or styles. The host may disable a UI contribution independently when it fails validation or runtime health checks.

## 11. Health and observability

Every plugin reports identity/version, lifecycle state, health, dependencies, last transition/update, active configuration version, warnings, errors, resource usage, latency and plugin-defined metrics. Diagnostics must be bounded and redacted. All lifecycle, permission, configuration, migration, API, event, hook, UI and administrative operations are correlated and auditable.

## 12. Management API alignment

Plugin management uses the REST standard's `/plugins` collection and per-plugin install, enable, disable, upgrade, rollback, health, metrics and settings operations. All routes use the platform's version prefix, authentication, authorization, tenant isolation, idempotency, error envelope, correlation, audit and asynchronous-operation conventions. The SDK does not create an alternate management API.

## 13. Testing and publication gate

A distributable plugin must pass:

- deterministic build and manifest/schema/package validation;
- SDK typecheck, lint, unit and integration tests;
- lifecycle, idempotency, rollback and failure-isolation contract tests;
- permission-denial, tenant-isolation, secret-redaction and resource-limit tests;
- migration upgrade/downgrade or forward-fix and retained-data uninstall tests;
- API/event/hook/UI compatibility tests as applicable;
- dependency, license, vulnerability, checksum and signature verification;
- installation, enablement, health, disablement and upgrade in the plugin test harness.

Engine plugins additionally pass `ENGINE_ADAPTER_CONTRACT.md` capability-discovery, stale-capability, unsupported-operation, mutation-safety and per-engine conformance suites.

## 14. Acceptance criteria

The SDK foundation is complete when plugins install without core modification; deterministic packages and centrally managed metadata are enforced; lifecycle changes are reversible and audited; permissions and tenant boundaries are enforced; configuration and migrations are versioned; failures are isolated; event/hook and host APIs are version-compatible; every plugin is observable; and future marketplace integration can consume the same signed package contract without becoming a runtime dependency.
