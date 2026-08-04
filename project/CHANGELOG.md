# Changelog

## 2026-08-05 (close the verified gaps: RBAC, alert lifecycle, message depth, deployment hardening — `d58a3d2`)

A follow-up pass against the open and partial items in
`project/IMPLEMENTATION_VERIFICATION.md`. **Backend only** — the matching console
screens are in progress, so several of these are API-reachable but not yet clickable.

- **Role and permission administration** (migration `036_rbac`) — the verification's
  single largest open gap. `POST` / `PATCH` / `DELETE /users/roles` plus
  `GET /users/permissions`, a seeded 21-code permission catalogue with human
  descriptions and eight categories, and **eight seeded roles per tenant**: Super
  Administrator, Administrator, Network Engineer, Operations Engineer, Support Engineer,
  Read Only, Auditor, API Client. Guard rails: system roles cannot be renamed or
  deleted; a change that would leave nobody holding `users.manage` is refused with 409;
  a role held by at least one user cannot be deleted; and editing a role's grants
  revokes every holder's live session. `PATCH` **replaces** the whole grant set rather
  than merging. API-key scopes are deliberately excluded from the catalogue so a human
  role cannot be granted a machine scope. *`RolesView.vue` still shows a read-only
  banner that is now factually wrong.*
- **Full alert lifecycle** (migration `037_alert_lifecycle`) — resolve, assign,
  suppress, reopen, close and comments alongside acknowledge, with a transition table
  that returns 409 naming the current state, and `GET /alerts/:id/lifecycle`. Suppress
  requires `system.manage` and is capped at 30 days. Assignment resolves against real
  tenant users. **No ticketing** — there is no ticket field and no ticket route.
- **Notification readiness** — seeds a `Default dashboard` channel and a
  `Default escalation` policy at boot, exposes `GET /monitoring/notifications/readiness`
  and a `repair` route, and warns when a tenant has open alerts but nothing deliverable.
  Undeliverable steps now record a reason rather than being silently skipped. The
  seeded policy's email and webhook steps have empty targets, so **out of the box only
  the in-app step delivers**.
- **Message depth** (migration `038_messaging_depth2`) — server-side `from`/`to` date
  range (strict ISO 8601, inclusive), and a single shared filter parser used by the
  list, CSV and PDF routes so **export parity now holds** and an unknown status token is
  a 400 everywhere. Encoding, charset, UDH, validity, deferred, mclass, pid, binfo and
  metadata are selected and returned, with a derived segment count (GSM-7 160/153,
  UCS-2 70/67, 8-bit 140/134; a UDH-declared part count wins). Free-text search is
  **still an unindexed leading-wildcard scan**, and an export still returns at most 500
  rows per call.
- **A real SMPP bind test** — a `bind_transceiver` PDU (or transmitter/receiver per bind
  mode), reading the response and reporting `ESME_*` status. Crucially it records a
  `verified` level of `smpp_bind`, `tcp_socket` or `not_applicable`, persisted to the
  operation history, so a TCP fallback can never be read as a successful bind. It falls
  back to TCP when the API container cannot resolve the credential — the standard
  topology, since credentials live in the engine container — and says so verbatim.
- **A genuine reconnect cycle** — observes the bind, issues `stop-smsc`, waits for it to
  leave `online`, issues `start-smsc`, waits for it to return, and records `bind_cycled`
  or `command_accepted`. Gated on the `runtime.smsc.reconnect` capability. Both this and
  the bind test had been flagged in two consecutive audits without changing.
- **An enforced security policy** — password minimum length and four complexity rules,
  history depth, lockout threshold and duration, access-token TTL, session idle timeout,
  absolute session lifetime and a concurrent-session cap, resolved per tenant with a
  30-second cache. These were previously decorative settings read by no code. Values are
  clamped one-sidedly toward strictness, and the session cap ships **off** by default.
  Hashing remains **scrypt, not Argon2id**, and **no password-expiry setting exists**.
- **Customer `rate_limit_per_min` enforced** on the send path — 429 with `limit`,
  `windowSeconds` and `retryAfterSeconds`. It fails open on Redis loss, counts attempts
  rather than successes, and uses a fixed 60-second window.
- **An S3-compatible offsite backup destination** (AWS, MinIO, Ceph) with SSE and
  path-style options, alongside the existing filesystem driver.
- **Container resource limits** — `mem_limit`, `cpus`, `pids_limit` and `ulimits` across
  the compose services, closing a gap where only `restart:` was set.
- **An opt-in `tls` profile.** The default topology is unchanged and **the live
  deployment still terminates TLS on an upstream system nginx**.
