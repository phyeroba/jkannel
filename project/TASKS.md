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

## Completed 2026-08-04 (Live Queue, audit, six remediation waves, deployment)

- [x] Live Queue console with per-bind control, spool reroute/cancel and bulk resend; ADR-0008 accepted (control plane vs data plane).
- [x] Independent spec-gap audit (`SPEC_GAP_ANALYSIS.md`) — 20 gaps found, three of them integration voids; traceability ledger corrected.
- [x] Remediation Wave A: lockout, refresh privileges, XFF trust, auth throttling, real `/health`, `dlr_mask` decode, CI.
- [x] Remediation Wave B: configuration generator composes from `smsc_definitions`; full SMPP render with secret references and `requiredSecrets`.
- [x] Remediation Wave C: bind poller, real SMS metrics + Grafana dashboard, alert-rule evaluator driven, escalation targets honoured.
- [x] Remediation Wave D: one transactional `MessageSendService`; routing and customer entitlements on the send path; API-key scopes on real endpoints.
- [x] Remediation Wave E: polling composable, dense grid columns, alert row actions, UI for escalation/maintenance/backup schedules/routing depth.
- [x] Remediation Wave F: mandatory backup encryption key, failure alerting, honest backup kinds, real job queue, plugin manifest validation called.
- [x] Independent implementation verification (`IMPLEMENTATION_VERIFICATION.md`) — 10 closed / 7 partial / 3 open.
- [x] Frontend deployable behind a reverse proxy (`VITE_ALLOWED_HOSTS`); deployed to a shared VPS on loopback-only ports behind a system nginx terminating TLS.
- [x] `FEATURES.md` — verified capability list with an honest "not implemented" section.
- [x] Rewrote `README.md`; added operator manuals under `docs/user-guides/`; retired `SUPERVISOR_HANDOVER_SUMMARY.md`.

## Completed 2026-08-05 (close the verified gaps, `d58a3d2`)

- [x] Role and permission administration (migration 036): role CRUD, seeded 21-code permission catalogue with descriptions/categories, **8 seeded roles per tenant**, system-role protection, `users.manage` orphan check, session revocation on grant change.
- [x] Full alert lifecycle (migration 037): resolve, assign, suppress, reopen, close, comments, validated transitions, lifecycle history.
- [x] Notification readiness: boot-seeded default in-app channel and escalation policy, per-channel deliverability report, warning when open alerts have nothing deliverable.
- [x] Message depth (migration 038): server-side `from`/`to`, shared filter parser giving CSV/PDF/grid export parity, encoding/charset/UDH/validity/segment columns.
- [x] Real SMPP bind test with an explicit `smpp_bind` / `tcp_socket` / `not_applicable` verification level persisted to operation history.
- [x] Genuine reconnect cycle recording `bind_cycled` vs `command_accepted`.
- [x] Enforced per-tenant security policy: password complexity/history, lockout, token TTL, session idle timeout, absolute lifetime, concurrent-session cap.
- [x] Customer `rate_limit_per_min` enforced on the send path (429 + `retryAfterSeconds`).
- [x] S3-compatible offsite backup destination; container resource limits; opt-in `tls` profile.
- [x] Correlation IDs in log lines via `AsyncLocalStorage`, `x-correlation-id` header, and `GET /observability/logs` over an in-memory ring buffer.

## Active

Ordered detail, with rationale, is in
[`../progress/next-actions.md`](../progress/next-actions.md).

**Finish the console catch-up** — Roles admin, Alert Lifecycle, Log Explorer and message date filters have landed; two loose ends remain

- [ ] **Delete the stale in-page note on the Alerts workspace** — it still denies the resolve/assign/suppress endpoints that now exist on the Alert Lifecycle screen.
- [ ] Make the Log Explorer display its `durable: false` / `scope: process` limits prominently, so nobody mistakes a 1000-line in-memory buffer for a log store.

**Fix what still misleads**

- [ ] Encrypt notification-channel secrets at rest, redact them on read, and replace the static `x-jkannel-signature` with an HMAC. *Now the most serious remaining security defect.*
- [ ] Surface `requiredSecrets` in the configuration UI (the backend returns it; the frontend drops it).
- [ ] Expose `credentialSecretRef` / `systemId` / bind mode / TON / NPI in the SMSC form — API-only today, and the reason the bind probe falls back to TCP.
- [ ] Reconcile the message export cap: `exportLimits()` advertises 5000, `list()` clamps to 500.
- [ ] Route the raw `console.warn` callers (notification readiness, customer rate limit) through the structured logger so their warnings are queryable.
- [ ] Surface `POST /auth/api-keys` in the console, and either retire or clearly relabel the API Gateway client registry, which authenticates nothing.

**Complete the remaining partials**

- [ ] A durable log path — Loki dashboards with the `observability` profile, or persisted warn/error lines.
- [ ] Real-time push (SSE) for the queue and log tails.
- [ ] `pg_trgm` index for free-text message search; run `ensureIndexes()` automatically instead of requiring `POST /messages/indexes`.
- [ ] Per-recipient retry in bulk send (`attempts` / `next_attempt_at`).
- [ ] Cursor + `?fields=` across the remaining 14 grids (one-line delegations to the existing `grid-runner`).
- [ ] Rebuild the `monitoring` workspace — the spec's primary NOC console is a one-row table over a hardcoded endpoint.
- [ ] Distributed lock on configuration and route deploy.
- [ ] cAdvisor/node_exporter; replication-lag and Sentinel-role metrics.
- [ ] PITR / WAL archiving; Azure or SFTP backup destination.
- [ ] Multi-part segment billing — the segment data now exists, the rating model does not.
- [ ] Production out-of-process plugin worker execution and signed-package install.
- [ ] Ticketing / ITSM integration for the alert lifecycle.

**Raise the quality floor**

- [ ] Convert navigation-smoke e2e cases into mutating workflow tests — priority: create → validate → deploy → bind, and the Live Queue disable-then-resend recovery.
- [ ] Ratchet coverage gates off the current floor; make the CI `security` job blocking once findings clear.
- [ ] **Re-run the independent verification against the current commit.** `FEATURES.md` and `IMPLEMENTATION_VERIFICATION.md` are anchored to `eefa320` and now understate the product.

**External evidence** — see [`../progress/blockers.md`](../progress/blockers.md)

- [ ] Carrier-grade SMPP send once the carrier allow-lists the deployment egress IP (the bind is configured and auto-retrying).
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
