# Pending

Updated: 2026-08-05, against
[`project/IMPLEMENTATION_VERIFICATION.md`](../project/IMPLEMENTATION_VERIFICATION.md)
(baseline `eefa320`) **plus commit `d58a3d2`**, which closed a substantial part of what
that report listed as open.

> This list is the honest remainder. Where an item is a *partial* rather than an
> absence, the working part is named so nobody re-builds it. The user-facing version is
> [`FEATURES.md § Not yet implemented`](../FEATURES.md#not-yet-implemented) — which
> predates `d58a3d2` and is correspondingly pessimistic.

---

## Closed since the verification report (`d58a3d2`)

Recorded here so nobody works these twice. Each is **backend-reachable**; the console
surface is noted where it lags.

| Was | Now | Console |
|---|---|---|
| **G11** no role/permission administration | Full role CRUD (`POST`/`PATCH`/`DELETE /users/roles`), a seeded 21-code permission catalogue with descriptions and categories, and **8 seeded roles** per tenant. System roles cannot be renamed or deleted; a change that would orphan `users.manage` is refused; editing a role's grants revokes every holder's session. | Shipped — create/edit controls on **Roles & Permissions**. |
| Alert lifecycle 2 of 9 | Acknowledge, resolve, assign, suppress, reopen, close and comments, with validated transitions (409 naming the current state) and a lifecycle history endpoint. Suppress requires `system.manage` and is capped at 30 days. | Shipped as a dedicated **Alert Lifecycle** screen. **The old in-page note on Alerts still denies these endpoints exist — remove it.** |
| No default notification target | A readiness service seeds a `Default dashboard` channel and a `Default escalation` policy at boot, reports per-channel deliverability at `GET /monitoring/notifications/readiness`, and warns when a tenant has open alerts but nothing deliverable. Undeliverable steps now record a reason instead of being silently skipped. | API only. |
| No message date range; export dropped the status filter | Server-side `from`/`to` (strict ISO 8601, inclusive) and a single shared filter parser across list, CSV and PDF — so **export parity holds**. Encoding, charset, UDH, validity, mclass, pid, binfo, metadata and a derived segment count are now selected and returned. | Shipped; the client-side date-filter warnings are gone. |
| "Test connection" was a TCP connect | A real `bind_transceiver` probe reporting `ESME_*` status, with an explicit `verified` level of `smpp_bind` / `tcp_socket` / `not_applicable` persisted to the operation history. | Shipped. |
| `reconnect` re-issued `start-smsc` | A genuine observed stop-then-start cycle, recording `bind_cycled` or `command_accepted`, gated on the `runtime.smsc.reconnect` capability. | Shipped. |
| Password policy / session settings read by no code | Enforced per tenant: password minimum length and four complexity rules, history depth, lockout threshold and duration, access-token TTL, session idle timeout, absolute lifetime, and a concurrent-session cap. | Shipped (System Settings). |
| `customers.rate_limit_per_min` enforced nowhere | Enforced on the send path, 429 with `retryAfterSeconds`. | Shipped. |
| Offsite backup was a filesystem copy only | An S3-compatible destination driver (AWS, MinIO, Ceph) with SSE support. | Shipped. |
| No container resource limits | `mem_limit`, `cpus`, `pids_limit` and `ulimits` set across the compose services. | n/a |
| No TLS listener | An opt-in `tls` profile. **The live deployment still terminates TLS upstream** — this does not change the default topology. | n/a |
| No correlation ID in log lines | Log lines carry correlation ID, request ID, user, tenant, method, route and client IP, via `AsyncLocalStorage`; an `x-correlation-id` response header is returned. | n/a |

## Open gaps (nothing built)

| # | Gap | Why it matters |
|---|---|---|
| — | **No durable log store.** A **Log Explorer** screen and `GET /observability/logs` exist, but they read an **in-memory, process-local ring buffer** — 1000 lines by default, 20 000 maximum, no retention window, lost on restart, and each replica sees only its own lines. Components that write via raw `console.warn` (notification readiness, customer rate limit) are not captured at all. | Incident tracing beyond the last few seconds of one process still means grepping container logs or running the Loki profile. It is triage convenience, not observability — and now it *looks* like a log explorer, which makes the caveat more important, not less. |
| — | **No real-time push.** Zero hits for WebSocket, socket.io, EventSource, SSE or `@WebSocketGateway` in either package. Three views poll; the rest need a manual refresh. | Live operational awareness is polling-shaped. |
| — | **No ticketing / ITSM integration.** No ticket field, no ticket route. | Alert lifecycle stops at close; there is no hand-off to an external system. |

## Partial — works, with a material limitation

| Area | Delivered | Remaining |
|---|---|---|
| **Health probes (G7)** | Real PostgreSQL + Redis probe, bounded timeouts, 503 when unhealthy, wired to compose/nginx/watchdog. | Only `GET /health` exists; the HA specification asks for `/health/live`, `/health/ready`, `/health/version`, `/health/dependencies`. |
| **Live updates (G10)** | `useLiveResource` on the Operations dashboard (30 s), Live Queue (5 s) and three workspace modules (30 s, default off). | 14 of 18 workspace modules and 7 of 13 dedicated views are manual refresh only. No push layer. |
| **Security cluster (G12)** | Stale-privilege refresh, XFF trust, MFA/auth throttling, and now an enforced password/session policy. An opt-in `tls` profile exists. | Notification-channel secrets stored and returned as **plaintext** `jsonb` behind a read permission, and re-sent as a replayable static `x-jkannel-signature` rather than an HMAC. Password hashing is **scrypt, not Argon2id**. **No password-expiry setting exists at all.** `require_mfa` is advisory only and non-editable — tenant-wide MFA forcing is not available. Policy values are clamped one-sidedly toward strictness (a `passwordMinLength` of 8 silently becomes 12), and the concurrent-session cap ships **off** by default. Idle and absolute-lifetime checks fire at refresh, not proactively. |
| **Message read model (G13)** | DLR-derived outcome, server-side `from`/`to`, export parity, and encoding/UDH/segment columns. | Free-text search is still a leading-wildcard `ILIKE` with **no trigram index**, so `query=` is a full scan. Read indexes are **not created automatically** — an operator must call `POST /messages/indexes` once. A message export returns **at most 500 rows** whatever `SQLBOX_EXPORT_MAX_ROWS` says, signalled only by an `x-jkannel-next-cursor` header. JKANNEL still owns no message store, so retention `DELETE`s the engine's rows without archiving. Segment counts are informational — billing still counts multi-part as one. |
| **Job platform (G15)** | `api_jobs` has a real executor with `FOR UPDATE SKIP LOCKED`, backoff, dead-lettering and stale-claim reaping; `POST /jobs` returns 202 + `Location`. | `bulk_send_recipients` has no `attempts`/`next_attempt_at`, so a transient failure is terminal for that recipient. The six domain schedulers are still advisory-locked `setInterval` loops. |
| **Backup & DR (G17)** | Mandatory encryption key, failure alerting, config/certificate capture, honest backup kinds, and local **plus S3-compatible** offsite destinations. | No Azure Blob or SFTP driver. No PITR or WAL archiving. No one-click production restore (by design). |
| **REST conformance (G18)** | A shared `grid-runner` composes cursor + `?fields=` + filtering. | Adopted by 3–4 of 18 grids. `platform/etag.ts` has zero non-test callers. `http-exception.filter.ts` hardcodes `errors: []` and never logs the exception. No problem+json; 1 of 14 filter operators. |
| **Alerts (G19a)** | A full lifecycle over the API, plus seeded default channel and policy with a deliverability report. | Console buttons for the new lifecycle actions are still in progress, and two in-page notes are stale. No ticketing. No bulk actions across alerts, no explicit un-suppress verb. Suppression lapses only when the escalation sweep runs, not on its own timer. The seeded policy's email/webhook steps have **empty targets**, so out of the box only the dashboard step delivers. A deduplicated alert still does not re-sharpen its summary as the condition worsens. |
| **Dense grids (G20)** | 13 modules have real column sets. | `configuration` still renders the generic four-column table; `monitoring` — the spec's primary NOC console — is four relabelled generic fields over an endpoint returning a **single hardcoded item**. |
| **SMSC operations** | CRUD, attributes, polling, transitions, enable/disable, a **real SMPP bind probe** and a **genuine reconnect cycle**, both recording how far they got. | The bind probe falls back to TCP whenever the API container cannot resolve the credential — which is the standard topology, since credentials live in the engine container. It also does not validate the TLS certificate chain. 4 of 7 SMSC types. No groups, clone, bulk or import. No console field for `credentialSecretRef` / `systemId` / bind mode — API only. |
| **Configuration** | Generates from the database, renders carrier-capable output, native validation, templates, drift. | The upstream-Kannel renderer throws. `markConfigurationValidated` mutates `content` without recomputing the checksum. No distributed lock, so two replicas can race a config push. One config file per engine. No import/export. Diff UI is a `<pre>` dump. |
| **Routing** | On the send path, all route types and strategies, health-aware failover, decision audit, resolve preview. | No per-route or per-SMSC throughput throttling. Round-robin rotation is per-process. No HLR/MNP lookup. No route-version restore. No visual builder. |
| **Customers** | Quota, credit, sender IDs and route bindings **enforced in the send transaction**, and `rate_limit_per_min` now enforced too (429 with `retryAfterSeconds`). | The rate limiter **fails open** on Redis loss, counts **attempts not successes**, uses a fixed rather than sliding 60-second window, and consumes batch slots through a non-atomic loop. No limit applies when the send carries no `customer_id`. Pricing is flat: no per-customer tariff, no destination rating, and **billing still counts multi-part as one** despite segment counts now being recorded. No console UI for quota/credit/sender-ID/route-binding workflows. |
| **API gateway** | Key auth, enforced scopes, Redis rate limit, IP allowlist, request audit. | `api_gateway_clients` (the registry the console manages) authenticates nothing; the working credential is `POST /auth/api-keys`, which has **no UI**. No OAuth2/OIDC. No webhook framework. 1 of 9 rate-limit dimensions. |
| **Reporting** | KPI, trend, per-SMSC/route, heatmap, latency percentiles, saved definitions, exports. | 7 of 14 SMSC operational report items missing. Monthly/yearly periods blocked by a database CHECK. No cost model, so financial/vendor/customer reports have no data. No large-result streaming. |
| **Docker topology** | 14 services, 4 isolated networks, hardening on stateless services, **CPU/memory/pid/fd limits**, and an opt-in `tls` profile. | No cAdvisor or node_exporter, so per-container CPU/RAM/disk/network is unobservable. App containers share one health endpoint. The default topology is still HTTP-only and the live deployment terminates TLS upstream. |
| **Plugins** | Registry, manifest validation on install, enable/disable. | `PluginExecutor` has **zero implementations** — plugins cannot execute. No signed-package install. |
| **Data model** | 81 tables, forced RLS, audit hash chain, archive tables, retention. | Four specification chapters at 0 % table coverage (MESSAGING 0/20, DLR 0/9, QUEUE 0/9, MONITORING 0/13). `deleted_at` on ~5 of 81 tables. `audit_signatures` has a service and no table. Migration 002's ten `engine_*` tables are referenced by no code. |
| **Frontend** | 34 routes, all with a real backend; honest degradation everywhere. Roles admin, Alert Lifecycle, Log Explorer and message date filters have caught up with `d58a3d2`. | **One stale in-page note remains**: the alerts workspace still says there is no resolve/assign/suppress endpoint. No console screen for customer quota/credit/sender-ID workflows, API-key issuance, or notification channels. No detail-tab architecture or `:id` routes (~116 spec'd tabs). No Permission Matrix editor, Scheduler, Auth-history or Service Accounts screens. No i18n. Visual regression captures screenshots but asserts nothing against a baseline. |
| **Testing** | 100 backend suites / 836 tests, 18 frontend suites / 112 tests, real CI with coverage gates. | Coverage gates sit at the current floor (backend 53/41/43/53) against a 95 % target. 2 of 9 specified integration areas. **Of 40 e2e runtime cases, 26 are a single navigation loop and only 5 are genuinely mutating workflows** — the "36 acceptance tests" framing does not survive inspection. The `npm audit` CI job is non-blocking. |

## External-evidence gates — outstanding, not fabricated

These need infrastructure or independent parties, not code. See
[`blockers.md`](blockers.md).

1. A generated configuration bound to a **live carrier** (blocked on carrier-side IP
   allow-listing of the deployment's egress IP).
2. An **independent penetration test**.
3. A **production-scale soak** at the specification's throughput targets.
4. A **multi-node HA failover drill** with measured RPO/RTO.
5. A **restore-to-production drill** and a full-site-loss drill.
