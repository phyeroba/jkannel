# JKANNEL — Supervisor Handover Summary

**Prepared:** 2026-07-09
**Author:** Claude (engineering, post-handover from the previous ChatGPT/Codex workflow)
**Audience:** Project supervisor (for review and hands-on testing)

---

## 1. What JKANNEL is

JKANNEL is a **Docker-first web platform for managing and operating SMS gateways** — not an SMS gateway itself. Operators run their SMSC connections, routing, message tracing, delivery reports, configuration, alerts, reporting, users and audit from a single web console, with **zero hand-editing of gateway config files**. Every gateway interaction crosses a generic **Engine Adapter**; **Kamex 1.8.3** (a maintained Kannel fork) is the first containerized engine, and upstream Kannel is supported as a sibling adapter.

**Stack:** NestJS/TypeScript backend, Vue 3/Vite frontend, PostgreSQL (system of record), Redis, Docker Compose. Messages flow through Kamex **SQLBox** (PostgreSQL `send_sms`/`sent_sms` tables).

---

## 2. How to run and test it

From the project root (`d:\JKANNEL`) with Docker running:

```bash
cp .env.example .env      # then set real values, or use the existing dev .env
docker compose --profile engine-kamex up -d --build
docker compose exec backend npm run migrate            # applies all DB migrations
DEV_OPERATOR_PASSWORD=<choose-one> docker compose exec -e DEV_OPERATOR_PASSWORD backend npm run provision:dev-operator
```

### Access URLs (local)

| Surface | URL |
|---|---|
| **Web console** | http://localhost:5173 |
| Backend API (versioned) | http://localhost:3000/api/v1 |
| Health check | http://localhost:3000/api/v1/health |
| OpenAPI document | http://localhost:3000/api/v1/openapi.json |
| Prometheus metrics | http://localhost:3000/api/v1/metrics |
| Prometheus (with `--profile monitoring`) | http://localhost:9090 |
| Grafana (with `--profile monitoring`) | http://localhost:3001 |

### Login (development operator)

| Field | Value |
|---|---|
| Tenant | `default` |
| Username | `operator` |
| Password | the `DEV_OPERATOR_PASSWORD` you set when provisioning |

> The development operator holds all 20 permissions (full console access). Additional users can be created through **Users → Invitations** and the self-service **Accept Invitation** page. Passwords can be reset from the **Forgot password?** link on the login screen.

---

## 3. What you can test in the console

