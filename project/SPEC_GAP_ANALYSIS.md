# JKANNEL — Specification vs Implementation Gap Analysis

Author: Claude (analysis agent) · Date: 2026-08-04 · Baseline commit `acd750d`
Scope: read-only audit. No source file was modified in producing this document.

> **Bottom line.** JKANNEL has a large, clean, well-tested body of *components*. What it
> largely lacks is *integration between them*. Three of the platform's headline domains —
> SMSC Manager, Configuration Generator, and Routing Engine — are each individually built
> and individually tested, and none of them is connected to the other two or to the message
> send path. The result is a system that an operator can configure extensively and whose
> configuration changes nothing. That, rather than any missing feature, is the dominant
> finding of this audit.

---

## 1. Method

### What was read

**Specifications (canonical, `docs/`).** 77 markdown files under `docs/specifications/**`
plus `docs/domain/**`. The following were read in full or near-full because they carry the
normative weight (`shall` counts in parentheses):

| Cluster | Documents |
|---|---|
| Engine / SMSC | `KANNEL_ENGINE_ADAPTER_SPECIFICATION` (2676 L, 98 shall), `ENGINE_ADAPTER_ENGINEERING_SPECIFICATION`, `ENGINE_ADAPTER_CONTRACT`, `ENGINE_ADAPTER_ARCHITECTURE`, `ENGINE_CAPABILITY_REGISTRY`, `ENGINE_OBSERVABILITY_DATA_MODEL`, `KAMEX_ENGINE_CAPABILITY_ASSESSMENT`, `SMSC_MANAGER_SPEC_01/02/03/04/05/06/10` + `SMSC_MANAGER_CATALOG` |
| Messaging / Routing | `MESSAGE_EXPLORER_ENGINEERING_SPECIFICATION` (17 shall) + `SPEC_01–04`, `ROUTING_ENGINE_SPEC_01–09`, `TELECOMMUNICATIONS_DOMAIN_MODEL` |
| Data model / REST | `SYSTEM_DATA_MODEL_ENGINEERING_SPECIFICATION` (7497 L, 57 chapters, 95 shall), `REST_API_ENGINEERING_STANDARD` (5595 L, 91 chapters, 101 shall), `DATABASE_ENGINEERING_SPECIFICATION`, `DATABASE_ARCHITECTURE`, `API_ARCHITECTURE`, `API_PLATFORM_PRIMITIVES` |
| Security / Identity / Audit | `SECURITY_ENGINEERING_SPECIFICATION`, `USER_MANAGEMENT_ENGINEERING_SPECIFICATION` + `SPEC_01–04`, `LOGGING_AND_AUDIT_ENGINEERING_SPECIFICATION`, `API_GATEWAY_ENGINEERING_SPECIFICATION` |
| Operations | `MONITORING_SPEC_01–03`, `ALERTS_ENGINEERING_SPECIFICATION`, `REPORTING_ENGINEERING_SPECIFICATION`, `BACKUP_AND_DISASTER_RECOVERY_*`, `HIGH_AVAILABILITY_*`, `PERFORMANCE_AND_SCALABILITY_*`, `TESTING_AND_QUALITY_ASSURANCE_*`, `DOCKER_DEPLOYMENT_*` |
| UI | `UI_SCREEN_ENGINEERING_SPECIFICATION` (3561 L), `DASHBOARD_ENGINEERING_SPECIFICATION_2`, `DASHBOARD_SPEC_01–03`, `FRONTEND_ENGINEERING_SPECIFICATION`, the three per-module UI specs |
| Config / Plugins / AI / Backend | `CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION` + `SPEC_01–10`, `PLUGIN_AND_EXTENSION_FRAMEWORK_*`, `PLUGIN_DEVELOPMENT_SDK`, `AI_OPERATIONS_ENGINE_SPECIFICATION` (2774 L), `BACKEND_ARCHITECTURE_*`, `PRODUCT_SCOPE`, `PRODUCT_VISION`, `SUCCESS_CRITERIA`, `SYSTEM_PHILOSOPHY` |

**Implementation.** All 228 backend TypeScript files under `backend/src/`, all 28 up-migrations
under `database/migrations/`, the Vue frontend under `frontend/src/`, `docker-compose.yml`,
`docker-compose.ha.yml`, `infrastructure/`, `runtime/`, `perf/`, `e2e/`.

**Ledgers under audit.** `project/SPEC_CONFORMANCE_PLAN.md`, `progress/requirements-traceability.md`,
`project/CONFORMANCE_RUN_SUMMARY.md`, `project/PROJECT_STATE.md`, `project/SYSTEM_IMPROVEMENT_PROPOSALS.md`.

### How claims were verified

Every finding below is grounded in one of three kinds of evidence:

1. **Call-site tracing** — for "is X actually used?" questions, the decisive test was grepping
   for callers of the symbol across `backend/src` excluding `*.spec.ts`. A function whose only
   non-test caller is a preview endpoint is not wired into the product, regardless of how well
   it is tested. This test produced most of the top-ranked gaps.
2. **Schema diffing** — the spec's declared entities versus `CREATE TABLE` statements actually
   present in `database/migrations/*.up.sql` (74 statements, 71 real tables + 1 bookkeeping
   table + 2 partition children).
3. **Rendered-artifact comparison** — the config the generator emits versus the config the
   running engine actually needs (`runtime/kamex/kamex.conf`).

Nothing in the traceability ledger was accepted on its word; each row was independently
re-derived from code and is graded in §4.

### Scope calls made deliberately

- **The queue-console work in flight is excluded.** `backend/src/queue-console/` (598 LoC) and
  `frontend/src/views/LiveQueueView.vue` (1147 LoC) are being written concurrently by another
  agent. Per-bind queue depth, spool reroute, resend-to-bind and per-bind start/stop are treated
  as in progress and are **not** counted as gaps.
- **Product-scope future items are not gaps.** `docs/domain/PRODUCT_SCOPE.md` explicitly places
  **Billing, Customer portal, AI diagnostics, Kubernetes deployment, Plugin marketplace** in
  *Future Scope*. Missing billing/rating/invoicing is therefore recorded as out-of-current-scope,
  not as a conformance gap — with one exception noted in §3 (per-message cost is a *prerequisite*
  for the least-cost routing strategy the routing spec does mandate).
- **The two mega-specs are read as catalogues, not checklists.** `SYSTEM_DATA_MODEL` names 179
  entities; `UI_SCREEN` enumerates ~236 navigation leaves and ~116 detail tabs. Literal
  conformance to either is not a sensible engineering target, and this report does not treat
  the raw shortfall as 149 or 214 "gaps". What it does do is identify which *whole domains*
  within them are absent and rank those by operator value.
- **Aspirational specs are named as such** rather than counted (see §3, final subsection).

---

## 2. Summary table

Legend — **Yes** = spec's operational workflow is built and reachable; **Partial** = substantial
build with a named material shortfall; **No** = requirement has no implementation.
"Ledger" = the status in `progress/requirements-traceability.md`; a ✗ marks a status this audit
could not substantiate.

