# JKANNEL System Improvement Proposals

Author: Claude (takeover maintainer)
Date: 2026-07-09
Status: Approved for autonomous implementation by project owner (P. Hyeroba).

**Update (2026-07-09, second cycle):** the following originally-[PROPOSED] items are now BUILT, tested, and validated against the live stack: real notification channels (email via SMTP + webhook, wired to both alerts and scheduled reports), backend Prometheus metrics (HTTP counters + latency histogram + event counters), the Ops Copilot (read-only, RBAC-scoped, opt-in, audit-logged, local + optional Claude API), traffic anomaly detection feeding the alert pipeline, and identity workflows (password reset, invitation acceptance, session administration). A live carrier SMPP bind was configured and is blocked only by carrier-side IP allowlisting (see §5). Remaining [PROPOSED] items (SMPP synthetic probe, config drift detection, historical partitioning/archive, backup scheduler, per-module detail pages, saved views, route cost fields, AI config review, alert triage assistant, routing optimization advisor, MFA) stay open for later cycles.

This document records defects found during the takeover review, the corrections applied, and improvement proposals that go beyond the existing specification set. Per the Engineering Constitution, anything that changes architecture will be accompanied by an ADR when implemented.

---

## 1. Defects found in takeover review and their fixes

### 1.1 Tenant isolation was not actually enforced **[BUILDING NOW]**
RLS policies existed but no table used `FORCE ROW LEVEL SECURITY`, and the application connected as the database owner (`jkannel`), which PostgreSQL exempts from RLS. Several repository queries had no explicit `tenant_id` predicate, so in the shipped Compose configuration cross-tenant reads were possible.

**Fix:** migration `009_rls_enforcement` creates a dedicated non-owner login role `jkannel_app`, grants it least-privilege table access, applies `FORCE ROW LEVEL SECURITY` to every tenant-scoped table, and the backend now connects as that role (`DATABASE_APP_URL`, falling back to `DATABASE_URL` with a startup warning). A cross-tenant integration test proves isolation.

### 1.2 Auth signing-key configuration mismatch **[BUILDING NOW]**
`environment.ts` validated `AUTH_ACCESS_TOKEN_KEY`/`AUTH_REFRESH_TOKEN_KEY`, while the auth service and guard read `AUTH_SIGNING_KEY`. Startup could pass validation and then fail at first login; access and refresh tokens also shared one key.

**Fix:** the token service now uses the two validated keys (separate signing keys for access and refresh tokens), `AUTH_SIGNING_KEY` is accepted as a deprecated fallback with a warning, and `.env.example` documents the pair.

### 1.3 SQLBox endpoints leaked data across tenants **[BUILDING NOW]**
Message, DLR and report endpoints query the engine-owned SQLBox tables, which have no tenant column, so any user with `messages.view` saw all traffic.

**Fix:** SQLBox reads are now scoped through the tenant's own SMSC definitions — the console resolves the SMSC identifiers owned by the caller's tenant and filters `sent_sms`/`send_sms` by them. A tenant with no SMSC definitions sees an honest empty state, not other tenants' traffic.

### 1.4 No migration runner **[BUILDING NOW]**
Migrations were applied manually; `schema_migrations` existed but nothing wrote to it.

**Fix:** a deterministic Node migration runner (`backend/src/database/migration-runner.ts`, exposed as `npm run migrate`) applies `database/migrations/*.up.sql` in order inside transactions, records each in `schema_migrations`, and supports `--down <version>` rollback. The backend container invokes it on boot before listening (configurable via `MIGRATIONS_ON_BOOT`).

### 1.5 Minified, unmaintainable source style **[BUILDING NOW]**
Large parts of the backend and frontend were single-line "minified" TypeScript/Vue produced by the previous workflow.

**Fix:** Prettier configuration added to both packages; entire source tree reformatted; formatting enforced via `npm run format:check` so it cannot regress. New code is written in conventional, readable NestJS/Vue style with meaningful names.

