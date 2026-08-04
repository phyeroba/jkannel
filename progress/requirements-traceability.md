# Requirements Traceability

Updated: 2026-08-04 (Claude maintainer — **corrected after an independent audit**)

> ## ⚠️ Correction notice — read this before trusting any row below
>
> A systematic specification-vs-implementation audit
> (**[`project/SPEC_GAP_ANALYSIS.md`](../project/SPEC_GAP_ANALYSIS.md)**) found that earlier
> revisions of this ledger were **materially overstated**. The failure was systematic,
> not dishonest, and it had a single shape:
>
> **This ledger booked *capability shipped* as *capability delivered*.**
>
> Code was written, tested and merged — then recorded as satisfying a requirement
> **without verifying that anything actually calls it**. Measured adoption of components
> previously cited as evidence: cursor pagination 1/18 grids, `?fields=` 1/18,
> soft-delete 4/71 tables, `AlertEvaluatorService` **0 callers**, `requireCapability()`
> **0 callers**, `PluginManifestValidator` **0 callers**, `SmscService` **0 injections**,
> `selectRoute()` 1 preview endpoint and **0 send paths**, customer quota/credit
> **0 send paths**.
>
> Eight rows previously marked **Complete** are not defensible and have been downgraded
> below. The decisive test now applied to every row is: **does a non-test caller reach
> this on a real request path?** If not, it is not delivered.
>
> Three integration voids explain most of it: the **configuration generator never reads
> `smsc_definitions`**, the **routing engine is not on the send path**, and **alert rules
> are never evaluated**. Per-row detail, evidence and effort estimates live in the gap
> analysis; it supersedes this table wherever the two disagree.

This ledger maps canonical documentation to implementation evidence. A row is only
marked **Complete** when its specification's operational workflow is built, unit/e2e
tested, verified against the live stack, **and reachable from a real request path**.
Rows whose only remaining gap is an infrastructure/independent-party **release gate**
(not code) are marked **Complete (software); external evidence outstanding** and the
gate is named. Everything else is **Partial** with the specific gap named.

Verification baseline: backend **75 suites / 463+ unit tests green**, project-wide
`tsc` clean; schema at **migration 028**; full Compose topology healthy; Live Queue
reroute/resend live-verified against the running engine. Test counts measure the
tests that exist — per the audit they are **not** evidence of spec coverage
(no CI, no coverage gate, and 22 of 33 e2e tests are navigation smoke).