- **Correlation IDs in log lines** via `AsyncLocalStorage` — correlation ID, request ID,
  user, tenant, method, route and client IP — plus an `x-correlation-id` response header
  and `GET /observability/logs`. **That endpoint reads a process-local, non-durable
  in-memory ring buffer** (1000 lines by default, 20 000 maximum, no retention window,
  lost on restart, one replica's view only); every response says `durable: false`. It is
  triage convenience, not a log store.

Not changed by this commit, and still true: **a generated configuration has never bound
to a real carrier**; notification-channel secrets are stored and returned in plaintext;
there is no real-time push; plugins do not execute.

`FEATURES.md` and `project/IMPLEMENTATION_VERIFICATION.md` are anchored to `eefa320` and
now **understate** the product. Re-running the verification is tracked in
`progress/next-actions.md`.

## 2026-08-04 (documentation: honest README, operator manuals, ledger refresh)

- **Rewrote `README.md`.** It now states the control-plane boundary
  ([ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md)) in one paragraph, links
  the capability summary to `FEATURES.md` rather than restating it, gives an
  architecture diagram, a Compose quick start with profiles, the configuration
  essentials, how to run every test layer, and a documentation map. It is explicit that
  the frontend is a **Vite dev server** and that **TLS is terminated upstream by
  default**.
- **Added task-oriented operator manuals** under
  [`docs/user-guides/`](../docs/user-guides/README.md): getting started and console
  tour, connecting an SMSC, sending messages, **Live Queue and recovering a bad bind**,
  routing, monitoring and alerts, reports and exports, customers and quotas, backup and
  restore, users and roles, and troubleshooting. Every screen name, button label and
  field was verified against `frontend/src/views/` and `frontend/src/navigation.ts`.
- Verifying those labels surfaced three gaps now stated plainly in the guides rather
  than omitted: the configuration UI **drops the `requiredSecrets` array** the backend
  returns; the SMSC create/edit forms expose **no field for `credentialSecretRef`,
  `systemId` or bind mode** (API only); and **`POST /auth/api-keys` — the only
  credential that authenticates the gateway — has no console UI**, while the API Gateway
  screen manages a registry that authenticates nothing.
- **Retired `project/SUPERVISOR_HANDOVER_SUMMARY.md`.** It was a point-in-time status
  memo from 2026-07-09, superseded by `FEATURES.md` and
  `project/IMPLEMENTATION_VERIFICATION.md`. The single inbound link (from `README.md`)
  was repointed.
- Brought `progress/completed.md`, `pending.md`, `next-actions.md`, `blockers.md` and
  `session-log.md`, plus `project/PROJECT_STATE.md`, `TASKS.md`,
  `SPEC_CONFORMANCE_PLAN.md`, `ROADMAP.md` and the documentation catalog, into line with
  the audited state. The honesty discipline from the traceability correction notice —
  *code merged is not capability delivered* — is applied throughout, including to the
  waves' own summaries.

## 2026-08-04 (verified feature list + collapsible navigation, `4ed4bda`)

- Added **`FEATURES.md`**: a capability list where every entry was verified by tracing
  that a **non-test caller reaches it on a real request path**. Code that exists but
  nothing invokes is not listed. Its "Not yet implemented" section is deliberately long
  and specific.
- Added **`project/IMPLEMENTATION_VERIFICATION.md`**: an independent, read-only,
  file-by-file verification of the six remediation waves. Method: call-site tracing of
  every previously-callerless symbol, route-table extraction of all non-test controllers
  paired with their guards and permissions, and direct inspection of every migration,
  compose file and CI workflow. **Result: 10 of 20 gaps closed, 7 partial, 3 open.**
- It also retracts the ledger's "36/36 Playwright e2e acceptance" claim. Of 40 runtime
  cases, **26 are one navigation loop and 5 are genuinely mutating workflows**.
- Frontend: collapsible navigation groups in the console shell.

## 2026-08-04 (deployable behind a reverse proxy, `eefa320`)

- The frontend container runs the Vite dev server, whose host check returned **403**
  behind a reverse proxy because it receives the *public* hostname in `Host`. Added
  **`VITE_ALLOWED_HOSTS`** (comma-separated; a leading dot allows a whole suffix).
- Deployed to a **shared VPS running an unrelated stack alongside it**. JKANNEL's
  published ports were remapped to **loopback only** so nothing is exposed publicly and
  nothing collides: backend 3200, frontend 5173, JKANNEL proxy 8081, Kamex admin 13000,
  Kamex sendsms 13013. A **system nginx terminates TLS** and proxies to
  `127.0.0.1:8081`.
- The shipped `reverse-proxy` service stays **HTTP-only by design** — the "TLS
  terminated upstream" topology. A profile-gated `reverse-proxy-tls` service exists for
  deployments that want JKANNEL to hold the certificate, with a deliberately separate
  port list so enabling it cannot republish a port publicly.
- Console live at `https://jkannel.34-134-248-1.sslip.io` (tenant `default`, username
  `operator`).

## 2026-08-04 (six remediation waves, `9ba2bae`)

Executed against the build order recommended by `project/SPEC_GAP_ANALYSIS.md`.

- **Wave A — stop the bleeding.** Fixed **permanent account lockout** (an
  unauthenticated DoS against any account). Fixed **stale privileges on refresh** —
  `refresh()` re-resolves status, roles and permissions and revokes the token family on
  a non-usable account. Closed the **`X-Forwarded-For` allowlist bypass** with
  `trust proxy` plus a platform-derived `request.clientIp`. Added **MFA and `/auth/*`
  throttling**; a wrong TOTP now increments the lockout counter. Replaced the
  **hardcoded `/health`** with a real PostgreSQL + Redis probe under bounded timeouts
  that redacts driver detail and returns 503. **Decoded `dlr_mask`**, so the shipped
  success-rate reports stopped being wrong — `successRate = delivered / (delivered +
  failed + rejected)`, with the old figure surviving under the honest label "DLR
  coverage". **Added CI**: five GitHub Actions jobs (backend, frontend, compose,
  migrations, security) with coverage gated at the current floor and ESLint at zero
  errors.
