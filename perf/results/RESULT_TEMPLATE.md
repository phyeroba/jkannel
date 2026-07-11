# JKANNEL Performance Run Record

> Fill one of these in per formal run and commit it alongside the raw JSON in
> `perf/results/`. The harness writes machine-readable JSON automatically; this
> template captures the human context (environment, intent, verdict).

| Field | Value |
| --- | --- |
| Date (UTC) | |
| Run by | |
| Git commit | |
| Scenario(s) | read-grid / auth / reporting / write-send / soak |
| Target URL | e.g. http://127.0.0.1:3000/api/v1 |
| Environment | dev laptop / CI / staging / dedicated load rig |
| Backend replicas | |
| DB / Redis sizing | |
| SLO profile | local / spec |

## Load shape

| Param | Value |
| --- | --- |
| VUs | |
| Duration | |
| Target RPS | |

## Results

| Metric | Value |
| --- | --- |
| Requests | |
| Throughput (rps) | |
| Error rate | |
| p50 / p95 / p99 (ms) | |
| Backend RSS start → end (soak) | |

## SLO verdict

| Check | Ceiling | Observed | Pass? |
| --- | --- | --- | --- |
| | | | |

## Notes / anomalies

-

## Attached raw result

- `perf/results/<scenario>-<timestamp>.json`
