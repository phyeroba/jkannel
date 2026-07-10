# JKANNEL Spec Conformance Plan

Author: Claude (maintainer) · Started 2026-07-10

Goal: drive JKANNEL toward full conformance with the canonical specifications under `docs/`, in prioritized, independently-verified waves. Each wave ships tested backend + frontend, applies cleanly to a fresh database, is smoke-tested against the live stack, and updates `progress/requirements-traceability.md` honestly (no foundation is marked complete while a spec workflow is unbuilt).

## Method

- **Waves, not big-bang.** Each wave targets a small set of separable domains so work parallelizes without merge conflicts and can be verified end to end before the next wave.
- **New modules over edits.** New capability goes in new NestJS modules / Vue views; shared files (`app.module.ts`, routers) are integrated by the maintainer between waves.
- **Migrations are numbered up front** per wave to avoid collisions.
- **Honesty discipline.** Anything not built, or not proven, stays "Partial"/"planned" in the ledger. External-evidence gates are called out as such.

## External-evidence gates (cannot be produced in code alone)

These spec release gates require infrastructure/independent parties and will be documented, not fabricated:
- Independent penetration test (Security/QA specs).
- Production-scale load/soak evidence (Performance spec: 100k msg/s target).
- Multi-node failover on real hardware (HA spec).

We will provide the *software and configuration* to make them achievable (replication config, load harness, HA compose/K8s manifests) and mark the evidence itself as outstanding.

## Waves

### Wave 1 — Security, Reliability, Monitoring depth (migrations 017–019)
- **Identity & Access depth** (`docs/specifications/security/*`, data model Ch.11): TOTP MFA + recovery codes with per-role enforcement; refresh-token family/replay revocation; `login_history`, `password_history`, `api_keys` (user-owned, hashed, IP/rate limited), `service_accounts`, `personal_access_tokens`.
- **Backup & DR** (`docs/specifications/operations/BACKUP_AND_DISASTER_RECOVERY_*`): real scheduled encrypted `pg_dump` artifacts, restore-execution workflow with verification, retention classes (hourly/daily/weekly/monthly/yearly), integrity checks; PITR foundation.
- **Monitoring & Alerting** (`docs/specifications/operations/MONITORING_*`, `ALERTS_*`): platform/DB/Redis Prometheus exporters; alert escalation chains; maintenance windows; alert correlation/dedup; notification templates.

### Wave 2 — Reporting, Configuration, Messaging depth (migrations 020–022)
- **Reporting** (`REPORTING_ENGINEERING_SPECIFICATION`): wire the planned report kinds (per-SMSC success/failure, per-route performance, hourly heatmap, SLA/latency percentiles); scheduled report exports (PDF via email/webhook); saved report definitions; report templates; executive dashboard.
- **Configuration generator Part 2** (`CONFIGURATION_GENERATOR_SPEC_*`): templates, per-engine rendering rules, drift detection, multi-server/cluster, secret-reference management, zero-downtime deploy.
- **Messaging depth** (`MESSAGE_EXPLORER_*`, data model Ch.15): replay/clone/requeue, bulk send/campaign jobs, message parts + status-history detail, cost fields.

### Wave 3 — Customers, API Gateway, Routing depth (migrations 023–025)
- **Customers domain** (`docs/domain/*` Customer context; data model Ch.12): accounts, quotas, credit, per-customer auth and reporting.
- **API Gateway** (`API_GATEWAY_ENGINEERING_SPECIFICATION`): real per-client rate-limit enforcement, IP restrictions, per-request gateway audit, key lifecycle/expiry.
- **Routing depth** (`ROUTING_ENGINE_SPEC_*`): cost/time/load-balance strategies, route versioning, prefix/country/operator/weighted route types.

### Wave 4 — Platform/API, data-model completeness, Docker topology
- **REST standard** (`REST_API_ENGINEERING_STANDARD`): auto-generated OpenAPI, cursor pagination everywhere, full idempotency, worker-backed long-running jobs, field selection, edge rate limiting.
- **Data model** (`SYSTEM_DATA_MODEL_*`): historical partitioning/archive jobs, soft-delete + optimistic locking conventions, audit signatures.
- **Docker** (`DOCKER_DEPLOYMENT_*`): fuller topology (nginx/reverse-proxy, loki/promtail, watchdog, scheduler, backup-service), non-root/read-only hardening, isolated networks.

### Wave 5 — HA/DR/Performance/QA
- **HA** (`HIGH_AVAILABILITY_*`): PostgreSQL streaming replication config, Redis Sentinel, stateless-API rolling updates, distributed locks.
- **Performance** (`PERFORMANCE_AND_SCALABILITY_*`): load/soak harness and dashboards against the stated targets.
- **QA** (`TESTING_AND_QUALITY_ASSURANCE_*`): coverage gates and Playwright e2e acceptance for every operational workflow.
- **External gates**: document pen-test, production soak, and multi-node failover as outstanding evidence.

## Status

- **Wave 1 — complete and pushed.** Identity depth (MFA, token-family revocation, login/password history, API keys), Backup & DR (real encrypted pg_dump, scheduler, retention, restore-verify), Monitoring depth (DB/Redis exporters, escalation, maintenance windows, correlation). Migrations 017–019. Backend 174 tests; live-verified.
- **User-reported fixes — complete and pushed.** AI Copilot CORS fix; messages clickable; SMSC edit/delete; route SMSC dropdowns; configuration baseline+edit; volume snapshot detail; Customers domain (migration 020); API Gateway docs; plugin sample + developer portal; backup restore modal with scope; roles checkboxes.
- **Wave 2 — complete and integrated.** Reporting depth (021): per-SMSC success/failure, per-route performance, hourly heatmap, latency/SLA percentiles, saved report definitions + scheduled export delivery. Configuration generator Part 2 (022): reusable templates with seeded built-ins, per-engine rendering hook, drift detection with audit trail. Messaging depth (023): message replay/clone/requeue, bulk-send/campaign jobs with a background processor. Migrations 021–023 applied (schema at 23). Backend 53 suites / 246 tests green; typecheck clean; all new endpoints live-verified (401 guarded unauthenticated, real data authenticated).

This document is updated as each wave completes; per-requirement status lives in `progress/requirements-traceability.md`.
