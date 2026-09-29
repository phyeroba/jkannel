# Project State

Updated: 2026-08-05, against the audited baseline in
[`IMPLEMENTATION_VERIFICATION.md`](IMPLEMENTATION_VERIFICATION.md) (commit `eefa320`)
**plus commit `d58a3d2`**.

**Current position:** JKANNEL is a working control plane for Kannel/Kamex SMS gateways,
deployed and reachable. Six remediation waves closed the three integration voids that
previously made it a console over disconnected parts; an independent verification then
found **10 of 20 gaps closed, 7 partial and 3 open**. A follow-up commit closed most of
that remainder — including the largest identity gap. Four release gates are outstanding
external evidence, not code.

> **The two authorities are now behind the code.** `FEATURES.md` and
> `IMPLEMENTATION_VERIFICATION.md` are anchored to `eefa320` and therefore *understate*
> the product. Re-running the verification is tracked in
> [`../progress/next-actions.md`](../progress/next-actions.md). Until then, this
> document and [`../progress/pending.md`](../progress/pending.md) carry the current
> position, and `/api/v1/openapi.json` is the final word on which routes exist.

> **Reading rule for this document.** Nothing here is recorded as delivered unless a
> non-test caller reaches it on a real request path. That rule exists because earlier
> revisions of the project ledger violated it systematically — see the correction
> notice in [`progress/requirements-traceability.md`](../progress/requirements-traceability.md).
> The authoritative per-capability answer is [`FEATURES.md`](../FEATURES.md).

---

## Scale

**Re-counted 2026-09-29 against `49cf542`.** 44 API controllers · **282 endpoints**
(counted from the running `/api/v1/openapi.json`, not from the source) · 52 forward
migrations, all 52 applied in production · 42 console screens · 101 tables ·
**177 backend test suites (2,064 tests)** · **63 frontend suites (704 tests)** ·
10 Playwright e2e spec files · 18-service Compose topology across 4 isolated networks,
of which 10 run in the default + `engine-kamex` shape used locally and in production.

> The figures above replace the 2026-08-05 set (39 controllers, ~250 endpoints, 34
> migrations, 26 screens, 81 tables, 100/18 suites), which had fallen roughly 130
> commits behind and **understated every dimension of the product**.

## Stack

NestJS/TypeScript backend · Vue 3 + Vite frontend · PostgreSQL (system of record, forced
row-level security) · Redis (rate limiting, idempotency, throttling) · Docker Compose ·
Kamex 1.8.3 pinned by OCI digest, behind a generic Engine Adapter · upstream Kannel as a
sibling adapter.

## Architectural position

**JKANNEL is a control plane; the engine owns the data plane.**
[ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md) records the decision and its
consequences: JKANNEL will not build a competing outbound queue and will not fork the
engine for per-message queue control. Where the engine does not expose a capability,
JKANNEL reports that honestly rather than simulating it.

The practical consequence, and the workflow built around it: messages already inside
bearerbox are visible only as an aggregate per-bind counter and cannot be moved
individually. The supported recovery path is **disable the sick bind, then resend the
affected traffic to a healthy one** — an equivalent outcome achieved without owning the
data plane.

---

## What works end to end

Summarised. The verified, itemised list is [`FEATURES.md`](../FEATURES.md).

- **One transactional send pipeline.** `MessageSendService` is the single funnel for the
  console, API-gateway, bulk and replay send paths. Normalise → blocklist → route →
  entitlements → record decision → submit, inside one database transaction. Fails
  closed when nothing matches.
- **Routing on the send path**, with all five route types and all five selection
  strategies, health-aware failover driven by live bind state, per-message decision
  audit, and a resolve/preview that runs the same selector as production.
- **Configuration generated from the database.** The SMSCs created in the console are
  what gets rendered, with credentials emitted as `${ENV}` references. Immutable
  versions, native validation, approval, atomic deploy, drift detection, and automatic
  rollback when the post-deploy health check fails.
- **Bind observability that reaches a human.** A poller writes bind state, transitions
  and metric samples; the alert-rule evaluator runs on a schedule; escalation honours
  per-step targets; real SMS metrics feed Prometheus and an SMS-focused Grafana
  dashboard.
- **Customer entitlements enforced atomically** — quota, prepaid credit with an
  append-only ledger, sender-ID approval and route bindings, all consumed inside the
  send transaction.
- **Live Queue console** — per-bind depth/failures/throughput, spool reroute and cancel,
  bulk resend by status filter, and per-bind start/stop without disturbing the engine.
