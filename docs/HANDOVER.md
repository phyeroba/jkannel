# JKANNEL — design-system implementation handover

**Last updated:** 2026-08-21 · **Production:** `8fe99e5` · **main:** `921e759`

> ## ⛔ PRODUCTION DEPLOYS ARE PAUSED
> Peter asked on 2026-08-21 to hold production at `8fe99e5` until **at least 15
> more kit screens** are done. Keep committing and pushing to GitHub so the work
> stays reviewable — just do not run `scripts/deploy.sh` until he says go.

Read §1–§4, run the tools in §5, then work §10. Nothing here needs rediscovering.

---

## 1. The job

The client handed over a packaged design system at
`design/JKANNEL design system/`. The job is to make the console look and behave
like it, screen by screen, until every screen in `ui_kits/console/` is
implemented. Peter's words: **"pixel for pixel, not just functionality."**

### The mistake that cost the most time — do not repeat it
For weeks the comparison was against the kit's **source** (its CSS and JSX).
`design-diff.mjs` reported 620/620 declarations matching and 0 selectors absent.
That was true and nearly useless: a CSS diff cannot see a panel that was never
built. Peter had to point out that production still looked nothing like the kit.

**The kit ships a self-contained `index.html` that opens in a browser.** Open it.
`scripts/kit-shots.mjs` now does that automatically and photographs both sides.

---

## 2. The four rules this work follows

1. **Compare against the rendered kit**, never only its source.
2. **Check `smsc_bind_snapshots` and `smsc_bind_transitions` before assuming
   anything needs building.** I estimated from memory twice and was wrong both
   times, most badly by claiming per-bind throughput needed a new collector when
   the poller had been recording it for months.
3. **Only build columns that have a real endpoint. Omit the rest entirely** —
   never a dash, never a zero. A dash implies we looked and found nothing.
   Where a value exists but was not measured, render `unknown`.
4. **Match the kit's names wherever the meaning matches; diverge where adopting
   the name would make the screen assert something it cannot see.** Example:
   `/routes` returns configuration and knows nothing about failover overrides,
   so its target column is *not* renamed "Active target" — FailoverView resolves
   the real active path and keeps the kit's wording there, because there it is
   true. If Peter asks for the label anyway, that is his call to make.

---

## 3. Where things stand

| Metric | At start | Now |
|---|---|---|
| Panels absent | 36 | **24** |
| Columns absent | 74 | **43** |
| Primitives absent | 25 | **15** |

**Fully `[MATCHES]`:** LoginScreen, SmscsScreen, SessionsScreen, QueuesScreen.

**Substantially done:** Dashboard (Traffic chart, Queue pressure, carrier
connectivity, stale banner), Carriers (MT TPS / utilisation / last event),
Carrier Detail (recent events, open alerts, last event, stale banner), SMSC
Detail (bind history as Timeline), DLR Performance (P50/P95/P99), Failover
(transition history, headroom), Engine Config (read-only banner, directive
ownership), Routes (Alternatives).

**Not started:** Test Tools (5 panels — largest gap), Performance (2), Traffic,
Alerts, Trace, Events, Logs, Audit, Users, Services, Nodes, Simulator, SMPP
Errors, Service Detail.

### Shared primitives — built, reuse them
| Component | Notes |
|---|---|
| `EventTimeline.vue` | the design's Timeline. `missing` state = hollow dashed dot for a step that never arrived. `dense` prop. |
| `DetailDrawer.vue` | right-hand sheet, focus trap, Escape closes, focus returns to the opening row. `wide` prop for code. |
| `CodeConsole.vue` | macOS terminal window; `prompt` prop for a `$` gutter. |
| `ScopePicker.vue` | gateway API-key scopes with descriptions. |
| `MiniChart.vue` | pre-existing line/area/bar; `series`, `labels`, `title`, `height`, `grid`. |

**Still needed:** `Tabs` (Test Tools, Users). `ConfirmAction.vue` already exists.

---

## 4. What is measurable

| Table | Carries | Already used for |
|---|---|---|
| `smsc_bind_snapshots` | one row per poll: `outbound_rate`, `inbound_rate`, `sent`, `received`, `queued`, `failed`, `observed_at` | SMSC + carrier TPS, capacity, queue depth/growth |
| `smsc_bind_transitions` | append-only bind history, **never pruned** | last event, reconnect counts, every Timeline |
| `route_failovers` | keeps **ended** rows with `end_reason` | Failover transition history |
| `sent_sms` (SQLBox) | MT↔DLR correlated on `foreign_id`, both timestamps | delivery rate, DLR P50/P95/P99 |
| `metric_samples` | `smsc.sent/received/queued/failed/throughput.*` per poll | alert rules |
| `audit_log` | `old_value`/`new_value`/`reason` | audit trail, "what changed" |

