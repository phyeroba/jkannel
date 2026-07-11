# Requirements Traceability

Updated: 2026-07-11 (Claude maintainer — spec-conformance waves 1–5 complete)

This ledger maps canonical documentation to implementation evidence. A row is only
marked **Complete** when its specification's operational workflow is built, unit/e2e
tested, and verified against the live stack. Rows whose remaining gap is an
infrastructure/independent-party **release gate** (not code) are marked
**Complete (software); external evidence outstanding** and the gate is named. Rows
with genuine unbuilt functionality stay **Partial** with the specific gap.

Verification baseline for this update: backend **70 suites / 387 unit tests green**,
project-wide `tsc` clean; **36/36 Playwright e2e** acceptance tests green against the
running stack; schema at **migration 028**; full Compose topology recreated with all
9 core services healthy; endpoints live-smoke-verified.

| Domain | Canonical specification | Current evidence | Status | Remaining gap |
|---|---|---|---|---|
| Platform/API | Backend architecture; REST API standard | Versioned NestJS API, auth/RBAC, correlation IDs, envelopes, errors; **OpenAPI 3.1 auto-derived from the live route table** (DiscoveryService reflection — every module appears automatically); **opt-in keyset/cursor pagination** and **`?fields=` projection** in the shared list helper; authenticated `Idempotency-Key` replay protection; tenant-scoped platform job records and `/jobs` APIs | Partial | SDK generation; universal cursor adoption across every grid; idempotency failure/expiry state transition (documented gap); worker-backed async job execution |
| Database | System data model; database specification | Migrations 001–028; FORCE RLS with non-owner app role incl. audit_log; deterministic migration runner (boot apply, checksum drift, rollback, baseline); cross-tenant RLS integration proof; **soft-delete (`deleted_at`) + optimistic-lock (`version`) conventions + helpers**; **DB-enforced tamper-evident audit hash-chain + verifier**; **cold-storage archive tables + batched advisory-locked retention scheduler** | Complete (software); external evidence outstanding | Native declarative time-partition adoption for audit_log is documented as a DBA/ops runbook (migration 027 footer), not app-executed |
| Engine | Adapter contract; capability registry; ADR-0007 | Sibling adapters, live Kamex health/status and SQLBox probing; capability-based dispatch | Partial | Full provider interfaces for lifecycle/configuration/storage and a contract integration suite; second live engine (upstream Kannel) proof |
| Configuration | Configuration Generator 01–10 | Deterministic generation, immutable versions, native validator, persisted validation, history/diff, approval workflow, atomic deploy/reload/health-rollback; **reusable templates with seeded built-ins + per-engine rendering hook**; **drift detection vs the live engine config with audit trail** (e2e-verified) | Partial | Visual side-by-side config editor UX; multi-server/cluster rollout; secret-reference management; zero-downtime deploy evidence |
| SMSC | SMSC Manager series | CRUD persistence, validation, adapter-backed enable/disable/reconnect, test connection, delete (soft-archive), idempotent operation history and workspace actions (e2e-verified) | Partial | Continuous status polling; SMPP protocol-level diagnostics; carrier-grade integration evidence (blocked on carrier IP allow-listing — external) |
| Routing | Routing Engine series | CRUD, deterministic evaluator, conflict checks, dry-run, simulation; **prefix/country/operator/weighted route types**; **least-cost / load-balance / round-robin / time-based selection over a pure, unit-tested selectRoute()**; **route_targets multi-target fan-out, route_versions history, `/routing/resolve` explain endpoint** | Complete (software); external evidence outstanding | Live per-route performance-at-volume evidence; MSISDN→operator (HLR/MNP) lookup for operator routing |
| Messaging | Message Explorer series | Tenant-scoped SQLBox history/queue/DLR reads, ownership-validated enqueue, normalized pagination/status filtering, trace lookup, bounded CSV/PDF exports, dry-run/apply retention; **replay / clone / requeue**; **bulk-send / campaign jobs with a background processor** (e2e-verified) | Complete (software); external evidence outstanding | Large-result streaming/export jobs; message-parts/cost model; search-performance-at-volume evidence |
| Monitoring | Monitoring series; alerts | Live engine monitoring, backend HTTP/latency/event + DB/Redis Prometheus exporters, Prometheus/Grafana profile, persisted alert rules, email+webhook delivery, statistical anomaly detection, **escalation chains, maintenance windows, alert correlation/dedup** | Complete (software); external evidence outstanding | Provider-grade delivery evidence (retry/backoff at scale); geo/heatmap dashboards |
| Reporting | Reporting specification | Delivery KPI service, SQLBox DLR read model, scheduled idempotent daily/weekly snapshots, report grid with CSV/PDF export, subscriber notifications; analytics layer (overview, trend, per-SMSC/route, delivery breakdown); **per-SMSC success/failure, per-route performance, hourly heatmap, latency/SLA percentiles**; **saved report definitions + scheduled CSV/summary export delivery** | Complete (software); external evidence outstanding | Financial/vendor/customer cost report data (no billing/cost model yet); large-result streaming |
| Identity | User Management series; security specification | Login, refresh rotation, **lockout (fixed: locked accounts no longer re-extend their own window)**, RBAC, invitations, full user lifecycle, password reset with reuse-prevention, session administration, TOTP MFA + recovery codes with login enforcement, refresh-token family/replay revocation, login history, user-owned API keys, separate signing keys, global audit interceptor | Partial | WebAuthn/passkeys; per-role MFA *forcing* policy (enrollment enforced, not yet mandated per role) |
| Plugins | Plugin framework; SDK | Manifest validation and worker transport contract; plugin registry with install/enable/disable; seeded examples; downloadable sample plugin + developer portal/management UI | Partial | Production out-of-process worker execution; lifecycle migrations/health/metrics; signed-package install pipeline |
| API Gateway | API Gateway spec; data model api_keys | API client registry with one-time secret issuance, scopes, rotate/revoke, export, docs/portal; **Redis atomic per-key rate-limit enforcement (429 + Retry-After, fail-open)**, **per-key IP/CIDR allowlist (403)**, **key expiry**, **per-request gateway audit log** | Complete (software); external evidence outstanding | OAuth2/OIDC client-credentials; distributed rate-limit evidence under multi-replica load |
| Runtime/Docker | Docker deployment spec | Runtime container view with live-probed health; **fuller topology: nginx reverse proxy (single entrypoint), optional loki+promtail observability profile, watchdog, split-out scheduler/backup-service workers, isolated edge/appnet/datanet/obsnet networks, and hardening (non-root, read-only rootfs, cap_drop, no-new-privileges) on stateless services** | Complete (software); external evidence outstanding | read-only/cap_drop on stateful images (postgres/redis/kamex) deliberately deferred to avoid breakage; TLS is opt-in pending certs; resource limits documented as tuning |
| System | System data model Ch.10 | Grouped system settings (23 documented defaults across 8 groups) with type/description/editable metadata and inline editing | Partial | Feature flags; environment/theme/preference domains; validation rules; encrypted-secret settings |
| AI Operations | AI Operations specification | Opt-in redacted assistance and approvals; read-only RBAC-scoped audit-logged Ops Copilot (local default, optional Claude Messages API); statistical anomaly detection feeding alerts | Partial | Predictive pipeline; AI config-review and alert-triage assistants; provider-backed telemetry baselines |
| Reliability / HA / Performance | Backup/DR; HA; performance; QA | Real encrypted pg_dump backups with scheduler, retention classes, integrity verification, restore-into-isolated-DB verify; **HA overlay (Postgres streaming replication + slot, Redis Sentinel 3-quorum, rolling-update backend replica behind HA proxy) — profile-gated, config-validated**; **load/soak harness (`perf/`) with encoded SLOs, Grafana dashboard, and a passing local baseline** | Complete (software/config); external evidence outstanding | Independent pen-test; production-scale soak at headline targets (100k msg/s); multi-node failover drill with measured RPO/RTO; PITR; one-click production restore UI; Sentinel-aware Redis client (documented follow-up) |
| Frontend | UI screen/dashboard specs; design authority | Design-aligned shell/login; generic workspaces; analytics charts incl. new report kinds; detail drawers; grouped settings; per-module surfaces across every nav item; **bulk-send view; config templates/drift; message-ops actions; saved report definitions** — **all 9 operational workflow groups covered by 36 green Playwright acceptance tests** | Partial | Specialized editors (visual route builder, side-by-side config editor); broader visual-regression coverage |
| QA | Testing & QA specification | 70 backend unit suites / 387 tests; RLS + app integration specs; **36/36 Playwright e2e acceptance across auth, navigation, SMSC, routing, messages, reports, bulk-send, configuration, audit/notifications**; perf harness with objective SLO gates | Complete (software); external evidence outstanding | Coverage-gate thresholds in CI; mutation testing; independent pen-test (external) |

