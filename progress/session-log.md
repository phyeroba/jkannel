# Session Log

## 2026-07-06 - Repository foundation and Phase 1 scaffold

### Changed and why

- Created the production monorepo boundaries required for controlled implementation.
- Grouped specifications by owning module, corrected two filename typos, and established canonical governance files.
- Moved `design_spec/` intact to `design/design_spec/` so its authority is explicit.
- Created ADRs to resolve stack and abstraction decisions.
- Added the Phase 1 Compose, backend health-check, and frontend shell scaffold.

### Archived

- Archived six historical documentation catalogs, old foundation/workflow/scaffolding prompts, the imported project-memory draft, and the older alerts specification.

### Unresolved

- The telecommunications domain model is absent.
- AI Operations, Plugin SDK, backup/recovery, and performance documents were supplied as zero-byte files.
- The repository is not currently Git-initialized.

### Next action

Validate package builds and Docker Compose, repair any failures, then update the recorded Phase 1 status.

### Engine architecture addendum

- Reviewed Kamex 1.8.3 project documentation separately from upstream Kannel 1.4.5 documentation.
- Replaced engine-name assumptions with typed, evidence-backed, per-instance capability discovery.
- Added sibling adapter selection, optional providers, explicit unsupported results, discovery freshness, runtime-control safety, and normalized PostgreSQL observability history.
- Independent review identified and then rechecked these architectural changes before any Engine Adapter implementation.

### Validation result

- `docker-compose --env-file .env.example config --quiet`: passed.
- Clean backend and frontend images: built successfully with lockfiles and `npm ci`.
- Dependency audit during clean installs: zero known vulnerabilities after pinning patched Multer 2.2.0.
- Backend Jest health test and TypeScript check: passed.
- Frontend Vue TypeScript and Vite production build: passed.
- PostgreSQL, Redis, backend, and frontend: all reached healthy Compose status.
- Backend in-container health returned the expected service/status/timestamp contract; frontend served the JKANNEL document.
- Windows host-port forwarding became inconsistent after startup; tracked as a Docker Desktop environment issue.

## 2026-07-06 - Reconciliation and Phase 2

- Copied six restored/newer master documents from the root into canonical folders while preserving newer adapter amendments.
- Filled the Plugin SDK and telecommunications domain model gaps; catalog classifications are now active rather than gaps.
- Initialized Git repository metadata with `main` as the initial branch.
- Implemented and validated the Phase 2 backend platform foundation.
- Corrected the first build failure by removing an unnecessary implicit Express type dependency.
- Final verification: two unit suites/four tests passed, integration test passed, typecheck/build passed, Compose config passed, four services healthy, and host/in-container API v1 health responses passed.

## Continued execution - Phases 3 through 6

- Merged the restored root Plugin SDK with the canonical security/lifecycle/testing requirements while preserving the restored original.
- Validated database migrations 001 and 002 against an isolated PostgreSQL database, ran SQL acceptance tests, then validated both down migrations.
- Repaired interrupted authentication and frontend agent work, including TypeScript crypto overload and encoding defects.
- Backend now passes five suites/nine tests; frontend Vue/TypeScript production build passes.
- Implemented typed Engine Adapter core and separate Kannel/Kamex manifests. Primary-source review found no official upstream Kannel container image, so Phase 7 requires a controlled official-source build rather than an untrusted third-party image.

## Continued execution - Authentication and Phases 8-10

- Added identity/RBAC/session migration 003 and validated the complete 001-003 migration chain.
- Implemented PostgreSQL authentication repository, scrypt login, five-attempt lockout, signed access/refresh tokens, refresh rotation, logout/revocation, audit writes, bearer guard and permission guard.
- A failing rotation test exposed same-second deterministic tokens; fixed with unique `jti` claims.
- Implemented deterministic configuration generation without embedded secrets, SMSC validation, and deterministic routing/fallback evaluation.
- Current backend result: nine suites and seventeen tests passing; dependency audit remains at zero known vulnerabilities.