| Spec / domain | Key requirements | Impl? | Evidence (file:symbol) | Principal gap | Ledger |
|---|---|---|---|---|---|
| **Configuration Generator** 01–10 | DB is the source of truth; full kannel.conf model (16 groups); validation pipeline; immutable versions; approval; atomic deploy + rollback; drift | **Partial** | `configuration/configuration-generator.service.ts:renderKamex`, `:validate`; `configuration/configuration-deployment.service.ts:deploy`; `configuration-depth/config-drift.service.ts` | **Model is not DB-derived** — no code reads `smsc_definitions` to build `EngineConfiguration`; renderer emits only `core` + `smsc{id,host,port}` + one `pgsql-connection`. No credentials, no SMPP tuning, no `smsbox`/`sendsms-user`/`sms-service`/`dlr-storage`/SSL groups. Kannel arm throws. | Partial ✗ (gap list omits the two biggest items) |
| **SMSC Manager** 01–06,10 | 7 SMSC types; 19 attributes; bind lifecycle; continuous health; groups/versions/metrics; clone/bulk/import; per-SMSC deploy/rollback | **Partial** | `console/console.controllers.ts:SmscController`; `console/console.repository.ts:createSmsc/updateSmsc/archiveSmsc/beginSmscOperation`; `smsc/smsc-connectivity.service.ts:test`; `engine/kamex.adapter.ts:controlSmsc` | 4/7 types; 8/19 attributes (no system-id, bind mode, TON/NPI, window, TLS, retry); `update` touches 5 columns; "test connection" is a bare TCP connect; `reconnect` == `enable`; 3/7 spec tables; no status polling, no bind history | Partial ✗ (omits the config-render gap) |
| **Engine Adapter** contract/registry/observability | 18 provider interfaces; capability-gated mutations; manifest per canonical ID; persisted observability | **Partial** | `engine/engine-adapter.types.ts:EngineAdapterCore`; `engine/engine-adapter.registry.ts:smscControl`; `engine/capability-manifest.ts:requireCapability`; `engine/kamex.adapter.ts:queueSnapshot` | 1 of 18 providers; dispatch is `'controlSmsc' in adapter` duck-typing; `requireCapability()` has **zero call sites**; `approvalRequired` never read; manifests carry 8/29 IDs mostly asserted from vendor docs; **all 10 `002_engine_observability` tables are unreferenced by any code**; `kannel.adapter.ts` performs no I/O | Partial (accurate, understated) |
| **Routing Engine** 01–09 | "determines how every SMS is delivered"; 12 route types; 9-step evaluation incl. throttle+submit+decision audit; blacklist/whitelist; retry; failover; groups/conditions/actions | **Partial** | `routing-depth/route-selection.ts:selectRoute` (clean, well-tested); `routing-depth/routing-depth.service.ts:resolve`; `routing/routing.service.ts:evaluate` (legacy) | **`selectRoute()`'s only non-test caller is the `/routing/resolve` preview.** No send path consults routing. Two divergent engines; the UI simulator calls the legacy one. No blacklist/whitelist, retry, customer routing, route groups/conditions/actions. `candidateRoutes` ignores `deployment_state`. No routing-depth UI. | Complete ✗ |
| **Message Explorer** + 01–04 | 22 search criteria; 13-stage lifecycle; route/SMSC/customer/DLR traces; parts+cost; `messages`/`message_events`/`dlrs` tables | **Partial** | `engine/kamex-sqlbox.repository.ts:list/trace/exportCsv/submit`; `messaging-depth/message-operations.service.ts:replay/clone/requeue`; `messaging-depth/bulk-send.service.ts` | 5/22 filters — **no date range**; 3 statuses; **`dlr_mask` never decoded** so failure is unknowable; spec-03's 4 tables absent (no owned message store); `coding/udhdata/validity/binfo` sit in `sent_sms` and are never SELECTed; export drops the `status` filter; search is unindexable `ILIKE '%…%'` | Complete ✗ |
| **System Data Model** (57 ch.) | 179 entities across 12 written chapters; soft-delete + versioning mandatory on operational entities; `audit_signatures` | **Partial** | 71 tables in `database/migrations/*.up.sql`; `data-model/soft-delete.ts`, `optimistic-lock.ts`, `audit-chain.ts` | Ch.15 MESSAGING 0/20, Ch.16 DLR 0/9, Ch.17 QUEUE 0/9, Ch.18 MONITORING 0/13 — **51 tables, zero built**; Ch.14 ROUTING 3/24; Ch.10 SYSTEM 1/15. `deleted_at`/`version` on **4 of 71** tables; helpers imported by **one** service | Complete ✗ |
| **REST API Standard** (91 ch.) | Envelope, 15 error categories, problem+json, cursor default, 14 filter operators, sparse fieldsets, idempotency, ETag, rate-limit headers, async 202, webhooks, deprecation, SDK | **Partial** | `platform/response-envelope.interceptor.ts`, `http-exception.filter.ts`, `list-query.ts`, `cursor.ts`, `field-selection.ts`, `idempotency.interceptor.ts`, `openapi-generator.ts` | Cursor adopted by **1 of 18** grids; `?fields=` by **1 of 18**; **1 of 14** filter operators; 2 of 15 error categories and `errors[]` never populated; no problem+json; **no ETag/If-Match**; no rate limiting on the JWT API; no Deprecation/Sunset; **`@HttpCode(202)` appears nowhere**; envelope `meta`/`links`/`warnings` are hardcoded empty | Partial (gap list ~25% complete) |
| **Security** | Argon2id; configurable password policy; TLS 1.3; session limits/idle timeout/forced logout; secrets never plaintext; intrusion detection | **Partial** | `security/auth.service.ts:login/refresh`; `password-hasher.ts`; `identity-crypto.ts:encryptSecret`; `platform/security-headers.middleware.ts` | **scrypt not Argon2id**; policy hard-coded and the Settings UI knobs are read by nothing; **no TLS listener in either nginx config**; no concurrent-session cap or idle timeout; `AuthGuard` never consults `auth_sessions`; **webhook secrets stored and returned in plaintext**; no intrusion detection | (folded into Identity) |
| **User Management** 01–04 | 8 default roles, configurable; permissions never hardcoded; 18 profile fields; login-history/session field sets | **Partial** | `security/permissions.guard.ts`; `003_identity_access.up.sql`; `security/create-development-operator.ts` | **0 of 8 spec roles seeded** (only a production-disabled dev script creating `administrator`); **no role or permission CRUD API**; 22 permission codes hard-coded in decorators; `users` table never altered since migration 003 → **12 of 18 profile fields absent**; seed omits 3 enforced permissions | Partial ✗ (2-item gap list) |
| **Logging & Audit** | 25 log categories, 8 levels, 12 structured fields, pipeline, live viewer, search, per-level retention, syslog/CEF/LEEF | **Split** | Audit: `platform/audit-trail.interceptor.ts`, `028_audit_chain_fix.up.sql:audit_log_sign`, `data-model/audit-signature.service.ts:verifyChain`. Logging: `platform/json.logger.ts:write` | **Audit half is the strongest artefact in the repo.** Logging half is unbuilt: logger emits 4 fields, correlation IDs never reach log lines, no categories/levels/pipeline/viewer/search/rotation, **no SIEM export**. `audit_log` lacks spec columns role/session_id/hostname/result | **No ledger row at all** |
| **API Gateway** | Per-endpoint scopes; webhooks (10 events, retries, signing); 9 rate-limit dimensions; per-request audit with duration | **Partial** | `api-gateway/api-key-auth.guard.ts`, `gateway-rate-limiter.ts:consume`, `ip-allowlist.ts`, `gateway-audit.interceptor.ts` | **`ApiKeyAuthGuard` protects exactly one route — `GET /gateway/whoami`** — which carries no `PermissionsGuard`. No business function is reachable by API key; no scope is enforced anywhere. Two disjoint credential systems (`api_gateway_clients` is read by no guard). No webhook framework; the "signature" is a replayed static secret. 1 of 9 rate-limit dimensions | Complete ✗ |
| **Monitoring** 01–03 | 12 named core metrics; Docker + host monitoring | **Partial** | `monitoring/metrics.registry.ts:render`; `monitoring-depth/platform-metrics.service.ts:render` | **2 of 12 metrics.** Zero SMSC/SMPP metrics exported (bind state, queue depth, throughput, DLR rate all exist in-process, none in `/metrics`). `jkannel_backend_up` is hardcoded `1`. Prometheus job `kamex-bearerbox` scrapes a path the engine does not serve. Grafana dashboard has 3 Node-process panels | Complete ✗ |
| **Alerts** | Automatic generation, 4 severities, SMS channel, escalation routing, ownership, dashboard, MTTA/MTTR, categories, RCA, ticketing | **Partial** | `monitoring/alert-evaluator.service.ts:evaluate`; `monitoring/anomaly-detection.service.ts:openAlert`; `monitoring-depth/alert-escalation.service.ts`, `alert-correlation.service.ts`, `maintenance-window.service.ts` | **`AlertEvaluatorService` has no caller** — console-authored `alert_rules` never fire. Only 3 anomaly conditions, daily batch. `type='sms'` is DB-creatable and silently no-ops. Escalation ignores `step.target` so every level pages the same channel. No auto-notify on alert open. No ownership/dashboard/MTTR/categories | Complete ✗ |
| **Reporting** | Operational/Traffic/SMSC/Route/Customer/Vendor/Financial catalogues | **Partial** | `reporting/reporting-analytics.service.ts:catalog/successRates/latencySla`; `reporting-depth/report-definitions.repository.ts`, `report-schedule.service.ts` | **`successRate = dlrs/messages`** and `failureRate = 1 − that` (`reporting-analytics.service.ts:260-267`) — a failure DLR counts as a success. 7 of 14 SMSC report items missing (bind time, reconnects, avg/max TPS, window, availability). Customer/Vendor/Financial flagged `available:false`. `period_type` CHECK blocks monthly/yearly | Complete (borderline) |
| **Backup & DR** | Offsite replication, PITR, incremental, config/cert capture, DR package, RPO<1min/RTO<5min, failure alerting | **Partial** | `backup-dr/backup-dr.service.ts:createBackup/verifyBackup/restoreBackup`; `backup-dr.scheduler.ts:runCycle` | Encrypted dump + verify + restore-into-isolated-DB is genuinely good. **No offsite** (`file://` only); **no PITR/WAL**; **`kind='incremental'` produces a full dump**; only 4 tables in config scope — certs/.env/compose/engine config never captured; **backup failure raises no alert**; default interval 1 h vs RPO<1 min; encryption key falls back to the JWT signing key and then to a hardcoded string | Complete (software) ✗ |
| **High Availability** | Active LB health checks, readiness/liveness, drain, rolling update with rollback, Redis distributed locks, replication observability | **Partial** | `docker-compose.ha.yml`; `infrastructure/ha/nginx/jkannel-ha.conf`; advisory locks in 6 schedulers | Topology is real. But **every health check terminates at a hardcoded `ok`**, so LB ejection cannot work; no readiness/liveness/version endpoints; no drain, no rolling-update automation; config/route **deploy paths take no lock at all**; no replication-lag/role/failover metrics | Complete (software) ✗ |
| **Performance** | 7 latency targets; throughput tiers; regression gating; bottleneck detection | **Partial** | `perf/config/slo.js`, `perf/run.js`, `perf/scenarios/*` | Harness is honest and well-documented (spec vs local profiles, "CHOSEN" labels). 5 of 7 latency targets encoded (Config Generation and Alert Creation absent); **no throughput scenario at all**; **no stored baseline / regression gate** (§23); health SLO measures a hardcoded endpoint | Complete (software) ✗ |
| **Testing & QA** | CI on every commit blocking merge; 95% coverage gate; static analysis; 9 integration areas | **No** (on its central claims) | 71 backend spec files / ~400 cases; `backend/tests/*.integration-spec.ts`; `e2e/tests/*` (33 tests) | **No CI exists** — no `.github/`, no pipeline file anywhere. **No `coverageThreshold`**, coverage never measured. **No ESLint config or dependency at all.** 2 of 9 integration areas. 22 of 33 e2e tests are navigation smoke | Complete (software) ✗ |
| **Docker Deployment** | 14 services, network segmentation, per-container probes, resource limits, image metadata | **Partial** | `docker-compose.yml`; `infrastructure/nginx`, `watchdog`, `loki`, `promtail` | All 14 services and 4 isolated networks present — genuinely delivered. **Zero resource limits** (`mem_limit`/`cpus`/`ulimits` appear nowhere); one static health endpoint for all probes; no cAdvisor/node_exporter; no OCI image metadata; watchdog restarts reach neither Alerts nor Audit | Complete (software) ✗ |
| **UI Screens / Dashboard / Frontend** | 8 dashboards + 14 tiles; per-entity detail tabs; route builder; side-by-side diff; real-time; i18n | **Partial** | `frontend/src/views/ModuleWorkspace.vue` (4262 L, 17 of 22 routes), `OperationsOverview.vue`, `AnalyticsView.vue`, `SessionsView.vue`, `BulkSendView.vue` | **No real-time layer** — repo-wide grep finds no WebSocket/SSE in backend *or* frontend; one 60 s bell poll. 1 of 8 dashboards, 4 of 14 tiles. No tab primitive, no `:id` routes. **Alerts have 0 of 9 lifecycle actions.** No Log Explorer, Scheduler, Permission Matrix, Auth history. Config diff is a `<pre>` JSON dump. No i18n. Visual regression = 2 screenshots | Partial ✗ (2-item gap list) |
| **Plugins / SDK** | Manifest+checksum+signature verification on install; out-of-process execution; hooks; event bus; plugin migrations; upgrade/rollback | **Partial** | `plugins/plugin-manifest.validator.ts`, `plugins/plugin.runtime.ts`; live path `platform-console/platform.controllers.ts:PluginsController` | The validator is thorough — and **never called**. `src/plugins/` is in no NestJS module; `installPlugin` inserts posted JSON verbatim after checking `if (!b.id)`. Host API is 3 methods. Zero `PluginExecutor` implementations. `sdk/typescript/` is a lone README | Partial (accurate) |
| **Customers** | Quotas, credit, sender IDs, route bindings | **Partial** | `customers-depth/customer-quota.service.ts:consumeInClient`, `customer-credit.service.ts:postInClient` (both correctly row-locked) | **Enforced by none of the four send paths.** `bulk_send_jobs` has no `customer_id`; grep for `customerId` outside `customers*` returns zero. Quota counters stay 0 forever, balances never move, rejected sender IDs are accepted verbatim, route bindings unchecked. `customers.quota_daily`/`allowed_sender_ids` duplicate the 026 tables | **No ledger row at all** |
| **AI Operations** | Ch.1–10 evidence/confidence, Ch.45–46 copilot, Ch.65–66 governance (current); Ch.11–64 prediction/self-healing/memory (future) | **Yes** (current scope) | `ai-operations/ai-operations.service.ts:assist`; `privacy-redactor.ts`; `ai-copilot/copilot-provider.ts:generateAnswer` | Current-scope requirements are met, and the governance implementation (kill switch, per-request consent, redact-before-persist, mandatory human approval, no execution) is exemplary. **Ch.11–64 is future scope** per `PRODUCT_SCOPE.md` and the spec's own "(Future)" chapter titles | Partial (should be annotated future-scope) |
| **Backend Architecture** | Domain layer; no business rules in controllers; repositories return domain models; real job queue with retries; health/readiness/version | **Partial** | `app.module.ts`, `database/database.service.ts:tenantTransaction`, `platform/*` | No domain layer. `console.controllers.ts` is ~1100 lines holding 7 controllers with orchestration inline. **No queue library**; six `setInterval` loops; **`api_jobs` rows are never executed by anything**; bulk send has no retry/backoff. `/health` is a hardcoded literal | (folded into Platform/API) |
| **Database (RLS/migrations)** | Forced RLS, non-owner role, deterministic runner | **Yes** | `011_rls_enforcement.up.sql`; `database/migration-runner.ts:enforceRowLevelSecurity`, `ensureRoleLogin`; `database.service.ts:applicationConnectionString` | **Verified clean.** 69/69 tenant tables carry a policy; FORCE applied per-migration *and* swept by the runner so a forgotten `FORCE` self-corrects; `jkannel_app` is a genuine non-owner; the BYPASSRLS `jkannel_auth` role has narrow grants and every consumer filters on `tenant_id` + `user_id`. The 2026-07-09 RLS and auth-key defects are genuinely closed | Complete (justified) |

