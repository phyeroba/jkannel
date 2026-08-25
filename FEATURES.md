# JKANNEL — Feature List

**JKANNEL is a control plane for Kannel/Kamex SMS gateways.** It gives operators a web
console for SMSC connections, routing, message tracing, delivery reports, configuration,
alerting, reporting, customers and audit — without hand-editing gateway config files.

The gateway engine itself (Kamex 1.8.3, a maintained Kannel fork) remains the data plane
and keeps ownership of in-flight message state. See
[ADR-0008](docs/adr/ADR-0008-control-plane-boundary.md).

---

## How to read this document

Every entry below was verified against the code by tracing whether a **non-test caller
actually reaches it on a real request path**. Code that exists but nothing invokes is not
listed as a feature. The full evidence, file-by-file, is in
[`project/IMPLEMENTATION_VERIFICATION.md`](project/IMPLEMENTATION_VERIFICATION.md).

| Mark | Meaning |
|---|---|
| ✅ | Works end to end |
| ⚠️ | Works, with a limitation stated inline |

Anything not built is in **[Not yet implemented](#not-yet-implemented)** at the bottom.
That section is deliberately long and specific — it is the honest half of this document,
and **`node scripts/features-verify.mjs` checks it**. Every claim there that can be
settled mechanically carries a probe; the tool reports any that no longer hold and exits
non-zero. Run it before trusting this file.

That check exists because hand-verification does not survive contact with three weeks of
work. This document was accurate on 2026-08-04 and by 2026-08-25 five of its claims were
wrong — all five in the direction of **understating** what had been built, which is the
expensive way for a capability document to rot: it gets work re-planned that is already
finished.

**Scale:** ~348 API operations · 99 database tables · 53 console routes ·
174 backend test suites (2,031 tests) · 60 frontend suites (687 tests).

---

## Messaging

- ✅ **Send a message** through the console, in bulk, or over the REST API.
- ✅ **Unified send pipeline** — every send is normalised (E.164), checked against the
  blocklist, routed, checked against customer entitlements, recorded, and submitted
  **inside one database transaction**. If entitlements fail, nothing is sent and nothing
  is charged.
- ✅ **Bulk send / campaigns** — queue one body to many recipients, with per-recipient
  routing and outcome tracking, processed by a background worker.
- ✅ **Message explorer** with search, status filter, and CSV/PDF export.
- ✅ **Delivery status derived from real DLRs** — `delivered`, `failed`, `rejected`,
  `buffered`, `accepted`, `pending`, correlated to each message's latest delivery receipt.
- ✅ **Replay, clone and requeue** an individual message; replay automatically re-routes
  if the original bind is no longer available.
- ✅ **Blocklist / allowlist / DND** evaluated before route selection, tenant- or
  customer-scoped.
- ⚠️ **Message history** is read from the engine's own store. JKANNEL keeps no independent
  archive, so retention deletes engine rows rather than archiving them, and search cannot
  filter by date range or show encoding/segment/UDH detail.

### Live Queue & on-the-fly rerouting

- ✅ **Live per-bind view** — status, queue depth, failures, throughput, refreshed
  automatically.
- ✅ **Reroute queued messages** to a different SMPP bind with no engine restart.
- ✅ **Resend failed traffic** to any bind, individually or by status filter — the primary
  recovery path.
- ✅ **Start / stop / reconnect a single bind** without restarting the gateway or
  disturbing other binds.
- ⚠️ **Boundary:** messages already accepted into the engine's internal queue are visible
  only as aggregate per-bind counts. They cannot be listed or moved individually — the
  engine does not expose that. The supported workaround (disable the bind, then resend
  from the log) is built in. This is a deliberate architectural decision, not an omission.
- ⚠️ **Operator resend deliberately bypasses routing and entitlements** — an explicit
  operator action targets the bind you pick, and consumes no customer quota or credit.

## Routing

- ✅ **Route types**: static, prefix, country, operator, weighted multi-target.
- ✅ **Selection strategies**: priority, least-cost, load-balance, round-robin, time-based
  windows.
- ✅ **Routing is on the send path** — omit the SMSC and the engine picks it; disabling a
  route genuinely changes where traffic goes.
- ✅ **Health-aware failover** — candidate binds come from live bind state, so failover
  actually fires.
- ✅ **Explain / preview** — submit a destination and see which bind it would take, which
  route controlled the decision, and why.
- ✅ **Decision audit** — every routed message records the chosen bind, matched route,
  strategy, fallback use and reason.
- ✅ **Route versioning** with full history.
- ⚠️ Routes must be **deployed** to be selectable (they default to `draft`).
- ⚠️ No per-route or per-SMSC throughput throttling; round-robin rotation is per-process,
  so distribution across replicas is only approximately fair.

## SMSC connections

- ✅ Full CRUD with validation, priority, tags and lifecycle state.
- ✅ Enable / disable / reconnect against the live engine.
- ✅ Live status polling with bind-state transition history and audit.
- ✅ Full SMPP attribute set — system ID, system type, bind mode, TON/NPI, window size,
  keepalive, reconnect delay, TLS.
- ✅ **All 38 settable attributes have a console control** — no config file and no curl.
  Grouped as a carrier onboarding sheet is laid out, collapsed until wanted, and each
  field names the `kannel.conf` directive it becomes. A field left blank is omitted from
  the generated file, so the engine's own default applies. Checked by
  `scripts/configurability-audit.mjs`, which reads the settable set out of the backend
  rather than from a list typed into the tool.
- ✅ A `secret://` reference resolves on screen: the form names the environment variable
  it derives to and says whether that variable is set.
- ⚠️ `reconnect` re-issues a start command rather than forcing a bind cycle; "test
  connection" proves a TCP socket opens, not that an SMPP bind succeeds.

## Configuration generator

- ✅ **Generates a complete, working gateway config from the database** — the SMSCs you
  create in the console are what gets rendered.
- ✅ Emits credentials by **secret reference**, never a literal, plus all bind parameters
  and the smsbox / sendsms-user / sms-service / dlr-storage groups.
- ✅ Immutable versions, diff, approval workflow, atomic deploy, reload, and **automatic
  rollback when the post-deploy health check fails**.
- ✅ Validated by the engine's own native validator.
- ✅ Reusable templates and **drift detection** against the live config file.
- ⚠️ **A generated config has never been bound to a real carrier** — that requires carrier
  IP allow-listing, which is outside the software.
- ⚠️ One config file per engine, so multi-tenant deploys would overwrite each other.

## Monitoring & alerting

- ✅ **Bind monitoring** — a poller observes every bind, records transitions, and raises
  deduplicated alerts on degradation, with anti-flap confirmation.
- ✅ **Alert rules are evaluated** on a schedule and open real alert instances.
- ✅ **Prometheus metrics for SMS operations** — bind state, queue depth, failures,
  throughput, DLR queue — plus an SMS-focused Grafana dashboard.
- ✅ Escalation policies, maintenance windows, alert correlation/dedup, and delivery over
  email, webhook and SMS.
- ✅ Statistical anomaly detection.
- ⚠️ **No escalation target is seeded**, so a fresh install sends no automatic
  notification until you configure a channel.
- ⚠️ Only **acknowledge** and **re-notify** exist as lifecycle actions — no resolve,
  assign, suppress or close.
- ⚠️ A deduplicated alert does not re-word itself when a bind degrades further.

## Reporting & analytics

- ✅ KPI overview, traffic trends, per-SMSC and per-route breakdowns, delivery breakdown.
- ✅ Hourly heatmap and latency/SLA percentiles.
- ✅ **Correct success rates** — computed from real DLR outcomes
  (`delivered / (delivered + failed + rejected)`), returning `null` rather than a
  misleading zero when nothing has finalised.
- ✅ Saved report definitions with scheduled CSV/summary delivery.
- ✅ Scheduled daily/weekly volume snapshots with subscriber notifications.
- ✅ CSV and PDF export throughout.
- ⚠️ No billing or cost model, so financial/vendor reports have no data behind them.

## Customers

- ✅ Customer accounts with quotas, prepaid credit and an append-only ledger.
- ✅ Sender-ID registration and approval workflow.
- ✅ Per-customer route/SMSC bindings.
- ✅ **Entitlements are enforced on the send path** — exceeding quota or credit, or using
  an unapproved sender ID, refuses the send atomically.
- ⚠️ Pricing is flat: no per-customer tariff, no destination-based rating, and multi-part
  messages count as one.

## API gateway

- ✅ API-key authentication with one-time secret issuance, rotation and revocation.
- ✅ **Scope enforcement on real endpoints** — message submission and reads.
- ✅ Per-key rate limiting (Redis, atomic) returning 429 + `Retry-After`, failing open if
  Redis is down.
- ✅ Per-key IP/CIDR allowlist, key expiry, and a per-request audit log.
- ✅ Auto-generated OpenAPI document reflecting the live route table.
- ⚠️ No OAuth2/OIDC; webhook signing is a static shared secret rather than HMAC.

## Identity & security

- ✅ Login, refresh-token rotation with family/replay revocation, and session
  administration.
- ✅ **Privileges re-resolved on token refresh** — disabling a user or removing a role
  takes effect immediately rather than at token expiry.
- ✅ Account lockout that a locked-out user can actually recover from.
- ✅ Brute-force throttling on login, MFA and password reset (counts only failures, so
  legitimate traffic is never limited).
- ✅ TOTP MFA with recovery codes; password reset with reuse prevention; invitations.
- ✅ RBAC on every endpoint, and **tenant isolation enforced in the database** by
  PostgreSQL row-level security on all tenant tables.
- ✅ Trustworthy client-IP derivation behind proxies (a spoofed `X-Forwarded-For` cannot
  defeat the IP allowlist).
- ✅ Tamper-evident audit log — append-only with a database-enforced hash chain and a
  verification endpoint.
- ⚠️ Password hashing is **scrypt**, not Argon2id.
- ⚠️ Password-policy and session-timeout settings exist in the UI but are not enforced.

## Platform

- ✅ Versioned REST API with consistent envelopes, correlation IDs and error taxonomy.
- ✅ Idempotency keys with crash recovery — a failed request releases its key instead of
  blocking retries forever.
- ✅ **Asynchronous job execution** — safe concurrent claiming, exponential backoff,
  dead-lettering, stale-claim recovery, and rejection of unrunnable job types at
  submission.
- ✅ Real health probe (PostgreSQL + Redis) that returns 503 when genuinely unhealthy and
  recovers automatically.
- ✅ Soft-delete and optimistic-locking conventions; archive tables and a retention
  scheduler.
- ✅ Deterministic migration runner with checksum drift detection and baselining.
- ⚠️ Cursor pagination and `?fields=` projection are adopted by ~4 of 18 grids.

## Backup & disaster recovery

- ✅ Real encrypted `pg_dump` backups on a schedule, with retention classes and integrity
  verification.
- ✅ Restore into an isolated verification database.
- ✅ Captures gateway configuration and certificates, not just the database.
- ✅ Encryption key is mandatory — a backup will not run without one.
- ✅ Failures raise alerts rather than passing silently.
- ⚠️ "Offsite" currently means a filesystem copy (point it at a mounted volume); no
  object-storage driver. No point-in-time recovery.

## Deployment & operations

- ✅ Docker Compose topology with isolated networks, an nginx reverse proxy, and optional
  profiles for the engine, monitoring, log aggregation, watchdog and split-out workers.
- ✅ Container hardening on stateless services (non-root, read-only rootfs, dropped
  capabilities).
- ✅ High-availability overlay — PostgreSQL streaming replication and Redis Sentinel
  (profile-gated configuration).
- ✅ Load/soak harness with encoded SLOs and a Grafana dashboard.
- ✅ CI: typecheck, lint, tests with coverage gates, compose validation, migration
  checking, dependency audit.
- ⚠️ No container resource limits are set.
- ⚠️ HTTPS is terminated by your own reverse proxy; the shipped nginx listens on HTTP.

## AI operations

- ✅ Read-only, RBAC-scoped, audit-logged Ops Copilot (local by default; optionally
  Claude-backed).
- ✅ Opt-in redaction and approval workflow.
- ✅ Statistical anomaly detection feeding the alert pipeline.

---

## Not yet implemented

Stated plainly so nobody plans around something that isn't there.

Verified by `scripts/features-verify.mjs` on 2026-08-25. Five entries were removed
from this list in that pass because the work had been done and nobody had come back to
the document — they are recorded under *Recently closed* below rather than deleted
silently, because a gap list that quietly shrinks is not evidence of anything.

**Administration**
- Password policy, session limits and idle timeout are configurable but not enforced.

**Observability**
- No real-time push — a few screens poll; the rest need a manual refresh.
- No per-container resource metrics. The API container has no Docker socket, deliberately,
  so this needs a metrics agent rather than a screen.

**Messaging & data**
- No independent message store, so no date-range search, and retention deletes engine rows
  without archiving.
- Export ignores an active status filter.
- No "replay DLR".
- No billing, rating or multi-part segment accounting.

**Platform & security**
- No HTTPS listener in the shipped gateway config (terminate TLS upstream).
- Webhook signing is a static secret, not HMAC.
- No OAuth2/OIDC, no WebAuthn.
- Plugins can be registered and validated but not executed — there is no plugin runtime.
- No point-in-time recovery: PostgreSQL WAL archiving is not configured, so a restore
  goes to the last full backup. (Streaming replication for HA *is* configured — see
  `infrastructure/ha/` — which is a different guarantee.)

**Data model conventions** — the specification calls these mandatory:
- Soft delete (`deleted_at`) is on **6 of 99 tables**; optimistic locking (`version`) on
  **9 of 99**. The helpers and the conventions exist; the coverage does not.

### Recently closed

Listed here for one release so the change is visible rather than silent:

| Was claimed missing | Evidence it is built |
|---|---|
| Role and permission management; read-only Roles screen | `POST /roles`, plus create/edit/delete and a permission catalogue in `RolesView.vue` |
| Alert resolve / assign / suppress / close | `/alerts/{id}/resolve`, `/assign`, `/suppress`, `/close`, `/acknowledge` — all served |
| No log explorer, live tail or correlation-ID search | `LogExplorerView.vue`, and correlation drill-down in `EventsView.vue` |
| No encoding / segment / UDH columns | All three in the message trace sheet |
| No object-storage backup target | `S3Destination` — SigV4 over `node:crypto`, wired into `backup-dr.service.ts` |

**External evidence outstanding** — these need infrastructure or third parties, not code:
- A generated configuration has never bound to a live carrier (awaiting carrier IP
  allow-listing).
- No independent penetration test.
- No production-scale soak at the throughput targets in the specification.
- No multi-node HA failover drill with measured RPO/RTO.

---

*Gap list verified 2026-08-25 by `scripts/features-verify.mjs` — re-run it rather than
trusting this date. Evidence:
[`project/IMPLEMENTATION_VERIFICATION.md`](project/IMPLEMENTATION_VERIFICATION.md) ·
Gap history: [`project/SPEC_GAP_ANALYSIS.md`](project/SPEC_GAP_ANALYSIS.md) ·
Per-requirement status: [`progress/requirements-traceability.md`](progress/requirements-traceability.md)*
