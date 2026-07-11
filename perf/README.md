# JKANNEL Performance & Scalability Harness

A **self-contained** load, throughput and soak harness for the JKANNEL SMS-gateway
operations platform. It exercises the real REST API (auth envelope, grids,
analytics, write path) with objective, spec-aligned SLO gates and feeds Grafana.

Everything lives under `perf/**` and touches nothing else in the repo. It does
**not** modify `backend/`, `docker-compose.yml`, or `infrastructure/`.

---

## What's here

```
perf/
  run.js                 # Node CLI: node run.js <scenario>
  package.json           # local, ZERO runtime deps (Node built-ins only)
  .env.example           # all PERF_* config (copy to .env, never commit secrets)
  config/
    env.js               # env + .env loader, duration parsing
    slo.js               # SLO thresholds (spec vs local profiles)
  lib/
    client.js            # keep-alive HTTP client, login, envelope unwrap
    stats.js             # bounded-memory latency histogram + metrics
    runner.js            # VU engine, pacing, SLO evaluation, reporting
  scenarios/             # Node scenario definitions (a–e below)
    read-grid.js  auth.js  reporting.js  write-send.js  soak.js
  k6/                    # equivalent k6 scripts (preferred tool; see below)
    common.js  read-grid.js  auth.js  reporting.js  write-send.js  soak.js
  dashboards/
    jkannel-perf.json    # Grafana dashboard (import; do NOT edit infrastructure/)
  results/
    RESULT_TEMPLATE.md   # per-run record template
    *.json               # machine-readable run artifacts (gitignored)
```

## Two runners, one harness — why

The spec and industry practice favour **k6**. k6 is a standalone Go binary and is
**not bundled** with this repo, and this harness must not install global software.
So the harness ships **both**:

1. **Node runner (primary, always runnable).** Zero external dependencies — it
   uses only Node built-ins (`http`/`https`, `perf_hooks`). It runs immediately
   with the Node that already builds the backend (validated on Node v24). This is
   what produced the baseline below and what CI can gate on with no install step.
2. **k6 scripts (preferred tool, optional).** Identical scenarios and SLOs for
   teams that have k6 and want its executors, distributed mode and native
   Prometheus remote-write. Install from <https://k6.io/docs/get-started/installation/>.

Both read the same `PERF_*` environment variables and encode the same SLOs.

---

## Quickstart

```bash
cd perf
cp .env.example .env          # then set PERF_PASSWORD (and PERF_BASE_URL if not :3000)

# Node runner (no install needed):
node run.js read-grid
node run.js reporting
node run.js write-send
node run.js auth
node run.js soak
node run.js all               # read-grid + reporting + write-send

# Syntax self-check of every script:
npm run check
```

Override load shape per run via flags or env:

```bash
node run.js read-grid --vus 25 --duration 2m --rps 200
PERF_VUS=50 PERF_DURATION=5m node run.js reporting
```

k6 equivalents:

```bash
PERF_BASE_URL=http://127.0.0.1:3000 PERF_PASSWORD=... k6 run k6/read-grid.js
PERF_VUS=25 PERF_DURATION=2m PERF_RPS=200 k6 run k6/reporting.js
```

Exit code is **non-zero when any SLO check fails**, so a run is an objective
pass/fail gate suitable for CI.

---

## Environment / configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERF_BASE_URL` | `http://127.0.0.1:3000` | Backend port, or the Wave-4 reverse proxy (`http://127.0.0.1:8080`). |
| `PERF_API_PREFIX` | `/api/v1` | Global API prefix (matches `main.ts`). |
| `PERF_TENANT` / `PERF_USERNAME` | `default` / `operator` | Login identity. |
| `PERF_PASSWORD` | — | Operator password. **Required** for authed scenarios. Never commit it. |
| `PERF_VUS` | `10` | Virtual users (concurrency). |
| `PERF_DURATION` | `30s` | Run length (`30s`, `5m`, `2h`). |
| `PERF_RPS` | `0` | Target aggregate arrival rate. `0` = closed-loop (max throughput). |
| `PERF_WARMUP` | `0` | Discarded warmup window before metrics record. |
| `PERF_THINK_MS` | `0` | Per-VU think time between iterations (unpaced only). |
| `PERF_SLO_PROFILE` | `local` | `local` (pragmatic single-node) or `spec` (strict spec Section 6). |
| `PERF_SLO_*` | see `slo.js` | Per-threshold overrides (ms / rate). |
| `PERF_ALLOW_SEND` | `false` | `true` makes `write-send` POST real `/bulk-send` jobs (destructive). |

The base URL can point at either the **direct backend port** (`:3000`) or the
**Wave-4 reverse proxy** (`:8080`) — the proxy path additionally measures the
nginx hop, keep-alive and any compression.

---

## Scenarios

