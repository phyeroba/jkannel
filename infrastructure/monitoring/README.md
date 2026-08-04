# JKANNEL monitoring profile

The `monitoring` Docker Compose profile starts Prometheus and Grafana for local/development observability.

## Start

```powershell
docker-compose --profile monitoring up -d prometheus grafana
```

Prometheus listens on `${PROMETHEUS_PORT:-9090}` and scrapes:

- JKANNEL backend Prometheus text metrics at `/api/v1/metrics`
- Prometheus self-metrics

There is deliberately **no** `kamex-bearerbox` scrape job. Kannel/Kamex's port
13000 is the admin interface — it serves `/status`, `/status.json` and the
control commands, and has no `/metrics` endpoint. The job that used to target it
scraped a 404 forever while looking correctly configured, which is why no engine
metric ever reached Prometheus. Engine telemetry now arrives through the backend
instead: `SmscStatusPoller` reads `/status.json` on an interval, caches the
parsed snapshot, and `EngineMetricsService` renders it into `/api/v1/metrics`.
The scrape therefore never blocks on the engine.

Grafana listens on `${GRAFANA_PORT:-3001}` and provisions:

- `JKANNEL Prometheus` datasource
- `JKANNEL SMS Operations` — bind state, queue depth, throughput, failures, DLR flow
- `JKANNEL Platform Health` — process, API latency, PostgreSQL and Redis

## Engine metrics exported

Per bind (label `smsc` = the engine id from `smsc_definitions.engine_id`):

| Metric | Type | Notes |
| --- | --- | --- |
| `jkannel_smsc_bind_up{smsc,state}` | gauge | 1 when bound; `state` is the normalised Ch.22 state |
| `jkannel_smsc_queued{smsc}` | gauge | messages queued on the bind |
| `jkannel_smsc_failed_total{smsc}` | counter | engine's own failure counter |
| `jkannel_smsc_messages_total{smsc,direction}` | counter | `sent` / `received` |
| `jkannel_smsc_throughput_messages_per_second{smsc,direction,window}` | gauge | engine's 1m/5m/15m rates |

Engine-wide:

| Metric | Type | Notes |
| --- | --- | --- |
| `jkannel_engine_up` | gauge | 0 when the last poll could not read the engine |
| `jkannel_engine_poller_up` | gauge | 0 when no snapshot has ever been cached |
| `jkannel_engine_snapshot_age_seconds` | gauge | staleness of the data this scrape served |
| `jkannel_engine_binds` / `jkannel_engine_binds_bound` | gauge | bind counts |
| `jkannel_engine_sms_queued{direction}` | gauge | `outbound` / `inbound` |
| `jkannel_engine_dlr_queued` | gauge | delivery reports awaiting processing |
| `jkannel_engine_store_size` | gauge | **absent** when the engine reports `-1` (unknown) |
| `jkannel_engine_uptime_seconds` | gauge | reported bearerbox uptime |

Nullable engine counters are omitted rather than exported as `0`: an absent
series is honest about "we do not know", a zero is a claim that the queue is
empty.

## Poller and evaluator configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMSC_POLLER_ENABLED` | `true` | Set `false` to disable engine polling entirely (also off under `NODE_ENV=test`) |
| `SMSC_POLLER_INTERVAL_MS` | `30000` | Poll cadence, clamped to 5s–10min (Ch.21's 5s/10s/1min range) |
| `SMSC_BIND_DOWN_CONFIRMATIONS` | `1` | Consecutive polls a hard-down state must persist before alerting |
| `SMSC_BIND_TRANSITIONAL_CONFIRMATIONS` | `3` | Same, for `connecting` / `retrying` / `binding` |
| `SMSC_FAILURE_JUMP_THRESHOLD` | `10` | Rise in the engine's per-bind failure counter that raises an alert |
| `ENGINE_SAMPLE_RETENTION_HOURS` | `72` | Retention for `metric_samples`, `smsc_bind_snapshots`, `engine_poll_snapshots` (bind transitions are never pruned) |
| `ALERT_RULE_EVALUATOR_ENABLED` | `true` | Set `false` to stop evaluating console alert rules |
| `ALERT_RULE_EVALUATOR_INTERVAL_MS` | `60000` | Rule evaluation cadence |
| `ALERT_SMS_SENDER` | `JKANNEL` | Sender ID used for alert SMS delivery |

### Metric names for alert rules

`alert_rules.metric` (authored in the console) is matched against the sample
stream the poller writes. Available names: `smsc.bind.up`, `smsc.queued`,
`smsc.failed`, `smsc.sent`, `smsc.received`, `smsc.throughput.outbound`,
`smsc.throughput.inbound`, `engine.up`, `engine.sms.queued.outbound`,
`engine.sms.queued.inbound`, `engine.dlr.queued`, `engine.store.size`,
`engine.binds.total`, `engine.binds.bound`. The `smsc.*` metrics are evaluated
per bind, so one rule covers every carrier independently. A rule naming a metric
nothing produces is reported as such in the evaluation outcome rather than
silently never firing.

## Current scope

Alert rules authored in the console are now evaluated continuously
(`AlertRuleEvaluatorScheduler` over the `metric_samples` stream the poller
writes), open `alert_instances`, and flow into the existing escalation and
notification machinery. Migration 031 seeds a default dashboard channel and a
default escalation policy so a fresh deployment notifies someone.

Notification delivery supports auditable dashboard records, bounded webhook
delivery, SMTP email, and SMS through the platform's own SQLBox send path.
Channels that cannot deliver report `failed` with a reason — none of them
silently accept and discard.

Still out of scope here: host/node metrics, PostgreSQL and Redis exporters
(only the backend's own probes are exported), and per-outcome DLR classification
(DLR masks are not decoded on ingest, so there is no
`jkannel_dlr_total{status}` series yet).