---

## 3. Gaps ranked by value

Ranked by what an SMSC operator loses day to day, not by ease. Effort: **S** ≤ 2 days · **M** ≈ 1–2 weeks · **L** > 2 weeks.

### The framing: three integration voids

Gaps 1–3 share one shape. Each names a subsystem that is built, unit-tested, documented and
merged — and connected to nothing. They are not "missing features"; they are missing wires, and
each one silently converts an operator's deliberate action into a no-op. They dominate this
ranking because a no-op that reports success is worse than an absent feature.

---

**G1 — The SMSC Manager and the Configuration Generator are two disconnected systems, and the generated config cannot run a real gateway. (Effort: L)**

*Spec.* `CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION` §1/§5 and part 03: the generator converts *the operational state stored in the database* into engine configuration; "the database is always the single source of truth". §7 enumerates 16 configuration groups. `SMSC_MANAGER_SPEC_03` enumerates 19 SMSC attributes including username, password, system type, TON/NPI, bind mode, window size, keepalive, TLS. `SUCCESS_CRITERIA.md`: "Complete management without editing configuration files."

*What exists.* `ConfigurationGeneratorService.renderKamex` (`backend/src/configuration/configuration-generator.service.ts:90`) emits exactly: `group=core` (admin-port, smsbox-port, two `${ENV}` passwords, log-level, log-format), one `group=smsc` per entry carrying only `smsc`, `smsc-id`, `host`, `port`, and optionally one `group=pgsql-connection`. The input is `EngineConfiguration` (`:4-25`), whose `smsc[]` element has six fields.

*The delta, in three parts.*

1. **No code path builds `EngineConfiguration` from the database.** Grep for the type across `backend/src` returns the interface, two seeded templates, and the hand-authored literal at `console/console.controllers.ts:768` (`/configurations/baseline`). `POST /configurations/generate` (`:831`) takes the model from the **request body**. Nothing reads `smsc_definitions`. An operator who creates an SMSC in the SMSC workspace will not find it in any generated configuration; conversely the baseline hardcodes a fictional `example-smsc`.
2. **Credentials and every SMPP bind parameter are unmodelled.** `usernameSecretRef` is validated for a `secret://` prefix and then discarded — `renderKamex` never reads it. `smsc_definitions.credential_secret_ref` and `.tps` are stored (migration `004:7-8`), surfaced in the grid, and never rendered. There is no `smsc-username`, `smsc-password`, `system-type`, `transceiver-mode`, `source-addr-ton/npi`, `throughput`, `enquire-link-interval`, `reconnect-delay`, `max-pending-submits`, or TLS directive anywhere in the emitter. **A configuration generated by JKANNEL cannot bind to any authenticated carrier SMSC.**
3. **Deploying a generated config would break the running gateway.** The working stack runs `runtime/kamex/kamex.conf`, which contains `group=smsbox`, `group=sendsms-user` and `group=sms-service` — none of which the generator emits. `ConfigurationDeploymentService.deploy` (`configuration/configuration-deployment.service.ts:40`) writes to `KAMEX_CONFIG_PATH`, which `docker-compose.yml:209` mounts as that exact file. The auto-rollback guard will not fire: a core+smsc-only config is syntactically valid so `validateNative` passes, `/graceful-restart` succeeds, and the health probe accepts 200 *or 503* (`:36`). The gateway comes back up with no smsbox, no sendsms account and no MO service — silently unable to accept traffic.

*Approach.* (a) Extend `EngineConfiguration.smsc[]` with the `SMSC_MANAGER_SPEC_03` attribute set and add `smsbox`, `sendsmsUsers`, `smsServices`, `dlrStorage`, `ssl` groups; add the matching columns to `smsc_definitions` in one migration. (b) Introduce a `SecretResolver` (env-backed first) so `secret://kamex/x` renders as `${KAMEX_X}` rather than being dropped. (c) Add a `ConfigurationModelBuilder` that assembles the model from `smsc_definitions` + `system_settings` inside a tenant transaction; make `/configurations/generate` build-from-DB by default with `?source=body` as the escape hatch. (d) Golden-file render tests per SMSC type, asserted against the native validator that already exists. (e) Fix the health verification to reject 503.

---

**G2 — The routing engine is not on the send path. Routing configuration changes nothing. (Effort: L)**

*Spec.* `ROUTING_ENGINE_SPEC_01` opens: "The Routing Engine determines how every SMS is delivered." `SPEC_04` defines a 9-step evaluation: validate → identify customer → sender → destination → rules → SMSC → throttle → submit → **audit the decision**.

*What exists.* `selectRoute()` (`backend/src/routing-depth/route-selection.ts:248`) is a genuinely good pure function — longest-prefix specificity, five strategies, well covered by `route-selection.spec.ts`. Its **only** non-test caller is `RoutingDepthService.resolve` (`routing-depth/routing-depth.service.ts:32`), reachable solely from `POST /routing/resolve`.

*The delta.* All four production send paths take the target SMSC from the caller:

| Path | Site | SMSC chosen by |
|---|---|---|
| `POST /messages` | `console/console.controllers.ts:1064` | `text(b.smscId, 'smscId')` from the request body |
| Bulk campaign | `messaging-depth/bulk-send.service.ts:290` | `bulk_send_jobs.smsc_id`, picked at job creation |
| Replay / clone / requeue | `messaging-depth/message-operations.service.ts:127` | copied from the original message |
| Queue-console resend | `queue-console/queue-console.service.ts` | operator-selected bind (by design) |

Consequences: disabling a route, reprioritising it or repointing it changes nothing observable.
A replay after an SMSC failure re-submits to the same dead SMSC. No route decision is ever
recorded, so `message_route_trace` (spec Ch.15) has no data source even if the table existed.
Three further defects compound it: there are **two divergent engines** (`routing/routing.service.ts:evaluate`
uses raw `startsWith` with no digit normalisation and throws on no-match) and the operator-facing
simulator calls the *legacy* one (`console.controllers.ts:371`, invoked from `ModuleWorkspace.vue`);
`availableSmscIds` is never populated from live health, and `/routes/simulate` passes *all* tenant
SMSCs as healthy (`:377`), so the failover branch is unreachable even in simulation; and
`RoutingDepthRepository.candidateRoutes` filters on `enabled` only, ignoring `deployment_state`,
so `/routing/resolve` resolves against draft and rolled-back routes.

*Approach.* Make `smscId` optional on `POST /messages`, `bulk_send_jobs` and replay; when absent,
call `RoutingDepthService.resolve` and persist the `SelectionResult` (routeId, strategy,
fallbackUsed, trace) into a new `message_route_decisions` table. Feed `availableSmscIds` from
`smsc_health`. Delete `routing/routing.service.ts` and repoint `/routes/simulate` at `selectRoute`
so the simulator and reality are one engine. Add `deployment_state` to `candidateRoutes`.

---

**G3 — Alert rules authored in the console are never evaluated. (Effort: M)**

*Spec.* `MONITORING_SPEC_03` / `ALERTS_ENGINEERING_SPECIFICATION` §25: alerts are generated automatically from rule thresholds.

*What exists.* `AlertEvaluatorService` (`backend/src/monitoring/alert-evaluator.service.ts:26`) is a
correct, tested pure evaluator. It is provided and exported by `domain.module.ts:14,22` and
**injected nowhere**. There is no scheduler, no interval, no controller that calls it, and no
`metric_samples` store for it to read. Meanwhile `console.repository.ts:687` lets operators create
`alert_rules` rows (metric / operator / threshold / sustain / severity) through the UI.

*The delta.* An operator configures "queue depth > 5000 for 5 minutes ⇒ critical", saves it
successfully, and it will never fire — no error, no indication. The only code that ever inserts
an `alert_instances` row is `anomaly-detection.service.ts:openAlert`, which supports three
daily-batch conditions (volume drop, volume spike, DLR failure). Compounding this: no escalation
policy is seeded, and the only other delivery path is a manual `POST /alerts/:id/notifications`
(`console.controllers.ts:549`) — so in a default deployment **no alert notification is ever sent
automatically**. Two further defects: `notification_channels` accepts `type='sms'` (migration 008)
and `notification-delivery.service.ts:92` returns `status:'skipped'` for it — on an SMS gateway;
and `alert-escalation.service.ts:recordEscalation` selects the channel with
`WHERE enabled AND type=$1 LIMIT 1`, ignoring `step.target`, so every escalation level pages the
same first channel.

*Approach.* Add an `AlertRuleEvaluatorScheduler` beside `alert-escalation.service.ts`, using the
same `pg_try_advisory_xact_lock` pattern. It needs a metric source: persist a rolling
`metric_samples` table fed from `KamexAdapter.queueSnapshot()` and `PlatformMetricsService`
(this is shared with G6). Route `step.target` in `recordEscalation`. Either implement
`deliverSms()` through the platform's own send path or reject `type='sms'` at the API and the DB
CHECK — do not leave a channel that silently discards alerts.

---

**G4 — DLR outcome is never classified, so "delivered" and "failed" are both guesses — and the shipped success-rate reports are wrong. (Effort: S–M)**

*Spec.* `MESSAGE_EXPLORER` §14 and `KANNEL_ENGINE_ADAPTER` Ch.26: normalise DLR to
DELIVRD / EXPIRED / UNDELIV / REJECTD / BUFFERED / ENROUTE / ACCEPTD, preserve the raw event,
expose the SMSC error code.

*What exists.* `KamexSqlboxRepository.normalize` (`backend/src/engine/kamex-sqlbox.repository.ts:87`)
sets `status = source === 'send_sms' ? 'queued' : row.momt === 'DLR' ? 'delivery_report' : 'sent'`.
`dlr_mask` is selected and carried through as a number; it is decoded nowhere.

*The delta.* There is no way in this product to answer "which of my messages failed". Worse, the
absence propagates into reporting as a **correctness bug**:
`ReportingAnalyticsService.successRates` (`backend/src/reporting/reporting-analytics.service.ts:260-267`)
computes `successRate = dlrs / messages` and `failureRate = 1 − successRate`. A failure DLR
increments `dlrs` and therefore counts as a **success**; "failure rate" actually means "messages
with no DLR yet". `deliveryBreakdown` (`:214-218`) labels the same number "Confirmed delivered".
An hour in which every message failed renders as 100 % delivery. These are the per-SMSC and
per-route success/failure reports shipped as a Wave 2 headline deliverable.

*Approach.* Decode `dlr_mask` on `momt='DLR'` rows in `normalize()` (1 = delivered, 2 = failed,
4 = buffered, 8 = smsc-accepted, 16 = smsc-rejected), surface `msgdata` as the SMSC error text,
and add the resulting statuses to `filters()`. Then fix `successRates`/`deliveryBreakdown` to
count only mask=1 as delivered and add a genuine failure count. This is the highest
value-per-hour item in the entire report.