| Domain | Canonical specification | Current evidence | Status | Remaining gap |
|---|---|---|---|---|
| Platform/API | Backend architecture; REST API standard | Versioned NestJS API, auth/RBAC, correlation IDs, envelopes, errors; **OpenAPI 3.1 auto-derived from the live route table** (DiscoveryService reflection — every module appears automatically); **opt-in keyset/cursor pagination** and **`?fields=` projection** in the shared list helper; authenticated `Idempotency-Key` replay protection **with failure-state release + stale-`processing` reclaim (a crashed request no longer blocks retries)**; tenant-scoped platform job records and `/jobs` APIs | Partial | SDK generation; universal cursor adoption across every grid; worker-backed async job execution |
| Database | System data model; database specification | Migrations 001–028; FORCE RLS with non-owner app role incl. audit_log; deterministic migration runner (boot apply, checksum drift, rollback, baseline); cross-tenant RLS integration proof; **soft-delete (`deleted_at`) + optimistic-lock (`version`) conventions + helpers**; **DB-enforced tamper-evident audit hash-chain + verifier**; **cold-storage archive tables + batched advisory-locked retention scheduler** | Partial (downgraded) | Four spec chapters are at 0% table coverage (MESSAGING 0/20, DLR 0/9, QUEUE 0/9, MONITORING 0/13 = 51 tables); ROUTING 3/24; SYSTEM 1/15. The soft-delete and optimistic-locking standards the spec calls mandatory are applied to 4 of 71 tables. `audit_signatures` has a service but no table. Native `audit_log` partitioning remains a DBA runbook. |
| Engine | Adapter contract; capability registry; ADR-0007 | Sibling adapters, live Kamex health/status and SQLBox probing; capability-based dispatch | Partial | Full provider interfaces for lifecycle/configuration/storage and a contract integration suite; second live engine (upstream Kannel) proof |
| Configuration | Configuration Generator 01–10 | Deterministic generation, immutable versions, native validator, persisted validation, history/diff, approval workflow, atomic deploy/reload/health-rollback; **reusable templates with seeded built-ins + per-engine rendering hook**; **drift detection vs the live engine config with audit trail** (e2e-verified) | Partial | Visual side-by-side config editor UX; multi-server/cluster rollout; secret-reference management; zero-downtime deploy evidence |
| SMSC | SMSC Manager series | CRUD persistence, validation, adapter-backed enable/disable/reconnect, test connection, delete (soft-archive), idempotent operation history and workspace actions (e2e-verified) | Partial | Continuous status polling; SMPP protocol-level diagnostics; carrier-grade integration evidence (blocked on carrier IP allow-listing — external) |
| Routing | Routing Engine series | CRUD, deterministic evaluator, conflict checks, dry-run, simulation; **prefix/country/operator/weighted route types**; **least-cost / load-balance / round-robin / time-based selection over a pure, unit-tested selectRoute()**; **route_targets multi-target fan-out, route_versions history, `/routing/resolve` explain endpoint** | Partial (downgraded) | **The routing engine is not on the send path.** `selectRoute()`'s only non-test caller is the `/routing/resolve` preview; all four send paths take `smscId` from the caller, so disabling a route changes nothing. Also missing: blacklist/whitelist, retry routing, customer routing, `route_groups`/`route_conditions`/`route_actions`; failover cannot fire because `availableSmscIds` is never populated from health; two divergent engines; no routing-depth UI; no `route_versions` restore. |
| Messaging | Message Explorer series | Tenant-scoped SQLBox history/queue/DLR reads, ownership-validated enqueue, normalized pagination/status filtering, trace lookup, bounded CSV/PDF exports, dry-run/apply retention; **replay / clone / requeue**; **bulk-send / campaign jobs with a background processor** (e2e-verified) | Partial (downgraded) | Against the spec's 10 acceptance criteria: 2 met, 2 partial, 5 fail — route trace, SMSC trace and DLR history absent; timeline is 2 rows. **Delivery-status classification now exists** (Live Queue work: DLR-derived delivered/failed/rejected/buffered/accepted/pending) but is not yet adopted by every message surface. "Replay DLR" is still unimplemented (replay re-sends the MT); retention deletes engine rows without archiving; no date-range filter. |
| Monitoring | Monitoring series; alerts | Live engine monitoring, backend HTTP/latency/event + DB/Redis Prometheus exporters, Prometheus/Grafana profile, persisted alert rules, email+webhook delivery, statistical anomaly detection, **escalation chains, maintenance windows, alert correlation/dedup** | Partial (downgraded) | **Alert rules are persisted but never evaluated** — `AlertEvaluatorService` has zero callers, so console-authored rules never fire and no error is surfaced. 2 of 12 named metrics; **zero SMSC-level metrics exported**; the `kamex-bearerbox` Prometheus job scrapes a path the engine does not serve; Grafana ships 3 Node-process panels. Escalation, maintenance windows and correlation are API-only with no UI and no seeded policy, so a default deployment sends no automatic notification. |
| Reporting | Reporting specification | Delivery KPI service, SQLBox DLR read model, scheduled idempotent daily/weekly snapshots, report grid with CSV/PDF export, subscriber notifications; analytics layer (overview, trend, per-SMSC/route, delivery breakdown); **per-SMSC success/failure, per-route performance, hourly heatmap, latency/SLA percentiles**; **saved report definitions + scheduled CSV/summary export delivery** | Complete (software); external evidence outstanding | Financial/vendor/customer cost report data (no billing/cost model yet); large-result streaming |
| Identity | User Management series; security specification | Login, refresh rotation, **lockout (fixed: locked accounts no longer re-extend their own window)**, RBAC, invitations, full user lifecycle, password reset with reuse-prevention, session administration, TOTP MFA + recovery codes with login enforcement, refresh-token family/replay revocation, login history, user-owned API keys, separate signing keys, global audit interceptor | Partial | WebAuthn/passkeys; per-role MFA *forcing* policy (enrollment enforced, not yet mandated per role) |
| Plugins | Plugin framework; SDK | Manifest validation and worker transport contract; plugin registry with install/enable/disable; seeded examples; downloadable sample plugin + developer portal/management UI | Partial | Production out-of-process worker execution; lifecycle migrations/health/metrics; signed-package install pipeline |
| API Gateway | API Gateway spec; data model api_keys | API client registry with one-time secret issuance, scopes, rotate/revoke, export, docs/portal; **Redis atomic per-key rate-limit enforcement (429 + Retry-After, fail-open)**, **per-key IP/CIDR allowlist (403)**, **key expiry**, **per-request gateway audit log** | Partial (downgraded) | **No scope is enforced anywhere and no business function is reachable by API key.** The guard protects exactly one demo route (`/gateway/whoami`), which itself has no permission check. `api_gateway_clients` — whose `scopes`, `allowed_routes` and `rate_limit_per_min` are the row's headline evidence — is read by zero guards. 1 of 9 rate-limit dimensions. No webhook framework; the "signature" is a replayed static secret. XFF is spoofable, defeating the IP allowlist. |
| Runtime/Docker | Docker deployment spec | Runtime container view with live-probed health; **fuller topology: nginx reverse proxy (single entrypoint), optional loki+promtail observability profile, watchdog, split-out scheduler/backup-service workers, isolated edge/appnet/datanet/obsnet networks, and hardening (non-root, read-only rootfs, cap_drop, no-new-privileges) on stateless services** | Partial (downgraded) | The 14-service topology and 4 isolated networks are genuinely delivered. But `DOCKER` §17 requires every container to define CPU/memory limits and reservations, file descriptors, max connections and OOM policy: a repo-wide grep for `mem_limit|cpus|deploy:|ulimits|pids_limit` returns **zero hits** — only `restart:` is set. Per-container probes reduce to the one static endpoint. No cAdvisor, so per-container metrics do not exist. TLS remains opt-in. |
| System | System data model Ch.10 | Grouped system settings (23 documented defaults across 8 groups) with type/description/editable metadata and inline editing | Partial | Feature flags; environment/theme/preference domains; validation rules; encrypted-secret settings |
| AI Operations | AI Operations specification | Opt-in redacted assistance and approvals; read-only RBAC-scoped audit-logged Ops Copilot (local default, optional Claude Messages API); statistical anomaly detection feeding alerts | Partial | Predictive pipeline; AI config-review and alert-triage assistants; provider-backed telemetry baselines |
| Reliability / HA / Performance | Backup/DR; HA; performance; QA | Real encrypted pg_dump backups with scheduler, retention classes, integrity verification, restore-into-isolated-DB verify; **HA overlay (Postgres streaming replication + slot, Redis Sentinel 3-quorum, rolling-update backend replica behind HA proxy) — profile-gated, config-validated**; **load/soak harness (`perf/`) with encoded SLOs, Grafana dashboard, and a passing local baseline**; **Sentinel-aware Redis client (env-gated, single-host fallback) wired through both Redis consumers** | Partial (downgraded) | **`/health` was a hardcoded literal** (now being replaced with a real probe), which left LB ejection, container healthchecks, the watchdog and HA failover inert — HA cannot be called complete-in-software until that lands and is verified. Backup omits offsite/S3 replication and config/certificate capture, and `kind='incremental'` actually produces a full dump. Performance: 2 of 7 latency targets unencoded, no throughput target tested, no regression gating. Plus the external gates below. |
| Frontend | UI screen/dashboard specs; design authority | Design-aligned shell/login; generic workspaces; analytics charts incl. new report kinds; detail drawers; grouped settings; per-module surfaces across every nav item; **bulk-send view; config templates/drift; message-ops actions; saved report definitions** — **all 9 operational workflow groups covered by 36 green Playwright acceptance tests** | Partial | Specialized editors (visual route builder, side-by-side config editor); broader visual-regression coverage |
| QA | Testing & QA specification | 70 backend unit suites / 387 tests; RLS + app integration specs; **36/36 Playwright e2e acceptance across auth, navigation, SMSC, routing, messages, reports, bulk-send, configuration, audit/notifications**; perf harness with objective SLO gates | Partial (downgraded) | **CI does not exist** — no `.github/`, no pipeline of any kind — so the previously claimed "coverage gates in CI" implied a pipeline that is absent. No `coverageThreshold`, coverage never measured, no ESLint config or dependency anywhere in the repo. 22 of 33 e2e tests are navigation smoke; of the rest only three are genuine workflows, and `reports.spec.ts` explicitly accepts `unavailable` as a pass. Nothing exercises the create→validate→deploy→bind acceptance chain. |
| Live Queue & Reroute | Queue/Message Explorer ops; SMSC Manager runtime control | **New.** `GET /queue-console/live` (per-bind status + queue depth + engine counters, tenant-filtered, honest `source` when the engine is unreachable); pending-spool grid; **`POST /spool/reroute`** (true zero-restart retarget of a queued message, tenant predicate in the SQL); `/spool/cancel`; **`POST /resend`** (bulk resend of failed traffic to any bind, by id or status filter); **`POST /binds/:id/control`** (start/stop/reconnect ONE bind — verified the engine and every other bind keep running); DLR-derived delivery status + `resendable`/`in-flight` presets; Live Queue console UI with auto-refresh. All live-verified end to end against the running engine | Complete (software) | **Tier-2 boundary is inherent, not a defect:** messages already inside bearerbox are exposed by its admin API only as an aggregate per-bind counter and cannot be listed, moved or cancelled individually. Supported workaround (built): disable the sick bind, then resend the affected traffic from the log. Removing the limit entirely would require JKANNEL to own the outbound queue instead of handing it to bearerbox — a deliberate architectural choice, not scheduled |
| Customers | Domain docs; data model Ch.12 | Accounts CRUD; quotas with usage counters; prepaid credit balance + append-only ledger; sender-ID approval workflow; per-customer route/SMSC bindings; all tenant-scoped with forced RLS and unit-tested | Partial | **Row previously missing from this ledger entirely.** The enforcement primitives have **zero send-path callers** — quotas, credit and sender-ID entitlements have no runtime effect, and `bulk_send_jobs` has no `customer_id`, so traffic cannot even be attributed to a customer. No customer-facing auth or reporting |
| Logging & Audit | Logging spec; audit requirements | Global audit interceptor recording every mutation; append-only `audit_log` with an immutability trigger; **DB-enforced tamper-evident hash chain + verifier endpoint**; structured JSON logs; optional Loki/Promtail aggregation profile; archive tables + retention scheduler | Partial | **Row previously missing from this ledger entirely.** No log-explorer UI; no correlation-id search across services; retention prunes engine rows without archiving them; Loki remains an opt-in profile with no shipped dashboards or alerting on log patterns |

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
