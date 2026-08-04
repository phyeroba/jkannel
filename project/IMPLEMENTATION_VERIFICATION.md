# JKANNEL — Independent Implementation Verification

Author: Claude (verification agent) · Date: 2026-08-04 · Baseline commit `eefa320`
(`9ba2bae` "Close the audit gaps" is the remediation commit under review)
Scope: **read-only**. No source file was modified in producing this document.

> **Headline verdict.** The six remediation waves are substantially real, not paper. The three
> integration voids that dominated `project/SPEC_GAP_ANALYSIS.md` are genuinely closed: a single
> `MessageSendService` now funnels the console, API-gateway, bulk and replay send paths through
> route selection, blocklist and customer entitlements inside one transaction and records the
> decision; `ConfigurationModelBuilder` composes the engine model from `smsc_definitions` and the
> renderer emits credentials, SMPP bind parameters and the `smsbox`/`sendsms-user`/`sms-service`/
> `dlr-db` groups; and `AlertRuleEvaluatorScheduler` drives the previously-callerless
> `AlertEvaluatorService` over a `metric_samples` stream that `SmscStatusPoller` actually writes.
> The most severe defect in the prior audit — permanent account lockout — is fixed, as are stale
> privileges on refresh, the X-Forwarded-For allowlist bypass, unthrottled auth, the hardcoded
> `/health`, the never-executed `api_jobs` queue, the wrong DLR-derived success rate, and the
> absence of CI. **Ten of twenty gaps are closed, seven are partially closed, three remain open.**
> What a public feature list must still avoid: there is **no role or permission administration and
> no seeded role catalogue** (G11), **no real-time/push layer** (polling only), **no log explorer**
> and no correlation ID in log lines, **no TLS listener** in the shipped topology, **webhook/
> notification-channel secrets are still stored and returned in plaintext**, **no PITR and no true
> remote offsite backup driver**, **no container resource limits**, **`reconnect` is still the same
> engine call as `enable`**, **"test connection" is still a bare TCP connect, not a bind**, and the
> e2e suite is *more* navigation-smoke-heavy than before (26 of 40 cases are one loop; **5 genuinely
> mutating workflow tests exist in the entire repository**).

---

## 1. Method

The decisive test is unchanged from the prior audit and was applied to every claim:

> **Does a non-test caller reach this on a real request path?**

Evidence was produced three ways:

1. **Call-site tracing.** For every symbol the prior audit reported as having zero or token
   callers (`selectRoute`, `AlertEvaluatorService`, `requireCapability`, `PluginManifestValidator`,
   `SmscService`, `CustomerQuotaService`, `CustomerCreditService`, `ConfigurationModelBuilder`,
   `JobWorker`, `SmscStatusPoller`), the symbol was grepped across `backend/src` excluding
   `*.spec.ts` and each hit was opened and read. Module registration was verified separately —
   a provider that is listed in a module but injected nowhere is still not delivered.
2. **Route-table extraction.** All 43 non-test `@Controller` classes were parsed and every
   `@Get/@Post/@Patch/@Put/@Delete` handler was paired with its `@RequirePermissions` and its
   class/method guard stack. That table (§4) is the checkable feature surface; **246** HTTP
   handlers exist.
3. **Artifact inspection.** Migrations `001–035` (81 `CREATE TABLE`s), `docker-compose.yml`,
   `docker-compose.ha.yml`, `infrastructure/`, `.github/workflows/ci.yml`,
   `infrastructure/monitoring/prometheus.yml` and both Grafana dashboards were read directly.

Frontend router/view/test enumeration was delegated to a read-only exploration pass and every
material claim in it was spot-checked against the cited file and line.

**Counts as measured this run** (not quoted from the ledger): backend **100 Jest suites / 824
`it()` declarations**, **2** integration spec files (`app.integration-spec.ts`,
`rls.integration-spec.ts`), frontend **18 vitest files / 112 cases**, e2e **10 spec files / 40
runtime cases in `e2e/` + 6 in `frontend/e2e/`**, **246** HTTP handlers, **81** tables,
**35** migrations, **289** backend TypeScript files.

### Classification

| Grade | Meaning |
|---|---|
| **WORKING** | Implemented, reachable from a real request path, covered by tests. |
| **PARTIAL** | Works, with a material limitation a user would notice. The limitation is stated. |
| **BUILT-NOT-WIRED** | Code exists and may be tested, but no non-test caller reaches it. |
| **ABSENT** | Claimed or specified, not implemented. |

---

## 2. Gap closure — G1 to G20