## Kamex-first runtime

- Accepted ADR-0008 after confirming upstream Kannel has no official image and Kamex publishes a maintained official GHCR image.
- Pinned Kamex 1.8.3 by immutable OCI index digest.
- Corrected image entrypoint handling and separated bearerbox/smsbox readiness probes.
- Bearerbox and smsbox are healthy; authenticated JSON status reports running and connected smsbox, and Prometheus metrics are available.
- The fake local SMSC remains `connecting` by design because no external fake peer is attached; native `/health` therefore reports degraded while process readiness is healthy.

## Phases 11-13 foundations

- Added tenant-first message filtering with bounded result limits and chronological trace reconstruction.
- Added deterministic alert state evaluation that distinguishes inactive, pending and sustained firing thresholds.
- Added tenant-isolated delivery totals, rates, failure/pending counts and latency percentiles.
- Backend validation now passes twelve suites and twenty-two tests.

## Console integration and live workflow validation

- Reconciled interrupted backend persistence, frontend API integration, and frontend test work after the usage reset.
- Added migration 004 and validated the complete 001-004 chain, 004 rollback/reapply, and tenant-RLS SQL assertions in a disposable database.
- Added guarded, audited APIs for SMSCs, routes, alert rules/acknowledgements, settings, users/invitations, and configuration versions.
- Added real browser-session plumbing: login, `/auth/me`, access-token refresh rotation, logout, route permissions, CORS allowlisting, global search, API states, and accessible module workspaces.
- Removed simulated alert counts and fixture rows. Missing event/monitoring services now surface explicit unavailable states.
- Provisioned a local validation operator through the opt-in development provisioning command; no credential was committed.
- Exercised authenticated live CRUD for a fake SMSC, route, configuration version, and system setting with tenant and audit enforcement.
- Validation: backend 13 suites/26 tests; frontend 6 suites/15 tests; frontend production build; Compose config; production dependency audits (zero known vulnerabilities); all six active services healthy.
- Interactive browser automation was unavailable in this environment, so UI behavior was validated through component/router/API tests and live HTTP serving without claiming a manual click-through.

## Phases 14-16 bounded foundations