### Genuinely NOT measurable — do not build, do not stub
Enquire-link RTT · per-session timeouts · P95 submit latency · top
`command_status` · throttle rate — Kannel exposes none through `/status.json`;
only bearerbox logs carry them.
Per-service CPU/memory — the backend has no Docker socket, a deliberate
boundary. Per-queue retries/expiries. Real session counts (`instances = N`
collapses behind one `smsc-id`). Per-message queue age per bind.

`SUM()` over zero rows is NULL in Postgres — that is exactly the distinction to
preserve, and the design system renders `unknown` too, so it is faithful.

---

## 5. Tools — run before and after every batch

```powershell
node scripts/screen-diff.mjs         # panels/columns/primitives absent, per screen
node scripts/column-feasibility.mjs  # which missing columns have data (16 buildable, 7 not)
node scripts/route-smoke.mjs         # all 44 routes: crashes, HTTP errors, empty views
node scripts/kit-shots.mjs           # renders the KIT and ours, 21 screens, side by side
node scripts/design-diff.mjs         # CSS conformance (620 match / 2 differ / 0 absent)
```

`route-smoke.mjs` is the regression guard. Baseline: **0 crashed, 0 empty,
0 HTTP errors, 0 console errors, 44/44 rendered.** Any non-zero is yours.

> Playwright scripts must be **copied into `e2e/`** to resolve `@playwright/test`:
> `Copy-Item scripts/route-smoke.mjs e2e/route-smoke.tmp.mjs` then
> `node e2e/route-smoke.tmp.mjs`. `e2e/*.tmp.mjs` is gitignored.

---

## 6. The working rhythm that has held up

1. Read the kit screen's JSX in `ui_kits/console/<Name>Screen.jsx`.
2. Check §4 — does the data exist? If not, **omit the column**.
3. Build. Reuse the primitives in §3.
4. `npm run build` — **not** `npx vue-tsc --noEmit`. See §9.
5. `npx vitest run` (frontend) and `npx jest --silent` (backend).
6. `node scripts/screen-diff.mjs` to confirm the gap closed.
7. `node e2e/route-smoke.tmp.mjs` to prove nothing broke.
8. Commit with the reasoning — *why*, not just what.
9. **Do not deploy** while the freeze in the header stands.

**One screen at a time, committed.** Two screens that conform beat five that
half-do — that has been Peter's experience of this work and he has said so.

---

## 7. Hard constraints — never violate

- **Never recreate `jkannel-kamex-bearerbox-1`.** sqlbox does not reconnect when
  bearerbox restarts: sending wedges silently with every metric still green.
  `deploy.sh` aborts if the container id changes.
- **Never touch `cpaas-*` containers, the 3 PM2 processes (`auth-service`,
  `messaging-service`, `console-web`), or `/etc/nginx/sites-available/speedamobile`.**
- **Never commit `smpp.carrier.example` carrier details** (`smpp.carrier.example:4089`, `carrier-user`, egress
  `203.0.113.10`). `.env` only — gitignored.
- **`docker-compose.override.yml`** is gitignored and exists only on the server.
- Documentation lives in `docs/`, never the repo root.

---

## 8. Deploying (when the freeze lifts)

```powershell
cd d:\JKANNEL
scp scripts/deploy.sh hyeroba@gw1.speedamobile.com:/tmp/deploy.sh
ssh hyeroba@gw1.speedamobile.com "bash /tmp/deploy.sh; rm -f /tmp/deploy.sh"
```

**Copy the file; never pipe it.** `Get-Content -Raw | ssh "bash -s"` re-adds CRLF
in the PowerShell pipeline even from a pure-LF file, and remote bash fails on the
last line with `$'\r': command not found` — the deploy succeeds but reports
failure, which is how people learn to ignore a red exit code.

`deploy.sh` repairs file ownership **before** pulling: a `sudo git` run leaves
root-owned files, `git merge` then fails partway through checkout (new content on
disk, HEAD unmoved), and the deploy looks like it silently did nothing. It also
aborts on a dirty tree after merge, and if bearerbox moves.

**Verifying:** a 200 proves nginx answers, not that new code shipped. Most views
are lazy routes in their **own chunks**, not the entry bundle:

```bash
docker exec jkannel-frontend-1 sh -c "ls /usr/share/nginx/html/assets | grep CarrierDetailView"
docker exec jkannel-frontend-1 grep -c -F "Recent carrier events" /usr/share/nginx/html/assets/<chunk>
```