---

**G5 — Customer quota, credit, sender IDs and route bindings have zero runtime effect. (Effort: M)**

*What exists.* `CustomerQuotaService.consumeInClient` (`backend/src/customers-depth/customer-quota.service.ts:169`)
and `CustomerCreditService.postInClient` (`customer-credit.service.ts:133`) are both correct:
`SELECT … FOR UPDATE`, lazy UTC window reset, reject-before-increment, over-draw protection,
audited. Their own docstrings say they are intended for a send path.

*The delta.* Their only callers are the admin endpoints in `customer-accounts.controller.ts`.
`grep -rn "customer_id\|customerId" backend/src --exclude-dir=customers*` returns **zero hits**;
`bulk_send_jobs` has no `customer_id` column. Stated plainly: a customer with a 10 000/day quota
can be sent unlimited traffic and `used_count` reads 0 forever; a customer with a zero balance can
be sent unlimited traffic because nothing ever debits them; a sender ID an operator explicitly
**rejected** is accepted verbatim by `POST /messages`; and a customer can be sent through any SMSC
in the tenant regardless of `customer_routes`. Separately, `bulk-send.service.ts:290` hard-codes
`sender: ''`, so every campaign message goes out with an empty sender ID.

*Approach.* Add `customer_id` to `bulk_send_jobs`; resolve a customer for `POST /messages`
(from the API key once G6 lands, or an explicit field meanwhile). Inside the *same*
`tenantTransaction` as the send, call the existing `consumeInClient` + `postInClient('debit')`
and check `sender_ids.status` and `customer_routes`. This is wiring, not design — the primitives
are done and correctly locked. Reconcile the duplicate `customers.quota_daily` /
`rate_limit_per_min` / `allowed_sender_ids` columns in the same change.

---

**G6 — No SMS/SMSC telemetry reaches Prometheus, and the engine scrape target does not exist. (Effort: S–M)**

*Spec.* `MONITORING_SPEC_02` names 12 core metrics: SMS/sec, MO rate, MT rate, DLR success, queue depth, bind count, CPU, RAM, disk, network, API latency, DB latency.

*What exists.* Two of twelve. `metrics.registry.ts` exports HTTP counters and a latency histogram;
`metrics.controller.ts` exports Node process memory/uptime; `monitoring-depth/platform-metrics.service.ts`
exports PG and Redis reachability, connections, size, commits, rollbacks.

*The delta.* Zero SMSC-level metrics. Bind state, per-bind queue depth, throughput and DLR rate
are all parsed by `KamexAdapter.queueSnapshot()` (`engine/kamex.adapter.ts:238`) and exposed only
over REST to whoever has a page open. Three compounding facts: `jkannel_backend_up` is rendered
unconditionally as `1` because `HealthService.getStatus()` hardcodes `status:'ok'`, so the gauge
can never be 0; the Prometheus job `kamex-bearerbox` scrapes `:13000/metrics`, which is Kannel's
admin port and serves `/status*`, not `/metrics`, so **no engine metric reaches Prometheus at
all**; and the provisioned Grafana dashboard has three panels, all about the Node process. An
operator opening Grafana on an SMS gateway sees a Node.js dashboard.

*Approach.* An `EngineMetricsService` mirroring `PlatformMetricsService`, rendering
`jkannel_smsc_bind_up{smsc}`, `jkannel_smsc_queued{smsc,direction}`,
`jkannel_smsc_throughput_total{smsc,direction}`, `jkannel_dlr_total{status}` (depends on G4 for
the status label). Delete or repoint the dead `kamex-bearerbox` job. Add the matching Grafana rows.
The same sample stream feeds G3's rule evaluator.

---

**G7 — `/health` is a hardcoded literal, which disables every health-dependent mechanism in the stack. (Effort: S)**

*What exists.* `HealthService.getStatus()` (`backend/src/health/health.service.ts:11-17`) returns
`{service, status:'ok', timestamp}`. It touches nothing. It is the only health route.

*The delta.* This one 6-line function silently defeats: the backend container healthcheck
(`docker-compose.yml:126`), the HA replica healthcheck (`docker-compose.ha.yml:245`), nginx
upstream ejection, the watchdog's restart trigger, the `jkannel_backend_up` gauge, and the
perf harness's health SLO. A replica with a dead PG pool passes every check and stays in
rotation serving 500s. `PROJECT_STATE.md:63` names this endpoint "the liveness/readiness
contract"; `HIGH_AVAILABILITY` §12 requires five endpoints (readiness, liveness, health,
version, dependencies) and one exists.

*Approach.* Probe PG (`SELECT 1`) and Redis (`PING`) with short timeouts; split `/health/live`
(process) from `/health/ready` (dependencies, 503 when down); add `/health/version` carrying
build/commit from Docker build args. Point compose healthchecks and nginx at `/ready`. The
underlying probes already exist in `PlatformMetricsService`.

---

**G8 — Account lockout is permanent: 5 wrong guesses disables any account until an administrator intervenes. (Effort: S)**

*Confirmed by direct trace.* `PostgresAuthRepository.recordFailedLogin`
(`backend/src/security/postgres-auth.repository.ts:46-51`) sets
`status = CASE WHEN $3 IS NULL THEN status ELSE 'locked' END`. `AuthService.login`
(`security/auth.service.ts:48`) short-circuits only *while* `lockedUntil > now`. Once the 15-minute
window elapses: the lock branch is skipped; the credential branch is skipped because the password
verifies and `'locked'` is not in its status list; execution reaches
`if (user.status !== 'active') throw new UnauthorizedException('Account is not active')`
(`:90`). `recordSuccessfulLogin` — the only code that flips `status` back to `active`
(`postgres-auth.repository.ts:52`) — is at `:129` and is never reached.

*Why the tests miss it.* The in-memory fake in `auth.service.spec.ts:69-73` mutates only
`failedLoginCount` and `lockedUntil`, never `status`, so it does not model the real SQL. The
Wave 5 fix correctly removed lockout **re-extension** and the regression test covers exactly that;
the permanent-lock path is a different branch.

*Impact.* Unauthenticated self-service denial of service against any known username, including
the operator account. This is the most severe concrete defect found.

*Approach.* Clear `status`/`locked_until` when `locked_until <= now()` — cleanest inside
`findCredential`'s SQL so the credential arrives unlocked. Extend the spec fake to mirror the
status transition so the existing lockout suite actually exercises it.

---

**G9 — The API gateway authenticates exactly one demo endpoint; no business function is reachable by API key. (Effort: M)**

*What exists.* `ApiKeyAuthGuard` (`backend/src/api-gateway/api-key-auth.guard.ts:68`) is complete
and good: hashed key lookup, expiry, CIDR allowlist (403), Redis atomic fixed-window rate limit
(429 + `Retry-After`, fail-open), rate-limit headers, and a scope→permission bridge at `:117-124`.

*The delta.* `grep ApiKeyAuthGuard` shows it applied to one route: `GET /gateway/whoami`
(`api-gateway.controller.ts:142`) — self-described in its own comment as a reference endpoint —
and that route carries no `PermissionsGuard` and no `@RequirePermissions`. So no scope is enforced
anywhere, and the rate limiter, allowlist and expiry machinery protect an echo endpoint. There is
no HTTP submit API for customers; the only send route is `POST /messages` behind a session JWT and
(oddly) the `configuration.manage` permission. Separately there are **two disjoint credential
systems**: `api_gateway_clients` (migration 016 — the portal-facing registry with `scopes`,
`allowed_routes`, `rate_limit_per_min`) is read by **no guard at all**, so a client provisioned
through the console cannot call anything.

*Approach.* Stack `ApiKeyAuthGuard` + `PermissionsGuard` + `GatewayAuditInterceptor` on a real
submit endpoint and the message/DLR read endpoints; define the scope vocabulary from
`API_GATEWAY_ENGINEERING_SPECIFICATION` §6 (`sms.send`, `sms.read`, `audit.read`, …). Add
`duration_ms` and `user_id` to `gateway_request_log`. Then either back `api_gateway_clients` with
`api_keys` or retire it — two credential models is the worst of the three options. This endpoint
is also the natural place to resolve the customer for G5.

---

**G10 — Nothing in the product updates by itself. (Effort: M)**

*Spec.* `FRONTEND_ENGINEERING_SPECIFICATION:357` "Real-time information uses SignalR"; `:375`
"No browser refresh should be required"; `:519` acceptance "Real-time updates function".
`DASHBOARD_SPEC` §6/§19/§21 and `UI_SCREEN` Ch.11 repeat it.

*What exists.* Repo-wide grep for WebSocket / SSE / `text/event-stream` / `@WebSocketGateway`
across **both** `backend/src` and `frontend/src` returns nothing. `@nestjs/websockets` is not a
dependency. The only recurring client-side timer is `AppShell.vue:82,88,161` — a 60-second poll
of the notification unread count.

*The delta.* Every operational number — queue depth, bind state, alert count, DLR feed — requires
the operator to click Refresh. For a 24/7 NOC screen this is the single most consequential UI
miss, and it is absent from the ledger's Frontend gap list.

*Approach.* Cheapest large win first: a `useLiveResource(endpoint, intervalMs)` composable with
visibility-aware polling, wired to the dashboard tiles, queue/DLR feeds, SMSC status and alerts.
Upgrade the queue and log tails to SSE once a backend stream exists (`@nestjs/common`'s `@Sse()`
needs no new dependency).

---

**G11 — Role and permission administration does not exist; no spec role is seeded. (Effort: M)**

*Spec.* `USER_MANAGEMENT_SPEC_02` names 8 default roles (Super Administrator, Administrator,
Network Engineer, Operations Engineer, Support Engineer, Read Only, Auditor, API Client) and
states "Roles shall be configurable"; §10 "Permissions shall never be hardcoded"; §20 acceptance
"Permissions are configurable".

*What exists.* 22 permission codes hard-coded in `@RequirePermissions` decorators. `GET /users/roles`
(`console.controllers.ts:616`) is read-only — there is no POST/PATCH/DELETE for roles and no
`role_permissions` mutation API. The only seeder is
`security/create-development-operator.ts`, which throws in production (`:5-6`) and creates exactly
one role, `administrator`. It also inserts 20 of the 22 enforced codes — `messages.send`,
`widgets.view` and `widgets.manage` are enforced but never seeded, so a freshly seeded
administrator gets 403 on message submission.

*The delta.* Least privilege is unachievable: an "Auditor" cannot be created, and audit-event
reads are gated on `system.view`, the same permission that grants backup listing and platform
metrics. "Role Changed" and "Permission Changed" audit events (`SECURITY` §18, `LOGGING` §12) can
never fire because no code path can change either.

*Approach.* One idempotent, production-safe migration seeding the full `permissions` catalogue
and the 8 default roles with their grants; a `RolesController` with create/update/delete and
permission assignment, each emitting `role.changed` / `permission.changed` audit rows; retire
`create-development-operator.ts` as the source of truth.

---

**G12 — Security defect cluster: stale privileges, plaintext webhook secrets, spoofable IP allowlist, unthrottled MFA, no TLS. (Effort: S each)**

Five independent defects, each individually small to fix, grouped because they are one review pass.

