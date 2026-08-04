# Blockers

Updated: 2026-08-04.

**No engineering work is blocked.** Everything in
[`next-actions.md`](next-actions.md) can be started today.

What follows are **external-evidence gates**: release criteria that cannot be satisfied
by writing code, because they need infrastructure or an independent party. The software
and configuration to make each achievable is shipped. The evidence itself is
outstanding and is **not** fabricated anywhere in this repository.

---

## 1. Carrier-grade live SMPP bind

**Blocked on:** the carrier allow-listing the deployment's public egress IP for SMPP.

**State:** the SMSC lifecycle, the configuration generator and the engine are all
wired. The platform correctly attempts the bind and its own connection test honestly
reports failure (`ECONNREFUSED`). A carrier's SMPP server accepts connections only from
pre-authorised source IPs; ours is not on the list.

**What unblocks it:** give the carrier the public egress IP of the host running the
engine container and ask for SMPP access. Once allowed, the gateway establishes the
bind automatically — it retries every 30 seconds — with no repository change. If the
platform moves host, the new host's egress IP must be allow-listed instead.

**Until then:** submissions are accepted and queued; delivery pends the carrier link.
No committed configuration contains a real SMPP group, so the
create → validate → deploy → **bind** chain remains unproven. It is recorded as
unproven, not as done.

*Carrier host, port, system ID and password are held only in the gitignored `.env` and
are never committed.*

## 2. Independent penetration test

**Blocked on:** engaging an independent party.

**State:** RBAC on every endpoint, forced row-level security, a tamper-evident audit
chain, auth throttling and a spoof-resistant client-IP derivation are all in place and
tested. Known weaknesses a tester will find are already documented rather than hidden:
scrypt instead of Argon2id, plaintext notification-channel secrets, no TLS listener in
the shipped topology, unenforced password-policy settings.

**Sequencing:** worth doing after the security items in
[`next-actions.md`](next-actions.md) §2 land, so the test spends its budget on unknowns.

## 3. Production-scale load and soak

**Blocked on:** representative infrastructure and a seeded multi-million-row dataset.

**State:** `perf/` is a real harness with encoded SLOs and a Grafana dashboard, and it
passes a local baseline. That baseline only proves the paths are healthy on a
near-empty database.

One genuine finding is already surfaced rather than smoothed over: authentication
(~535 ms p95 on this hardware) does not meet the specification's 100 ms target, and the
`spec` SLO profile deliberately fails on it to keep the gap visible.

**Sequencing:** meaningful only after the message read model has real indexes and a
date-range predicate, or it measures an empty database.

## 4. Multi-node HA failover drill

**Blocked on:** real hosts.

**State:** `docker-compose.ha.yml` is real and config-validated — PostgreSQL streaming
replication with a slot, Redis Sentinel at three-node quorum, a rolling-update backend
replica behind an HA proxy. A Sentinel-aware Redis client is wired through both Redis
consumers. It has **never been drilled**, and no RPO/RTO has been measured.

**Sequencing:** meaningful only now that `/health` is a real probe — previously the
health gate the drill depends on was a hardcoded literal.

## 5. Restore-to-production and full-site-loss drills

**Blocked on:** a scheduled maintenance window and a target environment.

**State:** encrypted `pg_dump` backups, retention classes, integrity verification and
restore-into-an-isolated-database all work and are exercised. Restoring to production is
deliberately **not** a console action, so the drill is a runbook exercise. "Offsite" is
currently a filesystem copy, so a full-site-loss drill also depends on pointing
`BACKUP_OFFSITE_DIR` at genuinely remote storage.

---

## Resolved

- **2026-08-04** — the frontend could not be served behind a reverse proxy (Vite's host
  check returned 403 for the public hostname). Resolved with `VITE_ALLOWED_HOSTS`; the
  console now runs on a shared VPS behind a system nginx that terminates TLS.
- **2026-08-04** — port collisions with an unrelated stack co-hosted on the same VPS.
  Resolved by remapping JKANNEL's published ports to loopback only.
- **2026-07-09** — the SQLBox runtime had never worked (the official binary RPM panics
  on any non-MSSQL configuration). Resolved by rebuilding from the official
  checksum-pinned source RPM with only the PostgreSQL dispatcher.
- **2026-07-06** — missing/empty source specifications, an absent telecommunications
  domain model, and Docker Desktop host-port forwarding. All resolved.
