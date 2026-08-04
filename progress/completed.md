# Completed

Updated: 2026-08-04.

> **Honesty rule.** An item belongs here only when a **non-test caller reaches it on a
> real request path**. Code that is written, merged and tested but that nothing invokes
> is **not** completed. This ledger was previously wrong in exactly that way; the
> correction notice in
> [`requirements-traceability.md`](requirements-traceability.md) explains how and why.
> Per-capability truth lives in [`FEATURES.md`](../FEATURES.md); the evidence is in
> [`project/IMPLEMENTATION_VERIFICATION.md`](../project/IMPLEMENTATION_VERIFICATION.md).

---

## Foundations (2026-07-06 → 2026-07-08)

- [x] Monorepo structure, documentation catalog, ADRs, project memory and progress
      tracking established; specifications categorised and duplicates archived.
- [x] Docker Compose baseline: PostgreSQL, Redis, NestJS backend, Vue 3 frontend,
      reproducible lockfiles, clean image builds, healthy startup.
- [x] Backend platform foundation: validated environment, structured JSON logging,
      versioned API, correlation IDs, response envelopes, global error handling.
- [x] Deterministic PostgreSQL migrations with a migration runner (boot apply, checksum
      drift detection, advisory locking, rollback, baselining).
- [x] Authentication and RBAC: scrypt password hashing, separate access/refresh signing
      keys, refresh rotation, lockout, permission guards, audited mutations.
- [x] Permission-aware Vue console shell aligned to `design/design_spec/`.
- [x] Generic Engine Adapter core with independently probed capabilities; Kannel and
      Kamex treated as siblings, never as parity-by-ancestry.
- [x] Kamex 1.8.3 pinned by OCI digest; bearerbox, smsbox and the native config
      validator running under the `engine-kamex` profile.
- [x] **SQLBox runtime repaired.** The official binary RPM panics on any non-MSSQL
      configuration; sqlbox is now rebuilt from the official checksum-pinned source RPM
      with only the PostgreSQL dispatcher. First live end-to-end message proof followed:
      API → `send_sms` → bearerbox → SMSC → `sent_sms` → console grid.

## Takeover remediation (2026-07-09)

- [x] **Tenant isolation enforced for real** — forced row-level security on every table
      including `audit_log`, a non-owner application role, a least-privilege pre-login
      lookup role, proven by a live cross-tenant integration test.
- [x] Authentication signing-key mismatch fixed (separate access/refresh keys).
- [x] Cross-tenant SQLBox read leak closed.
- [x] Global audit-trail interceptor over every mutation and sensitive read.
- [x] Uniform searchable/sortable/filterable grids with CSV and PDF export.
- [x] Scheduled daily/weekly volume reports with subscriber notifications.
- [x] Notification delivery over SMTP email and webhook.
- [x] Backend Prometheus metrics and the Prometheus/Grafana profile.
- [x] AI Ops Copilot — read-only, RBAC-scoped, opt-in, audit-logged.
- [x] Traffic anomaly detection feeding the alert pipeline.
- [x] Identity workflows: password reset, invitation acceptance, session administration.

## Console completeness and spec-conformance waves 1–6 (2026-07-10)

- [x] Every Platform console module built end to end: API Gateway clients, Plugins,
      Backups, Runtime Containers, grouped System Settings, full user lifecycle.
- [x] Analytics dashboard, seven-category report catalog, notification detail.
- [x] **Wave 1** — identity depth (TOTP MFA + recovery codes, refresh-token family
      revocation, login/password history, user-owned API keys); backup & DR (real
      encrypted `pg_dump`, scheduler, retention classes, restore-verify); monitoring
      depth (DB/Redis exporters, escalation policies, maintenance windows, correlation).
- [x] **Wave 2** — reporting depth (per-SMSC success/failure, per-route performance,
      hourly heatmap, latency/SLA percentiles, saved report definitions); configuration
      templates and drift detection; message replay/clone/requeue and bulk send.
- [x] **Wave 3** — API gateway rate limiting / IP allowlists / expiry / request log;
      routing depth (route types, selection strategies, targets, versions, resolve
      preview); customers depth (quotas, credit ledger, sender IDs, route bindings).
