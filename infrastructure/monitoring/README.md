# JKANNEL monitoring profile

The `monitoring` Docker Compose profile starts Prometheus and Grafana for local/development observability.

## Start

```powershell
docker-compose --profile monitoring up -d prometheus grafana
```

Prometheus listens on `${PROMETHEUS_PORT:-9090}` and scrapes:

- JKANNEL backend Prometheus text metrics at `/api/v1/metrics`
- Kamex bearerbox `/metrics` when the `engine-kamex` profile is also active
- Prometheus self-metrics

Grafana listens on `${GRAFANA_PORT:-3001}` and provisions:

- `JKANNEL Prometheus` datasource
- `JKANNEL Operations Overview` starter dashboard

## Current scope

This profile proves monitoring wiring and initial backend/process metrics. It does not yet claim production SLO evidence, host metrics, PostgreSQL/Redis exporters, alert correlation, escalation policies, maintenance-window suppression, or provider-backed email/SMS delivery.

Notification delivery currently supports auditable dashboard records and bounded webhook delivery. Email and SMS channels are configurable but intentionally marked skipped until provider adapters and secret handling are implemented.