| # | What it was | Status now | Evidence |
|---|---|---|---|
| **G1** | SMSC Manager and Configuration Generator disconnected; generated config cannot bind to an authenticated carrier | **CLOSED** (residual limits below) | `configuration/configuration-model.builder.ts:114 ConfigurationModelBuilder` reached from `console/console.controllers.ts:922` — `POST /configurations/generate` defaults to `source='database'` when no body is posted (`:913`). `configuration-generator.service.ts:474 renderSmppSmsc` emits `smsc-username`, `smsc-password`, `system-type`, `interface-version`, `transceiver-mode`, `source-addr-ton/npi`, `dest-addr-ton/npi`, `max-pending-submits`, `enquire-link-interval`, `wait-ack`, `use-ssl`; `:396–463` emit `group=smsbox`, `sendsms-user`, `sms-service`, `pgsql-connection`, `dlr-db`. Secrets render as `${ENV}` via `secret-resolver.service.ts:70 SecretResolver`, never literals. Migration `029_smsc_attributes.up.sql:25–62` adds 20 SPEC_03 columns. **Residual:** the Kannel arm still `throw`s (`configuration-generator.service.ts:345`); SMSC types remain 4 of 7 (`smsc/smsc.service.ts:2` — `smpp\|http\|fake\|at`); no committed config contains a real SMPP group, so the create→deploy→**bind** chain is still unproven. |
| **G2** | Routing engine not on the send path; routing configuration changed nothing | **CLOSED** (one step of SPEC_04 missing) | `messaging-depth/message-send.service.ts:126 MessageSendService` is the single funnel. Callers: `console.controllers.ts:1207` (`POST /messages`), `api-gateway/gateway-messaging.controller.ts:102` (`POST /gateway/messages`), `messaging-depth/bulk-send.service.ts:351`, `messaging-depth/message-operations.service.ts:139`. `smscId` is optional; when omitted `routing-depth/route-resolution.service.ts:154` calls `selectRoute()` and the send **fails closed** rather than picking an arbitrary bind (`message-send.service.ts:390`). Decisions persist to `message_route_decisions` (`:158`). `availableSmscIds` comes from `smsc_bind_state` (`route-resolution.service.ts:85`), `deployment_state='deployed'` is respected (`routing-depth/routing-depth.repository.ts:22`), and the legacy engine was converted into a thin adapter over the same `selectRoute()` (`routing/routing.service.ts:72`) so `/routes/simulate` and production agree. **Missing:** SPEC_04 step 7 per-route/per-SMSC throttling — grep for `throttl` in `routing-depth/` and `messaging-depth/` returns nothing. |
| **G3** | Console-authored `alert_rules` were never evaluated | **CLOSED** | `monitoring-depth/alert-rule-evaluator.scheduler.ts:97` injects `AlertEvaluatorService` and is registered at `monitoring-depth/monitoring-depth.module.ts:57`. Its metric source exists: `monitoring-depth/smsc-status.poller.ts:118` writes `metric_samples`, `smsc_bind_state` and `smsc_bind_transitions` (migration `031_engine_observability.up.sql:80,99,119`). `notification-delivery.service.ts:128 deliverSms` now submits through SQLBox instead of returning `skipped`, and `alert-escalation.service.ts:277 routeToTarget` honours `step.target`. |
| **G4** | `dlr_mask` never decoded; shipped success-rate reports were wrong | **CLOSED** | `engine/kamex-sqlbox.repository.ts:148–155` derives `delivery_status` from the **latest correlated DLR row's** mask (1=delivered, 2=failed, 4=buffered, 8=accepted, 16=rejected), correctly distinguishing it from an MT row's *requested* mask (`:157`, `:206`). `reporting/reporting-analytics.service.ts:98–110 summariseOutcomes` computes `successRate = delivered / (delivered + failed + rejected)`; the old dlrs/messages figure survives only under the honest label "DLR coverage" (`:242`). |
| **G5** | Customer quota, credit, sender IDs, route bindings had zero runtime effect | **CLOSED** (pricing still flat) | `messaging-depth/send-entitlements.service.ts:181 consumeInClient` is invoked at `message-send.service.ts:260` **inside the same tenant transaction as the engine submit**, and delegates to the correctly row-locked `customers-depth/customer-quota.service.ts:169` and `customer-credit.service.ts`. `bulk_send_jobs.customer_id` added (`032_send_path.up.sql:37`). **Remaining:** `customers.rate_limit_per_min` is enforced nowhere; no per-customer tariff, destination rating or multi-part segment counting. |
| **G6** | No SMS/SMSC telemetry in Prometheus; dead engine scrape job | **CLOSED** (host metrics still absent) | `monitoring-depth/engine-metrics.service.ts:133–167` exports `jkannel_smsc_bind_up`, `jkannel_smsc_queued`, `jkannel_smsc_failed_total`, `jkannel_smsc_messages_total`, `jkannel_smsc_throughput_messages_per_second`, `jkannel_engine_dlr_queued`; composed into the scrape at `monitoring/metrics.controller.ts:17,60`. `jkannel_backend_up` is now driven by the real probe (`metrics.controller.ts:29–34`). The dead `kamex-bearerbox` job is gone — `infrastructure/monitoring/prometheus.yml` has exactly two jobs (`jkannel-backend`, `prometheus`). A real SMS dashboard ships (`grafana/dashboards/jkannel-sms-operations.json`: bind health, per-SMSC queue depth, throughput, failures, DLR pending). **Remaining:** no cAdvisor/node_exporter, so CPU/RAM/disk/network — 4 of the spec's 12 named metrics — are still unobservable. |
| **G7** | `/health` was a hardcoded literal | **CLOSED for the defect; PARTIAL vs spec** | `health/health.service.ts:96 check()` probes Postgres (`SELECT 1`, required) and Redis (`PING`, optional) under a bounded `withTimeout`, redacts driver detail (`safeDetail`, `:62`), and `health.controller.ts:26` maps `unhealthy → 503`. Compose healthchecks point at it (`docker-compose.yml:126,357,385`). **Remaining:** `HIGH_AVAILABILITY` §12 asks for five endpoints; only `GET /health` exists — no `/health/live`, `/health/ready`, `/health/version`, `/health/dependencies`. |
| **G8** | 5 wrong guesses disabled an account permanently | **CLOSED** | `security/auth.service.ts:123` — `if (user.status !== 'active' && user.status !== 'locked') throw`. Reaching that line already guarantees no live lock window (the branch at `:69` returns while one is active), so a stale `'locked'` no longer bars entry and `recordSuccessfulLogin` (`postgres-auth.repository.ts:63`) clears it back to `active`. |
| **G9** | API key authenticated one echo endpoint; no scope enforced anywhere | **CLOSED** | `api-gateway/gateway-messaging.controller.ts:64` stacks `ApiKeyAuthGuard + PermissionsGuard + GatewayAuditInterceptor` over three real business routes: `POST /gateway/messages` (`sms.send`), `GET /gateway/messages` (`sms.read`), `GET /gateway/routing-decisions` (`routing.read`) — vocabulary in `api-gateway/gateway-scopes.ts`. Customer identity comes from `api_keys.customer_id` and **never from the body** (`:116`; migration `033_gateway_credentials.up.sql:31`). `api_gateway_clients` is explicitly demoted to a non-authenticating registry in the migration header. |
| **G10** | Nothing in the product updates by itself | **PARTIAL** | A real shared composable now exists — `frontend/src/composables/useLiveResource.ts` (overlap guard, `document.hidden` guard, caller pause predicate, deterministic cleanup) — consumed by `OperationsOverview.vue:132` (30 s), `LiveQueueView.vue:730` (5 s) and `ModuleWorkspace.vue:2649–2670` for `alerts`/`smsc`/`monitoring` only (30 s, **default off**). **Still absent:** repo-wide grep for `WebSocket`, `socket.io`, `EventSource`, `text/event-stream`, `@Sse(`, `@WebSocketGateway` returns **zero hits in both `backend/src` and `frontend/src`**. 14 of 18 workspace modules and 7 of 13 dedicated views are manual-refresh only. |
| **G11** | No role/permission administration; 0 of 8 spec roles seeded | **OPEN** | `GET /users/roles` (`console.controllers.ts:650`) is the only role endpoint and is read-only. Grep for `INSERT INTO roles`/`INSERT INTO permissions` across `database/migrations/` returns **nothing** — there is no seeding migration. The sole seeder remains `security/create-development-operator.ts`, which throws in production (`:5`) and creates exactly one role, `administrator`, with 21 codes. `RolesView.vue` is a read-only viewer over `/users/roles`. "Role Changed"/"Permission Changed" audit events remain structurally unreachable. *(One sub-item did close: the previously unseeded `messages.send` is now seeded at `:41`, and the enforced-but-unseeded `widgets.*` codes were removed, so the seed now covers every enforced permission.)* |
| **G12** | Five-defect security cluster | **PARTIAL — 3 of 5 closed** | **Closed:** stale privileges on refresh — `auth.service.ts:303` re-resolves via `findCredentialById` and revokes the family on a non-usable account. XFF trust — `main.ts:25 app.set('trust proxy', …)`, `platform/request-context.middleware.ts:37 resolveClientIp`, consumed at `api-key-auth.guard.ts:55`. MFA throttling and `/auth/*` rate limiting — `security/auth-throttle.service.ts` + `auth-throttle.guard.ts`, applied at `auth.controller.ts` and `identity-mfa.controller.ts`; a wrong TOTP now increments the lockout counter (`auth.service.ts:136`). **Open:** webhook/channel secrets are still stored as unencrypted `jsonb` and returned unredacted — `console.repository.ts:827` selects `config` raw behind `alerts.view`, and `notification-delivery.service.ts:200` still sends that raw secret as `x-jkannel-signature` (a replayable static token, not an HMAC). No TLS listener — both `infrastructure/nginx/conf.d/jkannel.conf:35` and `infrastructure/ha/nginx/jkannel-ha.conf:37` are plain `listen 8080`; the only 443 config in the repo is `conf.d/tls.conf.example`. Also unchanged: `security/password-hasher.ts` is **scrypt, not Argon2id** (now documented honestly in the file header rather than fixed). |
| **G13** | Message read model cannot answer basic questions | **PARTIAL — 1 of 3 items closed** | Delivery outcome is now answerable (G4). **Still open:** `kamex-sqlbox.repository.ts:249 filters()` has **no date-range predicate** — no `from`/`to` at all; free-text search is still `msgdata ILIKE '%…%'` (`:278`), a leading wildcard; the SELECT lists (`:127,345,491`) still omit `coding`, `charset`, `udhdata`, `validity`, `deferred`, `mclass`, `pid`, `binfo`, `meta_data`, so encoding, segments and billing info are unavailable; `console.controllers.ts:1096 exportMessages` still forwards `query`/`smscId`/`direction` and **drops `status`**, so the CSV disagrees with the grid; JKANNEL still owns no message store (`MESSAGE_EXPLORER_SPEC_03`'s `messages`/`message_events`/`dlrs` tables do not exist) and retention still `DELETE`s the engine's rows. |
| **G14** | No continuous bind polling; no bind-state history | **CLOSED** | `monitoring-depth/smsc-status.poller.ts:118 SmscStatusPoller implements OnModuleInit`, registered at `monitoring-depth.module.ts:56`, writing `engine_poll_snapshots`, `smsc_bind_snapshots`, `smsc_bind_state`, `smsc_bind_transitions` and `metric_samples` (migration 031). Transitions are audited and feed alerts; the state is consumed by routing (`route-resolution.service.ts:85`) and by `/metrics`. *(Note: migration 002's ten `engine_*` observability tables — including `engine_connection_snapshots` — are **still referenced by no code**; migration 031 built a parallel, simpler set instead.)* |
| **G15** | `POST /jobs` accepted work nothing executed; no retry semantics | **CLOSED for `api_jobs`; open for bulk send** | `platform/job-worker.ts:71 JobWorker implements OnModuleInit` claims with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, dead-letters and reaps stale claims; registered in the `@Global` `platform/jobs.module.ts:23`. Migration `034_job_queue.up.sql:30–63` adds `attempts`, `max_attempts`, `next_attempt_at`, `dead_lettered_at` and the `dead_letter` status. `POST /jobs` now returns `@HttpCode(202)` with a `Location` header (`jobs.controller.ts:86`) — the only 202 in the repo. **Remaining:** `bulk_send_recipients` still has no `attempts`/`next_attempt_at`; grep for `retry` in `bulk-send.service.ts` returns nothing, so a transient SQLBox blip still terminally fails those recipients. The six domain schedulers remain advisory-locked `setInterval` loops rather than queue-backed. |
| **G16** | No CI, no coverage gate, no linter | **CLOSED** | `.github/workflows/ci.yml` — 5 jobs (`backend`, `frontend`, `compose`, `migrations`, `security`). `backend/package.json:83` sets `coverageThreshold` 53/41/43/53; `frontend/package.json:16` sets 87/69/68/87. ESLint configs exist in both packages (`backend/eslint.config.mjs`, `frontend/eslint.config.js`). **Caveat:** the entire `security` job is `continue-on-error: true` (`ci.yml:250,256,262`) — `npm audit` and the dependency scan do not block. |
| **G17** | Backups never left the host; no PITR; failures paged nobody | **PARTIAL** | **Closed:** `BACKUP_ENCRYPTION_KEY` is now mandatory with placeholder rejection (`backup-dr.service.ts:490–507`) — the JWT-key fallback chain is gone; failure and verification-failure now open `alert_instances` rows (`backup-dr.repository.ts:310,335,393`); config/certificate capture added (`backup-dr.service.ts:193,527`); the false `incremental` label was **retired rather than faked** — a requested `incremental` is recorded as `full` with an explanatory note (`:409`). **Open:** the "pluggable offsite destination" (`backup-dr/backup-destination.ts`) ships **only** `LocalFilesystemDestination` — a filesystem copy to `BACKUP_OFFSITE_DIR`; there is no S3/Azure/SFTP driver, only a documented extension point. No PITR/WAL archiving anywhere. |
| **G18** | Built REST primitives were barely adopted | **PARTIAL** | A shared `platform/grid-runner.ts:147 runGrid` now composes cursor + `?fields=` + filtering, adopted by **3–4 of 18** grids (`backup-dr/backup-dr.repository.ts:158`, `platform/jobs.service.ts:138`, `reporting-depth/report-definitions.repository.ts:162`). `platform/etag.ts` exists with **zero non-test callers** — grep for `If-Match`/`ifMatch` outside the module returns nothing. `platform/http-exception.filter.ts:33` still emits a hardcoded `errors: []` and still never logs the exception. No problem+json; still 1 of 14 filter operators. |
| **G19** | Alerts read-only in the UI; no Log Explorer; logs carry no correlation ID | **PARTIAL** | **a)** Alerts now have row actions (`ModuleWorkspace.vue:893` adds `alerts` to `hasRowActions`; cell at `:4770`), but only **2 of 9** spec actions: Acknowledge → `POST /alerts/:id/acknowledgements` and Re-notify → `POST /alerts/:id/notifications`. No resolve/assign/suppress/close/reopen/ticket endpoint exists in `AlertsController` (`console.controllers.ts:501–611`); the UI states this limitation in-page (`:4648`). **b)** No Log Explorer. `/logs-audit` is still bound to `GET /audit-events` only; there is no log controller in the backend at all. `platform/json.logger.ts` still emits four fields — grep for `correlation`/`requestId`/`AsyncLocalStorage` in it returns nothing, so the correlation apparatus remains invisible in the logs it was built for. |
| **G20** | Generic 4-column tables where the spec needs density | **MOSTLY CLOSED** | 13 module descriptors in `ModuleWorkspace.vue` now define real `columns:` arrays — `messages` 11 (`:142`), `smsc` 12 (`:222`), `routing` 11 (`:275`), `alerts` 10 (`:396`), `backup` 12 (`:582`), `users` 5 (`:625`), plus notifications/customers/api-gateway/logs-audit/plugins. Four more (`queues`, `delivery-reports`, `docker`, `system`) have bespoke renderers. **Two caveats:** `configuration` still renders the generic Name/Details/Status/Updated table; and `monitoring` — which the spec calls the primary NOC console — has four "columns" that are exactly the four generic fields relabelled, over a backend endpoint that returns a **single hardcoded item** (`console.controllers.ts:1302–1324`), so it is a one-row table. |

