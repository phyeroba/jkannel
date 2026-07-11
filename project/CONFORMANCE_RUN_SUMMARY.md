# JKANNEL — Spec-Conformance Run Summary (2026-07-10 → 2026-07-11)

This document summarizes everything added in the autonomous spec-conformance run,
from the Cycle-4 baseline (`1d31ff7`) through `87a1b0a`. It embeds the end-of-run
summary at the bottom.

**Scope of the run:** 5 spec-conformance waves + 1 polish wave.
**Change footprint:** 183 files changed, +18,046 / −487 (`git diff 1d31ff7..HEAD`).
**Schema:** advanced from migration 015 → **028**.
**Tests:** backend **71 suites / 396 tests** green; **36/36** Playwright e2e green.
**Repo:** all work pushed to `github.com/phyeroba/jkannel` (`main`).

## Commits added this run (newest first)

| Commit | Summary |
|---|---|
| `87a1b0a` | docs: mark idempotency failure-state + Sentinel-aware Redis complete in traceability |
| `fa39cc6` | Wave 6 (polish): idempotency failure-state recovery + Sentinel-aware Redis client |
| `e79147b` | Wave 5: HA/DR, performance harness, e2e acceptance + auth lockout fix |
| `448fcab` | Wave 4: REST/OpenAPI depth, data-model completeness, Docker topology |
| `316710d` | Wave 2 frontend: report kinds, saved reports, config templates/drift, message ops, bulk send |
| `6e54232` | Wave 3: API gateway, routing depth, customers depth |
| `c46fd96` | Wave 2: reporting, configuration, messaging depth + license |

## What was added, by area

### Licensing
- `LICENSE.md` (MIT, © 2025–2026 Peter Hyeroba <peterhyeroba@gmail.com>) and
  `LICENSE.kannel` (Kannel Software License 1.0), with Kannel + Kamex attribution.

### Backend modules (new)
- **reporting-depth** (migration 021): per-SMSC success/failure, per-route
  performance, hourly heatmap, latency/SLA percentiles; saved report definitions;
  scheduled CSV/summary export delivery.
- **configuration-depth** (022): reusable config templates with seeded built-ins,
  per-engine rendering hook, drift detection vs the live engine config with audit.
- **messaging-depth** (023): message replay / clone / requeue; bulk-send / campaign
  jobs with a background processor.
- **api-gateway** (024): Redis atomic per-key rate limiting (429 + Retry-After,
  fail-open), per-key IP/CIDR allowlist (403), key expiry, gateway request audit log.
- **routing-depth** (025): prefix/country/operator/weighted route types;
  least-cost / load-balance / round-robin / time-based selection over a pure,
  unit-tested `selectRoute()`; `route_targets`, `route_versions`, `/routing/resolve`
  preview endpoint.
- **customers-depth** (026): per-customer quotas with usage counters, prepaid credit
  ledger, sender-ID approval workflow, per-customer route/SMSC bindings.
- **data-model** (027, +028 fix): soft-delete (`deleted_at`) + optimistic-lock
  (`version`) conventions + helpers; DB-enforced tamper-evident audit hash-chain +
  verifier; cold-storage archive tables + batched advisory-locked retention
  scheduler.

### Platform / REST
- OpenAPI 3.1 **auto-derived from the live route table** (DiscoveryService
  reflection) — every module appears automatically.
- Opt-in **keyset/cursor pagination** and **`?fields=` projection** in the shared
  list helper.
- **Idempotency hardening**: failure-state release on handler error + stale-
  `processing` reclaim, so a crashed request no longer blocks retries.
- **Sentinel-aware Redis client** (`REDIS_SENTINELS`/`REDIS_MASTER_NAME`, single-host
  fallback) wired through both Redis consumers.

### Frontend (Vue)
- Reports view: new report-kind panels (smsc-success, route-performance, hourly
  heatmap, latency SLA) + saved report definitions (grid, create, runs).
- Configuration view: templates panel + drift panel.
- Message trace drawer: replay / clone / requeue actions.
- New **Bulk Send** view + route + nav entry.

### Infrastructure / Docker
- Full topology: **nginx reverse proxy** (single entrypoint on `:8080`), optional
  **loki+promtail** observability profile, **watchdog**, split-out
  **scheduler/backup-service** workers, isolated **edge/appnet/datanet/obsnet**
  networks, and hardening (non-root, read-only rootfs, cap_drop, no-new-privileges)
  on stateless services.
- **HA overlay** (`docker-compose.ha.yml` + `infrastructure/ha/`): Postgres
  streaming replication + slot, Redis Sentinel (3-quorum), rolling-update backend
  replica behind an HA proxy — profile-gated and config-validated.

### Testing
- **`perf/`**: self-contained Node + k6 load/soak harness with encoded SLOs, a
  Grafana dashboard, and a passing local baseline.
- **`e2e/`**: Playwright acceptance suite (36/36 green) across auth, navigation,
  SMSC, routing, messages, reports, bulk-send, configuration, audit/notifications.

## Real defects found via live integration and fixed
1. **Login 500 on the new topology** — audit hash-chain trigger needed
   `SECURITY DEFINER` (the least-privilege auth role lacked SELECT on `audit_log`).
   Fixed in migration 028.
2. **Auth lockout re-extension** — a locked account (even with the correct password)
   perpetually renewed its own 15-minute lockout. Fixed + regression test (found by
   the e2e suite).
3. **Idempotency keys stuck forever** — a crashed request left its key blocking all
   retries. Now released on error + stale reclaim.
4. Retention query type-cast bug and an nginx header-inheritance 403 on the proxy.

## Honestly outstanding (documented, not fabricated)
See `progress/requirements-traceability.md` for the per-domain ledger.
- **External-evidence gates**: independent penetration test; production-scale soak
  at headline targets (100k msg/s); multi-node failover drill with measured
  RPO/RTO; carrier live-send (blocked only by carrier-side IP allow-listing).
- **Deferred pending design/user input**: wiring customer quota/credit enforcement
  into the send path (bulk-send has no `customer_id` association yet); per-role MFA
  *forcing*; WebAuthn; client-SDK generation; worker-backed async jobs.

## Operational note
The dev operator password drifted during automated smoke/perf runs; it is currently
`local-dev-operator-2026` (tenant `default`, user `operator`). Recreate the stack on
the new topology with `docker compose --profile engine-kamex up -d`.

---

## Appendix — end-of-run summary (as delivered)

All five spec-conformance waves **plus** a polish wave are built, tested,
live-verified, and pushed. The stack is running healthy on the new topology; working
tree clean.

**Verified:** backend 71 suites / 396 tests green; typecheck clean; e2e 36/36
against the live SPA; perf smoke passing; all 9 services healthy on isolated
networks; reverse proxy serving `/api` + `/`; schema at migration 028; endpoints
live-smoke-verified.

I stopped before the deferred items because they involve schema/UX design choices
better confirmed than guessed at. Everything done is reversible and independently
committed — ready to pick up the deferred list on request.
