# Changelog

## 2026-07-10 (Claude cycle 3: platform modules, analytics, and console completeness)

- Built the previously-missing Platform modules end to end (migration 016): **API Gateway** clients (create with one-time secret, rotate, revoke, export), **Plugins** (seeded examples with enable/disable and manifest install), **Backups** (logical-checkpoint catalog with create/verify/restore-request and export), **Runtime Containers** (declared Compose services with live-probed health for PostgreSQL/engine/SQLBox and honest "unknown" for the rest), and a **Customers** honest-unavailable placeholder — every one previously returned "Workspace API not available yet".
- **System Settings** now seeds 23 documented defaults across 8 groups (Platform, API, Security, Retention, Backup & DR, Notifications, Runtime, AI Operations) with per-setting description, type and editable/read-only flags, and inline editing.
- **Users & Roles**: full user lifecycle beyond invite — create user with roles, detail with effective permissions, edit (status/roles/password reset), archive (with session revocation), and a roles listing.
- **Sessions**: added search, whitelisted sort, and CSV/PDF export.
- **Queues** and **Delivery Reports**: real paginated, searchable, filterable grids with CSV export (previously summary-only).
- **SMSC**: detail endpoint (recent health samples + operations) and richer test results; **Logs & Audit**: per-event detail endpoint exposing old/new values.
- **Analytics & Reports**: overview KPI cards, daily traffic-trend series, per-SMSC and per-route breakdowns, delivery breakdown, and a seven-category report catalog (Reporting spec §3–10), plus SVG charts and a report-catalog view in the console.
- Frontend: analytics dashboard with a dependency-free MiniChart, grouped settings editor, user CRUD/detail drawers, SMSC detail/edit and connection status dots, configuration help panel, audit-event detail, queue/DLR pagination and export, and plugin/backup/API-gateway/runtime-container management surfaces.
- Fixed the "Failed to fetch" login issue by defaulting the API base to 127.0.0.1 (IPv4) — see the run note in the README.
- Verification: backend 32 suites / 105 tests, typecheck, Prettier clean; migration 016 applied on a fresh database; all new endpoints smoke-tested 200 against the live stack with real data.

## 2026-07-09 (Claude cycle 2: carrier SMPP, notifications, metrics, AI Copilot, anomaly detection, identity)

- Configured a live carrier SMPP bind (authorized test) as a managed SMSC; bearerbox correctly attempts the bind and the platform's own test-connection honestly reports `ECONNREFUSED`. The bind is blocked only by carrier-side IP allowlisting (the deployment egress IP must be authorized) and will establish automatically once allowed — proving the SMSC lifecycle and honest connection-state reporting end to end. The carrier endpoint and credentials are kept in the gitignored `.env` and are not committed.
- Repaired the SQLBox runtime so the message pipeline works: rebuilt sqlbox from the official checksum-pinned source RPM with only the PostgreSQL backend (the official binary panics on non-MSSQL configs) and added credential rendering; proved API→send_sms→bearerbox→sent_sms→grid live.
- Added real notification channel delivery: SMTP email (via `SMTP_URL`, honest "unavailable" when unset) and webhooks with optional signature header, unified behind a transport-neutral payload so scheduled reports and alerts both deliver; report deliveries are recorded (migration 013 relaxes notification_deliveries for non-alert categories).
- Added backend Prometheus metrics: HTTP request counters by method/status class, a latency histogram, and named event counters, exposed at `/metrics` for the Grafana profile, recorded by a global metrics interceptor.
- Added the AI Ops Copilot: a read-only, RBAC-scoped, opt-in, audit-logged assistant with six privacy-safe tools (traffic volume, queue depth, SMSC health, open alerts, engine capabilities, recent audit). Answers locally by default and via the Claude Messages API when `AI_PROVIDER=anthropic` is configured; never returns recipient numbers or message bodies; cannot execute changes.
- Added traffic anomaly detection: statistical per-SMSC volume-drop/spike and DLR-failure detection over daily report snapshots, opening deduplicated alert instances into the existing pipeline (migration 014 adds alert severity/source/dedup and fixes the alerts grid, which referenced a non-existent severity column).
- Added identity workflows (migration 015): password reset (request/confirm with session revocation), invitation acceptance (provisions an active user with the invited role), and session administration (list/revoke, new `users.sessions` permission). All proven live: invite→accept→login and reset→login with the new password.
- Verification: backend 30 suites / 102 tests, typecheck, Prettier clean; all 15 migrations apply cleanly to a fresh database on boot; new features smoke-tested against the running stack.