**Tally: CLOSED 10 · PARTIAL 7 · OPEN 3.**
Closed: G1, G2, G3, G4, G5, G6, G8, G9, G14, G16.
Partial: G7, G10, G12, G13, G15, G17, G18 *(and G19, G20 — see below)*.
Open: G11.

*(Precisely: G7 and G20 are closed against the defect that motivated them but partial against the
originating specification; G19 is half-closed. Counting them as PARTIAL gives 9 CLOSED / 10 PARTIAL
/ 1 OPEN; counting by "was the reported harm stopped" gives 10 / 7 / 3. Both readings are shown so
the number is not load-bearing.)*

---

## 3. Capability inventory

### 3.1 Messaging

| Capability | Grade | Evidence |
|---|---|---|
| Single message submit (console) | **WORKING** | `POST /messages` → `console.controllers.ts:1207` → `MessageSendService.send`. |
| Single message submit (API key) | **WORKING** | `POST /gateway/messages` → `gateway-messaging.controller.ts:102`, scope `sms.send`. |
| Message history with delivery outcome | **WORKING** | `GET /messages` → `kamex-sqlbox.repository.ts:287 list()`; status derived from correlated DLR (`:148`). |
| Message trace | **PARTIAL** | `GET /messages/:id/trace` (`:345`) returns spool + DLR events. No route trace, no SMSC trace, no customer trace — the recorded routing decision is exposed on the gateway API but not joined into the console trace. |
| Message search by date range | **ABSENT** | `filters()` (`:249`) has no `from`/`to`. |
| Free-text search performance | **PARTIAL** | `msgdata ILIKE '%…%'` (`:278`) — leading wildcard, unindexable. |
| Encoding / UDH / segments / validity / billing info | **ABSENT** | Present in `sent_sms`, never SELECTed (`:127,345,491`). |
| CSV export of messages | **PARTIAL** | `GET /messages/export.csv` drops the `status` filter (`console.controllers.ts:1096`), so the export disagrees with the grid. |
| PDF export | **WORKING** | `GET /messages/export.pdf`, `messages.export`. |
| Replay / clone / requeue | **WORKING** | `message-operations.controller.ts` → `message-operations.service.ts:139` → send path, with `rerouteIfUnavailable` so a replay does not re-target a dead bind. |
| "Replay DLR" | **ABSENT** | Named in `MESSAGE_EXPLORER_SPEC_02/04`; no endpoint. |
| Bulk send / campaigns | **PARTIAL** | `bulk-send.controller.ts` + `bulk-send.service.ts:351` (through the send path, per-recipient routing, real sender, `customer_id`). **No per-recipient retry** — no `attempts`/`next_attempt_at`, so a transient failure is terminal for that recipient. |
| Blocklist / whitelist / DND | **WORKING** | `messaging/blocklist` CRUD; enforced pre-selection at `message-send.service.ts:252`; shared E.164 normaliser (`routing-depth/msisdn.ts`). |
| Retention (dry-run + apply) | **PARTIAL** | Works, but `DELETE`s the *engine's* rows and archives nothing — JKANNEL keeps no message record. |
| JKANNEL-owned message store | **ABSENT** | `messages`/`message_events`/`message_status`/`dlrs` tables do not exist. |
| Live Queue console (per-bind depth, spool reroute/cancel, bulk resend, per-bind start/stop) | **WORKING** | `queue-console.controller.ts` (7 routes) + `LiveQueueView.vue`, 5 s polling. Bypasses routing/entitlements **by design** (operator explicitly picks a bind). |

