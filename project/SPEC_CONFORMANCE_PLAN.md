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

- **Wave 3 — complete and pushed.** API Gateway (024): Redis per-key fixed-window rate limiting (429 + Retry-After, fail-open), IP/CIDR allowlists, key expiry, tenant-scoped gateway request log. Routing depth (025): prefix/country/operator/weighted route types; least-cost/load-balance/round-robin/time-based selection over a pure tested selectRoute(); route_targets, route_versions, and a /routing/resolve preview. Customers depth (026): quotas with usage counters, prepaid credit ledger, sender-ID approval, per-customer route/SMSC bindings (enforcement primitives exposed, not yet wired into the send path). Frontend surfaced all Wave 2 depth (report kinds, saved reports, config templates/drift, message ops, bulk send). Backend 61 suites / 330 tests green; frontend build clean + 67 tests; migrations applied to schema version 26; endpoints live-verified.
- **Wave 4 — complete and pushed.** REST/OpenAPI auto-generation from the live route table + opt-in cursor pagination + field selection; data-model completeness (migration 027: soft-delete + optimistic-lock columns, DB-enforced audit hash-chain + verifier, archive tables + retention scheduler); fuller Docker topology (nginx reverse proxy, loki/promtail observability profile, watchdog, split-out scheduler/backup-service workers, isolated networks, hardening). Migration 028 fixed three defects found in live integration (audit-trigger SECURITY DEFINER so login no longer 500s, ambiguous verifier column, retention param casts) plus an nginx header-inheritance 403. Backend 70 suites / 387 tests; stack recreated onto the new topology with all 9 services healthy; live-verified.
- **Wave 5 — complete and pushed.** HA/DR overlay (`docker-compose.ha.yml`: Postgres streaming replication + slot, Redis Sentinel 3-quorum, rolling-update backend replica behind an HA proxy) — profile-gated, config-validated, live stack untouched. Performance/soak harness (`perf/`) with encoded SLOs, a Grafana dashboard, and a passing local baseline (auth-vs-spec gap honestly surfaced). Playwright e2e acceptance (`e2e/`): 36/36 green against the live stack across all nine operational workflow groups. Latent auth lockout defect fixed (locked accounts no longer re-extend their own window) with a regression test. External-evidence gates (independent pen-test, production-scale soak, multi-node failover drill, carrier live-send) documented as outstanding in `progress/requirements-traceability.md`, not fabricated.

- **Wave 6 (polish) — complete and pushed.** Idempotency failure-state recovery (a crashed request releases its key instead of blocking retries forever) and a Sentinel-aware Redis client wired through both Redis consumers.

**All six waves complete** — as *code shipped*. That is not the same as capability delivered, and the audit below proved the difference.

---

## Correction: what the wave status lines above got wrong

Read the status lines with this section beside them.

A systematic specification-vs-implementation audit
([`SPEC_GAP_ANALYSIS.md`](SPEC_GAP_ANALYSIS.md), 2026-08-04) applied one test to every
claim above: **does a non-test caller reach this on a real request path?** It found
that several wave deliverables had been merged, tested, and recorded as done while
nothing invoked them. Specifically:

- **Wave 1's monitoring depth** shipped `AlertEvaluatorService` with **zero callers**.
  Console-authored alert rules were never evaluated.
- **Wave 2's configuration generator** never read `smsc_definitions`. The SMSCs an
  operator created in the console did not reach the generator, so a generated
  configuration could not bind to an authenticated carrier.
- **Wave 3's routing depth and customers depth** were not on the send path.
  `selectRoute()` was reachable from one preview endpoint and **zero send paths**;
  customer quota and credit were enforced **nowhere**. The Wave 3 line above does
  concede "enforcement primitives exposed, not yet wired into the send path" — that
  concession was correct and should have prevented the domain rows from being treated
  as delivered.
- **Wave 4's REST primitives** reached 1 of 18 grids for cursor pagination, 1 of 18 for
  `?fields=`, and 4 of 71 tables for soft-delete. `requireCapability()` and
  `PluginManifestValidator` had **zero callers**.
- **Wave 5's QA line — "36/36 Playwright e2e acceptance across all nine operational
  workflow groups" — does not survive inspection.** The count reconciles only if a
  single `for` loop over 26 routes is counted as 26 acceptance tests. Of 40 runtime
  cases, **5 are genuinely mutating workflows**; several others pass on a broken
  backend by design. This claim is retracted.

These are stated here rather than edited out of the status lines above, because the
pattern matters more than any individual row: **this plan recorded merges, and merges
were then read as outcomes.**

## Remediation waves A–F (2026-08-04)

Six further waves ran against the gap analysis's recommended build order and closed the
three integration voids. They are summarised in
[`../progress/completed.md`](../progress/completed.md) and detailed in
[`CHANGELOG.md`](CHANGELOG.md); the per-gap evidence is in
[`IMPLEMENTATION_VERIFICATION.md`](IMPLEMENTATION_VERIFICATION.md).

| Wave | Theme | Outcome |
|---|---|---|
| **A** | Stop the bleeding | Permanent lockout, stale privileges on refresh, XFF bypass, auth throttling, real `/health`, wrong success rates, no CI — all fixed. |
| **B** | Make configuration real | Generator now composes from `smsc_definitions`; full SMPP render with `${ENV}` secret references and `requiredSecrets`. |
| **C** | Close the observability loop | Bind poller, real SMS metrics, alert-rule evaluator finally driven, escalation targets honoured. |
| **D** | Routing and customers on the send path | One transactional `MessageSendService`; entitlements enforced; API-key scopes on real endpoints. |
| **E** | Operator surfaces | Polling composable, dense columns, alert actions, UI for already-built backends. |
| **F** | Durability and platform depth | Mandatory backup key, failure alerting, honest backup kinds, a real job queue, plugin validation called. |

**Independently verified result: 10 of 20 gaps CLOSED, 7 PARTIAL, 3 OPEN.**
Nothing has been promoted back to *Complete* in the traceability ledger; the same rule
still applies, and several items need a live carrier or a real incident before they can
honestly be called done.

## Method note for future waves

Three rules, adopted after the audit and binding on anything added to this plan:

1. **A wave is not complete when its code merges.** It is complete when a non-test
   caller reaches it on a real request path, and that call site is named.
2. **State the residual limit in the same sentence as the deliverable.** Wave 3's
   parenthetical about unwired enforcement was the only line in this document that did
   this, and it was the only line the audit did not have to correct.
3. **Do not aggregate test counts across kinds.** Name what each number measures. A
   navigation loop is not an acceptance test.

This document is updated as each wave completes; per-requirement status lives in
[`../progress/requirements-traceability.md`](../progress/requirements-traceability.md),
and the user-facing capability answer is [`../FEATURES.md`](../FEATURES.md).
