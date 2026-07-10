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
so the proxy is additive. TLS is opt-in — see `nginx/README.md`.

## Profiles

| Profile         | Services                     | Launch |
| --------------- | ---------------------------- | ------ |
| _(none)_        | core stack + `reverse-proxy` | `docker compose up -d` |
| `engine-kamex`  | kamex bearerbox/smsbox/sqlbox| `docker compose --profile engine-kamex up -d` |
| `monitoring`    | prometheus, grafana          | `docker compose --profile monitoring up -d` |
| `observability` | loki, promtail               | `docker compose --profile observability up -d` |
| `watchdog`      | watchdog                     | `docker compose --profile watchdog up -d` |
| `workers`       | scheduler, backup-service    | `docker compose --profile workers up -d` |

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
Enforced CPU/memory limits are deliberately not set on the already-running
services to avoid OOM-killing a healthy stack; they remain a documented tuning
step (spec §17).

## Validation

Non-destructive syntax/merge check (safe to run against a live stack):

```
docker compose config
docker compose --profile engine-kamex --profile monitoring --profile observability --profile watchdog --profile workers config
```