### 3.2 Routing

| Capability | Grade | Evidence |
|---|---|---|
| Route selection on the live send path | **WORKING** | `route-resolution.service.ts:154` ← `message-send.service.ts:387`. Fails closed when nothing matches (`:390`). |
| Route types: prefix / country / operator / weighted / static | **WORKING** | `routing-depth/route-selection.ts:252`, well unit-tested. |
| Strategies: priority / least-cost / load-balance / round-robin / time-based | **PARTIAL** | Implemented; round-robin rotation is **per-process** (`message-send.service.ts:128 rotation Map`), so distribution is only approximately fair across replicas. |
| Failover to a fallback SMSC | **WORKING** | Driven by live `smsc_bind_state` (`route-resolution.service.ts:85`); degrades honestly to "health unobserved" when no bind rows exist (`:70`). |
| Decision audit | **WORKING** | `message_route_decisions` written for both successes and refusals (`message-send.service.ts:158,196`); readable via `GET /gateway/routing-decisions`. |
| Single engine (simulator == production) | **WORKING** | `routing/routing.service.ts:72` is now an adapter over `selectRoute()`. |
| `deployment_state` respected | **WORKING** | `routing-depth.repository.ts:22`. |
| Route versions + history | **PARTIAL** | `GET /routing/routes/:id/versions[/:version]` read-only; no restore endpoint. |
| Per-route / per-SMSC throttling (SPEC_04 step 7) | **ABSENT** | No `throttl`/`tps` enforcement in `routing-depth/` or `messaging-depth/`. |
| Route groups / conditions / actions | **ABSENT** | 3 of 7 SPEC_06 tables. |
| HLR / MNP operator lookup | **ABSENT** | Operator is a caller-supplied hint only. |
| Visual route builder UI | **ABSENT** | `RoutingDepthView.vue` is a form + grid. |

### 3.3 SMSC Manager

| Capability | Grade | Evidence |
|---|---|---|
| SMSC CRUD with SPEC_03 attribute set | **WORKING** | `SmscController` (9 routes); `SmscService` is now genuinely injected and its validator called on create and update (`console.controllers.ts:140,201,207`). Migration 029 adds 20 attributes. |
| Soft-archive delete with route-reference guard | **WORKING** | `DELETE /smscs/:id` → `console.repository.ts:archiveSmsc`, 409 when routes reference it. |
| Enable / disable | **WORKING** | `POST /smscs/:id/actions/:operation` → `engine/kamex.adapter.ts:318 controlSmsc` → bearerbox `start-smsc`/`stop-smsc`. |
| Reconnect | **PARTIAL (misleading)** | `kamex.adapter.ts:332` — `const command = operation === 'disable' ? 'stop-smsc' : 'start-smsc'`. **`reconnect` issues the identical call as `enable`**; only the capability id gating it differs (`:323`). A reconnect on an already-bound SMSC is a no-op that records success. |
| "Test connection" | **PARTIAL (misleading)** | `smsc/smsc-connectivity.service.ts:20` is a bare TCP `connect()`. It is not a bind test; `SMSC_MANAGER_SPEC_10`'s "Bind succeeds" acceptance is not what this measures. |
| Continuous bind status polling + history | **WORKING** | `SmscStatusPoller` (§G14). |
| Bind-transition audit + alert | **WORKING** | `smsc_bind_transitions` + alert raise in the poller. |
| SMSC types | **PARTIAL** | 4 of 7 (`smpp`, `http`, `fake`, `at`); no SMPP server, CIMD2, EMI/UCP. |
| Per-SMSC deploy / validate operations | **ABSENT** | `smsc_deployments.operation` CHECK permits them; the API rejects them. |
| Groups / clone / bulk / import | **ABSENT** | No tables, no routes. |

