# Tasks

## Completed 2026-07-09 (Claude takeover cycle)

- [x] Reformat all backend/frontend source with Prettier and enforce formatting in scripts.
- [x] Fix the auth signing-key configuration mismatch; introduce separate access/refresh keys.
- [x] Enforce tenant RLS: migration 011 (FORCE RLS, audit_log policy, jkannel_app/jkannel_auth roles), non-owner app connections, migration runner with boot-time application, cross-tenant integration proof.
- [x] Scope all SQLBox reads/submissions to tenant-owned SMSC identifiers.
- [x] Add the global audit-trail interceptor and searchable/exportable audit-event grid.
- [x] Add uniform grid search/sort/filter/pagination and CSV/PDF exports across console list endpoints.
- [x] Add scheduled daily/weekly volume reports (total/per-SMSC/per-route) with in-app notifications (migration 012).

## Completed 2026-07-09 (Claude cycle 2)

- [x] Email/webhook notification channel delivery, wired to alerts and scheduled reports (migration 013).
- [x] Backend Prometheus metrics (HTTP counters, latency histogram, event counters).
- [x] AI Ops Copilot: read-only, RBAC-scoped, opt-in, audit-logged, local + optional Claude API.
- [x] Traffic anomaly detection feeding the alert pipeline (migration 014).
- [x] Identity workflows: password reset, invitation acceptance, session administration (migration 015).
- [x] Configure a live carrier SMPP bind as a managed SMSC and prove honest connection reporting (send pending carrier-side IP allowlisting of the deployment egress IP; carrier endpoint/credentials kept in the gitignored `.env`).
- [x] Repair the SQLBox runtime and prove the message pipeline live end to end.

## Active

- [ ] Complete the traceability gaps in `progress/requirements-traceability.md`; foundations must not be represented as complete operational modules.
- [ ] Remaining [PROPOSED] items in `SYSTEM_IMPROVEMENT_PROPOSALS.md`: MFA, refresh-token family revocation, digest-pinning non-Kamex images, doc consolidation, SMPP synthetic probe, config drift detection, historical partition/archive jobs, backup scheduler, per-module detail pages, AI config review / alert triage / routing optimization.
- [ ] Carrier-grade SMPP send once the carrier allowlists the deployment egress IP (bind is configured and auto-retrying).
- [x] Add native Kamex `bearerbox --test` validation behind an internal least-privilege validator boundary.
- [x] Complete configuration history/diff/approval/rollback APIs and specialized UI.
- [x] Complete SMSC lifecycle/test-connection APIs and UI through adapter providers.
- [x] Complete routing simulation/conflict/deployment APIs and UI.
- [x] Complete indexed SQLBox message pagination, trace normalization, retention and exports.
- [x] Add Prometheus/Grafana monitoring profile and notification delivery.
- [x] Implement OpenAPI, idempotency and long-running job primitives from the REST standard.
- [ ] Implement production plugin worker/lifecycle and remaining identity workflows.
- [ ] Implement scheduled encrypted backups, restore workflow, HA deployment and external readiness evidence.

- [x] Validate full Docker Compose build and healthy four-service startup.
- [x] Diagnose and clear Docker Desktop host-port validation.
- [x] Restore or author the missing telecommunications domain model.
- [x] Populate the AI Operations, Plugin SDK, backup/recovery, and performance specifications.
- [x] Add distinct contract fixtures for upstream Kannel and Kamex before Engine Adapter implementation.
- [x] Incorporate engine observability entities into the Phase 3 physical schema and migrations.

## Phase 2 completed

- [x] Establish backend configuration validation, structured logging, API versioning, and global error handling.
- [x] Add backend unit and integration test harnesses.
- [x] Define the initial platform/config/health boundaries without adding business behavior prematurely.

## Phase 3 queue

- [x] Add deterministic PostgreSQL migrations and forward/rollback validation.
- [x] Implement tenant/audit/configuration and engine-observability schema foundations.
- [x] Add database SQL integration tests.
- [x] Add backup/restore smoke validation.

## Phase 4-7 active

- [x] Implement password hashing and typed access/refresh token primitives.
- [x] Implement PostgreSQL auth repository, login/session/lockout service, RBAC guards, and endpoints.
- [x] Build the permission-aware frontend operations shell.
- [x] Implement generic adapter core and separate Kannel/Kamex fixtures.
- [x] Create and validate the official digest-pinned Kamex bearerbox/smsbox runtime.

## Phases 8-10

- [x] Implement deterministic configuration validation/generation and secret placeholders.
- [x] Implement SMSC definition validation with secret-reference enforcement.
- [x] Implement deterministic priority/fallback routing evaluation.
- [x] Add tenant-RLS persistence, versioned APIs, permissions and live workflow validation for these domains.

## Phases 11-13

- [x] Implement tenant-isolated message filtering and ordered event traces.
- [x] Implement deterministic sustained-threshold alert evaluation.
- [x] Implement tenant-isolated delivery KPI and latency reporting.
- [x] Add guarded read models for alerts/reports/messages, persisted alert rules and acknowledgements, and explicit unavailable-source behavior where ingestion is not configured.

## Phases 14-16 active

- [x] Complete versioned plugin manifest/runtime isolation foundation and compatibility tests.
- [x] Complete opt-in, approval-gated, privacy-redacted AI Operations foundation and audit tests.
- [x] Complete backup/restore smoke, security configuration, bounded performance smoke, and release-readiness evidence.
- [ ] Obtain external penetration-test, production-scale soak, and multi-node failover evidence before production release.

See `ROADMAP.md` for dependency gates.
