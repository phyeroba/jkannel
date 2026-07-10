# Project State

**Current phase:** Phases 1-16 foundations are present; canonical-requirement completion is being tracked in `progress/requirements-traceability.md`. Maintenance transitioned to Claude on 2026-07-09; the active improvement plan is `SYSTEM_IMPROVEMENT_PROPOSALS.md`.

## What exists

- Organized documentation, architecture, decision, progress, design, application, infrastructure, SDK, plugin, test, and deployment boundaries.
- Canonical documentation catalog and six initial ADRs.
- Phase 1 backend/frontend health-check and Docker Compose scaffold.
- Reproducible npm lockfiles, clean image builds, passing backend test/typecheck and frontend production build.
- PostgreSQL, Redis, backend, and frontend reached healthy Compose state during validation.
- Evidence-backed Kannel/Kamex separation and a pre-implementation Engine Adapter capability contract.
- Versioned API foundation with validated environment, structured JSON logs, correlation IDs, response envelopes, and safe global errors.
- Deterministic Phase 3 PostgreSQL migrations for tenants, configuration, immutable audit, and engine observability/control history.
- Phase 4 cryptographic primitives: salted scrypt password hashing and typed HMAC access/refresh token validation.
- Phase 5 permission-aware Vue operations shell with JKANNEL-native navigation and responsive views.
- Phase 6 generic adapter core, typed capability manifests, registry, and distinct Kannel/Kamex fixtures.
- Official digest-pinned Kamex 1.8.3 bearerbox/smsbox Compose profile with authenticated status and metrics readiness.
- PostgreSQL authentication, refresh rotation, tenant claims, RBAC guards, development-operator provisioning, and audit writes.
- Tenant-RLS persistence and guarded APIs for SMSCs, routing, configuration versions, alert rules/acknowledgements, settings, users, and invitations.
- Functional Vue login/session/logout flow, permission-aware routing, global search, module workspaces, real API states, create forms, and not-found handling.
- Native Kamex SQLBox integration: official checksum-pinned extension image, PostgreSQL `send_sms`/`sent_sms` queue and event reads, outbound enqueue, queue depth, delivery-report reads, and live capability probing.
- Deterministic Kamex configuration rendering with SQLBox groups, immutable versions, validation, atomic runtime writes, audit transitions, and authenticated graceful reload.
- Vendor-native Kamex configuration validation through a least-privilege internal validator, plus history, diff, persisted validation, approval, deployment and rollback API workflows with approval/deployment metadata.
- Configuration workspace workflow controls for generated Kamex configuration versions: Validate, Approve, Deploy, Rollback and version comparison.
- Live adapter-backed monitoring/capability and tenant-scoped audit-event read models.
- Adapter-backed SMSC test/enable/disable/reconnect operations with idempotent deployment history and workspace controls.
- Route validation, conflict checks, simulation, deploy/rollback/history records, and route workspace simulation/deployment controls.
- Normalized Kamex SQLBox message pagination/filtering, trace lookup, DLR read model, authenticated bounded CSV export, read indexes, and dry-run/apply retention controls.
- Prometheus/Grafana Compose monitoring profile with backend Prometheus metrics, initial dashboard provisioning, and auditable dashboard/webhook notification delivery records.
- API platform primitives for OpenAPI, authenticated mutating-request idempotency and tenant-scoped long-running job records: raw `/api/v1/openapi.json`, `Idempotency-Key` replay protection, and `/api/v1/jobs` create/list/get/cancel APIs.
- Strict versioned plugin manifests and a coordinator that requires a real worker-process executor boundary; no untrusted plugin is loaded in-process.
- Deployment-disabled-by-default AI Operations with per-request consent, privacy redaction, deterministic local explanations, tenant persistence, audit, and human approval records.
- Defensive API headers plus runnable security, bounded readiness-load, and PostgreSQL backup/disposable-restore smoke checks.
- Enforced tenant isolation: FORCE row level security on all RLS tables including audit_log, a non-owner `jkannel_app` application role, a least-privilege BYPASSRLS `jkannel_auth` role for pre-authentication lookups, a deterministic migration runner (`npm run migrate`, boot-time application), and a live-database cross-tenant integration proof.
- Tenant-scoped SQLBox reads: message lists, traces, queue depth, DLRs, exports and outbound submission are restricted to the tenant's own SMSC engine identifiers with honest empty states.
- Full audit trail: a global interceptor records every authenticated mutating request and sensitive read (who/what/when, redacted parameters, outcome, correlation id, source IP); audit events are searchable, sortable, filterable and exportable.
- Uniform grid capabilities (whitelisted search/sort/filter with pagination totals) plus CSV and PDF exports across SMSC, route, alert, alert-rule, user, invitation, configuration, audit-event, notification and volume-report endpoints.
- Scheduled daily and weekly message-volume reports per tenant — total, per SMSC and per route (target-SMSC attribution) — with idempotent period claims and in-app notifications to report subscribers, plus a notification centre API.
- Separate access/refresh token signing keys with deprecated single-key fallback, and Prettier-enforced readable source formatting across both packages.
- A working SQLBox runtime: sqlbox rebuilt from the official checksum-pinned source RPM with the PostgreSQL backend (the official binary RPM panics on non-MSSQL configs) and credential rendering at container start; live end-to-end proof of API message submission through bearerbox to sent_sms and back into the tenant-scoped console grids.
- Live-stack evidence: migrations 001-015 verified on a fresh database, forced-RLS isolation proven as the non-owner role, and grids/exports/reports/notifications/audit exercised through the running API with all eight Compose services healthy.
- Real notification channel delivery: SMTP email (honest "unavailable" without SMTP_URL) and webhooks, wired to both alerts and scheduled reports.
- Backend Prometheus metrics (HTTP counters, latency histogram, event counters) at `/metrics` for the Grafana profile.
- AI Ops Copilot: a read-only, RBAC-scoped, opt-in, audit-logged assistant with privacy-safe tools; local answers by default and Claude Messages API when configured; cannot execute changes.
- Traffic anomaly detection over daily snapshots (volume drop/spike, DLR failure) opening deduplicated alerts into the existing pipeline.
- Identity workflows: password reset, invitation acceptance, and session administration (list/revoke), all proven live.
- A live carrier SMPP bind configured as a managed SMSC; blocked only by carrier-side IP allowlisting, with honest connection-state reporting.
- Complete Platform console modules: API Gateway clients, Plugins (enable/disable/install), Backups (catalog/verify/restore-request), Runtime Containers (live-probed health with honest unknowns), grouped System Settings with inline editing, and a Customers honest-unavailable placeholder (migration 016).
- Full user lifecycle (create/detail/edit/archive with roles), session search/sort/export, paginated searchable Queues and Delivery Reports with export, SMSC detail/edit with connection status, audit-event detail, and an Analytics dashboard (KPIs, traffic trend, per-SMSC/route breakdowns, delivery breakdown, seven-category report catalog) with SVG charts.