- **Security that is enforced where it counts** — RBAC on every endpoint, forced
  row-level security proven by a live cross-tenant test, refresh-token family
  revocation, privileges re-resolved on refresh, TOTP MFA, auth throttling that counts
  only failures, spoof-resistant client-IP derivation, and a database-enforced
  tamper-evident audit hash chain with a verification endpoint.
- **Platform primitives that are actually wired** — auto-generated OpenAPI from the live
  route table, idempotency keys with crash recovery, an async job queue with backoff and
  dead-lettering, and a real dependency health probe.
- **Backup and DR** — encrypted `pg_dump` on a schedule with retention classes,
  integrity verification, restore into an isolated verification database, and failure
  alerting.

## Closed since the verification report

Commit `d58a3d2`, with console screens following shortly after: **role and permission
administration** with
eight seeded roles and a described permission catalogue; the **full alert lifecycle**;
**notification readiness** seeding a default in-app channel and reporting per-channel
deliverability; **message date-range search with export parity** and encoding/segment
detail; a **real SMPP bind probe** and a **genuine reconnect cycle**, both reporting how
far they actually got; an **enforced password and session policy**; **customer
rate limiting**; an **S3 backup destination**; **container resource limits**; an
**opt-in TLS profile**; and **correlation IDs in log lines** with a query endpoint.

Itemised, with the guard rails and caveats, in
[`../progress/completed.md`](../progress/completed.md).

## What does not work

The **open** gaps:

1. **No durable log store.** A log query endpoint exists, but it reads a process-local
   in-memory ring buffer — 1000 lines by default, no retention window, lost on restart,
   one replica's view only. Triage convenience, not observability.
2. **No real-time push.** Polling on three surfaces; everything else is manual refresh.
3. **No ticketing or ITSM integration.**

Plus the partials, each with the working part and the missing part named, in
[`../progress/pending.md`](../progress/pending.md). The ones most likely to surprise:

- **One screen still contradicts the code.** The alerts workspace displays a note saying
  there is no manual resolve, assign or per-alert suppress endpoint. Those actions exist
  on the **Alert Lifecycle** screen. Tracked as the top next action.
- **Some workflows have no console screen at all** — customer quota, credit and
  sender-ID approval; API-key issuance; notification channels. All API-only.
- **A fresh install pages nobody.** Alerts always reach the console, but the seeded
  policy's email and webhook steps have empty targets, so no human is notified until
  you configure a destination.
- **The SMPP bind probe falls back to TCP** whenever the API container cannot resolve
  the credential — which is the standard topology, since credentials live in the engine
  container. It says so explicitly rather than claiming a bind.
- **JKANNEL owns no message store.** Retention deletes engine rows without archiving,
  free-text search is an unindexed scan, and a message export returns at most 500 rows
  per call.
- **Notification-channel secrets are stored and returned in plaintext**, and the webhook
  "signature" is a replayable static token. This is now the most serious remaining
  security defect.
- **Password hashing is scrypt, not Argon2id.** There is no password-expiry setting at
  all, and tenant-wide MFA forcing is advisory only.
- **Plugins register and validate but do not execute** — there is no plugin runtime.
- **No PITR**, and no Azure or SFTP backup destination.
- **TLS is terminated upstream by default.** The `tls` profile is opt-in and the live
  deployment does not use it.

## Test reality

Backend unit testing is genuine and broad (100 suites / 836 tests) with a real coverage
gate, though set at the current floor rather than the specification's 95 %. Two
integration specs exist of the nine areas the specification names; the row-level
security proof among them is high quality.

**The e2e figure should not be quoted without its caveat.** Of 40 runtime cases, 26 are
a single navigation loop and **5 are genuinely mutating workflows**. Several tests
tolerate a broken backend by design. The "36 acceptance tests across nine workflow
groups" framing in earlier documents does not survive inspection and has been retracted.

## Deployment

Running on a **shared VPS beside an unrelated stack**, on remapped **loopback-only**
ports (backend 3200, frontend 5173, JKANNEL proxy 8081, Kamex admin 13000, Kamex sendsms
13013), with a **system nginx terminating TLS** and proxying to `127.0.0.1:8081`.

Console: **`https://gw1.speedamobile.com`** · tenant `default` · username `operator`.
**There is no email login** — the users table has `username` and no email column, and
the login form's "Email or Username" label is misleading.