- **Stale privileges survive refresh.** `AuthService.refresh` (`security/auth.service.ts:222-229`)
  rebuilds the principal from the *incoming token's* claims and never re-reads `users`,
  `user_roles` or `users.status`. `console.repository.ts:947-966` changes status and roles without
  revoking sessions. A demoted, disabled or archived user who keeps refreshing retains their
  original full permission set for the 7-day refresh lifetime. *(Fix: re-resolve from the DB in
  `refresh()`, reject non-active, revoke sessions on disable/role change.)*
- **Webhook shared secrets are stored and disclosed in plaintext.** `notification_channels.config`
  is unencrypted `jsonb` (migration `008:10`); `ConsoleRepository.listNotificationChannels`
  (`console.repository.ts:744-748`) selects the raw column with no redaction behind
  `@RequirePermissions('alerts.view')` — a read-level permission. Contrast `system_settings`,
  which redacts correctly at `:850`. Additionally
  `notification-delivery.service.ts:116` sends that raw secret as `x-jkannel-signature` — a static
  bearer token mislabelled as a signature, replayable and carrying no integrity. *(Fix: encrypt at
  write with `identity-crypto.encryptSecret`, redact on read, switch to HMAC-SHA256 over the body.)*
- **`X-Forwarded-For` is trusted unconditionally, defeating the IP allowlist.** `callerIp`
  (`api-gateway/api-key-auth.guard.ts:35-40`) takes the **first** XFF value; `main.ts` never sets
  `trust proxy`; the bundled nginx *appends* (`proxy_add_x_forwarded_for`), preserving the
  attacker's value in first position. Sending `X-Forwarded-For: <allowlisted-ip>` bypasses the
  per-key allowlist and poisons `gateway_request_log.ip_address`. *(Fix: `app.set('trust proxy', …)`,
  derive from the rightmost untrusted hop, or read an nginx-authoritative `X-Real-IP`.)*
- **TOTP verification is unthrottled and there is no login rate limiting.** The MFA-failure branch
  (`auth.service.ts:94-116`) does not call `recordFailedLogin`, so lockout never triggers on the
  MFA leg; `verifyTotp` accepts a ±1 window. No throttler package exists and `/auth/login` has no
  rate limit at any layer, so per-account lockout also does nothing against credential stuffing
  spread across accounts. *(Fix: increment the counter on MFA failure; reuse `GatewayRateLimiter`
  behind a generic guard on `/auth/*`.)*
- **No TLS anywhere in the shipped topology.** Both `infrastructure/nginx/conf.d/jkannel.conf:35`
  and `infrastructure/ha/nginx/jkannel-ha.conf:37` are plain `listen 8080`; no 443, no cert, no
  redirect. The app emits HSTS in production against a listener that cannot serve HTTPS. No
  `sslmode` on the DB connection. `SECURITY` §11/§13 and acceptance §26 bullet 1 are unmet.

Two smaller latent items in the same pass: rotating `AUTH_ACCESS_TOKEN_KEY` silently bricks every
enrolled TOTP device, because `identity-crypto.ts:20-32` falls back to it when `MFA_ENCRYPTION_KEY`
is unset; and the admin password-set path (`console.controllers.ts:689`) bypasses both password
history and session revocation, which the token-based reset performs correctly.

---

**G13 — The message read model cannot answer an operator's basic questions. (Effort: S for filters, L for an owned store)**

Three separable pieces, listed cheapest first.

- **No date-range filter on message search.** `KamexSqlboxRepository.filters` (`engine/kamex-sqlbox.repository.ts:91`)
  supports 5 of the spec's 22 criteria and has no `from`/`to` at all. The `(time DESC, sql_id DESC)`
  index already exists. **S.**
- **Encoding, UDH/segments, validity and billing info are already in the engine table and simply
  never selected.** The five SELECT lists (`:129,141,145,285,409`) omit `coding`, `charset`,
  `udhdata`, `validity`, `deferred`, `mclass`, `pid`, `binfo`, `meta_data`. Adding them yields
  message parts, GSM7/UCS2 encoding and segment count for the cost of a column list. The ledger
  frames this as a "message-parts/cost model" gap, implying design work. **S.**
- **JKANNEL owns no message record.** `MESSAGE_EXPLORER_SPEC_03`'s `messages`, `message_events`,
  `message_status`, `dlrs` tables do not exist; every read is a live query against the engine's
  SQLBox. This contradicts a stated core invariant —
  `TELECOMMUNICATIONS_DOMAIN_MODEL.md:37`, "PostgreSQL is JKANNEL's system of record; engine-owned
  SQLBox/message/DLR stores are external observations". Retention (`applyRetention`) issues
  `DELETE FROM sent_sms`: JKANNEL deletes the engine's rows and keeps nothing. This is the
  prerequisite for cost, customer linkage, persisted route decisions and any SLA claim. **L.**

Also here: free-text search is `msgdata ILIKE '%…%'` — a leading wildcard, unindexable, and the
spec's <2 s target is architecturally unreachable without `pg_trgm`/GIN. And `exportMessages`
(`console.controllers.ts:973`) forwards `query`/`smscId`/`direction` but **drops `status`**, so the
CSV silently disagrees with the grid it was exported from.

---

**G14 — No continuous bind/status polling; no bind-state history. (Effort: M)**

`KANNEL_ENGINE_ADAPTER` Ch.21 requires 5 s/10 s/1 min configurable refresh; Ch.22 requires 8 bind
states with every transition producing a monitoring event, an audit record and an alert, and says
bind history "shall never be deleted". Today `smsc_health` rows are written **only** inside
`completeSmscOperation` (`console.repository.ts:373`) — i.e. only when an operator clicks something.
None of the six `setInterval` schedulers polls the engine. An operator does not learn that a bind
dropped at 03:00 unless they open the page. `engine_connection_snapshots` already exists (migration
002) and is written by nothing.

*Approach.* An `SmscStatusPoller` (`OnModuleInit` + advisory-locked interval, matching
`backup-dr.scheduler.ts`) calling `queueSnapshot()`, writing `engine_connection_snapshots` +
`smsc_health`, diffing against the previous state to emit bind-transition audit rows and alerts.
Normalise the state vocabulary to Ch.22's eight values. This also supplies the sample stream for
G3 and G6, so the three are best built together.

---

**G15 — `POST /jobs` accepts work that is never performed, and no worker has retry semantics. (Effort: S to make honest, L to make real)**

`grep api_jobs` returns only `platform/jobs.service.ts`. Rows are inserted, listed, fetched and
cancelled; **nothing ever moves one out of `queued`**. The REST standard's async pattern is also
absent in shape: `@HttpCode(202)` appears nowhere in the repo and no `Location` header is
returned. Separately there is no queue library (no bullmq/bull/@nestjs/schedule); the six
schedulers are `setInterval` loops — correctly advisory-locked, which is good, but with no
attempt counter, backoff or DLQ. `BulkSendService.finalise` (`:301-339`) marks each recipient
`submitted` or `failed` **terminally**, so a transient SQLBox blip permanently fails a
5 000-recipient campaign.

*Approach.* Short term, make it honest — return 501 or remove the create route. Then either adopt
BullMQ (ioredis is already a dependency) or a Postgres `SKIP LOCKED` claim loop with
attempts/backoff, migrate the six schedulers onto it, and add `attempts`/`next_attempt_at` to
`bulk_send_recipients`.

---

**G16 — No CI, no coverage gate, no linter. (Effort: S)**

`TESTING_AND_QUALITY_ASSURANCE` §24 requires every commit to run Build → Static Analysis → Unit →
Integration → Security Scan → Docker Build → Acceptance, with failures blocking merge; §27 lists
nine merge-blocking gates; §28 sets six coverage targets (95 % overall, 100 % business logic).

There is **no `.github/` directory** and no CI file of any kind in the repo. `backend/package.json`
has `collectCoverageFrom` but **no `coverageThreshold`**, and `--coverage` is not in the test
script — coverage is never measured. There is **no ESLint config or dependency** in either package;
static analysis is `prettier --check` plus `tsc --noEmit`. Everything else in this report can
regress silently.

*Approach.* One `.github/workflows/ci.yml`: backend typecheck + format:check + `test --coverage`,
frontend typecheck + vitest, `docker compose config`, `npm audit --audit-level=high`. Add
`coverageThreshold` initialised at *measured* current numbers and ratchet upward. Add ESLint.

---

**G17 — Backups never leave the host, there is no PITR, and a failed backup pages nobody. (Effort: M; L for PITR)**

The core is genuinely good: AES-256-GCM encrypted `pg_dump`, advisory-locked scheduler, retention
classes matching the spec's example exactly, `pg_restore --list` integrity verification, and
restore-into-a-throwaway-database verification. What is missing is the *disaster* half:

- **No offsite destination.** `backup-dr.service.ts:75-77` writes `file://${BACKUP_DIR}` only;
  grep for `s3|minio|azure|sftp` returns nothing. One of the spec's ten destination types.
- **No PITR.** No `archive_mode`/`archive_command` in either compose file or in
  `infrastructure/ha/postgres/primary-init.sh`. With a 1 h default scheduler interval, best-case
  RPO is ~1 hour against the spec's <1 minute.
- **`kind='incremental'` produces a full dump.** `pgDumpArgs()` (`:361-373`) branches only on
  `schema` and `configurations`. The label lies to the retention policy and to the operator's RPO
  arithmetic.
- **Config, certificates, `.env` and compose files are never captured.** `CONFIG_TABLES` is four
  tables. After a host loss you restore a database into an environment you must hand-rebuild —
  which also means the spec's "Complete Server Loss" scenario cannot succeed today.
- **A failed backup raises no alert.** It writes `status='failed'` and audits. This is the classic
  way an operator discovers backup failure at restore time.
- **The encryption key falls back** `BACKUP_ENCRYPTION_KEY → AUTH_SIGNING_KEY → AUTH_ACCESS_TOKEN_KEY
  → 'jkannel-development-backup-encryption-key-change-me'`. Reusing the JWT key as the backup KEK
  is wrong, and the hardcoded default means a misconfigured deployment produces silently weak
  backups with no warning.

---

**G18 — Cross-cutting REST conformance: the built primitives are barely adopted. (Effort: S–M)**

A consistent pattern: real, tested platform code with near-zero adoption.

| Primitive | Built | Adopted by |
|---|---|---|
| Cursor pagination (`platform/cursor.ts`) | Yes | **1 of 18** grids (`reporting-depth/report-definitions.repository.ts:162`) |
| `?fields=` projection (`platform/field-selection.ts`) | Yes | **1 of 18** grids |
| Soft delete (`data-model/soft-delete.ts`) | Yes | **1** service; `deleted_at` on **4 of 71** tables |
| Optimistic locking (`data-model/optimistic-lock.ts`) | Yes | **1** service; exposed as a body field, never as ETag/If-Match |
| Audit signature service | Yes | **0** backing `audit_signatures` table (chain is in-row) |

Beyond adoption: filtering implements **1 of 14** mandated operators (`list-query.ts:110-113`
emits only `expr::text = $n`); the error contract has 2 of 15 categories, a generic
`HTTP_${status}` code, and an `errors[]` array that is **never populated** so field-level
validation errors are never returned; there is no `problem+json`; no ETag/If-Match; no
Deprecation/Sunset headers; the envelope's `meta`/`links`/`warnings` are hardcoded empty literals
so pagination metadata never reaches `meta`; and `security-headers.middleware.ts:18` forces
`cache-control: no-store` on every response, foreclosing HTTP caching entirely.