### 3.4 Configuration

| Capability | Grade | Evidence |
|---|---|---|
| Generate from the database | **WORKING** | §G1. `?source=body` is the documented escape hatch; the response names the source used. |
| Carrier-capable render (credentials, SMPP tuning, smsbox/sendsms-user/sms-service/dlr-db) | **WORKING** | `configuration-generator.service.ts:396–499`. |
| Secret references resolved to `${ENV}` placeholders, never literals | **WORKING** | `secret-resolver.service.ts:70`; `MissingSecretError` names the reference and env var, never the value. |
| Native validation | **WORKING** | `ConfigurationDeploymentService.validateNative`. |
| Immutable versions | **PARTIAL** | `markConfigurationValidated` still UPDATEs `content` without recomputing the checksum. |
| Atomic deploy + health rollback | **PARTIAL** | Deploy rollback now fires on 503. **No distributed lock** — grep for `advisory` in `configuration-deployment.service.ts` returns nothing, so two replicas can race an engine config push. |
| Templates (seeded built-ins, instantiate) | **WORKING** | `config-templates.controller.ts`, 6 routes. |
| Drift detection vs the live engine | **WORKING** | `config-drift.controller.ts`, audited. |
| Kannel (upstream) rendering | **ABSENT** | `configuration-generator.service.ts:345` throws. The "per-engine rendering hook" exists; the renderer does not. |
| Side-by-side config diff UI | **PARTIAL** | `GET /configurations/diff/:id1/:id2` exists; the UI renders it as a `<pre>` dump. |
| Import / export of configuration | **ABSENT** | — |

### 3.5 Monitoring & Alerts

| Capability | Grade | Evidence |
|---|---|---|
| Prometheus SMS/SMSC metrics | **WORKING** | §G6. |
| Prometheus platform metrics (PG, Redis, HTTP, latency) | **WORKING** | `metrics.registry.ts`, `platform-metrics.service.ts`. |
| Host/container metrics (CPU, RAM, disk, network) | **ABSENT** | No cAdvisor, no node_exporter. |
| Grafana dashboards | **WORKING** | Two provisioned: `jkannel-overview.json` (platform), `jkannel-sms-operations.json` (bind health, queue depth, throughput, failures, DLR pending). |
| Alert rule evaluation | **WORKING** | §G3. |
| Statistical anomaly detection | **PARTIAL** | 3 daily-batch conditions (`anomaly-detection.service.ts`). |
| Notification channels: email, webhook | **PARTIAL** | Delivered, but a webhook has a 5 s timeout and **no retry**, and its "signature" is a static replayable secret. |
| Notification channel: SMS | **WORKING** | `notification-delivery.service.ts:128 deliverSms` through SQLBox; every failure mode explicit. |
| Escalation policies with per-step targets | **WORKING** | `monitoring/escalation/*` (6 routes) + `alert-escalation.service.ts:277 routeToTarget`. |
| Maintenance windows | **WORKING** | `monitoring/maintenance/*` (6 routes) + UI in `AlertResponseView.vue`. |
| Alert correlation / dedup | **PARTIAL** | `GET /monitoring/correlations`; a deduplicated alert does not re-sharpen its summary when the condition worsens. |
| Alert lifecycle actions | **PARTIAL** | 2 of 9 (Acknowledge, Re-notify). No resolve/assign/suppress/close/reopen/ticket — no endpoint and no column (`alert_instances` CHECK permits only open/acknowledged/resolved). |
| Default escalation reaching a human out of the box | **ABSENT** | No escalation policy or channel is seeded; a default deployment notifies nobody until an operator configures one. |
| MTTA / MTTR / ownership / RCA / ticketing | **ABSENT** | — |
| `/monitoring` as a NOC console | **PARTIAL** | Backend returns one hardcoded item (`console.controllers.ts:1302–1324`); the UI renders a one-row 4-column table. |

### 3.6 Reporting

| Capability | Grade | Evidence |
|---|---|---|
| Delivery KPI / overview / trend | **WORKING** | `reports/analytics/*` (10 routes). |
| Correct success/failure rate | **WORKING** | `summariseOutcomes` (§G4). |
| Per-SMSC success, per-route performance, hourly heatmap, latency/SLA percentiles | **WORKING** | `reporting-analytics.service.ts`. |
| Scheduled idempotent snapshots | **WORKING** | `report-jobs.service.ts`, advisory-locked. |
| Saved report definitions + scheduled export delivery | **WORKING** | `reports/definitions/*` (6 routes) + `report-schedule.service.ts`. |
| CSV / PDF export | **WORKING** | Per report, bounded. |
| SMSC operational report items (bind time, reconnects, avg/max TPS, window, availability) | **ABSENT** | 7 of 14 still missing. |
| Customer / vendor / financial reports | **ABSENT** | Flagged `available:false`; depends on a cost model (Future Scope). |
| Monthly / yearly periods | **ABSENT** | Blocked by the `period_type` CHECK. |
| Large-result streaming | **ABSENT** | Exports are bounded and buffered. |

### 3.7 Customers

| Capability | Grade | Evidence |
|---|---|---|
| Customer accounts CRUD | **WORKING** | `customers.controller.ts` (5 routes). |
| Quota with usage counters — **enforced** | **WORKING** | `customer-quota.service.ts:169` via `send-entitlements.service.ts:212` in the send transaction. |
| Prepaid credit + append-only ledger — **enforced** | **WORKING** | `customer-credit.service.ts` debited in the same transaction. |
| Sender-ID approval — **enforced** | **WORKING** | Refuses the send when the sender ID is not approved. |
| Per-customer route/SMSC bindings — **enforced** | **WORKING** | `route-resolution.service.ts:103` filters candidates by `customer_routes`. |
| `rate_limit_per_min` | **BUILT-NOT-WIRED** | Column exists; enforced nowhere. |
| Pricing / rating | **PARTIAL** | Flat per-message cost only. No per-customer tariff, no destination rating, no multi-part segment counting. |
| Billing / invoicing / customer portal | **ABSENT (out of scope)** | Future Scope per `docs/domain/PRODUCT_SCOPE.md`. |

### 3.8 API Gateway