| # | Scenario | Endpoints | Purpose | SLO anchor (spec §6) |
| --- | --- | --- | --- | --- |
| a | `read-grid` | `GET /messages`, `/smscs`, `/routes`, `/alerts`, `/users`, `/audit-events`, `/bulk-send` | Read-heavy operator grid browsing | Message Search < 2 s |
| b | `auth` | `POST /auth/login` (fresh each iteration) | Auth throughput; heaviest CPU path (argon2) | Authentication < 100 ms |
| c | `reporting` | `GET /reports/analytics/*` (overview, trend, per-smsc, breakdown, latency-sla, …) | Dashboard analytics aggregate queries | Dashboard API < 500 ms |
| d | `write-send` | `POST /routes/simulate` (default, safe) or `POST /bulk-send` (opt-in) | Write / compute path | Route Lookup < 50 ms |
| e | `soak` | Weighted read mix + `GET /health` | Sustained low-RPS stability & leak detection | (stability, RSS growth) |

### Write / send safety

`write-send` defaults to `POST /routes/simulate` — a genuine POST that runs the
routing engine server-side and **writes nothing**. Setup discovers a routable
destination from existing routes; when no routes are seeded the engine answers
`No eligible route` (HTTP 400), which still fully exercised the parse+auth+engine
path and is counted as a valid outcome (not an error).

To load the **real** send path, set `PERF_ALLOW_SEND=true`. The harness then
discovers one of the tenant's SMSC `engine_id`s and POSTs `/bulk-send` jobs with
a single synthetic recipient in the `+99999…` documentation range. This **queues
real, persisted campaign jobs** drained by the background processor — use it only
against a disposable/test environment, never a live gateway.

### Soak / leak detection

The soak profile holds a low, steady rate for a long duration and polls the
backend's public `/api/v1/metrics` every 5 s, reading
`jkannel_backend_memory_bytes{kind="rss"}`. A steadily climbing RSS across a long
run indicates a leak. The SLO gate fails if RSS grows more than `PERF_SLO_SOAK_RSS_GROWTH`
(default 25%). A meaningful leak hunt needs **hours**:

```bash
PERF_DURATION=2h PERF_VUS=5 PERF_RPS=20 node run.js soak
```

---

## SLOs / thresholds

Transcribed verbatim from **PERFORMANCE_AND_SCALABILITY_ENGINEERING_SPECIFICATION.md
Section 6 (Response Time Objectives)** as the `spec` profile, with pragmatic
single-node `local` defaults. Select with `PERF_SLO_PROFILE`.

| Operation | Spec target (p95) | Local default (p95) | Notes |
| --- | --- | --- | --- |
| Authentication | **< 100 ms** | 750 ms | argon2 verification dominates; 100 ms needs provisioned hardware. Local bar chosen from measured ~500 ms p95 + headroom. |
| Dashboard / reporting API | **< 500 ms** | 800 ms | Aggregate analytics queries. |
| Message search (messages grid) | **< 2 s** | 2000 ms | Same value both profiles. |
| Route lookup (`/routes/simulate`) | **< 50 ms** | 500 ms | Simulate adds a DB read for rule data; 50 ms is the engine-only target. |
| Health check | **< 1 s** | 1000 ms | |
| Send accept (`/bulk-send`) | (no explicit spec) | 1500 ms | **Chosen** default. |
| Error rate (all) | (no explicit spec) | ≤ 1% | **Chosen** default; override with `PERF_SLO_ERROR_RATE`. |
| Soak RSS growth | (no explicit spec) | ≤ 25% | **Chosen** leak guard. |

> The `spec` profile is the release gate for a properly provisioned deployment.
> The `local` profile is for developer / Compose runs and is clearly labelled as
> pragmatic, NOT as evidence the spec targets are met. Values marked **Chosen**
> are harness defaults, not spec-derived.

Gate strictly against the spec bar with:

```bash
PERF_SLO_PROFILE=spec node run.js reporting
```

---

## Dashboards

A Grafana dashboard is provided at `perf/dashboards/jkannel-perf.json`. Because
this harness must not edit `infrastructure/`, **import it manually** (it is not
auto-provisioned):

1. The repo's monitoring stack already provisions a Prometheus datasource with
   UID `jkannel-prometheus` (see
   `infrastructure/monitoring/grafana/provisioning/datasources/prometheus.yml`)
   which scrapes the backend `/metrics`.
2. In Grafana: **Dashboards → New → Import → Upload JSON file** →
   `perf/dashboards/jkannel-perf.json` → select the JKANNEL Prometheus datasource.

Panels (server-side, always populated by the backend `/metrics`):

- **HTTP request rate by status class** — `rate(jkannel_http_requests_total[1m])`
- **HTTP latency p50/p95/p99** — `histogram_quantile(…, jkannel_http_request_duration_ms_bucket)`
- **Backend memory (RSS/heap) — leak watch** — `jkannel_backend_memory_bytes`
- **Backend up / uptime / error ratio** — health and 4xx+5xx share.

