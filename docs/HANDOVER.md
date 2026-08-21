# JKANNEL — implementation handover

**Last updated:** 2026-08-21 · **Production:** `0f5d422` · **main:** `0f5d422`

Two long-running jobs finished in this session. Both are measured, and the
measurements are committed as scripts so nobody has to take this on trust.

| Question | Tool | Answer |
|---|---|---|
| Does the console look like the design system? | `scripts/screen-diff.mjs` | **0 panels, 0 columns, 1 primitive absent** (down from 36/74/25) |
| Does every API endpoint have a screen? | `scripts/endpoint-coverage.mjs` | **0 with no surface** (325 surfaced, 18 headless, 5 superseded) |
| Does anything crash? | `scripts/route-smoke.mjs` | **50/50 routes rendered, 0 crashed** |

Tests: **674 frontend · 2,022 backend**, green.

---

## 1. The rules this work follows

1. **Compare against the rendered kit**, never only its source. The kit ships a
   self-contained `index.html`; `scripts/kit-shots.mjs` opens it and photographs
   both sides.
2. **Check what the poller already records before assuming anything needs
   building.** `smsc_bind_snapshots` and `smsc_bind_transitions` had been
   carrying per-bind throughput and full bind history for months while screens
   showed `unknown`.
3. **Only build what has a real endpoint. Omit the rest entirely** — never a
   dash, never a zero. Where a value exists but was not measured, render
   `unknown`. Where the engine cannot report something, say so in words on the
   screen.
4. **Match the kit's names where the meaning matches; diverge where the name
   would make the screen assert something it cannot see.**

Rule 3 is the one that produced the most work, because honouring it means
finding out what is actually measurable rather than guessing. Several things
the previous handover listed as impossible turned out to be measurable
(per-bind oldest-message age, service uptime, last-seen), and several the kit
draws turned out not to be (gateway submit latency, carrier throttle rate,
per-service CPU).

---

## 2. What is NOT measurable — do not build, do not stub

Each of these is stated on the screen that would have shown it, with the reason:

| Not measurable | Why | Said on |
|---|---|---|
| Gateway submit latency, internal queue wait | Kannel's status interface reports counters and rate averages, never per-message timings | Performance |
| Carrier throttle rate | A refusal is an SMPP `command_status` on the submit response; bearerbox records neither it nor a count | DLR Performance, SMPP Errors |
| Per-session identity, timeouts, enquire-link RTT | `instances = N` collapses N sessions behind one `smsc-id` | SMSC Detail, SMPP Sessions |
| Per-service CPU and memory | No Docker socket, deliberately — an API that can inspect its siblings is a much larger blast radius | Services |
| Service restart | Same reason. The console says which component to restart and does not pretend it can | Services |

`SUM()` over zero rows is NULL in Postgres. That is exactly the distinction to
preserve.

---

## 3. Tools — run before and after every change

```powershell
node scripts/screen-diff.mjs         # panels/columns/primitives absent, per screen
node scripts/endpoint-coverage.mjs   # which API operations have no console surface
node scripts/route-smoke.mjs         # all 50 routes: crashes, HTTP errors, empty views
node scripts/column-feasibility.mjs  # which missing columns have data behind them
node scripts/kit-shots.mjs           # renders the KIT and ours, side by side
node scripts/design-diff.mjs         # CSS conformance
```

> Playwright scripts must be **copied into `e2e/`** to resolve `@playwright/test`:
> `Copy-Item scripts/route-smoke.mjs e2e/route-smoke.tmp.mjs` then
> `node e2e/route-smoke.tmp.mjs`. `e2e/*.tmp.mjs` is gitignored.

### These tools lie in one direction, and it is always the same direction

**Six false positives were found and fixed in them this session.** Every one
reported work as already done:

1. Exact string matching missed `/alerts/${id}/${transition}` — one call serving
   six operations, reported as six gaps.
2. The literal scanner truncated templates at the first quote inside a hole, so
   Message Trace's own endpoint looked unsurfaced.
3. A hole glued to a literal (`/…/lifecycle{}`) matched nothing.
4. `/sessions/export.${format}` collapsed to a trailing dot — Sessions has had
   working export buttons the whole time.
5. `screen-diff`'s Tabs detector matched the **word** "Tabs" in a prose comment.
6. **`/{}` in the API Reference matched every one-segment endpoint**, hiding the
   entire `/jobs` resource.

If a tool says something is done, be suspicious in that direction specifically.

---

## 4. The working rhythm

1. Read the kit screen's JSX in `design/JKANNEL design system/ui_kits/console/`.
2. Check §2 — does the data exist? If not, **omit and say why on the screen**.
3. Build. Reuse the primitives in §5.
4. `npm run build` — **not** `npx vue-tsc --noEmit`. See §7.
5. `npx vitest run` (frontend) and `npx jest --silent` (backend).
6. `node scripts/screen-diff.mjs` and `node scripts/endpoint-coverage.mjs`.
7. `node e2e/route-smoke.tmp.mjs` to prove nothing broke.
8. **Verify against the live stack**, not just the tests. Run the SQL in psql,
   call the endpoint with a token. Every backend change this session was checked
   that way and two would otherwise have shipped broken.
9. Commit with the reasoning — *why*, not just what.

---

## 5. Shared primitives — built, reuse them

