# JKANNEL High Availability / DR overlay

This directory + `docker-compose.ha.yml` (repo root) implement the
**High Availability Engineering Specification**
(`docs/specifications/operations/HIGH_AVAILABILITY_ENGINEERING_SPECIFICATION.md`)
as a **runnable, profile-gated configuration overlay**.

Everything here is **additive**. Every HA service is gated behind the `ha`
compose profile and uses **distinct service names, volumes, and host ports**, so
the live single-node stack (`docker compose up -d`) is completely unaffected —
none of these containers start unless you explicitly opt in with `--profile ha`.

> **Honesty note.** This is a software + configuration deliverable. The configs
> below are parse-validated and structured to run on a single Docker host as a
> replication/failover *demonstration*. A true multi-node HA failover drill with
> measured RPO/RTO requires multiple physical/virtual hosts and is **not**
> produced here — see [External evidence outstanding](#external-evidence-outstanding).

---

## Topology

```
                         ┌─────────────────────────────┐
      host :8090  ─────▶ │  reverse-proxy-ha (nginx)   │   round-robin + retry
                         └───────────┬─────────────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                   ▼
             backend (core)                      backend-replica
             (schedulers ON)                     (schedulers OFF, stateless)
                    │                                   │
        ┌───────────┴───────────────┬───────────────────┘
        ▼                           ▼
   Postgres cluster            Redis Sentinel cluster
   ┌────────────────┐          ┌──────────────────────────────┐
   │ postgres-primary│◀───────│ redis-primary  ◀── redis-replica│
   │      │ WAL      │ stream  │      ▲                          │
   │      ▼          │         │   sentinel-1 / -2 / -3 (quorum 2)│
   │ postgres-standby│         └──────────────────────────────┘
   └────────────────┘
```

| Concern | Services | Status |
|---|---|---|
| 1. Postgres streaming replication | `postgres-primary`, `postgres-standby` | **Runnable** (single-host demo) |
| 2. Redis Sentinel | `redis-primary`, `redis-replica`, `redis-sentinel-1/2/3` | **Runnable** (single-host demo) |
| 3. Stateless-API rolling updates | `backend-replica`, `reverse-proxy-ha` | **Runnable** scaffold + documented procedure |
| 4. Distributed locks | (app already uses PG advisory locks + Redis) | **Documented** (no backend change) |

The HA Postgres/Redis clusters are **standalone** — the core `backend` still
points at the single-node `postgres`/`redis` services. This keeps the overlay
non-colliding and safe to bring up next to the running stack. To actually run
the app *against* the HA cluster, see [Cutting the app over](#cutting-the-app-over).

---

## Files

| Path | Purpose |
|---|---|
| `docker-compose.ha.yml` (repo root) | All HA services, gated behind `profiles: ["ha"]` |
| `postgres/primary-init.sh` | One-time init hook: creates the replication role + `pg_hba` entry on the primary |
| `postgres/standby-entrypoint.sh` | Clones the primary via `pg_basebackup -R -C -S` on first boot, then runs as a hot standby |
| `redis/sentinel.conf` | Sentinel config template (monitor `mymaster`, quorum 2) |
| `redis/sentinel-entrypoint.sh` | Copies the template to a writable path (Sentinel rewrites its own config) |
| `nginx/jkannel-ha.conf` | Reverse-proxy config with a **two-server** backend upstream + `proxy_next_upstream` |

New `.env` vars (documented placeholders, **no secrets**): `REPLICATION_USER`,
`REPLICATION_PASSWORD`, `REPLICATION_SLOT`, `PROXY_HA_HTTP_PORT` — see `.env.example`.

---

## Launch

```bash
# Bring the HA overlay up alongside the core stack:
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile ha up -d

# Parse-validate only (non-destructive — no containers touched):
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile ha config
```

Tear down only the HA services (leaves the core stack running):

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile ha down
```

---

## 1. PostgreSQL streaming replication

**How it works.** `postgres-primary` starts with `wal_level=replica`,
`max_wal_senders`, `max_replication_slots`, `hot_standby=on`, and
`wal_log_hints=on` (needed for `pg_rewind`). Its init hook creates a dedicated
`REPLICATION` login role and appends a `pg_hba.conf` line authorizing
replication for that role (scram-sha-256) over the private `datanet`.

`postgres-standby` runs a wrapper entrypoint that, on first boot only, waits for
the primary, then `pg_basebackup --write-recovery-conf --create-slot
--slot=standby_slot --wal-method=stream`. `-R` writes `standby.signal` +
`primary_conninfo`, so the node comes up as a streaming hot standby serving
read-only queries. A **physical replication slot** on the primary guarantees the
primary retains WAL the standby still needs.

**Verify replication (once up):**

```bash
# On the primary: the standby should appear as a walsender in streaming state.
docker compose -f docker-compose.yml -f docker-compose.ha.yml exec postgres-primary \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication;"

# On the standby: recovery is true while it is a standby.
docker compose -f docker-compose.yml -f docker-compose.ha.yml exec postgres-standby \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_is_in_recovery();"
```

### Failover / promotion runbook (Postgres)

1. **Confirm the primary is down** (health, `pg_stat_replication`, alerts).
2. **Promote the standby** to a read/write primary:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ha.yml exec postgres-standby \
     pg_ctl promote -D /var/lib/postgresql/data
   # or: SELECT pg_promote();
   ```
   `pg_is_in_recovery()` flips to `false`; the node now accepts writes.
3. **Repoint writers** at the promoted node (update `DATABASE_URL` host to
   `postgres-standby`, or swap DNS/service alias) and restart the API tier.
4. **Rebuild the old primary as a new standby** once recovered: either
   `pg_rewind` (works because `wal_log_hints=on`) against the new primary, or
   wipe its volume and let `standby-entrypoint.sh` re-clone. Point
   `PRIMARY_HOST` at the promoted node.
5. **Record the event** (failover count, recovery time) per the observability
   spec §19.

> Automatic Postgres failover (Patroni / repmgr) is listed as **Future** in the
> HA spec §8 and is intentionally not wired here — promotion is a documented
> manual runbook.

---

## 2. Redis Sentinel

**How it works.** `redis-primary` is the master; `redis-replica` starts with
`--replicaof redis-primary 6379`. Three sentinels monitor `mymaster` with a
**quorum of 2** (2-of-3 tolerates the loss of one sentinel and can still
authorize a failover). `resolve-hostnames`/`announce-hostnames` are on so
Sentinel gossips Docker service names rather than ephemeral container IPs. Each
sentinel copies its config to a per-container tmpfs because Sentinel **rewrites**
its own config file at runtime.

**Verify (once up):**

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml exec redis-sentinel-1 \
  redis-cli -p 26379 sentinel master mymaster

docker compose -f docker-compose.yml -f docker-compose.ha.yml exec redis-sentinel-1 \
  redis-cli -p 26379 sentinel replicas mymaster
```

### Failover runbook (Redis)

Failover is **automatic**: if the master is unreachable for
`down-after-milliseconds` (5s) and a quorum (2) of sentinels agrees, Sentinel
elects a leader, promotes the replica, and reconfigures the other replicas.

- Observe an in-progress/last failover:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.ha.yml exec redis-sentinel-1 \
    redis-cli -p 26379 sentinel master mymaster | grep -A1 -E 'flags|num-slaves|role-reported'
  ```
- Force a failover for a drill:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.ha.yml exec redis-sentinel-1 \
    redis-cli -p 26379 sentinel failover mymaster
  ```
- After a failover the old master, when it returns, is reconfigured as a replica
  of the new master automatically.

**Client note.** For an app to follow Sentinel failover automatically its Redis
client must be **Sentinel-aware** (query sentinels for the current master). The
JKANNEL backend currently connects to a single `REDIS_URL` host
(`backend/src/api-gateway/redis.provider.ts`) and **fails open** on Redis loss
(rate limiting degrades to allow-all rather than erroring). Making the client
Sentinel-aware (ioredis supports `{ sentinels: [...], name: 'mymaster' }`) is a
backend-code change (`redis.provider.ts`) and is **out of scope** for this
infra-only deliverable — noted as a follow-up. Until then, the Sentinel cluster
is a runnable demonstration; app cutover uses a fixed master endpoint.

---

## 3. Stateless-API rolling updates

**Why replicas are safe.** The API is stateless: identity is a signed JWT
(no server-side session), and *all* shared state lives in Postgres and Redis.
Any number of `backend` replicas can serve traffic concurrently.

**The one non-stateless part — in-process schedulers.** The report scheduler and
backup scheduler run *inside* the backend by default. If two replicas both ran
them, jobs could double-run. Mitigations already in the codebase:

- **Backup scheduler** holds a PostgreSQL **advisory lock**
  (`ADVISORY_LOCK_KEY = 7_244_118` in `backend/src/backup-dr/backup-dr.scheduler.ts`),
  so only one replica ever executes a cycle — safe across replicas.
- **Report scheduler** has only an *in-process* guard, so the honest rule
  (already documented in `.env.example` and the Wave-4 `workers` profile) is:
  **run the schedulers on exactly one node.** In this overlay `backend-replica`
  sets `REPORT_JOBS_ENABLED=false` and `BACKUP_SCHEDULER_ENABLED=false`; the
  core `backend` remains the single scheduler owner. (Alternatively, disable both
  on every `backend` and run the dedicated `scheduler`/`backup-service`
  containers from the `workers` profile.)

**Scaffold.** `backend-replica` is a second, port-less API node; `reverse-proxy-ha`
(host `:8090`) round-robins across `backend` + `backend-replica` with
`proxy_next_upstream` + `max_fails`/`fail_timeout`, so a node restarting
mid-request is retried against the healthy one.

### Rolling-update procedure

Send client traffic through the HA proxy (`http://localhost:8090`), then restart
nodes **one at a time**, waiting for health between steps:

```bash
BASE="-f docker-compose.yml -f docker-compose.ha.yml"

# 1. Rebuild the new image.
docker compose $BASE --profile ha build backend backend-replica

# 2. Recreate the REPLICA first (proxy keeps serving from the core backend).
docker compose $BASE --profile ha up -d --no-deps backend-replica
#    Wait until healthy:
docker inspect --format '{{.State.Health.Status}}' $(docker compose $BASE ps -q backend-replica)

# 3. Then recreate the core backend (proxy serves from the now-updated replica).
docker compose $BASE --profile ha up -d --no-deps backend
docker inspect --format '{{.State.Health.Status}}' $(docker compose $BASE ps -q backend)
```

`proxy_next_upstream` + per-server `max_fails`/`fail_timeout` eject a draining
node so in-flight requests retry against its peer — no dropped client requests
while one node cycles. Roll back by redeploying the previous image tag the same
way. This mirrors HA spec §15 (upgrade one instance at a time, verify health,
continue only if healthy).

> Note: the core `backend` publishes host port 3000 and is `depends_on` by
> `frontend`/`reverse-proxy`. During its restart the **direct** :3000 path blips;
> the **HA proxy** :8090 does not (it fails over to the replica). Route rolling
> traffic through :8090.

---

## 4. Distributed locks

Multi-replica correctness rests on locks held in **shared backing stores**, so
they are cluster-wide regardless of how many API replicas run:

- **PostgreSQL advisory locks** (the primary is the single source of truth):
  - `backend/src/backup-dr/backup-dr.scheduler.ts` — session lock `7_244_118`
    gates each backup/retention cycle to one replica.
  - `backend/src/database/migration-runner.ts` — lock `7_244_101` serializes
    migrations so concurrent boots never race the schema.
  - `backend/src/data-model/retention.scheduler.ts` — per-tenant **transaction**
    advisory lock so retention never double-runs per tenant.
  - `backend/src/reporting-depth/report-schedule.service.ts` — advisory-locked
    schedule dispatch.
- **Redis** for cross-replica **rate limiting**:
  `backend/src/api-gateway/gateway-rate-limiter.ts` uses an atomic single-`EVAL`
  fixed-window counter (INCR + conditional EXPIRE + TTL), so the limit is shared
  across all replicas hitting the same Redis. It **fails open** on Redis loss.

**Locking approach for multi-replica correctness:** keep using PostgreSQL
advisory locks for *mutually-exclusive background work* (backup, restore,
retention, config/route deploy, engine reload — HA spec §17) — they are already
correct across replicas because they live in the shared primary DB. Use Redis
for *high-frequency counters/coordination* (rate limiting) where fail-open is
acceptable. Under Sentinel, advisory-lock correctness is unaffected (still the
Postgres primary); only the Redis path needs the Sentinel-aware client noted in
§2 to keep pointing at the current master after a failover.

No backend code was changed for this deliverable; the above is the existing,
verified behavior plus the operational guidance to run it safely at 2+ replicas.

---

## Cutting the app over

To run the app *against* the HA clusters instead of the single-node services
(a deliberate, separate action — not the default):

1. Point `DATABASE_URL` / `DATABASE_APP_URL` / `AUTH_DATABASE_URL` at
   `postgres-primary` (and update to `postgres-standby` after a promotion).
2. Point `REDIS_URL` at `redis-primary` — or, for automatic Sentinel failover,
   after the `redis.provider.ts` change in §2, configure the sentinel list.
3. Restart the API tier.

This is documented rather than defaulted so the overlay stays non-colliding with
the running stack.

---

## External evidence outstanding

The following acceptance items from the HA spec (§20, §22) require a
**multi-host environment** and real fault injection, and are **NOT** produced by
this config-only deliverable. They are listed honestly as outstanding:

- **Real multi-node failover drill.** Killing the Postgres primary / Redis master
  host (not just a container on one box) and observing automatic recovery on a
  separate node.
- **Measured RPO/RTO.** The spec targets RTO < 5 min and RPO < 1 min. These must
  be *measured* under a controlled outage on real hardware/VMs; the numbers are
  not fabricated here.
- **Sustained replication-lag / sync-state evidence** under production-like write
  load, and **backup restore verification** on the standby.
- **Sentinel-aware backend client** (`redis.provider.ts`) so the app follows a
  Redis master failover automatically — a backend-code change outside this
  infra-only scope.

What *is* delivered and validated here: the profile-gated compose topology, the
primary/standby replication configuration + scripts, the Sentinel quorum
configuration, the load-balanced rolling-update scaffold + runbook, and the
distributed-locking guidance — all parse-validated with
`docker compose ... config` (exit 0). Proving live failover and the recovery
objectives is the external-evidence gate above.