## What does not exist

- Production deployment automation and production Kannel integration. Production scale, historical partition/archive, job workers/large export execution, and alert escalation/correlation remain outstanding. Notification channels deliver (email/webhook) but production delivery-provider evidence (deliverability, retries/backoff) is not yet gathered.
- Full specialized UI editors for every planned module and browser acceptance for every workflow; unsupported services render honest unavailable states rather than simulated behavior.
- Production plugin worker implementation, independent penetration testing, HA/failover, and production-scale load/soak evidence. Carrier-grade SMPP send evidence is pending the carrier allowlisting the deployment egress IP (the bind is configured and honest about its blocked state).
- MFA and the deeper AI pipeline items (predictive analytics, AI config review, alert triage) remain proposed; the Ops Copilot is read-only and advisory only.

## Assumptions

- Development runs on current Node.js LTS-compatible containers.
- Local Compose credentials are supplied through `.env`; committed defaults are non-secret placeholders.
- `/api/v1/health` is the liveness/readiness contract.

## Selected stack

NestJS/TypeScript backend, Vue 3/TypeScript/Vite/Tailwind frontend, PostgreSQL, Redis, Docker Compose, generic Engine Adapter with Kamex as the first containerized runtime and upstream Kannel as an external sibling adapter.

## Next milestone

Exercise SMSC lifecycle, routing deployment, SQLBox pagination/trace/export and retention flows against carrier-like SMPP traffic; connect the platform job foundation to worker-backed large exports and historical archive/partition jobs; then obtain independent penetration-test, production-scale soak, and multi-node failover evidence before a production release.
