# JKANNEL — design-system implementation handover

**Last updated:** 2026-08-21 · **Production:** `8fe99e5` · **main:** `6aeefb9`

> **PRODUCTION DEPLOYS ARE PAUSED.** Peter asked on 2026-08-21 to hold at
> `8fe99e5` until at least 15 more kit screens are done. Keep committing and
> pushing to GitHub so nothing is lost and the work is reviewable — just do not
> run `scripts/deploy.sh` until he says go.

Read this first, then run the three tools in §3. Everything needed to continue is
here; nothing has to be rediscovered.

---

## 1. What this work is

The client handed over a packaged design system at
`design/JKANNEL design system/`. The job is to make the console actually look
and behave like it — not approximately, screen by screen, until every screen in
`ui_kits/console/` is implemented.

**The mistake that cost the most time, stated plainly so it is not repeated:**
for weeks the comparison was against the kit's *source* — its CSS and JSX.
`design-diff.mjs` reported 620/620 declarations matching and 0 selectors absent,
which was true and nearly useless: it cannot see a panel that was never built.
The kit ships a **self-contained `index.html` that opens in a browser**. Open it.
That is what `kit-shots.mjs` now does automatically.

---

## 2. Where things stand

| Metric | At start | Now |
|---|---|---|
| Panels absent | 36 | **24** |
| Columns absent | 74 | **43** |
| Primitives absent | 25 | **15** |

**Screens that fully `[MATCHES]`:** LoginScreen, SmscsScreen, SessionsScreen, QueuesScreen.

**Substantially done:** Dashboard (Traffic chart + Queue pressure + carrier
connectivity + stale banner), Carriers (MT TPS / utilisation / last event),
Carrier Detail (recent events + open alerts + last event + stale banner),
SMSC Detail (bind history as Timeline), DLR Performance (P50/P95/P99).

**Also substantially done:** Queues (per-destination register with real growth +
recovery history), Failover (transition history + headroom), Engine Config
(read-only banner + directive ownership).

**Not started:** Test Tools (5 panels — largest single gap), Routes (2 panels),
Performance (2), Traffic, Alerts, Trace, Events, Logs, Audit, Users, Services,
Nodes, Simulator, SMPP Errors, Service Detail.

### Shared primitives — all built, ready to reuse
- `components/EventTimeline.vue` — the design's Timeline. `missing` state renders
  a hollow dashed dot for a step that never arrived.
- `components/DetailDrawer.vue` — right-hand sheet with focus trap. `wide` prop
  for code-heavy content.
- `components/CodeConsole.vue` — macOS-style terminal window.
- `components/ScopePicker.vue`, `components/MiniChart.vue` (pre-existing).

---

## 3. The three tools — run these before and after every batch

```bash
node scripts/kit-shots.mjs           # renders the KIT and ours, 21 screens each, side by side
node scripts/column-feasibility.mjs  # which missing columns have data: 16 buildable, 7 not
node scripts/screen-diff.mjs         # panels/columns/primitives still absent per screen
node scripts/route-smoke.mjs         # all 44 routes: crashes, HTTP errors, empty views
node scripts/design-diff.mjs         # CSS conformance (currently 620 match / 2 differ / 0 absent)
```

`route-smoke.mjs` is the regression guard. Current baseline: **0 crashed, 0 empty,
0 HTTP errors, 0 console errors, 44/44 rendered.** Run it after each batch; any
non-zero is something you introduced.

> Playwright scripts must be **copied into `e2e/`** to resolve `@playwright/test`:
> `Copy-Item scripts/kit-shots.mjs e2e/kit-shots.tmp.mjs` then
> `node e2e/kit-shots.tmp.mjs`. `e2e/*.tmp.mjs` is gitignored.

---

## 4. The single most useful fact

**Check `smsc_bind_snapshots` and `smsc_bind_transitions` before assuming
anything needs building.** I estimated work from memory twice and was wrong both
times, most badly by claiming per-bind throughput needed a new collector when the
poller had been recording it for months.

| Table | Carries | Already used for |
|---|---|---|
| `smsc_bind_snapshots` | one row per poll: `outbound_rate`, `inbound_rate`, `sent`, `received`, `queued`, `failed`, `observed_at` | SMSC TPS/capacity, carrier TPS, dashboard queue pressure |
| `smsc_bind_transitions` | append-only bind history, **never pruned** | last event, reconnect counts, all Timelines |
| `sent_sms` (SQLBox) | MT↔DLR correlated on `foreign_id`, both timestamps | delivery rate, DLR P50/P95/P99 |
| `metric_samples` | `smsc.sent/received/queued/failed/throughput.*` per poll | alert rules |

### Genuinely not measurable — do not build these
Enquire-link RTT, per-session timeouts, P95 submit latency, top `command_status`,
throttle rate (Kannel exposes none through `/status.json`; only bearerbox logs
carry them). Per-service CPU/memory (backend has no Docker socket — deliberate
boundary). Per-queue retry counts. Real session counts (`instances = N` collapses
behind one `smsc-id`).