### 1.6 Cosmetic dashboard **[BUILDING NOW]**
The Operations Overview showed hardcoded zeros and "Healthy" labels. It now consumes real endpoints (message volume from SQLBox, engine health from the adapter, platform health from `/health`) and renders honest "unavailable" states when a source is not configured — per the project's honesty discipline.

### 1.7 Remaining hygiene items **[PROPOSED — low risk, mechanical]**
- Digest-pin `postgres`, `redis`, `prometheus`, `grafana` images the way Kamex images are pinned.
- Collapse root-level duplicate specs into `docs/` (the catalog already declares `docs/` canonical); the root copies of the Kannel adapter spec and the Plugin SDK are stale and misleading.
- Merge the two ALERTS spec halves into one file and restore §1–9 to `docs/operations/`.
- Prune the ~200-byte stub specs that coexist with full versions.
- Author the missing SMSC Manager parts 07–09 before building the SMSC API beyond current scope.

---

## 2. Features being added this cycle (owner-requested)

### 2.1 Scheduled volume reports with notifications **[BUILDING NOW]**
A `report-jobs` module computes, per tenant:
- daily messages sent (previous UTC day) — total and per route/SMSC,
- weekly messages sent (previous ISO week) — total and per route/SMSC.

Snapshots are persisted (immutable rows with a `job_run` audit trail), and a notification is generated for every user holding a new `reports.subscribe` permission (admins by default). Delivery channels: in-app notification centre now; SMTP email when `SMTP_URL` is configured (honest "channel unconfigured" status otherwise). Schedules run inside the backend via an interval scheduler guarded by a PostgreSQL advisory lock so multiple replicas never double-send.

### 2.2 Uniform grid capabilities **[BUILDING NOW]**
Every list endpoint (messages, DLRs, SMSCs, routes, alerts, users, audit events, configuration versions) accepts `search`, `sort` (`-field` descending), and typed `filter.<field>` parameters with validated whitelists per resource; responses carry pagination metadata per the REST standard. The frontend workspace gains a shared grid toolbar: text search, per-column sort toggles, filter chips, and export buttons.

### 2.3 CSV and PDF export everywhere **[BUILDING NOW]**
The existing bounded CSV export generalizes to all grids. PDF export is server-side (pdfkit), bounded to the same export limits, carries report header/footer (tenant, requester, timestamp, filters applied) and is audit-logged like every other export.

### 2.4 Full audit coverage **[BUILDING NOW]**
A global audit interceptor records every authenticated mutating request (and sensitive reads: exports, message traces) into the immutable `audit_log` partition set with actor, tenant, action, resource, outcome, correlation id and redacted parameters. Login/logout/refresh/lockout were already audited; the interceptor closes the gap for everything else, and an `audit.view`-guarded query API + UI grid (searchable/sortable/filterable/exportable like all grids) answers "who did what, when".

---

## 3. Proposals beyond the current specification

### 3.1 Platform and operations
1. **Real notification channels** — Slack/Telegram/webhook channel adapters behind the existing notification-delivery boundary; alert escalation chains (spec §ALERTS 10–25 already describe them; the runtime lacks them). **[PROPOSED]**
2. **Prometheus metrics from the backend itself** (`/metrics` in Prometheus text format: request latency histograms, queue depth gauge, report job durations) so the shipped Grafana profile shows platform health, not just Kamex. **[PROPOSED — small]**
3. **SMPP synthetic probe** — a tiny containerized SMPP client that periodically submits a canary message through a fake/loopback route and asserts DLR round-trip, giving true end-to-end health rather than process-up health. **[PROPOSED]**
4. **Config drift detection** — hash the live rendered config on the engine volume and compare to the active configuration version; surface drift as an alert (spec hints at this; nothing implements it). **[PROPOSED]**
5. **Historical partitioning/archive jobs** for SQLBox reads and audit (spec requirement, still open). **[PROPOSED]**
6. **Backup scheduler** — the smoke script exists; wire an actual scheduled encrypted pg_dump with retention and a restore-verification job (Backup/DR spec RTO/RPO targets). **[PROPOSED]**