## 2026-07-09 (maintainer transition: Claude)

- Project maintenance moved from the ChatGPT/Codex workflow to Claude; takeover review findings, applied fixes and forward proposals are recorded in `SYSTEM_IMPROVEMENT_PROPOSALS.md`.
- Reformatted the entire backend and frontend source with Prettier (config at `.prettierrc.json`, enforced via `npm run format:check`) to eliminate the minified single-line style; all suites remained green after the reformat.
- Fixed the authentication signing-key mismatch: token issue/verify now use validated `AUTH_ACCESS_TOKEN_KEY`/`AUTH_REFRESH_TOKEN_KEY` (separate keys per token type) with `AUTH_SIGNING_KEY` accepted as a deprecated fallback; environment validation, Compose and `.env.example` updated.
- Enforced tenant isolation for real: migration 011 adds `FORCE ROW LEVEL SECURITY` to every RLS table, an `audit_log` tenant policy (previously the audit trail had no row security), a non-owner `jkannel_app` application role, and a least-privilege `jkannel_auth` BYPASSRLS role for pre-authentication identity lookups; the API now connects via `DATABASE_APP_URL`/`AUTH_DATABASE_URL`.
- Added a deterministic migration runner (`npm run migrate`, `MIGRATIONS_ON_BOOT`) with checksum drift detection, advisory locking, `--down` rollback, automatic FORCE-RLS enforcement, and role login provisioning; Compose now applies migrations on backend boot.
- Closed the SQLBox cross-tenant leak: message list/trace/export/queue/DLR reads and outbound submission are scoped to the tenant's own SMSC engine identifiers, with honest empty states for tenants without SMSCs.
- Added a global audit-trail interceptor: every authenticated mutating request and sensitive read (exports, traces, audit queries) is recorded in `audit_log` with actor, tenant, redacted parameters, outcome, correlation id and source IP; audit events are queryable and exportable through the console.
- Added uniform grid capabilities (whitelisted `search`, `sort`, `filter.<field>`, `limit`/`offset` with totals) across SMSC, route, alert, alert-rule, user, invitation, configuration, audit-event, notification and report endpoints, plus CSV and PDF export endpoints for each grid (server-side pdfkit rendering with tenant/requester/filter metadata).
- Added scheduled volume reporting (migration 012): idempotent per-tenant daily and weekly message/DLR snapshots — total, per SMSC, and per route (attributed via target SMSC) — generated by an in-process scheduler with unique period claims, plus in-app notifications to `reports.view`/`system.manage` holders and a notification centre API (list, unread count, mark read).
- Added a cross-tenant RLS integration proof (`backend/tests/rls.integration-spec.ts`) that runs against a live database when `RLS_TEST_*` URLs are provided and skips honestly otherwise.
- Live-stack validation: proved migrations 001-012 apply cleanly to a fresh database (fixing 001 bootstrap overlap and the missing routing_rules UNIQUE constraint 007 always required), added `--baseline` for brownfield databases, and verified RLS isolation, grids, exports, reports, notifications and the audit trail against the running stack.
- Repaired the SQLBox runtime, which had never worked: the official kamex-sqlbox 1.8.3 RPM panics on any non-MSSQL configuration (upstream dispatcher bug), so the sqlbox image now rebuilds it from the official checksum-pinned source RPM with only the PostgreSQL backend enabled and renders `${POSTGRES_*}` credentials in an entrypoint. First live end-to-end message proof: API submission → send_sms → bearerbox → fake SMSC → sent_sms → tenant-scoped grid.
- Fixed the pdfkit CommonJS import so PDF exports produce real PDFs (verified live).