- Added schema-versioned plugin contracts and strict manifest validation for compatibility, paths, permissions, checksums, production signatures, event declarations, and generic engine-adapter capability use.
- Corrected an early false isolation claim: the runtime coordinator now accepts only a worker-process executor transport and never directly invokes an untrusted plugin implementation.
- Added AI Operations migration 005, tenant-scoped assistance APIs, deterministic local explanations, evidence redaction, deployment opt-in plus per-request consent, audited persistence, and human approval/rejection records. Recommendations are never executed.
- Added defensive API headers and validated them against the running backend.
- Added Windows PowerShell-compatible hardening checks. The bounded readiness run completed 50 requests at concurrency 10 with zero failures and 205.62 ms p95 under a 1000 ms smoke threshold.
- Created, checksummed, verified, restored, queried, and dropped a disposable PostgreSQL backup database. The local dump artifact was removed after validation.
- Migration 005 passed up/down/up in the disposable migration database and was applied to the development database.
- Backend validation now passes 17 suites/40 tests. These checks do not claim an independent penetration test, production capacity/soak, PITR, encrypted off-site backups, or multi-node failover.
- 2026-07-07: Reviewed Kamex 1.8.3 independently from upstream Kannel, including its SQLBox source, PostgreSQL schema, RPM packaging, and graceful-restart behavior. Added the native SQLBox runtime/data integration and configuration deployment vertical slice. TypeScript type-check passed; Compose model validation passed. Full Jest rerun remains locally obstructed by an incomplete Windows `node_modules` tree (`bs-logger`/`exit`) and a clean reinstall that stalled while long-lived Node processes held the tree; this is recorded rather than misreported as passing.
- Verified the official SQLBox RPM installs successfully over the pinned Kamex OCI image and produces `/usr/sbin/sqlbox`. The first derivative build attempt exposed that UBI microdnf does not accept this local RPM path; the Dockerfile now uses the successfully exercised `rpm -Uvh` path after SHA-256 verification.
- Frontend component validation passes 6 suites/15 tests and direct Vue type-check passes. The production bundle command is currently prevented from creating `.cache`/`node_modules/.vite-temp` by this session's filesystem policy; this is an environment write restriction, not reported as a passing build.
- 2026-07-07 continuation: Re-audited the roadmap against canonical specifications and created `progress/requirements-traceability.md`; numerous modules are correctly classified as partial foundations. Added native `bearerbox --test` validation without Docker socket exposure, configuration history/diff/validate/deploy/rollback APIs, live monitoring/capabilities, and audit reads. Backend TypeScript and Compose model validation pass. Docker image builds still time out silently in this host session before returning BuildKit progress, so validator image startup remains unclaimed.
- Final runtime review caught a single-quoted Kamex health URL that sent the password variable name literally and eventually timed out. The probe now expands the environment value correctly; bearerbox and smsbox both returned healthy after forced recreation.
- Corrected the frontend after operator review found it diverged from the visual authority. The production shell now maps the canonical `#2f3349` sidebar, `#7367f0` accent, Public Sans type, grouped navigation, SVG icon set, floating topbar, borderless soft-shadow cards, and split-screen login from `design/design_spec/`, with JVIDEO terminology replaced by JKANNEL/Kamex operational language.
- Follow-up visual review removed remaining interpretation from login: its structure and measurements now directly follow prototype lines 59-109, with only domain terminology/data changed. Fresh sessions use light mode; only an explicit new theme preference enables dark mode.
- Sidebar scrolling now applies to the nav region alone, preserving the fixed brand and runtime footer. Added regression assertions for default light mode and Playwright checks for computed scroll behavior.
- Browser tooling diagnosis confirmed Browser Use is installed/enabled, but this VS Code thread lacks the Node REPL tool exposed by the Codex app surface. Added Playwright against installed Chrome as a durable rendered-browser fallback; its first run caught four issues that component tests missed and drove the corrections above.

## 2026-07-09 - SMSC, routing, and SQLBox operational continuation

- Repaired the interrupted workspace rewrite: restored accessible table header scopes, normalized display of snake_case API fields, and kept the design-aligned light/default shell behavior intact.
- Added migration 006-backed SMSC operation workflows through the Engine Adapter boundary: test, enable, disable, reconnect, idempotency keys, operation history, lifecycle state and workspace row actions.
- Added migration 007 for route deployment metadata, plus route dry-run validation, duplicate-priority/scope conflict checks, route simulation, deploy, rollback and route history endpoints.
- Extended the routing workspace with destination-prefix, sender and fallback inputs, a route simulator panel and Validate/Deploy/Rollback actions.
- Extended Kamex SQLBox reads from simple latest rows into normalized cursor pagination, server-side filters, message trace lookup, CSV export, and DLR reporting. SQLBox remains an external Kamex-owned source, not JKANNEL's system of record.
- Repaired a partially installed backend `node_modules` tree by replacing corrupted generated dependency folders (`bs-logger`, `exit`, nested `source-map`, and `iterare`) and reinstalling through npm.
- Validation: backend TypeScript passed; backend Jest passed 18 suites/41 tests; frontend Vue typecheck passed; frontend Vitest passed 6 suites/15 tests; Docker Compose model validation passed with expected missing-env warnings.
- Remaining gaps: SQLBox retention/partitioning and large export streaming, specialized configuration approval UI, Prometheus/Grafana profile, OpenAPI/idempotency/job framework, production plugin worker, backup scheduling/encryption, HA and external readiness evidence.

## 2026-07-09 - SQLBox retention and export controls