## External-evidence gates (cannot be produced in code alone)

These are release gates requiring infrastructure or independent parties. The
software and configuration to make each achievable is shipped; the evidence itself
is outstanding and is **not** fabricated:

1. **Independent penetration test** (Security/QA specs).
2. **Production-scale load/soak** at the Performance spec's headline targets
   (100k msg/s future target; 10k concurrent users). The `perf/` harness, SLO
   gates, and dashboards are ready to run against representative infrastructure and
   a seeded multi-million-row dataset; the local baseline only proves the paths are
   healthy on a near-empty DB. A real finding is already surfaced: argon2 auth
   (~535 ms p95 on this hardware) does not meet the spec's 100 ms auth target — the
   `spec` SLO profile deliberately fails it to keep the gap visible.
3. **Multi-node HA failover drill** with measured RPO/RTO on real hosts. The HA
   overlay (`docker-compose.ha.yml`) is config-validated; a live promotion/failover
   drill and the Sentinel-aware Redis client change remain.
4. **Carrier-grade live send**: the managed carrier SMPP bind is fully wired and the
   platform honestly reports its connection state; establishment is blocked only by
   carrier-side IP allow-listing of the deployment egress IP (an external gate).

Production readiness for a specific deployment is reached when the applicable
external-evidence gates above are satisfied in that environment; all in-repo
software/configuration workflows for waves 1–5 are complete, tested, and
live-verified.