- [x] **Wave 4** — auto-generated OpenAPI from the live route table, cursor pagination
      and field projection helpers, data-model completeness (soft-delete and
      optimistic-lock conventions, DB-enforced audit hash chain and verifier, archive
      tables, retention scheduler), fuller Docker topology with hardening.
- [x] **Wave 5** — HA overlay (`docker-compose.ha.yml`), performance/soak harness
      (`perf/`) with encoded SLOs, Playwright e2e suite, auth lockout defect fixed.
- [x] **Wave 6** — idempotency failure-state recovery and a Sentinel-aware Redis client.

> These waves shipped code. The audit below then showed that several of the resulting
> ledger rows had booked *code merged* as *capability delivered*. Read this section
> together with the audit result that follows.

## Live Queue and the control-plane boundary (2026-08-04)

- [x] **Live Queue console** — per-bind status, queue depth, failures and throughput;
      pending-spool grid with reroute and cancel; DLR-derived delivery status with
      `resendable` / `in-flight` presets; bulk resend by id or status filter; per-bind
      start/stop/reconnect that leaves the engine and every other bind running. All
      live-verified against the running engine.
- [x] **[ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md) accepted** — JKANNEL
      is a control plane; the engine owns the data plane. Rather than build a competing
      outbound queue, the boundary is stated honestly and the disable-then-resend
      workflow is built.

## Spec-gap audit and the six remediation waves (2026-08-04)

An independent specification-vs-implementation audit
([`project/SPEC_GAP_ANALYSIS.md`](../project/SPEC_GAP_ANALYSIS.md)) found 20 gaps, three
of which were integration voids that made the product a console over disconnected
parts. Six remediation waves ran against its recommended build order.

- [x] **Wave A — stop the bleeding.** Permanent account lockout fixed; stale privileges
      on refresh fixed; the `X-Forwarded-For` allowlist bypass closed; MFA and
      `/auth/*` throttling added; the hardcoded `/health` replaced with a real
      PostgreSQL + Redis probe returning 503; `dlr_mask` decoded so success rates are
      correct; **CI added** (5 GitHub Actions jobs with coverage gates, ESLint at zero
      errors).
- [x] **Wave B — make configuration real.** Migration 029 adds the SMSC attribute set;
      a `SecretResolver` renders credentials as `${ENV}` placeholders and reports
      `requiredSecrets`; the `smsbox` / `sendsms-user` / `sms-service` / `dlr-db` groups
      are emitted; `ConfigurationModelBuilder` composes the model **from
      `smsc_definitions`**, closing the gap between the SMSC Manager and the generator;
      deploy rollback fires on a failed health check.
- [x] **Wave C — close the observability loop.** `SmscStatusPoller` observes every bind
      and writes state, transitions and metric samples; real SMS metrics are exported
      and an SMS-focused Grafana dashboard ships; `AlertRuleEvaluatorScheduler` finally
      drives the previously callerless alert evaluator; escalation honours per-step
      targets; the SMS notification channel actually sends.
- [x] **Wave D — routing and customers on the send path.** A single
      `MessageSendService` funnels console, API-gateway, bulk and replay sends through
      route selection, blocklist and customer entitlements **inside one transaction**,
      recording the decision; API-key authentication with enforced scopes on real
      business endpoints; customer identity taken from the key, never from the body.
- [x] **Wave E — operator surfaces.** A shared `useLiveResource` polling composable;
      real dense columns on 13 modules; alert row actions; UI for escalation policies,
      maintenance windows, backup schedules and routing depth.
- [x] **Wave F — durability and platform depth.** Mandatory backup encryption key with
      placeholder rejection; backup failure alerting; config and certificate capture;
      the false `incremental` label retired rather than faked; a real job queue with
      `FOR UPDATE SKIP LOCKED` claiming, exponential backoff, dead-lettering and
      stale-claim recovery; plugin manifest validation actually called on install.

**Audited result: 10 of 20 gaps closed, 7 partially closed, 3 open.** Both readings of
the tally, the per-gap evidence and the residual limits are in
[`project/IMPLEMENTATION_VERIFICATION.md`](../project/IMPLEMENTATION_VERIFICATION.md) §2.
What is still open is in [`pending.md`](pending.md).

## Closing the verified gaps (2026-08-05, commit `d58a3d2`)