- Added bounded SQLBox retention governance for the native Kamex `sent_sms` table: retention status, dry-run cleanup, explicit apply cleanup and default `SQLBOX_RETENTION_DAYS`.
- Added operator-created SQLBox read indexes for message-search paths without claiming JKANNEL ownership of SQLBox data.
- Hardened message exports: `messages.export` permission, authenticated raw CSV download, `SQLBOX_EXPORT_MAX_ROWS`, response metadata headers and frontend download support.
- Extended the Messages workspace with Export CSV and SQLBox retention dry-run/apply controls.
- Added status filtering to SQLBox reads for sent versus DLR records.
- Validation: backend TypeScript passed; backend Jest passed 18 suites/42 tests; frontend Vue typecheck passed; frontend Vitest passed 6 suites/17 tests; frontend production build passed after elevated `.cache` write access; Docker Compose model validation passed with expected missing-env warnings.
- Remaining messaging gaps: large export jobs/streaming, replay/clone workflows, partitioned historical archive and search-performance evidence under carrier-like traffic.

## 2026-07-09 - Monitoring profile and notification delivery foundation

- Added migration 008 for tenant-scoped notification channels and notification delivery records with RLS and audit integration.
- Added backend Prometheus text metrics at `/api/v1/metrics` for backend health, uptime and process memory.
- Added a `monitoring` Docker Compose profile with Prometheus, Grafana, Prometheus scrape configuration, Grafana datasource provisioning and a starter JKANNEL dashboard.
- Added notification delivery service behavior: dashboard delivery succeeds locally, webhooks are guarded and attempted with bounded timeout, disabled/severity-mismatched channels are skipped, and email/SMS remain honest unsupported skipped transports until provider adapters exist.
- Added alert APIs for notification channels and alert notification delivery history/triggering.
- Validation: backend TypeScript passed; backend Jest passed 20 suites/46 tests; `docker-compose --profile monitoring config --quiet` passed with expected missing-env warnings.
- Remaining monitoring gaps: DB/Redis/host/exporter coverage, alert auto-generation/correlation/escalation, maintenance windows, provider-backed email/SMS, full browser UI for channels, and production delivery evidence.

## 2026-07-09 - API platform primitives

- Added migration 009 for tenant-scoped `api_idempotency_records` and `api_jobs` with RLS.
- Added a global authenticated mutating-request `Idempotency-Key` interceptor that scopes keys by tenant/method/route, hashes request bodies, replays completed responses and rejects in-flight or mismatched retries.
- Added `/api/v1/jobs` create/list/get/cancel APIs as the long-running operation ledger foundation.
- Added raw `/api/v1/openapi.json` OpenAPI 3.1 output and documented the bounded implementation in `docs/specifications/api/API_PLATFORM_PRIMITIVES.md`.
- Validation: backend Jest passed 23 suites/53 tests; backend TypeScript passed with `npx.cmd tsc --noEmit --incremental false` because the normal incremental script cannot create `backend/dist/tsconfig.tsbuildinfo` under this session policy; `docker-compose --profile monitoring config --quiet` passed with expected missing-env warnings.
- Remaining API gaps: full automatic OpenAPI/schema generation, SDK generation, pagination/filter enforcement across every collection, worker-backed async job execution and large export/archive job integration.

## 2026-07-09 - Configuration approval workflow and UI

- Added migration 010 with approval/deployment metadata on immutable configuration versions.
- Added persisted native validation, explicit approval endpoints, and deployment protection so unapproved versions cannot be deployed.
- Updated rollback to create a new immutable rollback version, approve it, then deploy it, preserving audit/history semantics.
- Extended the Configuration workspace with Validate, Approve, Deploy, Rollback row actions and a version diff panel.
- Validation: backend TypeScript passed; backend Jest passed 23 suites/56 tests; frontend Vue typecheck passed with `npx.cmd vue-tsc --noEmit -p tsconfig.app.json --incremental false`; frontend Vitest passed 6 suites/17 tests; `docker-compose --profile monitoring config --quiet` passed with expected missing-env warnings.
- Remaining configuration gaps: richer editor/preview experience, browser acceptance against a running stack, template reuse, drift detection, and carrier-like runtime deployment evidence.