**When a value is not measured, render `unknown` — never `0`, never a dash.**
`SUM()` over zero rows is NULL in Postgres, which is exactly the distinction to
preserve. The design system does this too, so it is faithful, not a cop-out.

---

## 5. Hard constraints — do not violate

- **Never recreate `jkannel-kamex-bearerbox-1`.** sqlbox does not reconnect when
  bearerbox restarts: sending wedges silently with every metric green.
  `scripts/deploy.sh` aborts if the container id changes.
- **Never touch the `cpaas-*` containers, the 3 PM2 processes
  (`auth-service`, `messaging-service`, `console-web`), or
  `/etc/nginx/sites-available/speedamobile`.** JKANNEL has its own nginx site.
- **Never commit `smpp.carrier.example` carrier details** (`smpp.carrier.example:4089`, `carrier-user`, egress
  `203.0.113.10`). `.env` only, which is gitignored.
- **`docker-compose.override.yml` is gitignored** and exists only on the server.
  `deploy.sh` checksums it before and after the pull.
- Documentation lives in `docs/`, not the repo root.

---

## 6. Deploying

```powershell
cd d:\JKANNEL
scp scripts/deploy.sh hyeroba@gw1.speedamobile.com:/tmp/deploy.sh
ssh hyeroba@gw1.speedamobile.com "bash /tmp/deploy.sh; rm -f /tmp/deploy.sh"
```

**Copy the file; do not pipe it.** `Get-Content -Raw | ssh "bash -s"` re-adds
CRLF in the PowerShell pipeline even when the file on disk is pure LF, and the
remote bash then fails on the last line with `$'\r': command not found`. The
deploy itself succeeds, so it presents as a script that reports failure on
success — which is how people learn to ignore a red exit code.

The script repairs file ownership **before** pulling. This matters: a `sudo git`
run leaves root-owned files, `git merge` then fails partway through checkout —
new content on disk, HEAD unmoved — and the deploy looks like it silently did
nothing. It also aborts if the tree is dirty after merge, and if bearerbox moves.

**Verifying a deploy:** a 200 proves nginx answers, not that new code shipped.
Grep the served bundle. Lazy-route views (most screens) are in their **own
chunks**, not the entry bundle:

```bash
docker exec jkannel-frontend-1 sh -c "ls /usr/share/nginx/html/assets | grep CarrierDetailView"
docker exec jkannel-frontend-1 grep -c -F "Recent carrier events" /usr/share/nginx/html/assets/<chunk>
```

---

## 7. Credentials

**Local, verified working:** tenant `default`, user `operator`, password
`JkannelLocal2026!`.

**Production: I do not have a verified console password and have never printed
one.** Passwords are scrypt-hashed and unreadable; `.env` holds only
infrastructure secrets. Earlier in this project I stated a password I had never
read and it was wrong — do not guess. Either ask, or run a reset and report the
value actually set.

Local users: `operator` (administrator), `analyst1` (administrator), `newop2`
(**no role** — can sign in and see nothing). There is currently no account per
role, so role-by-role review is not possible without creating some.

---

## 8. Recurring traps

- **PowerShell eats double quotes in ssh commands.** Write a `.sh` to a file, fix
  line endings to LF, `scp`, then `ssh "bash /tmp/x.sh"`.
- **`Get-Content` without `-Encoding` mangles UTF-8.** Use
  `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`. Em dashes and
  arrows have been corrupted this way before; `.gitattributes` now forces
  `*.sh eol=lf`.
- **Backticks inside a JS template literal terminate it.** A SQL comment
  containing `` `table_name` `` broke a build.
- **Teleported components escape the test wrapper.** `DetailDrawer` renders into
  `<body>`, so `wrapper.find` cannot see it. Use a helper that checks the wrapper
  first, then `document.body`, and clear `document.body.innerHTML` between mounts.
- **`export const` inside `<script setup>`** passes `vue-tsc` and fails the SFC
  compiler — it silently dropped 73 tests from the suite once. Put shared
  constants in a `.ts` module.
- **Docker Desktop wedges** (`ps` works, `build` hangs, `dockerd` absent). Kill
  the Docker processes, `wsl --shutdown`, relaunch Docker Desktop.

---

## 9. Next batch

Take these five, in this order — every one uses a pattern already proven:

1. **Test Tools** — 5 panels, the largest remaining gap. Needs `Tabs`; the
   `ConfirmAction` component already exists.
2. **Routes** — `Carrier routes` and `Continuity` panels, plus Active target /
   Alternatives / Last transition / Used-vs-capacity. Same sources as Failover.
3. **Engine Config** — only `Generated configuration` remains; it needs the
   DEPLOYED config content, not the draft the composer holds.
4. **Performance** — `Gateway latency` and `Capacity` panels.
5. **Traffic** — `Traffic matrix`. Note LiveTrafficView has no server-side time
   series, only browser-tracked peaks, so a matrix would have to be invented —
   check this one before building.

**Working rhythm that has held up:** read the kit screen's JSX → check the
feasibility table in §4 → build only what has data → `screen-diff` to confirm →
`route-smoke` to prove nothing broke → commit with the reasoning → deploy →
grep the served chunk.

Commit after each screen. Two screens that conform beat five that half-do.
