# Centralized logging (Loki + Promtail)

The `observability` Docker Compose profile adds log aggregation:

- **Loki** (`loki-config.yml`) — single-binary, filesystem-backed log store,
  7-day retention. Runs read-only as uid 10001 with all caps dropped.
- **Promtail** (`../promtail/promtail-config.yml`) — discovers containers in
  the `jkannel` compose project via the Docker socket and ships their
  stdout/stderr to Loki, labelled by `service`, `container`, and `project`.

## Start

```powershell
docker compose --profile observability up -d loki promtail
```

Loki is exposed on `${LOKI_PORT:-3100}`.

## View logs

Run both the `monitoring` and `observability` profiles, then open Grafana
(`${GRAFANA_PORT:-3001}`). The **JKANNEL Loki** datasource is auto-provisioned;
use Explore and a query like:

```
{project="jkannel"}
{service="backend"} |= "error"
```

Or query Loki directly:

```
curl -s "http://localhost:3100/loki/api/v1/query_range?query={project=\"jkannel\"}"
```

## Notes

- Promtail runs as root because it reads the Docker socket for service
  discovery; as the socket's owner it needs no extra Linux capability, so caps
  are still dropped and the rootfs is read-only.
- Positions are persisted to the `promtail-data` volume so restarts do not
  re-ingest old log lines.
- This profile is optional; the core stack does not depend on it.