- Added API platform primitives from the REST standard: migration 009 for tenant-scoped idempotency records and jobs, a global authenticated `Idempotency-Key` interceptor, `/api/v1/jobs` job create/list/get/cancel APIs, and raw `/api/v1/openapi.json` OpenAPI 3.1 output.
- Documented the API platform primitive behavior and remaining gaps in `docs/specifications/api/API_PLATFORM_PRIMITIVES.md`.
- Added configuration approval workflow support: migration 010 approval/deployment metadata, persisted native validation state, approve endpoints, deploy-before-approval protection, auditable rollback-to-new-approved-version behavior, and configuration workspace Validate/Approve/Deploy/Rollback plus version diff controls.
- Validation: backend Jest passed 23 suites/53 tests, backend TypeScript passed via `tsc --noEmit --incremental false` after the normal npm script hit the known sandbox write restriction creating `backend/dist/tsconfig.tsbuildinfo`, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.
- Follow-up validation after configuration workflow work: backend Jest passed 23 suites/56 tests, backend TypeScript passed, frontend Vue typecheck passed with the non-incremental command, frontend Vitest passed 6 suites/17 tests, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.
- Added audited SMSC runtime operations through the Engine Adapter boundary: test connection, enable, disable, reconnect, idempotency records, lifecycle state, and deployment history.
- Added route operation persistence with migration 007, route validation dry-runs, conflict checks, simulation endpoints, deploy/rollback/history records, and routing workspace UI actions.
- Extended the Vue module workspace with SMSC protocol-aware creation, route prefix/sender/fallback fields, a route simulator, route deployment controls, configuration deploy/rollback actions, and restored accessible table headers.
- Expanded Kamex SQLBox reads into normalized paginated message records, server-side filtering, message trace lookup, CSV export, and DLR reporting while preserving SQLBox as an engine-owned external data source.
- Added SQLBox retention governance: bounded dry-run/apply cleanup for native `sent_sms`, operator-created read indexes, authenticated CSV downloads with export row caps, status filtering, `messages.export` permission enforcement, and Messages workspace export/retention controls.
- Added a Prometheus/Grafana monitoring profile with backend Prometheus text metrics, Prometheus scrape configuration, Grafana datasource/dashboard provisioning, and environment placeholders.
- Added notification delivery foundations: migration 008, dashboard/webhook/email/SMS channel definitions, auditable notification delivery records, safe dashboard delivery, guarded webhook delivery, honest skipped status for unsupported transports, and alert notification APIs.
- Repaired the local backend dependency tree after partial `node_modules` installs (`bs-logger`, `exit`, `source-map`, `iterare`) and restored the full backend Jest suite.
- Validation: backend TypeScript passed, backend Jest passed 20 suites/46 tests, frontend Vue typecheck passed, frontend Vitest passed 6 suites/17 tests, frontend production build passed after elevated `.cache` write access, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.

## 2026-07-07

- Integrated the official Kamex 1.8.3 SQLBox extension as a checksum-verified derivative of the pinned Kamex image and placed it correctly between bearerbox and smsbox.
- Made native `send_sms` and `sent_sms` tables the adapter boundary for outbound enqueue, message history, delivery reports, queue depth, and database-backed capability discovery.
- Extended deterministic configuration generation with environment-only PostgreSQL credentials and implemented version retrieval, atomic runtime writing, deployed/superseded transitions, audit, and authenticated Kamex graceful reload.
- Preserved honest degradation: APIs and capability manifests report SQLBox unavailable until the native tables can be probed.
- Added an internal, token-authenticated, resource-bounded Kamex validator that executes the vendor-native `bearerbox --test` command without Docker socket access; deployment now requires native acceptance and rolls back on failed reload/health verification.
- Implemented documented configuration history, diff, validate, deploy and rollback API surfaces, plus live engine monitoring/capability and audit-event read models.
- Added canonical requirements traceability and corrected project tracking so bounded foundations are no longer conflated with complete operational modules.

## 2026-07-06