| Capability | Grade | Evidence |
|---|---|---|
| API-key authentication with hashed lookup + expiry | **WORKING** | `api-key-auth.guard.ts`. |
| Scope enforcement on real business functions | **WORKING** | §G9. |
| Per-key Redis rate limit (429 + `Retry-After`, fail-open) | **WORKING** | `gateway-rate-limiter.ts`. |
| Per-key IP/CIDR allowlist (403), spoof-resistant | **WORKING** | `ip-allowlist.ts` + `request.clientIp` (§G12). |
| Per-request gateway audit with duration | **WORKING** | `gateway-audit.interceptor.ts`; `gateway_request_log.duration_ms` (migration 033). |
| Single credential model | **WORKING** | `api_keys` is authoritative; `api_gateway_clients` demoted to a documented non-authenticating registry. |
| API key → customer identity | **WORKING** | `api_keys.customer_id`, never taken from the body. |
| Client registry UI + one-time secret + rotate/revoke | **PARTIAL** | `api-gateway/clients/*` (7 routes) manage `api_gateway_clients`, which **no longer authenticates anything** — a console-provisioned "client" still cannot call the API by itself; a real `api_keys` credential must be issued via `POST /auth/api-keys`. This is honest in the migration but confusing in the UI. |
| Webhook framework (events, retries, HMAC, DLQ, replay) | **ABSENT** | — |
| OAuth2 / OIDC | **ABSENT** | — |
| Rate-limit dimensions | **PARTIAL** | 1 of 9. |

### 3.9 Identity & Security

| Capability | Grade | Evidence |
|---|---|---|
| Login, refresh rotation, logout | **WORKING** | `auth.controller.ts` (7 routes). |
| Refresh-token family/replay revocation | **WORKING** | `auth.service.ts:277`. |
| Privilege re-resolution on refresh | **WORKING** | `:303`. |
| Account lockout that expires correctly | **WORKING** | §G8. |
| Auth-surface throttling (login, MFA, reset, token) | **WORKING** | `auth-throttle.service.ts` + guard; fails open on Redis loss by design. |
| TOTP MFA + recovery codes, enforced at login | **WORKING** | `identity-mfa.controller.ts`, `auth.service.ts:127`. |
| Password reset with reuse prevention | **WORKING** | `auth/password-reset/*`. |
| Invitations + full user lifecycle | **WORKING** | `UsersController` (10 routes). |
| Session administration | **WORKING** | `sessions.controller.ts` (4 routes) + `SessionsView.vue`. |
| Login history | **PARTIAL** | `GET /auth/login-history`; 5 of 11 spec fields absent (country, browser, OS, device, failure reason). |
| User-owned API keys | **WORKING** | `auth/api-keys` (3 routes). |
| Global audit interceptor on every mutation | **WORKING** | `platform/audit-trail.interceptor.ts`. |
| DB-enforced tamper-evident audit hash chain + verifier | **WORKING** | Migration `028_audit_chain_fix.up.sql:audit_log_sign`; `GET /data-model/audit-chain/verify`. **The strongest single artefact in the repository.** |
| Forced RLS on every tenant table, non-owner app role | **WORKING** | `011_rls_enforcement.up.sql` + `migration-runner.ts:enforceRowLevelSecurity`; proven by `rls.integration-spec.ts`. |
| Password hashing algorithm | **PARTIAL** | **scrypt, not Argon2id** (`password-hasher.ts:3`). `SECURITY` §9 is unconditional. Documented, not fixed. |
| Role / permission administration | **ABSENT** | §G11. |
| 8 default spec roles seeded | **ABSENT** | Zero. One dev-only `administrator`. |
| Configurable password policy (complexity, expiry, max age) | **ABSENT** | Min length + history depth, both hard-coded; the five Settings UI security knobs are read by no code. |
| Concurrent-session cap / idle timeout / forced logout | **ABSENT** | `AuthGuard` never consults `auth_sessions`. |
| TLS in the shipped topology | **ABSENT** | Both nginx configs `listen 8080`; only `tls.conf.example` mentions 443. No `sslmode` on the DB connection. |
| Secrets at rest for notification channels | **ABSENT** | Stored and returned as plaintext `jsonb` behind a read-level permission. |
| Intrusion detection | **ABSENT** | — |
| Service accounts / personal access tokens | **ABSENT** | Scoped into Wave 1; neither table exists. |

### 3.10 Platform / API