### 3.2 Product / UX
7. **Per-module detail pages** — the generic workspace is efficient but SMSC and Route detail views (status timeline, last deployment, live queue depth) would materially improve operator workflow. **[PROPOSED]**
8. **Saved views** — persist a user's grid filters/sorts as named views (trivial once 2.2 lands). **[PROPOSED — small]**
9. **Notification centre UI** with read/unread, per-category mute, and delivery-channel preferences per user. **[BUILDING NOW — minimal version as part of 2.1]**
10. **Route cost & margin fields** — the routing spec's cost-optimized strategy needs per-route cost data; adding cost columns now unblocks both the strategy and profitability reporting later. **[PROPOSED]**

### 3.3 AI integration (beyond the current AI Operations spec)
The current foundation is deliberately local and rules-based. To make JKANNEL genuinely AI-driven while honouring its consent/approval/audit constitution:

11. **Ops Copilot (natural-language operations)** — a chat surface in the console backed by the Claude API with tool-use over a *read-only, permission-scoped* toolset: query messages/DLRs, capability manifests, audit log, alert history. Every tool call runs under the caller's RBAC and is audit-logged; the model never receives unredacted MSISDNs (existing privacy redactor applies). Answers cite the queried data. **[PROPOSED — flagship]**
12. **Anomaly detection on traffic baselines** — learn per-route/per-SMSC hourly volume and DLR-success baselines (simple seasonal statistics first, model-based later); raise alerts on deviations (traffic drop, DLR failure spike, latency drift). This feeds the existing alert pipeline, so escalation/ack flows apply. **[PROPOSED]**
13. **AI-assisted config review** — before deployment, send the *redacted* config diff to the model for a risk annotation ("this removes the DLR route for SMSC X") attached to the approval screen. Human approval remains mandatory (constitution ch.65–66). **[PROPOSED]**
14. **Alert triage and dedup assistant** — cluster related alert instances, draft an incident summary with probable cause ranked by capability evidence, and propose (never execute) remediation actions mapped to existing adapter operations. **[PROPOSED]**
15. **Routing optimization advisor** — periodic analysis of delivery rate/latency/cost per route with suggested priority/failover changes, delivered as a reviewable change-set that flows through the normal route validation/simulation/deploy pipeline. **[PROPOSED]**
16. **Natural-language report builder** — "weekly Nigeria traffic by SMSC as PDF" → structured report definition executed by the reporting engine (the report jobs of 2.1 provide the execution substrate). **[PROPOSED]**

All AI features stay behind the existing opt-in deployment flag, per-request consent header, redaction layer, and human-approval records; external provider calls (Claude API) additionally require an explicit `AI_PROVIDER=anthropic` + key configuration so the default deployment remains fully local.

### 3.4 Security roadmap
17. Password reset + invitation acceptance flows (spec'd, unbuilt). **[PROPOSED]**
18. TOTP MFA (spec mandates; enforceable per role). **[PROPOSED]**
19. Session administration UI (list/revoke active sessions). **[PROPOSED]**
20. Argon2id migration path (spec says Argon2id, code uses scrypt — scrypt is acceptable; if compliance requires Argon2id, add `argon2` with hash-upgrade-on-login). **[PROPOSED — decision needed]**
21. Refresh-token family revocation (detect replay of a rotated token and revoke the whole session family). **[PROPOSED — small]**

---

## 4. Suggested sequencing after this cycle

1. Backend Prometheus metrics + notification channels (completes the monitoring story).
2. Ops Copilot read-only MVP (11) — highest visible value, lowest blast radius of the AI items.
3. Anomaly detection (12) feeding existing alerts.
4. Identity workflows (17–19).
5. Partitioning/archive + backup scheduler (5–6) before any production traffic.
