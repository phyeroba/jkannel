# JKANNEL infrastructure & Docker topology

This directory holds the deployment-side configuration for the containerized
JKANNEL stack. The canonical runtime definition is the root
`docker-compose.yml`. This file documents the topology, the optional profiles,
and the container-hardening decisions.

## Networks (service isolation)

| Network   | Members                                                             | Purpose |
| --------- | ------------------------------------------------------------------- | ------- |
| `edge`    | reverse-proxy, frontend, backend, watchdog                          | Public entrypoint plane. |
| `appnet`  | backend, kamex-bearerbox/smsbox/sqlbox/validator, scheduler, backup | Application ↔ engine plane. |
| `datanet` | backend, postgres, redis, kamex-sqlbox, scheduler, backup           | Data plane. |
| `obsnet`  | prometheus, grafana, loki, promtail, backend, kamex-bearerbox       | Observability plane (scrape + logs). |

`postgres` and `redis` live **only** on `datanet`; the `reverse-proxy` lives
**only** on `edge`. The two never share a network, so the database is never
reachable from the public entrypoint.

## Entrypoint / routing

`reverse-proxy` (nginx-unprivileged) is a single HTTP entrypoint published on
`${PROXY_HTTP_PORT:-8080}`:

- `/api/` → `backend:3000` (prefix preserved)
- `/` → `frontend:5173` (incl. HMR websocket)
- `/healthz` → nginx liveness

The original direct ports (frontend `5173`, backend `3000`) remain published,
so the proxy is additive.

`reverse-proxy` is **HTTP-only by design**: it is the "TLS terminated upstream"
topology. For JKANNEL to terminate TLS itself, enable the `tls` profile, which
starts the separate `reverse-proxy-tls` service (HTTPS on 8443 + an HTTP→HTTPS
redirect). Both topologies are documented in `nginx/README.md`.

## Profiles

| Profile         | Services                     | Launch |
| --------------- | ---------------------------- | ------ |
| _(none)_        | core stack + `reverse-proxy` | `docker compose up -d` |
| `engine-kamex`  | kamex bearerbox/smsbox/sqlbox| `docker compose --profile engine-kamex up -d` |
| `monitoring`    | prometheus, grafana          | `docker compose --profile monitoring up -d` |
| `observability` | loki, promtail               | `docker compose --profile observability up -d` |
| `watchdog`      | watchdog                     | `docker compose --profile watchdog up -d` |
| `workers`       | scheduler, backup-service    | `docker compose --profile workers up -d` |
| `tls`           | reverse-proxy-tls            | `docker compose --profile tls up -d` |
| `ha`            | HA overlay (separate file)   | `docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile ha up -d` |

Profiles compose, e.g.
`docker compose --profile engine-kamex --profile monitoring --profile observability up -d`.

## Scheduler / backup: split vs in-process

The report and backup schedulers run **in-process inside the backend** by
default (`REPORT_JOBS_ENABLED` / `BACKUP_SCHEDULER_ENABLED`, both default
`true`). The `workers` profile provides dedicated `scheduler` and
`backup-service` containers that reuse the backend image to run those same
schedulers out-of-process.

- The **backup scheduler** holds a PostgreSQL advisory lock, so running it in
  the backend and in `backup-service` simultaneously is safe (only one replica
  executes a cycle).
- The **report scheduler** has only an in-process guard (no cross-process
  lock). To avoid generating reports twice, set `REPORT_JOBS_ENABLED=false` on
  the backend when you enable the `scheduler` worker (see `.env.example`).

This is honest scaffolding: it is fully wired and runnable, but because there
is no scheduler-only entrypoint in the app, each worker container also boots
the (unpublished) API. Splitting is therefore an opt-in operational choice, not
the default.

## Container hardening matrix

| Service         | no-new-privileges | cap_drop ALL | read_only + tmpfs | non-root | Notes |
| --------------- | :---------------: | :----------: | :---------------: | :------: | ----- |
| reverse-proxy   | ✅ | ✅ | ✅ | ✅ (uid 101) | Fully hardened. |
| reverse-proxy-tls | ✅ | ✅ | ✅ | ✅ (uid 101) | Same, plus a read-only cert mount. |
| kamex-validator | ✅ | ✅ | ✅ | image default | Pre-existing full hardening. |
| loki            | ✅ | ✅ | ✅ | ✅ (uid 10001) | Data on volume. |
| promtail        | ✅ | ✅ | ✅ | root* | *root needed to read the Docker socket; as owner it needs no cap. |
| watchdog        | ✅ | ✅ | ✅ | root* | *root needed for the Docker socket. |
| prometheus      | ✅ | ✅ | ➖ | image default | read_only omitted to avoid TSDB write surprises. |
| grafana         | ✅ | ➖ | ➖ | image default | Writes plugins/state to its volume. |
| backend         | ✅ | ➖ | ➖ | root | Writes encrypted backups to a bind mount; kept as-is to protect the live stack. |
| scheduler       | ✅ | ➖ | ➖ | root | Mirrors backend. |
| backup-service  | ✅ | ➖ | ➖ | root | Mirrors backend. |
| postgres        | ✅ | ➖ | ➖ | image manages own user | Entrypoint chowns data dir; forcing caps/read_only risks the live DB. |
| redis           | ✅ | ➖ | ➖ | image drops via gosu | Entrypoint chowns `/data` on start. |
| frontend        | ✅ | ➖ | ➖ | root | Vite dev server writes a `.vite` cache. |
| kamex-*         | ✅ | ➖ | ➖ | root | Upstream image writes spool/logs; not designed for a read-only rootfs. |

