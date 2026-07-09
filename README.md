# JKANNEL

**A Docker-first web platform for managing and operating SMS gateways.**

JKANNEL is the control room around your SMS infrastructure — not an SMS gateway itself. Operators run SMSC connections, routing, message tracing, delivery reports, configuration, alerts, reporting, users and audit from one web console, with **zero hand-editing of gateway config files**. Every gateway interaction crosses a generic **Engine Adapter**; **Kamex** (a maintained Kannel fork) is the first containerized engine, and upstream **Kannel** is supported as a sibling adapter.

---

## Screenshots

### Sign in
![JKANNEL login](docs/screenshots/login.png)

### Operations dashboard
![JKANNEL operations dashboard](docs/screenshots/dashboard.png)

---

## Highlights

- **Engine Adapter architecture** — one generic contract; Kamex and Kannel are interchangeable adapters, and modules branch on discovered *capabilities*, never on engine names.
- **Live message pipeline** — outbound submission flows through Kamex SQLBox (`send_sms` → bearerbox → SMSC → `sent_sms`) and back into a tenant-scoped message explorer with per-message trace.
- **Enforced multi-tenancy** — PostgreSQL row-level security is *forced* on every table (including the audit log), the API connects as a non-owner role, and a cross-tenant isolation test proves a tenant cannot see or touch another's data.
- **Everything is a grid** — SMSCs, routes, messages, alerts, users, configuration, audit events and reports are all searchable, sortable, filterable, and exportable to **CSV and PDF**.
- **Scheduled reports & notifications** — idempotent daily/weekly message-volume reports (total, per route, per SMSC) delivered in-app and by **email/webhook**.
- **Full audit trail** — every state-changing action and sensitive read is recorded with who / what / when, correlation ID and source IP.
- **Traffic anomaly detection** — statistical volume-drop/spike and delivery-failure detection that opens alerts automatically.
- **AI Ops Copilot** — a read-only, permission-scoped, opt-in, audit-logged assistant that answers operational questions from data you're allowed to see (local by default; Claude API optional). It never returns message contents or recipient numbers and cannot execute changes.
- **Identity workflows** — password reset, invitation acceptance, and session administration.
- **Observability** — backend Prometheus metrics and an optional Prometheus/Grafana monitoring profile.

## Tech stack

NestJS/TypeScript backend · Vue 3 + Vite frontend · PostgreSQL (system of record) · Redis · Docker Compose · Kamex/Kannel via a generic Engine Adapter.

## Quick start

```bash
cp .env.example .env        # fill in development-only values
docker compose --profile engine-kamex up -d --build
docker compose exec backend npm run migrate                 # apply all migrations

# create the first operator (choose any password ≥ 12 chars)
DEV_OPERATOR_PASSWORD=change-me-please \
  docker compose exec -e DEV_OPERATOR_PASSWORD backend npm run provision:dev-operator
```

Then open the console:

| Surface | URL |
|---|---|
| **Web console** | http://127.0.0.1:5173 |
| Backend API | http://127.0.0.1:3000/api/v1 |
| Health | http://127.0.0.1:3000/api/v1/health |
| OpenAPI | http://127.0.0.1:3000/api/v1/openapi.json |
| Metrics | http://127.0.0.1:3000/api/v1/metrics |

> **Use `127.0.0.1`, not `localhost`.** On Windows/macOS the browser resolves `localhost` to IPv6 (`::1`) first, but Docker publishes the ports on IPv4 — so `http://localhost:3000` API calls fail with *"Failed to fetch"*. The console's API base is set to `127.0.0.1` for this reason.

Sign in with tenant `default`, username `operator`, and the password you provisioned above.

## Documentation

| Document | Purpose |
|---|---|
| `SUPERVISOR_HANDOVER_SUMMARY.md` | Reviewer-facing overview and test guide |
| `PROJECT_STATE.md` | Current capabilities and gaps |
| `SYSTEM_IMPROVEMENT_PROPOSALS.md` | Forward roadmap and rationale |
| `CHANGELOG.md` | Dated history of changes |
| `docs/` | Full engineering specifications (canonical) |
| `JKANNEL_DOCUMENTATION_CATALOG.md` | Index of all canonical documentation |

## Status

Actively developed. Backend: 30 test suites / 102 tests. Frontend: 40 tests. All 15 database migrations apply cleanly to a fresh database and the full stack (PostgreSQL, Redis, backend, frontend, Kamex bearerbox/smsbox/sqlbox/validator) runs healthy under Docker Compose. Production hardening items (HA/failover, encrypted scheduled backups, penetration testing, carrier-scale soak) are tracked in `SYSTEM_IMPROVEMENT_PROPOSALS.md`.
