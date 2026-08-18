# 13. Services and Nodes: is it broken, and which part?

**Read this when** sending has stopped, or slowed, and you need to know which
component is at fault — and whether it is the cause or just a symptom.

---

## The short version

**Services** (System → Services) lists every component the gateway depends on,
its state, and — where a dependency explains a failure — which one to fix first.
**Nodes** (System → Nodes) shows resource pressure on the one node JKANNEL can
actually measure, and states plainly what it cannot.

---

## Services

### The one rule to internalise

A component that **nothing watches** shows as **`not observed`**, in its own
column, sorted *above* the healthy rows. It is not green and it never will be.

This matters more than it sounds. If "unknown" were folded into the healthy
count, then the fewer probes a deployment had, the healthier it would look — the
board would reward blind spots. So they are counted separately and pushed up the
list, because a blind spot is a gap to close, and burying it under the green
rows is how it stays a blind spot.

### What is in the register

| Component | What it does | How it is watched |
|---|---|---|
| `bearerbox` | Holds the carrier SMPP binds and moves every message | HTTP probe of its health endpoint |
| `smsbox` | Accepts HTTP submissions and hands them to bearerbox | HTTP probe of the sendsms port |
| `sqlbox` | The spool and message history | Reads its tables |
| `database` | Routes, tenants, audit, jobs | `SELECT 1` |
| `cache` | Sessions and rate-limit counters | Redis `PING` |
| `engine-poller` | Collects engine telemetry into the console | Snapshot freshness |
| `job-worker` | Scheduled sends, MO fan-out, retries, reports | Overdue and dead-lettered job counts |
| `metrics-collector` | Scrapes and stores the Prometheus series | Prometheus readiness endpoint |

`smsbox` and `metrics-collector` are only probed when
`KAMEX_SENDSMS_URL` and `PROMETHEUS_BASE_URL` are configured. Until then they
show `not observed` and the row tells you which variable to set.

### Reading a failure

Each row carries **Evidence** (what the probe actually said) and **Explained
by** (an unhealthy dependency, when one accounts for it).

That second column is the whole value of the screen. When PostgreSQL goes down,
`bearerbox`, `sqlbox` and `job-worker` all go red with it — but only `database`
is a *root failure*. The summary line says so:

> *3 failing of 8 components. Start with database — nothing upstream explains
> it.*

and the detail panel for `bearerbox` says:

> *Fix database first. Restarting bearerbox while its dependency is unhealthy
> usually changes nothing.*

Which is the difference between one fix and six pointless restarts.

### Things the board deliberately does not claim

**`sqlbox` healthy does not mean sqlbox is draining.** The probe reads its
tables, which is a stronger signal than the container's own healthcheck (that
one is `kill -0 1` — "does PID 1 exist" — and passes for a completely wedged
daemon), but it is still not proof that messages are moving. Check the queue age
on **Queues** for that. The row says so itself.

**`smsbox` healthy means the HTTP listener answered.** It does not prove a
submission would route. Kannel answers a parameterless request with an error
page, and an error page is a perfectly good liveness signal — but only a
liveness signal.

### Why there is no Restart button

Because the backend cannot restart anything. It has no Docker socket. A restart
button would open a confirmation dialog and then fail, which is worse than its
absence — the console never shows a control that maps to nothing it can do.

This screen tells you **which** component to restart and **why**; restarting it
stays with whoever operates the host.

---

## Nodes

### This screen is smaller than you might expect

The specification asks for a table of hosts with CPU, memory, disk, network I/O,
load average and versions. JKANNEL cannot produce that table honestly: there is
no node inventory, no agent on the hosts, and no Docker socket. Every column
would be a number nobody measured.

So it reports the one node it *can* measure — the container the backend runs in,
via cgroup accounting — and renders everything it cannot as first-class content
with the reason. A banner at the top says explicitly that one row is not an
inventory, because a single-row Nodes table with no caption reads as "this
deployment has one host", which is a claim about your estate that nobody
verified.

### Why not just read the host's figures?

Because from inside a container they are wrong in a way you could not detect.
`os.totalmem()` returns the *host's* RAM and `os.loadavg()` returns the *host's*
load, including every other container on the box. On a shared machine that means
showing a neighbouring stack's load as JKANNEL's. A wrong number is worse than
no number, so when cgroup accounting is unreadable the screen says so instead of
falling back.

### Reading it

- **Memory** — used against this container's limit.
- **CPU** — share of this container's quota, between two samples. It says
  `unknown` on the first read after a restart and refreshes every 10 seconds.
  A cumulative counter is not a rate, and publishing one as a percentage would
  render a busy container as 0% and a long-lived idle one as thousands.
- **Pressure** — one sentence naming the single resource worth acting on, or
  saying plainly that nothing is under pressure. That is a finding, not an
  absence.

An **uncapped** container reports `unknown` for CPU percentage. There is no
denominator, so a percentage would be a fabrication.

### What is not measured, and why

Listed on the screen itself, each with the reason:

- Host CPU, memory, disk and load — no host agent, no Docker socket
- Other nodes — no inventory exists
- Disk free space — no filesystem is mounted for measurement
- Per-service CPU/memory for bearerbox, smsbox, sqlbox — separate containers,
  nothing collects from them
- Network I/O — no interface counters are read

Getting these means putting a collector on each host. That is a deployment
decision, not a console one.

---

## Related

- [06. Monitoring and alerts](06-monitoring-and-alerts.md) — being *told* rather than looking
- [11. Troubleshooting and FAQ](11-troubleshooting.md)
- **System → Runtime Containers** — what Compose *declares*, as opposed to what is observed