| Capability | Grade | Evidence |
|---|---|---|
| Versioned REST API, response envelope, correlation IDs | **WORKING** | `platform/response-envelope.interceptor.ts`, `request-context.middleware.ts`. |
| OpenAPI 3.1 auto-derived from the live route table | **WORKING** | `platform/openapi-generator.ts` via `DiscoveryService`; `GET /openapi.json`. |
| Idempotency-Key replay protection with failure-state release + stale reclaim | **WORKING** | Registered as a global `APP_INTERCEPTOR` (`app.module.ts:73`). |
| Async job platform: queue + executor + retry + backoff + DLQ + 202/Location | **WORKING** | §G15. |
| Cursor pagination + `?fields=` projection | **PARTIAL** | 3–4 of 18 grids. |
| ETag / If-Match | **BUILT-NOT-WIRED** | `platform/etag.ts` has zero non-test callers. |
| Typed filter operators | **ABSENT** | 1 of 14. |
| Error taxonomy with populated `errors[]` | **ABSENT** | `http-exception.filter.ts:33` hardcodes `errors: []`; no problem+json; the filter also never logs the exception. |
| Deprecation / Sunset headers, SDK generation, batch operations | **ABSENT** | — |
| Structured JSON logging | **PARTIAL** | 4 fields; **no correlation/request/user/category/duration**, no levels, no categories, no rotation, no SIEM export. |
| Log explorer / live tail | **ABSENT** | No backend log endpoint, no UI. |
| Plugin registry with install/enable/disable | **WORKING** | `plugins/*` (6 routes). |
| Plugin manifest validation on install | **WORKING** | `PluginManifestValidator` is now instantiated and called at `platform-console/platform.controllers.ts:182` — previously zero callers. |
| Plugin out-of-process execution | **BUILT-NOT-WIRED** | `plugins/plugin.runtime.ts:16 PluginExecutor` has **zero implementations**. |
| Signed-package install | **ABSENT** | `PLUGIN_DEVELOPMENT_SDK.md:71` makes this current scope. |
| AI assistance (opt-in, redacted, human-approved) + Ops Copilot | **WORKING** | `ai/assistance/*`, `ai/copilot/*`; kill switch, per-request consent, redact-before-persist, no execution. Current scope (Ch.1–10, 45–46, 65–66) is met; Ch.11–64 is Future Scope. |
| Engine adapter provider interfaces | **PARTIAL** | 1 of 18 (`SmscControlProvider`). Dispatch is `'controlSmsc' in adapter` duck-typing. |
| `requireCapability()` | **BUILT-NOT-WIRED** | `engine/capability-manifest.ts:20` — still **zero call sites**. |
| Migration 002's ten `engine_*` observability tables | **BUILT-NOT-WIRED** | Referenced by no code; migration 031 built a parallel set instead. |
| `audit_signatures` table | **ABSENT** | The service exists; no such table in any migration (the chain is in-row). |
| Soft-delete / optimistic-lock conventions | **PARTIAL** | `deleted_at` on ~5 of 81 tables (migration 027 adds it to `smsc_definitions`, `routing_rules`, `customers`, `alert_rules`, `data_model_records`). The spec calls both mandatory on operational entities. |
| Data-model chapters MESSAGING / DLR / QUEUE / MONITORING | **ABSENT** | 51 tables, none built (migration 031 added 5 observability tables, not the spec's set). |

### 3.11 Runtime, Backup & DR, HA, Performance

| Capability | Grade | Evidence |
|---|---|---|
| 14-service Compose topology, 4 isolated networks | **WORKING** | `docker-compose.yml`. |
| Hardening on stateless services (non-root, read-only rootfs, cap_drop, no-new-privileges) | **WORKING** | `docker-compose.yml`. |
| Real dependency health probe wired to compose/nginx/watchdog | **WORKING** | §G7. |
| Container CPU/memory/fd/pid limits | **ABSENT** | Grep for `mem_limit\|cpus:\|deploy:\|ulimits\|pids_limit` across **both** compose files returns **0 hits**. Only `restart:` is set. |
| Per-container probes | **PARTIAL** | Several are now service-specific (`pg_isready`, `redis-cli ping`, bearerbox `status.json`), but the app containers share one endpoint. |
| cAdvisor / node_exporter | **ABSENT** | — |
| Encrypted `pg_dump` backup, scheduler, retention classes | **WORKING** | `backup-dr.service.ts`, advisory-locked scheduler. |
| Integrity verification + restore-into-isolated-DB verify | **WORKING** | `pg_restore --list` + throwaway-database restore. |
| Mandatory encryption key, no weak fallback | **WORKING** | `:490–507`. |
| Config + certificate capture | **WORKING** | `:193,527`. |
| Backup-failure alerting | **WORKING** | `backup-dr.repository.ts:310,335,393` → `alert_instances`. |
| Honest backup kinds (no faked `incremental`) | **WORKING** | `:409`. |
| Genuine remote offsite (S3/Azure/SFTP) | **ABSENT** | Only `LocalFilesystemDestination`; a documented extension point, not a driver. |
| PITR / WAL archiving | **ABSENT** | No `archive_mode`/`archive_command` anywhere. |
| One-click production restore | **ABSENT (by design)** | `restoreBackup()` deliberately never touches the live DB. |
| HA overlay (PG streaming replication + slot, Redis Sentinel quorum, rolling replica behind HA proxy) | **PARTIAL** | `docker-compose.ha.yml` is real and config-validated; never drilled on real hosts. |
| Sentinel-aware Redis client | **WORKING** | `platform/redis-options.ts`, used by both Redis consumers. |
| Replication-lag / sentinel-role metrics | **ABSENT** | — |
| Load/soak harness with encoded SLOs | **PARTIAL** | `perf/` is honest and well documented; no throughput scenario, no stored baseline, no regression gate. |

### 3.12 Frontend

| Capability | Grade | Evidence |
|---|---|---|
| 32 routes / 26 nav items, all with a real backend | **WORKING** | `router/index.ts`; only `NotFoundView` and the orphaned `ModulePlaceholder.vue` are static. Views degrade honestly ("Workspace API not available yet") rather than faking data. |
| Dense operational columns | **PARTIAL** | 13 modules with real columns; `configuration` still generic; `monitoring` cosmetic over a 1-row endpoint (§G20). |
| Live Queue console | **WORKING** | `LiveQueueView.vue`, 5 s polling, 5 endpoints. |
| Operations dashboard | **PARTIAL** | 1 of the spec's 8 dashboards; 30 s polling. |
| Analytics / reports UI incl. saved definitions | **WORKING** | `AnalyticsView.vue`, 5 endpoints. |
| Alert response UI (escalation policies, maintenance windows, correlations) | **WORKING** | `AlertResponseView.vue`, 12 endpoints. |
| Routing-depth UI | **WORKING** | `RoutingDepthView.vue`, 9 endpoints. |
| Bulk send UI | **WORKING** | `BulkSendView.vue`. |
| Sessions UI | **WORKING** | `SessionsView.vue`. |
| Roles UI | **PARTIAL** | `RolesView.vue` is **read-only** — there is no role mutation API to call. |
| Auto-refresh | **PARTIAL** | `useLiveResource` on 3 views; opt-in and default-off in `ModuleWorkspace`. |
| Real-time push (WebSocket/SSE) | **ABSENT** | Zero hits in either package. |
| Alert lifecycle actions | **PARTIAL** | 2 of 9. |
| Log Explorer | **ABSENT** | — |
| Detail-tab architecture / `:id` routes | **ABSENT** | ~116 spec'd tabs, no tab primitive. |
| Permission Matrix, Scheduler, Auth-history, Service Accounts screens | **ABSENT** | — |
| Visual route builder, side-by-side config editor | **ABSENT** | — |
| i18n | **ABSENT** | No i18n package, no locale files, `<html lang="en">` hard-coded, every string an English literal. |
| Visual regression | **PARTIAL** | 2 `page.screenshot()` calls — **artifacts, not `toHaveScreenshot()` assertions**, so nothing is compared against a baseline. |

---

## 4. Test reality

| Layer | Measured | Honest assessment |
|---|---|---|
| Backend unit | **100 suites / 824 `it()`** | Genuine and broad. Coverage gate is real but set at the current floor (53 % statements / 41 % branches). The spec asks for 95 %. |
| Backend integration | **2 files** (`app`, `rls`) | 2 of the spec's 9 integration areas. The RLS proof is high quality. |
| Frontend unit | **18 files / 112 cases** | Solid. Coverage gate 87/69/68/87. `BulkSendView.vue` and `LoginView.vue` have no spec file. |
| E2E | **10 files; 40 runtime cases in `e2e/`, 6 in `frontend/e2e/`** | **`e2e/tests/navigation.spec.ts` is still a single `for` loop over 26 routes** (`e2e/fixtures/routes.ts:17–44`), 17 of which assert the same generic `module-workspace` testid. Of the remaining 14 cases, **5 are genuine mutating workflows** (3 auth, SMSC create→edit→delete, report-definition create→delete) and 9 are read-only smoke or interaction checks. Several tolerate a broken backend by design — `configuration.spec.ts` passes on `drift-error`; `messages`, `audit-notifications` and `bulk-send` early-`return` when there is no data. |
| CI | 5 jobs, blocking except `security` | Real. `npm audit` and the dependency scan are `continue-on-error`. |

**The ledger's "36/36 Playwright e2e acceptance across …" and "all 9 operational workflow groups
covered by 36 green Playwright acceptance tests" cannot be substantiated.** The count reconciles
only if the navigation loop is counted as 26 acceptance tests. The share of navigation smoke went
**up**, not down: it was 22 of 33; it is now 26 of 40.

---

## 5. Still overstated in `progress/requirements-traceability.md`

The ledger is far more honest than its predecessor and most rows now name their own gaps
accurately. These specific claims this audit could not substantiate:

1. **QA row — "36/36 Playwright e2e acceptance across auth, navigation, SMSC, routing, messages,
   reports, bulk-send, configuration, audit/notifications"** and the Frontend row's **"all 9
   operational workflow groups covered by 36 green Playwright acceptance tests."** Five of the
   forty cases are genuine workflows. Routing, messages, bulk-send, configuration and
   audit/notifications are covered by tests that assert a dropdown populates or accept an error
   state as a pass. The ledger's own later sentence ("22 of 33 e2e tests are still navigation
   smoke") contradicts the "36 acceptance tests" framing in the same table and is itself now stale
   — it is 26 of 40.

2. **SMSC row — "adapter-backed enable/disable/**reconnect**, **test connection**".** `reconnect`
   issues the same `start-smsc` command as `enable` (`kamex.adapter.ts:332`); it cannot cycle a
   bound SMSC. "Test connection" is a bare TCP `connect()` (`smsc-connectivity.service.ts:20`),
   not a bind test, and the `fake` type short-circuits to success. Both were flagged in the prior
   audit and neither changed.

3. **API Gateway row — "API client registry with one-time secret issuance, scopes, rotate/revoke,
   export, docs/portal"** is listed as *current evidence* in the same row that concedes
   `api_gateway_clients` is retired. Those seven `/api-gateway/clients` routes manage a registry
   that authenticates nothing. The genuinely delivered credential path is `POST /auth/api-keys`.
   Presenting both in one row invites the reading that a console-provisioned client can call the
   API. It cannot.

4. **Identity row — remaining gap listed as only "WebAuthn/passkeys; per-role MFA forcing".** Still
   unlisted: **no role or permission administration and no seeded role catalogue** (the single
   largest identity gap, and the one that makes least privilege unachievable and
   `role.changed`/`permission.changed` audit events unreachable); **scrypt not Argon2id**; no
   configurable password policy and five decorative Settings knobs read by nothing; no concurrent-
   session cap or idle timeout; `AuthGuard` never consults `auth_sessions`; **notification-channel
   secrets stored and returned in plaintext**; **no TLS listener**.

5. **Reporting row — "Complete (software); external evidence outstanding".** This is the only row
   still at Complete. It is defensible for the delivery/traffic/SMSC/route catalogues after the G4
   fix, but the row's own gap column omits that 7 of 14 SMSC report items are missing and that
   monthly/yearly periods are blocked by a database CHECK — neither is an external gate.

6. **Live Queue row — "Complete (software)".** The functionality is real and live-verified. But the
   row does not note that this path deliberately bypasses routing and customer entitlements — a
   deliberate and defensible choice, and one a user-facing feature list should state, because it
   means quota and credit are **not** consumed by an operator resend.

7. **Configuration row — "A generated config can now bind to a carrier."** True as an assertion
   about the rendered file; it has never been proven against an SMSC. No committed config contains
   an SMPP group (`runtime/kamex/kamex.conf` and `infrastructure/kannel/kamex.conf` still carry
   only `smsc = fake`). The row does say "never bound to a real carrier (external gate)" later, but
   the bolded headline reads as an accomplished fact.

8. **Runtime/Docker row — "TLS remains opt-in".** There is no TLS listener at all in either shipped
   nginx config; what exists is a `.example` file an operator must author into place. "Opt-in"
   overstates the readiness of that path.

9. **Reliability row — "pluggable offsite destination".** Accurate as written, but the only
   implementation is a filesystem copy on the same host unless the operator supplies a FUSE mount.
   No object-storage or SFTP driver exists. A reader will hear "offsite backups work".

10. **Database row.** Correctly downgraded, but still understates one item: `deleted_at` reached
    ~5 of 81 tables (the ledger says 4 of 71, which is now stale in both numerator and
    denominator), and migration 002's ten `engine_*` observability tables remain referenced by
    zero lines of code.

---

## 6. Honest "not implemented" list

What a user should **not** expect to work today:

**Identity and access**
1. Creating, editing or deleting a role, or changing which permissions a role holds. There is no
   API and no UI. The eight roles the spec names (Super Administrator, Network Engineer, Auditor, …)
   do not exist; a deployment has one `administrator` role created by a development-only script.
2. Configuring password complexity, expiry or lockout duration. The Settings screen shows these
   knobs; nothing reads them.
3. Argon2id password hashing, concurrent-session caps, idle timeout, forced logout, service
   accounts, personal access tokens, WebAuthn, intrusion detection.
4. HTTPS. The shipped reverse proxies listen on plain HTTP only.

**Operations**
5. Resolving, assigning, suppressing, closing, reopening or ticketing an alert. Only Acknowledge and
   Re-notify exist. And out of the box, **no alert notification is sent automatically** — no channel
   or escalation policy is seeded.
6. A log explorer, live log tail, or searching logs by correlation ID. Log lines carry four fields
   and no correlation ID; `/logs-audit` shows audit events only. No syslog/CEF/LEEF export.
7. Real-time updates. Nothing is pushed. Three views poll on a timer; everything else needs a
   manual refresh.
8. Per-route or per-SMSC throughput throttling; HLR/MNP operator lookup; a visual route builder.
9. `reconnect` cycling a live bind (it re-issues `start-smsc`), and "Test connection" proving a
   successful SMPP bind (it proves a TCP socket opened).

**Messaging and data**
10. Searching messages by date range; filtering an export by status (the CSV silently ignores it);
    seeing message encoding, segment count, UDH or billing info; "Replay DLR". JKANNEL stores no
    message record of its own — every message read is a live query against the engine's SQLBox, and
    retention deletes those rows without archiving them.
11. Per-recipient retry in a bulk campaign: a transient failure marks that recipient failed
    permanently.
12. Per-customer rate limiting, per-customer tariffs, destination rating, multi-part segment
    billing, invoicing or a customer portal.

**Platform and infrastructure**
13. Point-in-time recovery, WAL archiving, or backups leaving the host to object storage — the only
    "offsite" driver is a filesystem copy.
14. Container CPU/memory/file-descriptor limits (none are set on any service in either compose
    file); per-container metrics (no cAdvisor); replication-lag or Sentinel-role metrics.
15. ETag/If-Match concurrency control, field-level validation errors in responses (`errors[]` is
    always empty), problem+json, typed filter operators, Deprecation/Sunset headers, a generated
    SDK, batch operations, or a webhook framework (the alert webhook has one 5 s attempt, no retry,
    and its "signature" is a replayable static secret).
16. Generating an upstream-Kannel configuration (the renderer throws); SMPP-server, CIMD2 or
    EMI/UCP SMSC types; per-SMSC deploy/validate operations; SMSC groups, clone, bulk or import.
17. Out-of-process plugin execution (no `PluginExecutor` implementation exists) and signed-package
    plugin installs.
18. Any UI language other than English.

**Unproven rather than unbuilt** — these are wired but have never been exercised against reality:
a live carrier SMPP bind (no committed config has an SMPP group; blocked on carrier IP
allow-listing), a multi-node HA failover with measured RPO/RTO, a production restore drill, an
independent penetration test, and production-scale load.

---

*End of verification.*