A follow-up pass against the verification report's own open and partial list. All of the
following are **backend-reachable**; where the console has not caught up it is marked.

- [x] **Role and permission administration** — the report's single largest open gap
      (G11). Role create / rename / edit / delete, a seeded 21-code permission catalogue
      with descriptions and categories, and **eight seeded roles** per tenant (Super
      Administrator, Administrator, Network Engineer, Operations Engineer, Support
      Engineer, Read Only, Auditor, API Client). Guard rails: system roles cannot be
      renamed or deleted, a change that would leave nobody holding `users.manage` is
      refused, a role held by a user cannot be deleted, and editing a role's grants
      revokes every holder's live session. *API only — Roles admin UI in progress.*
- [x] **Full alert lifecycle** — acknowledge, resolve, assign, suppress, reopen, close
      and comments, with validated transitions returning 409 naming the current state,
      and a lifecycle history endpoint. *API only — buttons in progress.*
- [x] **Notification readiness** — seeds a `Default dashboard` channel and a
      `Default escalation` policy at boot, reports per-channel deliverability, and warns
      when a tenant has open alerts but nothing deliverable. Undeliverable steps record
      a reason instead of being silently skipped.
- [x] **Message depth** — server-side `from`/`to` date range, a single shared filter
      parser so **CSV, PDF and the grid agree**, and encoding / charset / UDH / validity
      / mclass / pid / binfo / metadata plus a derived segment count.
- [x] **A real SMPP bind test** — `bind_transceiver` with the `ESME_*` status reported,
      and an explicit `verified` level (`smpp_bind` / `tcp_socket` / `not_applicable`)
      persisted to the operation history, so a TCP fallback can never be mistaken for a
      bind.
- [x] **A genuine reconnect cycle** — observed stop-then-start, recording `bind_cycled`
      or `command_accepted`. Both this and the bind test had been flagged in two
      consecutive audits without changing.
- [x] **An enforced security policy** — password minimum length and complexity, history
      depth, lockout threshold and duration, access-token TTL, session idle timeout,
      absolute session lifetime and a concurrent-session cap, all per tenant. These were
      previously decorative settings read by no code.
- [x] **Customer `rate_limit_per_min` enforced** on the send path, 429 with
      `retryAfterSeconds`.
- [x] **An S3-compatible offsite backup destination** (AWS, MinIO, Ceph) with
      server-side encryption options, alongside the existing filesystem driver.
- [x] **Container resource limits** — `mem_limit`, `cpus`, `pids_limit` and `ulimits`
      across the compose services.
- [x] **An opt-in `tls` profile.** *The default topology is unchanged and the live
      deployment still terminates TLS upstream.*
- [x] **Correlation IDs in log lines** via `AsyncLocalStorage`, plus an
      `x-correlation-id` response header and a log query endpoint.
      *The endpoint reads a process-local, non-durable in-memory ring buffer — see
      [`pending.md`](pending.md).*

> Not closed, and worth stating beside this list: there is still no ticketing
> integration, no durable log store, no real-time push, and **a generated configuration
> has still never bound to a real carrier.**

## Deployment (2026-08-04)

- [x] **Deployed to a shared VPS** beside an unrelated stack. The frontend Vite dev
      server was made deployable behind a reverse proxy (`VITE_ALLOWED_HOSTS` host
      check), ports were remapped to loopback-only to avoid collision with the co-hosted
      stack, and a system nginx terminates TLS and proxies to the JKANNEL entrypoint.
- [x] Console reachable at `https://jkannel.34-134-248-1.sslip.io` (tenant `default`,
      username `operator` — there is no email login).

## Documentation (2026-08-04)

- [x] [`FEATURES.md`](../FEATURES.md) — a capability list where every entry was verified
      by tracing a real request path, with a deliberately long "Not yet implemented"
      section.
- [x] [`project/IMPLEMENTATION_VERIFICATION.md`](../project/IMPLEMENTATION_VERIFICATION.md)
      — independent, read-only, file-by-file verification.
- [x] Rewritten `README.md` and task-oriented operator manuals under
      [`docs/user-guides/`](../docs/user-guides/README.md).
- [x] `project/SUPERVISOR_HANDOVER_SUMMARY.md` retired — a point-in-time status memo
      superseded by the two documents above.