### Optional: k6 → Grafana (client-side latency)

To also see the load generator's own view, run k6 with Prometheus remote-write and
point it at the same Prometheus (needs `--web.enable-remote-write-receiver` on
Prometheus):

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  k6 run --out experimental-prometheus-rw perf/k6/read-grid.js
```

The dashboard's bottom row (`k6 request rate & VUs`, `k6 duration p95`) populates
from those `k6_*` series; it stays empty when only the Node runner is used.

---

## Reading results

Each Node run prints a summary and writes
`perf/results/<scenario>-<timestamp>.json` containing per-endpoint histograms,
status classes, error breakdown, throughput, memory samples and the SLO verdict.
Record formal runs with `results/RESULT_TEMPLATE.md`. k6 prints its own end-of-test
summary and honours `--out json=…` / `--summary-export=…`.

---

## Local baseline (smoke — honestly labelled)

Captured with the **Node runner** against the live dev Compose stack
(`http://127.0.0.1:3000`, backend + Postgres + Redis + Kamex on a single Windows
dev host, unseeded message/route data), `PERF_SLO_PROFILE=local`. These are
**tiny smoke runs to prove the harness executes and to set a rough local floor —
NOT a capacity result.**

| Scenario | Load | Throughput | p50 / p95 / p99 (ms) | Errors | Verdict |
| --- | --- | --- | --- | --- | --- |
| read-grid | 3 VU / 6 s | 74 rps | 36 / 75 / 104 | 0% | PASS |
| reporting | 3 VU / 6 s | 94 rps | 26 / 60 / 88 | 0% | PASS |
| write-send (simulate) | 3 VU / 5 s | 36 rps | 73 / 156 / 430 | 0% | PASS |
| auth | 2 VU / 5 s | 7 rps | 224 / 535 / 545 | 0% | PASS (local); **FAILS `spec` 100 ms** |
| soak | 2 VU / 10 rps / 14 s | 10 rps | 21 / 72 / 137 | 0% | PASS; RSS 149.7→150.1 MB (+0.3%) |

Key honest observations:

- Read and analytics latencies are excellent on a near-empty database (p95 well
  under even the strict spec bars). They will rise with realistic data volume;
  re-baseline against a seeded/large dataset before trusting the message-search
  and analytics numbers.
- **Auth cannot meet the spec's 100 ms p95** on this hardware because argon2 is
  intentionally expensive (~230 ms p50, ~535 ms p95). This is surfaced, not
  hidden: the `spec` profile fails auth by design. Meeting 100 ms requires
  provisioned CPU and/or an argon2 cost review — an engineering decision, not a
  harness knob.
- Throughput figures above are from 2–3 VU smokes and are **not** the platform's
  capacity ceiling.

---

## ⚠️ External evidence outstanding (production-scale validation)

**This harness is the runnable instrument and a modest local baseline. It is NOT
production-scale soak evidence, and the spec's headline targets remain an EXTERNAL
gate that is not satisfied here.**

The Performance & Scalability spec states (Section 5):

- **Initial deployment:** 10 SMSCs, 100 concurrent users, 50 API clients,
  **100 messages/second**.
- **Future target:** 1,000 SMSCs, 10,000 concurrent users, 10,000 API clients,
  **100,000 messages/second** — "Architecture shall not require redesign."

None of these are demonstrated by the local smoke above. Proving them requires
**dedicated load infrastructure that this harness intentionally does not
provision**, specifically:

1. **A production-representative deployment** — horizontally scaled backend
   replicas, an appropriately sized Postgres (partitioning, read replicas,
   tuned pools per spec §11–15), Redis, and the reverse proxy — not a single dev
   host.
2. **A seeded, realistic dataset** — millions of SQLBox message rows so the
   message-search and analytics SLOs are measured under real cardinality, not an
   empty table.
3. **A distributed load generator** — one machine cannot generate 100k msg/s;
   this needs k6 distributed / k6 Cloud or an equivalent fleet on separate hosts,
   isolated from the system under test.
4. **The real engine send path at volume** — sustained SMSC submission through
   Kamex to carrier(s) (or a high-throughput fake SMSC), which also depends on
   carrier IP allow-listing that is currently outstanding for the live SMPP bind.
5. **Long-duration soak (hours to days)** at the target rate with the Grafana RSS
   / connection-count panels watched for leaks and pool exhaustion, plus
   release-over-release regression comparison (spec §22–23).

Until such a run is executed on dedicated infrastructure and its results are
attached under `perf/results/` (use `RESULT_TEMPLATE.md`), the spec's throughput
and scale acceptance criteria (§24) must be considered **NOT YET DEMONSTRATED**.
The scripts, SLO gates and dashboards here are exactly what that external run
should use — only the environment and scale are missing.