`no-new-privileges` is applied to **every** service. Aggressive hardening
(dropped caps + read-only rootfs) is applied to the new stateless services and
anything already proven; for the running stateful/engine services it is
intentionally left off and documented rather than risk breaking the live stack.

## Resource limits

**Every** service in both compose files now carries a memory limit + reservation,
a CPU limit, a `pids_limit` and a `nofile` ulimit. This matters because the
stack is designed to be **co-hosted**: without limits, one runaway container
(a pg_dump of a large database, an SMPP flood, a leaking Node heap) can take the
whole host down, including the unrelated stack sharing it.

### Which compose keys, and why

The deploy-agnostic keys — `mem_limit`, `mem_reservation`, `cpus`, `pids_limit`,
`ulimits` — are used, **not** the swarm-style `deploy.resources.*` block, which
`docker compose up` ignores unless you also pass `--compatibility`. Verified
against the installed Compose (v5.1.4) with
`docker compose --env-file .env.example config`: every one of those keys appears
in the rendered model for every service (memory is normalised to bytes).

### The table (host: ~10 GB RAM, shared with a co-tenant)

| Service | Profile | `mem_limit` | `mem_reservation` | `cpus` | `pids_limit` | `nofile` |
| ------- | ------- | ----------: | ----------------: | -----: | -----------: | -------: |
| postgres          | —              | 1536m | 512m | 1.5  | 512 | 65536 |
| backend           | —              | 1024m | 256m | 1.5  | 512 | 65536 |
| frontend          | —              |  768m | 128m | 1.0  | 512 | 16384 |
| redis             | —              |  512m | 128m | 0.5  | 256 | 16384 |
| reverse-proxy     | —              |  128m |  32m | 0.5  | 256 | 16384 |
| kamex-validator   | —              |  128m |  32m | 0.5  | 128 | 16384 |
| **default total** |                | **4096m** | **1088m** | | | |
| kamex-bearerbox   | engine-kamex   |  512m | 128m | 1.0  | 512 | 65536 |
| kamex-smsbox      | engine-kamex   |  256m |  64m | 0.5  | 256 | 16384 |
| kamex-sqlbox      | engine-kamex   |  256m |  64m | 0.5  | 256 | 16384 |
| scheduler         | workers        |  512m | 128m | 1.0  | 512 | 65536 |
| backup-service    | workers        | 1024m | 128m | 1.0  | 512 | 65536 |
| prometheus        | monitoring     |  768m | 128m | 1.0  | 256 | 16384 |
| grafana           | monitoring     |  512m | 128m | 0.75 | 256 | 16384 |
| loki              | observability  |  512m | 128m | 0.75 | 256 | 16384 |
| promtail          | observability  |  256m |  64m | 0.5  | 256 | 16384 |
| watchdog          | watchdog       |   64m |  16m | 0.25 | 128 |  4096 |
| reverse-proxy-tls | tls            |  128m |  32m | 0.5  | 256 | 16384 |

HA overlay (`docker-compose.ha.yml`, profile `ha`):

| Service | `mem_limit` | `mem_reservation` | `cpus` | `pids_limit` | `nofile` |
| ------- | ----------: | ----------------: | -----: | -----------: | -------: |
| postgres-primary        | 1024m | 256m | 1.0  | 512 | 65536 |
| postgres-standby        | 1024m | 256m | 1.0  | 512 | 65536 |
| backend-replica         | 1024m | 256m | 1.5  | 512 | 65536 |
| redis-primary           |  384m |  96m | 0.5  | 256 | 16384 |
| redis-replica           |  384m |  96m | 0.5  | 256 | 16384 |
| redis-sentinel-1/2/3    |   96m |  32m | 0.25 | 128 | 16384 |
| reverse-proxy-ha        |  128m |  32m | 0.5  | 256 | 16384 |
| **HA total**            | **4256m** | | | | |

### Justification

- **The default stack cannot exceed ~4 GB**, leaving ~6 GB for the co-tenant and
  the host. `engine-kamex` + `workers` — the realistic production shape — takes
  it to ~6.7 GB. Adding `monitoring` **and** `observability` on top would reach
  ~8.7 GB and is not advisable on this host; run those elsewhere, or trim.
- Limits are **ceilings, not allocations**. Idle containers use far less; the
  reservations (1088m for the default stack) are the soft floor the scheduler
  keeps free.
- Numbers are deliberately **generous**. A limit that OOM-kills the backend
  mid-backup is worse than no limit at all — the point is to bound a runaway,
  not to squeeze steady state.
- `postgres` 1536m is the largest because `shared_buffers` plus per-connection
  `work_mem` is the single biggest legitimate consumer, and its OOM is the most
  damaging.
- `backend` / `backup-service` 1024m: `BackupDrService` reads the whole pg_dump
  into a Buffer and encrypts it, so peak RSS is roughly twice the dump size plus
  the Node baseline.
- `redis` 512m is the real backstop because no `maxmemory` is configured.
- `pids_limit` bounds fork-bomb blast radius (postgres forks a backend per
  connection). `nofile` is raised well above Docker's 1024 default — too low for
  a socket-heavy gateway — but is bounded rather than unlimited.
- HA services are sized tighter than their core equivalents on purpose: the
  overlay is a single-host replication/failover *demonstration* and must never
  be able to squeeze the live services. Promote `postgres-primary` to 1536m
  first if you make it the real data path.

## Validation

Non-destructive syntax/merge check (safe to run against a live stack):

```
docker compose --env-file .env.example config
docker compose --env-file .env.example --profile engine-kamex --profile monitoring --profile observability --profile watchdog --profile workers --profile tls config
docker compose -f docker-compose.yml -f docker-compose.ha.yml --env-file .env.example --profile ha config
```