*Approach.* Closing the adoption gap is the cheapest large credibility win available: route the
shared grid runners in `console.repository.ts` and `platform-console.repository.ts` through
`usesCursor()` and `projectItems()` exactly as `report-definitions.repository.ts` already does
(~1 day), then extend `list-query.ts` with typed filter operators (~200 LoC).

---

**G19 — Alerts are read-only in the UI, and there is no Log Explorer. (Effort: S–M and M)**

`UI_SCREEN` Ch.12 requires nine alert actions (Ack, Assign, Comment, Escalate, Resolve, Close,
Suppress, Reopen, Ticket). `ModuleWorkspace.vue:599` excludes `alerts` from `hasRowActions`, so
the alerts grid has **zero row actions** — an operator can look at alerts and nothing else.
Adding `alerts` to that list plus a row-actions cell mirrors the existing SMSC implementation.

`UI_SCREEN` Ch.30 specifies a 12-leaf Log Explorer. `/logs-audit` is bound to `/audit-events`
only; there is no log viewer at all — no live tail, no source selector, no regex highlight, no
Kannel/Postgres/Redis streams. This is the first screen an operator opens during an incident.
The backend side is equally thin: `platform/json.logger.ts:write` emits four fields
(`timestamp, level, context, message`); correlation and request IDs are generated and echoed as
headers but **never injected into log lines**, so the whole correlation apparatus is invisible in
the logs it was built for.

---

**G20 — Generic 4-column tables where the spec requires operational density. (Effort: S each)**

`ModuleWorkspace.vue:645 normalize()` flattens every record to `{name, detail, status, updated}`.
Modules without a `columns` array — `messages`, `monitoring`, `alerts`, `smsc`, `routing`,
`users` — render an identical Name/Details/Status/Updated table. Against the spec: Messages should
have 13 columns (Customer, Direction, Route, SMSC, DLR, Retry Count, Latency…), SMSC 14 (Provider,
Protocol, Host, Port, System ID, Throughput, Connected Since…), Routing 11. The mechanism already
exists and is used by seven other modules; this is adding `columns:` arrays. Highest
value-per-hour item in the UI cluster, and it is what makes `/monitoring` — which the spec calls
"the primary NOC console" — currently a four-column list.

---

### Remaining gaps, grouped

**Operator-facing, medium value**

| Gap | Effort | Note |
|---|---|---|
| No blacklist / whitelist / DND / opt-out register | M | Explicit `ROUTING_ENGINE_SPEC_02` requirement, zero implementation. `route_blacklist`/`route_whitelist` tables absent. |
| No MSISDN normalisation to E.164 | S | `normalizeMsisdn` is `replace(/[^0-9]/g,'')`; `0700…` can never match a `256` country route. No shared normaliser across the three call sites. |
| `reconnect` is `enable` | S | `kamex.adapter.ts:controlSmsc` maps both to `start-smsc`; a reconnect on a bound SMSC is a no-op that records success. |
| "Test connection" is a bare TCP connect | S | `smsc-connectivity.service.ts:20`; `fake` short-circuits to success. `SMSC_MANAGER_SPEC_10`'s "Bind succeeds" acceptance is unreachable. |
| SMSC types: no SMPP server, CIMD2, EMI/UCP | M | 4 of 7; the union is duplicated in four places. Depends on G1. |
| TPS stored, validated, displayed — never enforced or rendered | S | Part of G1's render work. |
| No SMSC groups / versions / metrics tables; no clone/bulk/import; no per-SMSC deploy | M | `smsc_deployments.operation` CHECK already permits `validate`/`deploy` but `console.controllers.ts:211` rejects them — DB and API disagree. |
| No detail-tab architecture | M | ~116 spec'd tabs, zero implemented, no tab primitive and no `:id` routes to hang them on. |
| Permission Matrix, Scheduler, Help/Diagnostics, Service Accounts, Auth-history screens | M | Each absent; each straightforward once the API exists. |
| No i18n at all | M | `UI_SCREEN` Ch.37 and `FRONTEND` §18; zero locale infrastructure; timestamps rendered as raw API strings. |
| Toasts, skeletons, styled confirms, correlation ID on errors | S–M | Seven `window.confirm()` sites, none guarding Deploy/Rollback. |
| Webhook framework (10 event types, retries, HMAC, DLQ, replay) | L | `REST` Ch.63 and `API_GATEWAY` §18. What exists is an alert channel with a single 5 s attempt and no retry. |
| Report gaps: 7 of 14 SMSC items; monthly/yearly blocked by a DB CHECK; Customer/Vendor/Financial `available:false` | M | Financial depends on a cost model, which is Future Scope; the SMSC operational items are not. |
| No resource limits on any container | S | `mem_limit`/`cpus`/`ulimits`/`deploy.resources` appear nowhere. One runaway container OOMs the host. |
| Plugin install skips the validator that exists | S | `PluginsController.install` checks `if (!b.id)`; the thorough `PluginManifestValidator` is in no module. Any `system.manage` user can register a manifest with wildcard permissions and a bogus checksum. |
| Watchdog restarts reach neither Alerts nor Audit | S | `DOCKER` §5/§14 require both. |
| No distributed lock on config/route deploy | S | Five other paths use `pg_try_advisory_xact_lock`; the deploy paths use none, so two replicas can race an engine config push. |
| No perf regression baseline | S | `perf/results/*.json` exists; nothing compares runs. `PERFORMANCE` §23 requires degradation to block release. |
| No cAdvisor / node_exporter; no replication-lag or sentinel-role metrics | S | CPU, disk, network, container restarts and PG replication lag are unobservable. |
| Config version content is mutated after creation | S | `markConfigurationValidated` UPDATEs `content` without recomputing the checksum, contradicting "versions are immutable". |
| Exception filter discards the exception | S | `http-exception.filter.ts` never logs; a production 500 leaves only a correlation ID. |
| `validateEnvironment` covers ~5 of ~40 env vars | S | A typo'd `KAMEX_BASE_URL` degrades deploy to "written but unverified" instead of failing at boot. |
| SIEM export (syslog / CEF / LEEF) | M | `LOGGING` §16; grep returns zero hits. |
| `audit_log` missing spec columns role / session_id / hostname / result | S–M | Must change with the hash-chain canonicalisation and a chain-version marker. |
| Login-history and session field coverage | S–M | 5 of 11 and 4 of 10 spec fields missing (country, browser, OS, device, failure reason, session id). |
| User profile: 12 of 18 fields absent | M | `users` has never been altered since migration 003 — no email, phone, display name, timezone, last login, password expiry. Email is a prerequisite for the invitation/verification lifecycle. |
| Password complexity / expiry / max-age | M | Only min-length and history depth, both hard-coded. |
| Security settings UI is decorative | M | `settings-defaults.ts:67-105` presents five editable security knobs; **none is read by any code**. An operator who raises the lockout duration gets a success toast and no behavioural change. Same for `api.rate_limit_per_min` and `api.max_page_size`. |
| scrypt, not Argon2id | S | `SECURITY` §9 is unconditional. Note the perf harness attributes ~535 ms p95 auth to "argon2"; the real path is `scrypt(N=16384)` on the default 4-thread libuv pool with `UV_THREADPOOL_SIZE` unset anywhere — the remediation is probably thread-pool sizing, not "provisioned hardware". |
| Data-model domains with no tables | L | Ch.15 MESSAGING (0/20), Ch.16 DLR (0/9), Ch.17 QUEUE (0/9), Ch.18 MONITORING (0/13), plus Infrastructure/Docker (0/7). Pursue selectively — see the scope note below. |

**Explicitly *not* gaps** — recorded so they are not re-raised:
Billing, invoicing, rating, customer portal, AI diagnostics, Kubernetes and plugin marketplace are
**Future Scope** per `docs/domain/PRODUCT_SCOPE.md`; `PLUGIN_AND_EXTENSION_FRAMEWORK` §215 further
states "No billing logic belongs inside JKANNEL Core". The one adjacent item worth keeping visible
is that **no per-message cost or per-route price exists**, which is a prerequisite for the
least-cost routing strategy the routing spec *does* mandate.

### Specs that are aspirational and should not be scored as gaps

1. **`AI_OPERATIONS_ENGINE_SPECIFICATION` Ch.11–64** (~2 300 of 2 774 lines) — prediction,
   self-healing, memory engine, knowledge graph, federated knowledge. Future per
   `PRODUCT_SCOPE.md`, per the spec's own Ch.64 "(Future)" title and Ch.68 "shall evolve", and per
   `docs/operations/AI_OPERATIONS_PHASE15.md:30`. Current scope is Ch.1–10, 45–46, 65–66 — all
   delivered, and the governance implementation is the best-executed safety design in the repo.
2. **`CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION` lines 671–689** — the document states
   "This document is intentionally only Part 1." Multi-server, cluster, HA, secret management,
   configuration encryption, zero-downtime deployment, DR and automatic repair are named as
   *unwritten future parts*. The ledger currently books three of these as conformance gaps; they
   are roadmap. **G1's items are not** — DB-derived model, SMSC credentials and directive-group
   coverage are failures against Part 1 §1/§5/§7/§13 as written.
3. **`PLUGIN_AND_EXTENSION_FRAMEWORK` §8 (billing plugins), §9 (AI plugins), §24 (marketplace)** —
   self-labelled Future. Note that `PLUGIN_DEVELOPMENT_SDK.md:71` *overrides* the signature
   deferral for the production install gate, so signature verification on install **is** current
   scope and is unimplemented.
4. **`BACKEND_ARCHITECTURE` §20 "Future Clustering"**.
5. **The two mega-specs read literally.** `SYSTEM_DATA_MODEL` names 179 entities; ~30 exist. Much
   of the shortfall is `*_tags`, `*_labels`, `*_notes` and per-source metrics tables that a
   sensible implementation would collapse. The report treats only four whole-domain voids
   (messaging, DLR, queue, monitoring time-series) as material. Likewise `UI_SCREEN` enumerates
   ~236 nav leaves against 22 routes; the report ranks the handful an operator actually needs
   rather than the raw shortfall.