- **Wave B — make configuration real.** Migration 029 adds the 20-column SMSC attribute
  set. `SecretResolver` renders every credential as a `${ENV}` placeholder — never a
  literal — and reports `requiredSecrets`. The renderer emits the full SMPP bind
  parameter set plus the `smsbox`, `sendsms-user`, `sms-service`, `pgsql-connection` and
  `dlr-db` groups. **`ConfigurationModelBuilder` composes the model from
  `smsc_definitions`**, closing the void between the SMSC Manager and the generator, and
  `POST /configurations/generate` defaults to `source='database'`. Deploy rollback fires
  on a 503 health check. Verified live that Kamex expands `${VAR}` from its own
  environment.
- **Wave C — close the observability loop.** `SmscStatusPoller` (migration 031) observes
  every bind and writes state, transitions and metric samples. Live-verified: a bind
  drop detected (`connecting → disconnected`), transition audited, alert raised, no
  flapping. Real SMS metrics exported (`jkannel_smsc_bind_up`, queue depth, failures,
  throughput, DLR queued); the dead bearerbox scrape job deleted; an SMS-focused Grafana
  dashboard added. **`AlertRuleEvaluatorScheduler` now drives the previously callerless
  `AlertEvaluatorService`.** `deliverSms` submits through SQLBox instead of returning
  `skipped`; escalation honours `step.target`.
- **Wave D — routing and customers on the send path.** A single **`MessageSendService`**
  funnels the console, API-gateway, bulk and replay send paths. `smscId` is optional;
  when omitted the router selects and the send **fails closed**. Decisions persist to
  `message_route_decisions` for successes *and* refusals. Candidates come from live
  `smsc_bind_state`; `deployment_state='deployed'` is respected; the two divergent
  routing engines were converged onto one `selectRoute()`. **Customer entitlements are
  consumed inside the same transaction as the engine submit.** `POST /gateway/messages`
  and its read endpoints sit behind `ApiKeyAuthGuard` with enforced
  `sms.send`/`sms.read`/`routing.read` scopes, and customer identity comes from
  `api_keys.customer_id`, never from the body. Blocklist/allowlist/DND evaluate before
  selection via a shared E.164 normaliser.
- **Wave E — operator surfaces.** `useLiveResource` (overlap guard, `document.hidden`
  guard, caller pause predicate, deterministic cleanup) on the Operations dashboard,
  Live Queue and three workspace modules. Real dense column sets on 13 modules. Alert
  row actions. New UI for escalation policies, maintenance windows, backup schedules and
  routing depth.
- **Wave F — durability and platform depth.** `BACKUP_ENCRYPTION_KEY` made **mandatory**
  with placeholder rejection; the JWT-key fallback chain removed. Backup and
  verification failures open real alert instances. Config and certificate capture added.
  **The false `incremental` label was retired rather than faked** — a requested
  incremental is recorded as `full` with an explanatory note. A **real job queue**
  (migration 034): `FOR UPDATE SKIP LOCKED` claiming, exponential backoff,
  dead-lettering, stale-claim reaping, and `POST /jobs` returning 202 + `Location`.
  `PluginManifestValidator` — previously zero callers — is now called on install.