- Organized the documentation-first repository into its production monorepo boundaries.
- Preserved visual assets under `design/design_spec/` and archived superseded planning material.
- Corrected API Gateway and Docker Deployment specification filename typos.
- Established the documentation catalog, project memory, state tracking, roadmap, ADRs, and progress logs.
- Added the Phase 1 Docker, NestJS health-check, and Vue application-shell scaffold.
- Reworked ADR-0007 and the Engine Capability Registry to assess Kamex independently from upstream Kannel.
- Added typed capability provenance/freshness, optional adapter providers, runtime-management safety metadata, and database-backed engine observability entities.
- Added deterministic npm lockfiles, corrected frontend TypeScript build configuration, and pinned Multer 2.2.0 to resolve runtime audit findings.
- Verified clean image builds, backend tests/typecheck, frontend production build, Compose configuration, and healthy four-service startup.
- Restored newly supplied master specifications and completed the missing Plugin SDK and telecommunications domain model.
- Initialized Git on `main`.
- Completed Phase 2 backend foundation: validated environment, JSON logging, API v1, correlation IDs, standard response/error handling, and integration harness.
- Reconciled the restored Plugin Development SDK into the canonical signed, scoped, testable SDK contract.
- Added and validated Phase 3 database migrations, SQL acceptance tests, and rollback paths.
- Added Phase 4 scrypt password hashing and signed typed-token primitives with tests.
- Added the Phase 5 permission-aware Vue operations shell and verified its production build.
- Added Phase 6 generic Engine Adapter core with deliberately distinct upstream Kannel and Kamex capability fixtures.
- Added PostgreSQL-backed authentication, refresh rotation, lockout, audit, bearer validation and RBAC guards; fixed deterministic refresh-token rotation with unique token IDs.
- Added tested Phase 8 deterministic configuration generation, Phase 9 SMSC validation, and Phase 10 priority/fallback routing foundations.
- Adopted Kamex as the first containerized runtime in ADR-0008; pinned official image 1.8.3 by OCI digest and validated bearerbox, smsbox, JSON status, and Prometheus metrics.
- Added tested Phase 11 message exploration, Phase 12 sustained alert evaluation, and Phase 13 delivery reporting foundations.
- Added migration 004 with tenant-RLS persistence for SMSCs, routes, alert rules/instances/acknowledgements, settings, invitations, and configuration-version isolation.
- Added guarded console APIs with same-transaction audit writes and explicit unavailable-source contracts for message and delivery-report ingestion.
- Replaced the mock frontend session with real login, refresh rotation, logout, `/auth/me`, permission guards, API retry handling, and CORS allowlisting.
- Completed the responsive console shell, global search, all planned module routes, honest loading/error/empty states, not-found handling, and contract-aligned create forms.
- Added Vitest component/API/router coverage; current validation passes 13 backend suites (26 tests) and 6 frontend suites (15 tests).
- Validated migration 004 up/down/up and SQL tenant-isolation behavior in a disposable database, then exercised authenticated SMSC, route, configuration, and setting workflows against the live stack.
- Revalidated zero known production dependency vulnerabilities, Compose configuration, frontend production build, and healthy Postgres, Redis, backend, frontend, Kamex bearerbox, and Kamex smsbox services.
- Added Phase 14 strict plugin manifest validation, signature/checksum policy, declared permissions/events, redacting host APIs, circuit breaking, and an explicit worker-process executor boundary without in-process isolation claims.
- Added Phase 15 deployment- and request-opt-in AI Operations using deterministic local rules, evidence redaction, tenant-RLS migration 005, audited assistance records, and human approval/rejection decisions without action execution.
- Added Phase 16 defensive API headers and PowerShell 5.1-compatible security, bounded concurrent readiness-load, and PostgreSQL dump/checksum/disposable-restore smoke checks.
- Final backend validation passes 17 suites and 40 tests; the readiness smoke completed 50 requests at concurrency 10 with zero failures and 205.62 ms p95, and backup restoration was verified before its temporary artifact was removed.
- Corrected Kamex bearerbox health-probe shell quoting so the status password environment variable is expanded rather than sent literally; bearerbox and smsbox revalidated healthy.
- Realigned the Vue console with `design/design_spec/` as visual authority: Public Sans typography, canonical violet/navy tokens, soft-shadow cards, floating topbar, grouped navigation, reusable stroked SVG icons, split-screen login, and JKANNEL/Kamex product language replaced the improvised blue admin theme and two-letter menu markers.
- Rebuilt login from the prototype's exact layout recipe: default-light 1.15/1 split, top-left mark, 460px circular three-card illustration, 340px form, Admin Console badge, username/password reveal, Remember Me, and violet submit treatment. Removed the invented orbit composition and visible tenant field.
- Changed the sidebar to match the prototype: the logo and Kamex footer stay fixed while only the padded navigation region scrolls with the canonical narrow violet scrollbar.
- Added a repository-owned Playwright/installed-Chrome acceptance harness for desktop and mobile visual checks when the VS Code Codex surface does not expose Browser Use's Node REPL tool.