6. **Two spec-side gaps worth noting**, since they affect what can be conformed to at all:
   `SMSC_MANAGER_SPEC_07/08/09` **do not exist** (the improvement proposals already flag this:
   "Author the missing SMSC Manager parts 07–09 before building the SMSC API beyond current
   scope"), and `SYSTEM_DATA_MODEL` jumps from Chapter 21 to Chapter 32 — Chapters 22–31
   (Configuration, Infrastructure, Docker, Plugin, Notification, Security, Backup, Scheduler)
   are declared in Ch.3 and never written.

---

## 4. Overstated claims

`progress/requirements-traceability.md` is, by industry standards, an unusually honest document.
Its external-evidence section is correct and unfabricated, several "Partial" rows are accurate,
and the in-code `INTEGRATION POINT` docstrings deserve credit for naming their own gaps.
The problem is systematic rather than dishonest, and it has one shape:

> **The ledger consistently books *capability shipped* as *capability delivered*.**
> Cursor pagination, `?fields=` projection, soft delete, optimistic locking, the audit-signature
> service, `AlertEvaluatorService`, `requireCapability()`, `PluginManifestValidator`,
> `selectRoute()`, `CustomerQuotaService`, `CustomerCreditService` and `SmscService` are all real,
> tested, merged code with adoption rates of 1/18, 1/18, 4/71, 1 service, 0 tables, **0 callers**,
> **0 callers**, **0 callers**, 1 preview endpoint, 0 send paths, 0 send paths and **0 injections**
> respectively. Every one of them is listed as evidence of a delivered requirement.

### Rows marked "Complete" that this audit cannot substantiate

| Row | Claim | Finding |
|---|---|---|
| **Routing** | "Complete (software); external evidence outstanding". Remaining gap: performance-at-volume evidence and HLR/MNP lookup. | The spec's defining sentence is "the Routing Engine determines how every SMS is delivered". It determines none. Also unlisted: blacklist/whitelist, retry routing and customer routing (all explicit `SPEC_02` requirements with zero implementation); `route_groups`/`route_conditions`/`route_actions` (3 of 7 `SPEC_06` tables); failover cannot fire because `availableSmscIds` is never populated from health; two divergent engines with the operator's simulator wired to the legacy one; routing-depth has no UI at all; `/routing/resolve` ignores `deployment_state`; `route_versions` has no restore endpoint. |
| **Messaging** | "Complete (software)". Remaining: streaming exports, parts/cost model, search-perf evidence. | Against the spec's own §20 acceptance list of 10 criteria, 2 are met, 2 partially, and 5 fail outright: history is not complete (3 statuses), route trace absent, SMSC trace absent, DLR history absent, timeline is 2 rows. Unlisted: spec-03's entire database design; no date-range filter; **DLR outcome never classified, producing a materially incorrect delivery-rate KPI**; "Replay DLR" (a named `SPEC_02` requirement and `SPEC_04` endpoint) is not implemented — replay re-sends the MT; retention deletes the *engine's* rows and keeps no archive. |
| **API Gateway** | "Complete (software)". Remaining: OAuth2/OIDC and distributed rate-limit evidence. | The guard protects one demo route which itself has no permission check, so **no scope is enforced anywhere and no business function is reachable by API key**. The row's headline evidence ("API client registry with scopes, rotate/revoke, portal") describes `api_gateway_clients`, a table **no guard reads** — its `scopes`, `allowed_routes` and `rate_limit_per_min` are enforced by zero lines of code. No webhook framework; the "signature" is a replayed static secret. 1 of 9 rate-limit dimensions. |
| **Database** | "Complete (software)". Remaining: `audit_log` native partitioning, documented as a DBA runbook. | Four whole spec chapters are at 0 % table coverage (MESSAGING 0/20, DLR 0/9, QUEUE 0/9, MONITORING 0/13 = 51 tables); ROUTING is 3/24; SYSTEM 1/15. Two cross-cutting standards the spec calls *mandatory* are applied to **4 of 71** tables. `audit_signatures` has a service and no table. The single named gap understates the real one by roughly two orders of magnitude. Internally inconsistent, too: the **System** row is Partial for schema reasons and the **Reporting** row concedes "no billing/cost model yet" — both are Database-schema gaps. |
| **Monitoring** | "Complete (software)". Remaining: provider-grade delivery evidence, geo/heatmap dashboards. | 2 of the spec's 12 named metrics; **zero SMSC-level metrics exported**. "Live engine monitoring" is one endpoint returning engine identity plus health — presence, not monitoring. "Persisted alert rules" is the most misleading item in the table: they are persisted and **never evaluated**. The Grafana dashboard has 3 Node-process panels and one of the two Prometheus jobs scrapes a path the engine does not serve. Escalation, maintenance windows and correlation are API-only — none has a UI, and no escalation policy is seeded, so in a default deployment no alert notification is ever sent automatically. |
| **Reliability / HA / Performance** | "Complete (software/config)". Remaining: pen-test, soak, failover drill, PITR, one-click restore. | Backup wording is accurate and well hedged — credit. But **offsite/S3 replication** (a headline BDR objective) appears in neither column; nor does config/certificate capture; nor that `kind='incremental'` produces a full dump. Claiming HA complete-in-software while **every health check terminates at a hardcoded `ok`** is not defensible — LB ejection, container healthchecks and the watchdog are all inert. Performance omits that 2 of 7 latency targets are unencoded, no throughput target is tested at all, and §23 regression gating does not exist. |
| **QA** | "Complete (software)". Remaining: coverage-gate thresholds in CI, mutation testing. | The *numbers* check out — 71 backend spec files / ~400 cases, and 33 `test()` declarations across 9 e2e files against 1 chromium project reconcile with "36" at the reported commit. The *conclusion* does not. **CI does not exist** — there is no `.github/` and no pipeline file of any kind — so "coverage-gate thresholds in CI" implies a pipeline that is absent. No `coverageThreshold`; coverage is never measured. No ESLint config or dependency. 2 of 9 integration areas. And 22 of the 33 e2e tests are navigation smoke (`e2e/tests/navigation.spec.ts` loops 22 routes asserting a testid is visible); of the remaining 11, three are genuine workflows and the rest assert widget presence — `e2e/tests/routing.spec.ts` verifies that two dropdowns populate, and `reports.spec.ts:24-34` explicitly accepts `unavailable` as a pass. No e2e acknowledges an alert, runs a backup, or verifies a restore. Nothing in the suite exercises `SMSC_MANAGER_SPEC_10`'s acceptance chain (create → validate → deploy → **bind succeeds**), which is unreachable anyway given G1. |
| **Runtime / Docker** | "Complete (software)". Remaining: read-only/cap_drop on stateful images, opt-in TLS, resource limits "documented as tuning". | The 14-service topology and 4 isolated networks are genuinely delivered. But "resource limits documented as tuning" understates a spec requirement: `DOCKER` §17 says *every* container shall define CPU limit/reservation, memory limit/reservation, file descriptors, max connections, restart policy and OOM policy. Repo-wide grep for `mem_limit|cpus|deploy:|ulimits|pids_limit` in `docker-compose.yml` returns **zero hits**; only `restart:` is set. Per-container probes (§11) reduce to the one static endpoint. No cAdvisor, so §19's per-container metrics do not exist. |

### Rows marked "Partial" whose gap list is materially incomplete

- **Identity** — the two named gaps are WebAuthn (explicitly "Future" in both specs, therefore the
  *least* important item on the list) and per-role MFA forcing. Unlisted: **scrypt not Argon2id**
  (§9 is unconditional); no configurable password policy and the Settings UI knobs are read by
  nothing; **0 of 8 spec roles seeded** and no role/permission CRUD, which also makes the
  "Role Changed"/"Permission Changed" audit events structurally unreachable; 12 of 18 profile
  fields absent; no concurrent-session cap or idle timeout; `AuthGuard` never consults
  `auth_sessions`; no service accounts; and **two live defects** — permanent lockout (G8) and
  privilege persistence through refresh (G12). The row's bolded claim
  "**lockout (fixed: locked accounts no longer re-extend their own window)**" is true as written
  and, read as a whole, misleading: lockout is now permanent rather than self-extending.
- **Frontend** — the two named gaps are the visual route builder, the side-by-side config editor
  and visual-regression breadth. Unlisted: **no real-time layer anywhere** (three specs make it an
  acceptance criterion); alerts have 0 of 9 lifecycle actions; no Log Explorer, Scheduler,
  Permission Matrix, Auth-history or Service-Accounts screens; 1 of 8 dashboards and 4 of 14
  tiles; no tab/detail-route architecture for ~116 spec'd tabs; no i18n. "Per-module surfaces
  across every nav item" is true but load-bearing in a misleading way — 17 of 22 routes are one
  component and 6 of them render an identical 4-column table. "Broader visual-regression coverage"
  understates `frontend/e2e/console.visual.spec.ts`: 66 lines, **2 screenshots** (login and the
  authenticated shell).
- **Platform / API** — the three named gaps (SDK generation, universal cursor adoption,
  worker-backed jobs) are all real, but at least twelve more exist: 1 of 14 filter operators;
  2 of 15 error categories with `errors[]` never populated; no problem+json; **no rate limiting on
  the JWT API at all**; no ETag/If-Match; no Deprecation/Sunset; `?fields=` is *also* 1-of-18
  adopted though the row credits it as delivered; no `page`/`page_size`; envelope `meta`/`links`/
  `warnings` permanently empty; no webhook API; no real-time/streaming (a full dedicated chapter);
  no generic batch operations. And "tenant-scoped platform job records and `/jobs` APIs" as
  *evidence* deserves the plainer wording **no executor exists** — `POST /jobs` accepts work
  forever.
- **Configuration** — the four named gaps are accurate; three of them are against
  *unwritten future parts* of the spec and should be relabelled roadmap. Missing from the list are
  the two Part-1 failures that matter most: the model is not DB-derived, and SMSC credentials and
  SMPP tuning cannot be rendered. Also unlisted: the Kannel renderer **throws** (the row credits
  "per-engine rendering hook" as delivered — the hook exists, the renderer does not); only 3 of
  ~10 directive groups are modelled; import/export is absent; and "immutable versions" is
  contradicted by `markConfigurationValidated` mutating `content` without recomputing the checksum.
  "Secret-reference management" as a gap label reads as *we have refs, we need a manager*; in fact
  the refs are never resolved or rendered anywhere — they are a naming convention validated by
  `String.startsWith`, and the one enforcement point (`SmscService`) is injected nowhere.
- **SMSC** — accurate on CRUD, validation, soft-archive (which is better than claimed: it includes
  a route-reference 409 guard) and idempotent operation history. Two overstatements:
  "adapter-backed **reconnect**" issues the identical `start-smsc` call as enable, so it does not
  reconnect a bound SMSC; and "**test connection**" is a raw TCP `connect()`, not a bind test,
  with `fake` returning success without touching the network. The remaining-work column omits the
  config-render gap, which is more severe than the polling gap it does name.
- **Engine** — "sibling adapters" is technically true and materially misleading:
  `kannel.adapter.ts` performs **no I/O whatsoever** and selection is by a global
  `process.env.ENGINE_IMPLEMENTATION ?? 'kamex'`, never per `engine_instance`. "Capability-based
  dispatch" is overstated — dispatch is `'controlSmsc' in adapter` duck-typing, and the one
  manifest check re-derives the manifest one line earlier so it can never fail; the real gate,
  `requireCapability()`, has zero call sites. "Live Kamex health/status and SQLBox probing" is
  accurate and if anything *understated*. Unlisted: all ten `002_engine_observability` tables are
  referenced by no code, so no capability, runtime, connection or lifecycle snapshot is ever
  persisted and the contract's freshness rules are structurally unenforceable.
- **Plugins** — the gap sentence is accurate and well phrased. The *evidence* column is not:
  "manifest validation" ships as a library, not as behaviour — `PluginManifestValidator` and
  `PluginRuntime` are in no NestJS module and the live install path inserts unvalidated JSON.
  "Sample plugin + SDK" overstates: `sdk/typescript/` is a lone README, the example plugin has no
  `src/`, and the seeded `slack-notifier` has no package in the repo at all.
- **AI Operations** — this row is, if anything, an *under*statement that reads as an overstatement.
  It should carry an explicit note that Ch.11–64 is future scope per `PRODUCT_SCOPE.md`, otherwise
  a reviewer comparing 2 774 spec lines to ~15 KB of code will conclude the domain is 1 % complete
  when its current scope is essentially done.

### Missing rows

- **Customers** — no row at all, despite two shipped modules, two migrations, six FORCE-RLS tables
  and 14 live routes. Honest status: **Partial** — primitives correct and well locked, enforcement
  wired into none of the four send paths, duplicate policy columns across migrations 020 and 026,
  no cost model. Billing's absence is spec-compliant and should be stated as such.
- **Logging & Audit** — no row names this 619-line specification. The audit half is credited
  obliquely under Database and Platform/API. The **logging** half (§§4,5,6,9,10,11,14,16,18,19 —
  categories, 8 levels, structured fields, pipeline, live viewer, search, per-level retention,
  SIEM export, rotation, centralisation) is credited nowhere and built nowhere. This is the
  largest silently-uncovered specification in the repo.
- **Health/readiness** — no row acknowledges that the health endpoint performs no dependency
  check, while both Platform/API and Runtime/Docker imply working probes and the compose
  healthchecks depend on it.

### Smaller factual corrections

- "argon2 auth (~535 ms p95)" — the measured path is `scrypt(N=16384, r=8, p=1)`
  (`security/password-hasher.ts:3`). `SYSTEM_IMPROVEMENT_PROPOSALS.md:104` states this correctly;
  the ledger and `perf/README.md` do not. The distinction matters: `UV_THREADPOOL_SIZE` is unset
  anywhere in the repo, so scrypt is serialised across 4 libuv threads under concurrency — the
  likely remediation is thread-pool sizing and cost tuning, not the "provisioned hardware"
  the harness notes conclude.
- `SPEC_CONFORMANCE_PLAN.md:26` scoped `service_accounts` and `personal_access_tokens` into Wave 1;
  neither table exists and the Wave 1 status line silently omits them. Scope was dropped, not
  overstated — but it should be recorded.
- `PROJECT_STATE.md:48` states "A live carrier SMPP bind configured as a managed SMSC". No SMPP
  SMSC group exists in any committed config (`runtime/kamex/kamex.conf` and
  `infrastructure/kannel/kamex.conf` contain only two `smsc = fake` groups), and per G1 the
  generator cannot render one. If such a bind existed it was a manual file edit, not a managed
  SMSC — which is the opposite of the claim.

---

## 5. External-evidence gates

Requirements that no amount of code can satisfy. The four already named in
`progress/requirements-traceability.md:44-57` are correct and stand: **independent penetration
test**, **production-scale soak at 100 k msg/s**, **multi-node HA failover drill with measured
RPO/RTO**, and **carrier-grade live send** (blocked on carrier-side IP allow-listing). Note that
the pen-test gate should be *sequenced after* G8 and G12 — commissioning one now would spend an
external engagement rediscovering defects already documented here.

Additional gates identified by this audit:

1. **Restore-to-production drill.** `restoreBackup()` deliberately never touches the live database
   — correct engineering, and it means no code path can ever prove a production restore works.
   `BACKUP_AND_DR` §25 acceptance is unmet by construction. Requires a scheduled human drill on a
   rebuilt host with wall-clock time recorded against the <5 min RTO.
2. **Full-site loss recovery from artefacts alone** (`BACKUP_AND_DR` §21, `DOCKER` §22). Rebuild on
   a clean host using only backup artefacts. This will fail today — certificates, `.env`, compose
   files and engine config are in no backup (G17). Worth running precisely to prove that.
3. **Measured RPO/RTO.** Wall-clock properties of a real failure. Note the *code* currently
   guarantees RPO ≥ the scheduler interval (1 h default) with no WAL shipping — fix that design
   gap before scheduling the drill, or the drill will only confirm it.
4. **SMPP protocol conformance against a real or simulated SMSC.** submit_sm/deliver_sm behaviour,
   DLR mapping, window sizing, throttling and rebind under carrier conditions. Needs a carrier
   bind or SMPPSim with captured PDUs. Blocked behind G1 — there is nothing to bind with yet.
5. **Notification deliverability at scale.** SMTP reputation, webhook retry under receiver outage,
   provider rate limits. Partly a code gap too: `deliverWebhook` has a 5 s timeout and **no retry**,
   so a transient receiver blip permanently loses the notification.
6. **Rolling-upgrade and rollback drill on real hosts** (`HIGH_AVAILABILITY` §15, `DOCKER` §16),
   with real client traffic and a measured error budget during the roll. No automation exists to
   drill yet, and G7 must land first or the health gate is meaningless.
7. **Chaos and stress recovery** (`TESTING_AND_QA` §19–20): kill containers, partition the network,
   restart the database, disconnect an SMSC, corrupt the cache. Recovery behaviour is inherently
   empirical; no harness exists.
8. **Container supply chain** (`DOCKER` §15): image scanning, checksums, licence audit, signing.
   Requires a registry, scanner and signing authority outside the repo.
9. **Grafana/Loki/Prometheus operational validation** — dashboard usefulness under real load, log
   retention and cardinality, alert-rule tuning. Currently unvalidatable: three panels and a dead
   engine scrape job (G6).
10. **Accessibility and browser compatibility** (`TESTING_AND_QA` §15). Playwright runs chromium
    only; WCAG conformance needs assistive-technology testing.

---

## 6. Recommended next build order

Sequenced so that each wave unblocks the next and each ships something an operator can feel.
The first wave is deliberately small and defect-shaped: it stops active harm before adding
capability.

### Wave A — Stop the bleeding (days, not weeks)

Nothing here is larger than S, and several are single-function fixes with outsized effect.

1. **G8 permanent lockout** — clear `status`/`locked_until` on window expiry; extend the spec fake
   so the existing suite covers it. *Unauthenticated DoS against any account.*
2. **G12 stale privileges on refresh** — re-resolve status/roles/permissions in `refresh()`;
   revoke sessions on disable and role change.
3. **G12 webhook secrets** — redact on read, encrypt at write, replace the static-secret header
   with HMAC-SHA256.
4. **G12 XFF trust** — set `trust proxy`, derive the client IP from the rightmost untrusted hop.
5. **G12 MFA throttling + `/auth/*` rate limiting** — reuse the existing Redis limiter.
6. **G7 real health/readiness probes** — and point compose and nginx at `/ready`.
7. **G4 decode `dlr_mask`, then fix `successRates`/`deliveryBreakdown`** — the shipped
   success/failure reports are currently wrong; this is the highest value-per-hour item in the
   report.
8. **G16 add CI** — typecheck, format, tests with coverage measured (thresholds set at current
   measured values), `docker compose config`, `npm audit`. Everything after this is protected.
9. **Honesty fixes** — make `POST /jobs` return 501 until an executor exists; reject
   `type='sms'` notification channels; disable alert-rule creation in the UI until G3 lands.
   Update `progress/requirements-traceability.md` per §4 — the Complete rows, the two missing
   rows, and the argon2/scrypt correction.

*Exit criterion: no shipped surface silently reports success while doing nothing.*

### Wave B — Make configuration real (the product's core promise)

10. **G1a** — extend `EngineConfiguration` and `smsc_definitions` with the `SMSC_MANAGER_SPEC_03`
    attribute set; add a `SecretResolver`; render `smsc-username`/`smsc-password`/`system-type`/
    bind mode/TON/NPI/`throughput`/keepalive.
11. **G1b** — add the `smsbox`, `sendsms-user`, `sms-service`, `dlr-storage` and `ssl` groups so a
    generated config is a *complete working gateway*, with golden-file tests against the native
    validator. Fix the deploy health check to reject 503.
12. **G1c** — `ConfigurationModelBuilder` reading from the database; `/configurations/generate`
    builds from DB by default.
13. **Ancillary** — fix `reconnect` to actually cycle the bind; make "test connection" attempt a
    real bind; stop mutating version `content`; call `SmscService`'s `secret://` assertion from the
    console create path.

*Exit criterion: an operator can create an SMPP SMSC in the UI, generate, validate, deploy, and
have the engine bind to a carrier — the `SMSC_MANAGER_SPEC_10` acceptance chain, currently
unreachable.*

### Wave C — Close the observability loop

14. **G14 `SmscStatusPoller`** — advisory-locked, writing `engine_connection_snapshots` +
    `smsc_health`, diffing state to emit bind-transition audit rows and alerts.
15. **G6 `EngineMetricsService`** — export bind/queue/throughput/DLR metrics; delete the dead
    Prometheus job; build a Grafana dashboard that is about SMS, not about Node.
16. **G3 `AlertRuleEvaluatorScheduler`** over the sample stream from 14/15; route `step.target` in
    escalation; implement `deliverSms()` through the platform's own send path.
17. **G19a alert lifecycle actions in the UI** (ack/assign/resolve/suppress) — the mechanism
    already exists for SMSC rows.

*Exit criterion: a bind that drops at 03:00 produces an alert that reaches a human, and the
operator can acknowledge it.*

### Wave D — Put routing and customers on the send path

18. **G9 an API-key-authenticated submit endpoint** with scope enforcement — this is also where the
    customer identity for step 20 comes from. Retire or unify `api_gateway_clients`.
19. **G2 route selection in the send path** — optional `smscId`, `RoutingDepthService.resolve` on
    the send path, `message_route_decisions` persisted, `availableSmscIds` from live health, one
    engine only, `deployment_state` respected.
20. **G5 customer entitlement enforcement** — `customer_id` on `bulk_send_jobs`, quota + credit +
    sender ID + route binding checked inside the send transaction; reconcile the duplicate policy
    columns; give bulk send a real sender.
21. **Blacklist/whitelist/DND** evaluated before route selection; shared E.164 normaliser.

*Exit criterion: disabling a route changes traffic; exceeding a quota is refused; a rejected
sender ID cannot send.*

### Wave E — Operator surfaces

22. **G10 live-update layer** — `useLiveResource` polling first, SSE for the queue and log tails.
23. **G20 real columns** for messages/SMSC/routing/monitoring/users — hours of work each, using a
    mechanism that already exists.
24. **G13 message search** — date range, the unselected `sent_sms` columns (encoding, UDH,
    validity, binfo), `pg_trgm` index, `status` passed through to export.
25. **G19b Log Explorer** + enrich `JsonLogger` with correlation/request/user/category/duration
    via AsyncLocalStorage and the spec's 8 levels.
26. **G11 role and permission administration** + seed the 8 spec roles and the full permission
    catalogue.
27. **Missing UI for already-built backends** — escalation policies, maintenance windows, backup
    schedules, routing-depth (route types, strategies, targets, versions). Cheapest conversion of
    existing work into operator value in the whole plan.

### Wave F — Durability and platform depth

28. **G17 backup hardening** — offsite destination, failure alerting, config/cert/compose capture,
    fix or remove the `incremental` label, mandatory `BACKUP_ENCRYPTION_KEY`; then PITR.
29. **G15 a real job queue** with retry/backoff/DLQ; migrate the six schedulers; bulk-send retries.
30. **G18 REST conformance** — cursor and `?fields=` across all 18 grids (~1 day), typed filter
    operators, error taxonomy with populated `errors[]`, ETag/If-Match over the existing `version`
    column.
31. **G12 TLS**, container resource limits, distributed lock on config/route deploy, watchdog →
    Alerts + Audit, cAdvisor/node_exporter, replication-lag metrics.
32. **Plugin install validation** (call the validator that already exists) — S, and it closes a
    real hole.

### Wave G — Then, and only then, the external gates

33. Independent penetration test (after Waves A and F).
34. Production-scale soak (after G13's owned store and indexes, or it measures an empty database).
35. Multi-node failover drill (after G7, or the health gate is meaningless).
36. Carrier live send (after Wave B, or there is nothing to bind with).
37. Restore-to-production and full-site-loss drills (after Wave F item 28).

---

*End of analysis.*