> **Corrected 2026-09-29.** Every document here said
> `https://jkannel.34-134-248-1.sslip.io`. That host now fails the TLS handshake with
> an `unrecognized_name` alert, because `/etc/nginx/sites-available/jkannel` — which
> holds its certificate and server block — **is not symlinked into `sites-enabled/`**,
> so the `default-reject` default server answers instead. The console was not down; it
> is served by the enabled `speedamobile` vhost, and `gw1.speedamobile.com/api/v1/health`
> returns `jkannel-backend`. `sites-available/cpaas` is likewise not enabled. Both
> disabled files are left alone: the system nginx is shared with the CPaaS stack and is
> not ours to re-point without Peter deciding which names should be live.

**Corrected 2026-09-29: the frontend container serves a static build behind nginx**
(`nginx -g "daemon off;"`), both in production and in the local Compose stack. It no
longer runs the Vite dev server, so a `.vue` edit is invisible until the image is
rebuilt. For design work, run a dev server on the host instead
(`cd frontend && npx vite --port 15174`, with `VITE_API_BASE_URL` pointed at the
backend and that origin added to `FRONTEND_ORIGIN` so CORS admits it).

## Release gates outstanding

Not code. Not fabricated. See [`progress/blockers.md`](../progress/blockers.md).

1. A generated configuration bound to a **live carrier** — blocked on carrier-side IP
   allow-listing of the deployment's egress IP.
2. An **independent penetration test**.
3. A **production-scale soak** — the local baseline only proves the paths are healthy on
   a near-empty database, and it already surfaces one honest failure (auth ~535 ms p95
   against a 100 ms target).
4. A **multi-node HA failover drill** with measured RPO/RTO, plus a
   restore-to-production drill.

## Next milestone

**Both loose ends from the catch-up are closed** (verified in code 2026-09-29, not
assumed): the stale alerts note is gone — `AlertResponseView.vue` now states the
opposite, that `POST /alerts/:id/suppress` exists and ships on the Alert Lifecycle
screen — and the Log Explorer carries its `durable: false` / `scope: process` caveat
prominently, above the results.

Next, in order:

1. **Encrypt notification-channel secrets at rest, redact them on read, and replace the
   static `x-jkannel-signature` with an HMAC.** Still the most serious remaining
   security defect: as of `49cf542` the secret is sent verbatim as the signature header
   in both `monitoring/notification-delivery.service.ts` and
   `messaging-depth/mo-delivery.service.ts`, so the "signature" is replayable and the
   secret is stored and returned in plaintext.
2. **Surface `POST /auth/api-keys` in the console.** The only credential that actually
   authenticates the gateway still has no screen — the CPAAS-SMSONE key had to be issued
   over HTTP.
3. **Re-run the independent verification** against the current commit so `FEATURES.md`
   and `IMPLEMENTATION_VERIFICATION.md` stop understating the product; both are still
   anchored to `eefa320`.

Ordered plan: [`../progress/next-actions.md`](../progress/next-actions.md).

**The design system is not the bottleneck.** A full sixteen-audit run on 2026-09-29
came back clean on eleven of them, including 622 CSS selectors matching the kit with
zero divergences, every comparable component rendering identically to it, and 0 of 352
API operations without a console surface. The audits are in
`docs/HANDOVER.md` §3; run them against a dev server, not while the test suites are
running, because contention makes them report empty grids as "no rows".

## Where to read more

| Document | Purpose |
|---|---|
| [`../FEATURES.md`](../FEATURES.md) | Verified capability list, including what is not built |
| [`IMPLEMENTATION_VERIFICATION.md`](IMPLEMENTATION_VERIFICATION.md) | File-by-file evidence for every claim |
| [`SPEC_GAP_ANALYSIS.md`](SPEC_GAP_ANALYSIS.md) | The audit that drove the remediation waves |
| [`../progress/requirements-traceability.md`](../progress/requirements-traceability.md) | Per-requirement ledger with its correction notice |
| [`../progress/pending.md`](../progress/pending.md) · [`../progress/next-actions.md`](../progress/next-actions.md) · [`../progress/blockers.md`](../progress/blockers.md) | What is left, in what order, and what is gated externally |
| [`../docs/user-guides/README.md`](../docs/user-guides/README.md) | Operator manuals |
| [`SYSTEM_IMPROVEMENT_PROPOSALS.md`](SYSTEM_IMPROVEMENT_PROPOSALS.md) | Forward proposals and rationale |