| Component | Notes |
|---|---|
| `EventTimeline.vue` | the design's Timeline. `missing` = hollow dashed dot for a step that never arrived. `dense` prop. |
| `TabStrip.vue` | the design's Tabs, with the roving tabindex the ARIA role promises. Renders the strip only; the parent owns the panels. |
| `DetailDrawer.vue` | right-hand sheet, focus trap, Escape closes, focus returns. `wide` prop. |
| `ConfirmAction.vue` | impact before the verb. Fetches from `/control/smscs/:id/impact/:op`, or takes a caller-supplied impact read from an API response. |
| `CodeConsole.vue` | macOS terminal window. |
| `ScopePicker.vue` | gateway API-key scopes with descriptions. |
| `MiniChart.vue` | line/area/bar; `series`, `labels`, `title`, `height`, `grid`. |
| `ObservabilityLimits.vue` | what one SMSC connection cannot report. Speaks about a connection — do not reuse it for gateway-wide statements. |

---

## 6. Hard constraints — never violate

- **Never recreate `jkannel-kamex-bearerbox-1`.** sqlbox does not reconnect when
  bearerbox restarts: sending wedges silently with every metric still green.
  `deploy.sh` aborts if the container id changes. Starting a stopped container
  with `docker start` is fine — that keeps the same container.
- **Never touch `cpaas-*` containers, the 3 PM2 processes (`auth-service`,
  `messaging-service`, `console-web`), or `/etc/nginx/sites-available/speedamobile`.**
- **Never commit `smpp.carrier.example` carrier details** (`smpp.carrier.example:4089`, `carrier-user`, egress
  `203.0.113.10`). `.env` only — gitignored.
- **`docker-compose.override.yml`** is gitignored and exists only on the server.
- Documentation lives in `docs/`, never the repo root.

---

## 7. Traps, all hit at least once

- **`npx vue-tsc --noEmit` passes on code `npm run build` rejects.** The build
  is the gate.
- **`export const` inside `<script setup>`** passes vue-tsc, fails the SFC
  compiler, and once silently dropped 73 tests. Shared constants go in a `.ts`.
- **A backtick inside a SQL comment terminates the JS template literal holding
  the query.** Hit twice. Do not put backticks in SQL comments.
- **PowerShell's `.Replace()` / `-replace` on a file mangles UTF-8** — em dashes
  became `â€"` and the file had to be reverted. Use the Edit tool.
- **PowerShell eats double quotes in ssh commands.** Write a `.sh`, normalise to
  LF, `scp`, then `ssh "bash /tmp/x.sh"`. Never pipe a script over ssh: the
  pipeline re-adds CRLF and remote bash fails on the last line.
- **Teleported components escape the test wrapper.** `DetailDrawer` renders into
  `<body>`. Clear `document.body.innerHTML` between mounts.
- **Nav counts are asserted in two specs.** Adding a sidebar entry breaks
  `navigation.spec.ts` and `app-shell.spec.ts` on purpose — a route should not
  appear without somebody deciding it should.
- **Backend suite has an occasional worker-teardown flake.** One failure that
  passes on re-run is not real.

---

## 8. Deploying

```powershell
cd d:\JKANNEL
scp scripts/deploy.sh hyeroba@gw1.speedamobile.com:/tmp/deploy.sh
ssh hyeroba@gw1.speedamobile.com "bash /tmp/deploy.sh; rm -f /tmp/deploy.sh"
```

`deploy.sh` repairs file ownership **before** pulling (a `sudo git` run leaves
root-owned files and `git merge` then fails partway through checkout, which
presents as a deploy that silently did nothing), aborts on a dirty tree, and
aborts if bearerbox moves.

**Verifying:** a 200 proves nginx answers, not that new code shipped. Most views
are lazy routes in their own chunks:

```bash
docker exec jkannel-frontend-1 sh -c "grep -rl 'Traffic matrix' /usr/share/nginx/html/assets"
curl -s http://127.0.0.1:8081/api/v1/openapi.json | grep -c '/performance/throughput'
```

The OpenAPI document is generated from registered routes, so a path appearing in
it proves the new backend is the one answering.

---

## 9. The one remaining design gap, and why it stays

`screen-diff` reports **1 primitive absent**: `ConfirmAction` on Service Detail.
The design puts a restart button there. There is no restart endpoint and there
cannot be one without a Docker socket this container deliberately does not have.
A dialog that opened and then failed would be worse than no button, so the
screen says the console tells you which component to restart and why, without
pretending it can do it.

That is the only intentional divergence. Everything else in the kit is built.

---

## 10. Credentials

**Local, verified:** tenant `default`, user `operator`, password
`JkannelLocal2026!`.

**Production: there is no verified console password and none has ever been
printed.** Passwords are scrypt-hashed; `.env` holds only infrastructure
secrets. Earlier in this project a password was stated that had never been read,
and it was wrong. **Do not guess.** Ask Peter, or run a reset and report the
value actually set.

Local users: `operator` (administrator), `analyst1` (administrator), `newop2`
(**no role** — signs in and sees nothing; the Users grid now says so in words).

---

## 11. Open questions for Peter

- **Demo data.** The kit is a mock: it shows `530/s` throughput and four
  invented failover events. Locally the engine runs with two fake SMSCs and no
  traffic, so most figures read `0` or `unknown` — correctly. Screens will not
  look like the kit's screenshots until real traffic flows. A seed script would
  fix this for a demo; it has been offered and not asked for, and it would be
  the first fabricated data in the product.
- **Role accounts.** Both real local users are administrators, so there is no
  way to review what a restricted role actually sees. Every screen has
  permission-aware copy that has never been seen by a user who lacks the
  permission.
- **Two superseded write endpoints.** `POST /backups/:id/restore` and `/verify`
  are the legacy platform-console controller; `/backup-dr` is the real one and
  is what the console calls. They are not equivalent — the newer restore goes
  into an isolated verify database. Both are live and reachable. Worth deleting.