---

## 9. Traps, all hit at least once

- **`npx vue-tsc --noEmit` passes on code `npm run build` rejects.** It missed a
  `flatMap` widening to `unknown[]` and a non-existent `CapacityView.ceiling`.
  **The build is the gate.**
- **`export const` inside `<script setup>`** passes vue-tsc, fails the SFC
  compiler, and once silently dropped 73 tests from the suite. Shared constants
  go in a `.ts` module.
- **Teleported components escape the test wrapper.** `DetailDrawer` renders into
  `<body>`. Use a helper that checks the wrapper first then `document.body`, and
  clear `document.body.innerHTML` between mounts or a test inherits the previous
  test's open drawer.
- **PowerShell eats double quotes in ssh commands.** Write a `.sh`, normalise to
  LF, `scp`, then `ssh "bash /tmp/x.sh"`.
- **`Get-Content` without `-Encoding` mangles UTF-8.** Use
  `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`. Em dashes and
  arrows have been corrupted this way. `.gitattributes` forces `*.sh eol=lf`.
- **Backticks inside a JS template literal terminate it.** A SQL comment
  containing a backticked table name broke a build.
- **PowerShell `.Replace()` fails on multi-line here-strings** with an overload
  error; normalise `\r\n` to `\n` on both needle and haystack first, or use the
  Edit tool.
- **Docker Desktop wedges** — `ps` works, `build` hangs, `dockerd` absent. Kill
  the Docker processes, `wsl --shutdown`, relaunch Docker Desktop.
- **Backend suite has an occasional worker-teardown flake.** One failure that
  passes on re-run is not real; a deterministic failure is.

---

## 10. Next batch — do these in order

### 1. Test Tools (5 panels, largest gap)
Kit: `Test SMS`, `DLR lookup`, `Receipt lifecycle`, `Encoding and segment
analyser`, `Send operational test SMS`. Needs a **`Tabs` primitive** — build it,
`components/navigation/Tabs.jsx` in the kit is the reference. `ConfirmAction`
already exists. `TestToolsView.vue` already has number lookup, the encoding
analyser and an SMPP connectivity test, so **check what is genuinely missing
before building**. Receipt lifecycle should use `EventTimeline` over the
`sent_sms` foreign_id correlation.

### 2. Performance (2 panels)
Kit: `Gateway latency`, `Capacity`. Maps to `AnalyticsView.vue`. Latency can come
from the DLR percentiles already built in `dlr-performance.service.ts`; capacity
from `smsc_definitions.tps` summed against observed `outbound_rate`.

### 3. Traffic — **CHECK BEFORE BUILDING**
Kit wants a `Traffic matrix`. `LiveTrafficView` is a live snapshot with
browser-tracked peaks and **no server-side time series**, so a matrix would have
to be invented. Either build a real series first (`metric_samples` holds the
per-poll data) or leave it out and say why.

### 4. Alerts (4 columns + Timeline)
Category / Started / Duration / Acknowledgement. `alert_instances` has
`opened_at`, `acknowledged_at`, `resolved_at` — duration is derivable. Timeline
for the lifecycle.

### 5. Message Trace (1 panel + 5 columns)
`Diagnostic summary`; Carrier ID / Destination / Sender / SMSC / Final. All
present in the SQLBox projection (`MESSAGE_COLUMNS` in
`kamex-sqlbox.repository.ts`).

---

## 11. Credentials

**Local, verified:** tenant `default`, user `operator`, password
`JkannelLocal2026!`.

**Production: there is no verified console password and none has ever been
printed.** Passwords are scrypt-hashed; `.env` holds only infrastructure
secrets. Earlier in this project a password was stated that had never been read,
and it was wrong. **Do not guess.** Ask Peter, or run a reset and report the
value actually set.

Local users: `operator` (administrator), `analyst1` (administrator), `newop2`
(**no role** — signs in and sees nothing). No account exists per role, so
role-by-role review needs accounts created first.

---

## 12. Open questions for Peter

- **Demo data.** The kit is a mock: it shows `530/s` throughput and four
  invented failover events. Ours renders `unknown` because the local engine is
  stopped and no traffic flows, so screens will not be pixel-identical until
  real data exists. A seed script would fix this for demos — offered, not yet
  asked for.
- **Role accounts.** Both real local users are administrators, so there is no
  way to review what a restricted role sees.
- **Generated configuration panel** (Engine Config) needs the *deployed* config
  content, not the draft the composer holds. No endpoint returns it yet.
