# Watchdog

Lightweight automatic recovery for containers that are *running but failing
their healthcheck* — the one failure mode Docker's own `restart` policy does
not remediate (restart policies only react to process exit/crash).

`watchdog.sh` polls every `${WATCHDOG_INTERVAL:-30}` seconds, lists containers
labelled `com.docker.compose.project=jkannel`, and `docker restart`s any whose
health status is `unhealthy`. It emits structured JSON to stdout, so its own
actions are collected by Promtail/Loki alongside every other container log.

## Start

```powershell
docker compose --profile watchdog up -d watchdog
```

## Scope & safety

- Only touches containers in the `jkannel` project — never unrelated
  containers on the host.
- Mounts the Docker socket read-only. Runs with a read-only rootfs, tmpfs
  `HOME`, and all Linux capabilities dropped.
- It is a *complement* to, not a replacement for, the `restart: unless-stopped`
  policy and per-service healthchecks already defined on every service.

## Relationship to the Alerts module

Per the deployment spec the watchdog should also notify the Alerts module on
repeated failures. That escalation path is currently **not wired** here — the
watchdog logs and restarts only. Alert emission would require a backend
endpoint/queue contract (owned by the backend), so it is intentionally left as
a documented extension point rather than a half-built integration.