## 2026-07-09 - Maintainer transition to Claude: security fixes, grids, exports, report jobs

- Recorded takeover findings and forward plan in `SYSTEM_IMPROVEMENT_PROPOSALS.md`; permission bypass configured for autonomous work.
- Reformatted all backend/frontend source with Prettier (root `.prettierrc.json`); added `format`/`format:check` scripts to both packages.
- Fixed auth signing-key mismatch: `signing-keys.ts` resolves validated `AUTH_ACCESS_TOKEN_KEY`/`AUTH_REFRESH_TOKEN_KEY` with deprecated `AUTH_SIGNING_KEY` fallback; separate keys per token type; env validation, Compose and `.env.example` updated.
- Migration 011: FORCE ROW LEVEL SECURITY on all RLS tables, audit_log tenant policy (previously none), non-owner `jkannel_app` role, least-privilege BYPASSRLS `jkannel_auth` role for pre-auth identity lookups.
- Added `backend/src/database/migration-runner.ts` (`npm run migrate`, `MIGRATIONS_ON_BOOT=true` in Compose): ordered transactional application, checksum drift detection, advisory lock, `--down`, automatic FORCE-RLS safety net, role login provisioning from env.
- `DatabaseService` now prefers `DATABASE_APP_URL` (jkannel_app) and routes auth queries through `AUTH_DATABASE_URL` (jkannel_auth).
- SQLBox tenant scoping: `allowedSmscIds` restriction on list/trace/export/queue/volume reads and validated tenant ownership on outbound submission.
- Global `AuditTrailInterceptor`: every authenticated mutating request and sensitive read audited with redacted parameters, outcome, correlation id, source IP.
- Shared grid engine (`platform/list-query.ts`) with whitelisted search/sort/filter and pagination totals wired through SMSC, route, alert, alert-rule, user, invitation, configuration, audit-event, notification and report-snapshot repositories/controllers.
- `ExportService` (CSV + pdfkit PDF) with per-resource export endpoints; export requests audit-logged; bounded row counts.
- Migration 012 + `ReportJobsService`: idempotent per-tenant daily/weekly volume snapshots (total/per-SMSC/per-route with target-SMSC attribution), in-app notifications to `reports.view`/`system.manage` holders, notification centre APIs, `/reports/volume` grid + exports + manual run.
- Added `backend/tests/rls.integration-spec.ts` cross-tenant proof (live-DB gated, honest skip otherwise).
- Validation: backend Jest passed 26 suites/70 tests; backend typecheck passed; backend build passed; `docker compose config` passed. Frontend grid/notification/dashboard work delegated and validated separately.
- Frontend cycle: shared grid toolbar (debounced search, sort, filters, pagination, CSV/PDF export) across module workspaces; notifications bell with unread polling and mark-read; reports module rebuilt on /reports/volume snapshots with Generate-now; logs-audit wired to /audit-events with who/what/when columns; OperationsOverview rebuilt on live /queues, /reports/volume, /alerts, /monitoring and /health with honest unavailable/unknown states (fabricated Healthy rows removed); message composer requires a tenant SMSC selection; /notifications route added.
- Final validation: backend Prettier check, typecheck and Jest 26 suites/70 tests passed; frontend vue-tsc, Vitest 6 files/30 tests and production build passed; `docker compose config --quiet` passed with expected missing-env warnings.

## 2026-07-09 - Live-stack validation and SQLBox runtime repair