- Verification: backend 100 suites / 836 tests, frontend 18 files / 112 tests, `tsc`
  clean, ESLint 0 errors, schema at migration 035, all 9 Compose services healthy.
  Live-verified: Live Queue reroute/resend, a bind drop detected and alerted, `/health`
  failing and recovering, an async job executing to `succeeded`.

## 2026-08-04 (Live Queue console + spec-gap audit, `e7d9df9`)

- **Live Queue console** (`backend/src/queue-console/` + `LiveQueueView.vue`, 7 routes,
  5-second polling): per-bind status, queue depth, failures and throughput with an
  honest `source` when the engine is unreachable; a pending-spool grid with
  **`POST /spool/reroute`** (true zero-restart retarget, tenant predicate in the SQL) and
  `/spool/cancel`; **`POST /resend`** (bulk resend of failed traffic to any bind, by id
  or status filter); and **`POST /binds/:engineId/control`** to start, stop or reconnect
  **one** bind — verified live that the engine and every other bind keep running.
- DLR-derived delivery status with `resendable` and `in-flight` presets, shared by the
  Live Queue and the Messages explorer.
- **Accepted [ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md).** Building this
  surfaced a hard boundary: bearerbox's internal per-SMSC queue is exposed only as an
  aggregate counter and cannot be listed, moved or cancelled per message. Owning the
  outbound queue in JKANNEL was **considered and rejected** — it duplicates two decades
  of hardened retry, throttling, windowing, store-and-forward, DLR correlation and SMPP
  flow control, and would turn a control-plane bug into a message-loss bug. Forking the
  engine was also rejected. The boundary is stated in the UI and the supported
  workaround (disable the bind, then resend) is built.
- **`project/SPEC_GAP_ANALYSIS.md`**: a systematic specification-vs-implementation audit
  applying one decisive test — *does a non-test caller reach this on a real request
  path?* It found 20 gaps, three of them **integration voids**: the configuration
  generator never read `smsc_definitions`, the routing engine was not on the send path,
  and alert rules were never evaluated. Measured adoption of components the ledger had
  cited as evidence: `AlertEvaluatorService` **0 callers**, `requireCapability()` **0
  callers**, `PluginManifestValidator` **0 callers**, `SmscService` **0 injections**,
  `selectRoute()` **0 send paths**, customer quota/credit **0 send paths**.
- A correction notice was added to the head of
  `progress/requirements-traceability.md`: the ledger had been booking **capability
  shipped** as **capability delivered**. Eight rows previously marked Complete were
  downgraded. That discipline is now permanent across every project document.

## 2026-07-10 (Claude cycle 4: user-reported fixes + Customers domain)

- Fixed the **AI Copilot "Failed to fetch"** — the `x-jkannel-ai-opt-in` consent header was missing from the CORS allowlist, so the browser preflight blocked the request (curl worked). Added it.
- **Messages** rows are now clickable and open a message trace/detail drawer.
- **SMSC Connections**: click-to-edit plus a Delete/Archive action (`DELETE /smscs/:id`, 409 when referenced by routes); connection status dots retained.
- **Routing**: Target SMSC and Fallback SMSC are now dropdowns populated from the SMSC list instead of free-text ids.
- **Configuration**: a "Load baseline" starter configuration (`GET /configurations/baseline`) and an Edit action that loads a version's content into the form to save as a new immutable version.
- **Volume report snapshots** are clickable to a detail view showing the full period breakdown (total + per-SMSC + per-route) via `GET /reports/volume/:id`.
- **Customers domain** implemented (migration 020): a `customers` table (name, code, status, contact, daily quota, per-minute rate limit, allowed sender IDs, notes) with tenant-scoped CRUD, a create form, detail/edit/archive, and a help panel explaining the concept.
- **API Gateway**: an API-documentation/how-to panel (client creation, one-time secret, bearer auth, scopes, rate limits, OpenAPI reference).
- **Plugins**: a downloadable sample plugin manifest (`GET /plugins/sample-manifest`) and a developer-portal panel (manifest fields, lifecycle, permission/event model, packaging).
- **Backup & Restore**: create now opens a modal to name the backup and choose scope (Full / Database / Configurations); a Restore action (confirm + reason, restores into an isolated verify database); Verify action; pointed at the real `/backup-dr` endpoints. Configurations-scope backups dump only the config tables.
- **Users & Roles**: role assignment is now a labelled checkbox list (name + description) in both create and edit, with roles shown as chips in the detail drawer.
- Verification: backend 45 suites / 189 tests, frontend 12 files / 67 tests, both typecheck + build clean; migration 020 applied on the live stack; new endpoints and the Customers UI smoke-tested live.


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