- **Dashboard** — live queue depth, engine identity/health, recent daily volume and recent alerts (honest "unavailable/unknown" when a source can't be observed — nothing is faked).
- **SMSCs** — create/manage gateway connections (SMPP, HTTP, fake, AT); test-connection, enable/disable/reconnect; searchable/sortable/filterable grid with CSV/PDF export.
- **Routing** — priority/prefix/sender routes with validation, conflict checks, a simulator, and deploy/rollback history.
- **Messages** — tenant-scoped message explorer over SQLBox with search/filter, per-message trace, and CSV/PDF export; a send composer (requires selecting one of your SMSCs).
- **Reports** — scheduled **daily and weekly message-volume reports** (total, per route, per SMSC) with CSV/PDF export and a "Generate now" action.
- **Alerts** — alert rules, instances (including auto-generated **traffic-anomaly** alerts), acknowledgement, and notification channels (email/webhook).
- **Notifications** — in-app notification centre (bell) with unread count and mark-read.
- **AI Ops Copilot** — ask plain-language operational questions ("any open alerts?", "how's traffic today?"); read-only, permission-scoped, and advisory only.
- **Logs / Audit** — full "who did what, when" audit trail, searchable/filterable/exportable.
- **Users / Sessions** — user list, invitations, and active-session administration (view/revoke).

Every grid in the console is **searchable, sortable, filterable, and exportable to CSV and PDF**, and every state-changing action is **audit-logged**.

---

## 4. Work completed in this engineering cycle (2026-07-09)

### Security and correctness fixes (from the takeover review)
- **Tenant isolation enforced for real** — forced row-level security on every table (including the audit log), a dedicated non-owner application database role, and a least-privilege role for pre-login lookups; proven with a live cross-tenant test (a tenant cannot see or write another tenant's data).
- **Authentication key handling fixed** — separate signing keys for access and refresh tokens.
- **Message-visibility leak closed** — message/DLR/queue/export reads are restricted to the tenant's own SMSCs.
- **Deterministic database migrations** — a migration runner applies the full schema on boot; all 15 migrations verified against a fresh database.
- **Codebase de-minified** — the previous single-line generated code was reformatted to a readable, maintainable standard, enforced automatically.

### New capabilities delivered
- **Full audit trail** across all state-changing actions and sensitive reads.
- **Uniform searchable/sortable/filterable grids with CSV + PDF export** on every list.
- **Scheduled daily/weekly volume reports** (total, per route, per SMSC) with notifications.
- **Notification delivery** by **email (SMTP)** and **webhook**, for both alerts and reports.
- **Backend Prometheus metrics** for the Grafana monitoring profile.
- **Traffic anomaly detection** (volume drops/spikes, delivery-confirmation failures) that raises alerts automatically.
- **AI Ops Copilot** — a read-only, permission-scoped, opt-in, audit-logged assistant. It answers only from data the user is allowed to see, never returns phone numbers or message contents, and cannot execute changes. It runs locally by default and can use the Claude API when explicitly configured.
- **Identity workflows** — password reset, invitation acceptance, and session administration.
- **A working SQLBox message pipeline** — the delivery box had a defect in the upstream build that prevented PostgreSQL operation; it was rebuilt from the official signed source so the end-to-end message path works.

### Verification performed
- Backend: **30 test suites / 102 tests** green; TypeScript and formatting clean.
- **Live end-to-end proof:** a message submitted via the API travelled queue → gateway → sent, and appeared in the console; volume reports, notifications, exports, audit trail, session admin, password reset, invitation acceptance, and the AI Copilot were all exercised against the running system.
- All eight containers report healthy.

---

## 5. Carrier-grade SMPP test — current status (action needed)

A **live carrier SMPP bind** was configured as a managed SMSC and is fully wired. The specific carrier host, port, system ID and password are held privately (in the deployment's gitignored `.env`) and are **not published in this repository**; they are shared with the reviewer separately.

The platform **correctly attempts the bind** and its own connection test **honestly reports failure** (`Connection refused`). The cause is **carrier-side IP allowlisting**: the carrier's SMPP server only accepts connections from pre-authorized source IPs, and our deployment's egress IP is not yet on that list.

> **Action required (carrier side):** allowlist the deployment's public egress IP (provided separately) for SMPP access. Once that is done, the gateway establishes the bind automatically (it retries every 30 seconds) and test sends can proceed with no further changes on our side. If the platform will run from a different host in production, allowlist that host's egress IP instead.

Until then, test-message submission is accepted and **queued**; delivery pends the carrier link. A carrier SMSC is added the same way as any other — through the console (**SMSCs → create**, type `smpp`) — so no repository change is needed to point at a carrier.

---

## 6. Honest limitations / not yet done

- **Carrier SMPP delivery** is unproven pending the carrier-side IP allowlist described in section 5.
- **Email delivery** requires an SMTP server (`SMTP_URL`); without it, email channels report "unavailable" rather than pretending to send.
- **Not yet built:** MFA, historical data partitioning/archival, scheduled encrypted backups with restore UI, high-availability/failover, production-scale load/soak evidence, independent penetration testing, and the deeper AI features (predictive analytics, AI config review, alert-triage assistant). These are catalogued in `SYSTEM_IMPROVEMENT_PROPOSALS.md`.
- The AI Copilot is deliberately **read-only and advisory** — it never changes anything.

---

## 7. Where to read more

| Document | Purpose |
|---|---|
| `README.md` | Quick start |
| `PROJECT_STATE.md` | Current capabilities and gaps |
| `SYSTEM_IMPROVEMENT_PROPOSALS.md` | Forward roadmap and rationale |
| `CHANGELOG.md` | Dated history of changes |
| `progress/requirements-traceability.md` | Spec-to-implementation ledger |
| `docs/` | Full engineering specifications (canonical) |
| `progress/session-log.md` | Detailed engineering session log |

---

*Prepared for supervisor review. The system is running and testable now; the only external dependency for the carrier send test is the IP allowlist noted in section 5.*