- Booted the full Compose stack with a fresh generated `.env`; synchronized the pre-existing postgres volume's owner password.
- Discovered the live dev schema was built from older, hand-applied migration versions (drift) and held only disposable scaffolding rows; rebuilt it from the canonical chain — proving migrations 001-012 apply cleanly to a fresh database for the first time.
- Fixed two latent migration defects found by that proof: 001 now creates schema_migrations idempotently (runner bootstrap overlap) and 007 adds the routing_rules UNIQUE(tenant_id,id) constraint its composite FK always required.
- Added `npm run migrate -- --baseline <version>` for brownfield databases.
- Live RLS proof as jkannel_app: zero rows without tenant context; only own rows with app.tenant_id; cross-tenant INSERT rejected by policy; zero RLS tables left unforced.
- **Repaired the SQLBox runtime, which had never actually worked**: the official kamex-sqlbox 1.8.3 RPM panics on any non-MSSQL configuration (upstream dispatcher bug — every sqlbox_init_* panics instead of returning NULL when its connection group is absent, and the binary is compiled multi-backend). The sqlbox image now rebuilds sqlbox from the official checksum-pinned source RPM (AlmaLinux 10 builder, recipe mirroring kamex-sqlbox.spec) with only the PostgreSQL dispatcher branch enabled, plus an entrypoint that renders ${POSTGRES_*} credentials (sqlbox does not expand env placeholders). Restored the valid baseline bearerbox config into runtime/kamex.
- Fixed a pdfkit CommonJS import defect that broke all PDF exports (caught live, unit tests had mocked it away).
- Live API smoke (operator via jkannel_auth): login; grid page shape with totals; invalid sort rejected 400; CSV export with audit headers; **outbound message submitted through /messages traversed send_sms → bearerbox → fake SMSC → sent_sms and appeared in the tenant-scoped messages grid with the queue drained**; volume report snapshots + subscriber notifications generated with idempotent re-run refusal; volume-report and messages PDF exports verified as real PDFs; audit-events grid recorded every mutation and export with actor/path/outcome.
- Final live state: all eight Compose services healthy (postgres, redis, backend, frontend, kamex bearerbox/smsbox/sqlbox/validator).

## 2026-07-09 - Cycle 2: carrier SMPP, notifications, metrics, AI Copilot, anomaly detection, identity

- Live carrier SMPP bind (authorized) configured as a managed SMSC; bearerbox attempts bind, carrier refuses (errno 111) — carrier-side IP allowlist required for the deployment egress IP. Platform test-connection returns honest 'failed/ECONNREFUSED'. Retries every 30s; will bind automatically once allowlisted. Carrier host/port/system-id/password kept only in the gitignored .env (never committed).
- Notification channel delivery: SMTP email (nodemailer, SMTP_URL) + webhook (optional x-jkannel-signature) behind a transport-neutral DeliverablePayload; scheduled reports now deliver to enabled email/webhook channels opting into the 'report' category; migration 013 relaxes notification_deliveries.alert_id + adds category.
- Backend Prometheus metrics: MetricsRegistry (HTTP counters, latency histogram, event counters) + global MetricsInterceptor; exposed via /metrics.
- AI Ops Copilot (src/ai-copilot): CopilotToolsService (6 read-only RBAC-scoped tools), CopilotService (opt-in gate + keyword tool selection + audit), CopilotProvider (local summary default, Claude Messages API when AI_PROVIDER=anthropic). Proven live: selected smsc_health/open_alerts/engine_capabilities, grounded answer citing real data.
- Anomaly detection: AnomalyDetectionService over daily report_snapshots (volume drop/spike, DLR failure), deduplicated alert instances; runs after report generation; migration 014 adds alert_instances severity/source/dedup_key and fixes the alerts grid.
- Identity workflows (migration 015, delegated agent): password reset request/confirm (+session revocation), invitation acceptance, session admin (users.sessions permission). Proven live: invite->accept->login and reset->login.
- Verification: backend 30 suites/102 tests, typecheck, Prettier clean; 15 migrations apply to a fresh DB on boot; live smoke of copilot/sessions/reset/invitation all passed. AI_OPERATIONS_ENABLED set true in dev .env for demo (local provider).
