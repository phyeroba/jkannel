# Console redesign — what is done, what is not

Living checklist for the 2026-09/10 redesign. **Update it in the same commit
as the work**, not afterwards: this file exists because a context compaction
already cost one full set of design material, and because "which screens are
done" is otherwise only answerable by clicking through production.

**2026-10-06, end of the evening session: everything below is deployed**
(production is on `3f4258b`). Next task is the rest of the dialogs — see
"Resume here".

**The sweep, v2 — read this before auditing anything.**
`node scripts/screen-sweep.mjs` now walks in **two phases** and clicks **every**
opener, not one:

```
BASE=https://gw1.speedamobile.com U=operator P=... OUT=<dir> node scripts/screen-sweep.mjs
ONLY=/alerts,/carriers  …same…      # a subset
SKIP_DIALOGS=1 / PHASE1=1           # faster passes
```

Phase one is the `navigation.ts` routes. Phase two is **every screen reached
only by a link** — the carrier, SMSC and message detail pages, none of which
is in the navigation and none of which any audit had visited before
2026-10-06. It also clicks the first register row, for the drawer, and reports
**which table** overflows by panel name and column count, not just a pixel
count — two fixes went at the wrong table before it did that.

It also reports `dialog +N`: a dialog taller than the window. That is how the
SMSC editor's Save button was found 1,156px below the fold.

The artifact at `claude.ai/artifact/FQ9MVFVexZesG8WzcGgheJ` carries the
before/after screenshots.

- **Authority**: `docs/handbook/CONSOLE_DESIGN_SPEC.md` (supersedes
  `design/design_spec/` for everything it covers)
- **Source material**: `design/redesign-2026-09/` — six `.dc.html` pages from
  the design pass plus the original write-ups (gitignored; they render against
  production data). These are the authority, not screenshots.
- **Audits** (both read every route from `navigation.ts`):
  `node scripts/layout-audit.mjs` · `node scripts/overflow-audit.mjs`
- **Build check**: `npm run build` in `frontend/`, **not** `vue-tsc -b` — only
  the `vite build` half catches an unbalanced template tag
- **Deploy**: `scripts/prod-ssh.ps1`, then on the host
  `cd /home/hyeroba/jkannel && git pull --ff-only && docker compose build
  frontend backend && docker compose up -d --no-deps frontend backend`

---

## Live on production (commit `a50a3dd`)

| Screen | What it got |
|---|---|
| `/dashboard/operations` | **Rebuilt whole.** Controls bar (range, live countdown, refresh); status line naming the degraded and silent carriers with a way into the worst; Copilot question box with three state-derived starters; four figures; Carriers first with 6 columns, per-bind bars and a side panel; Platform merging services and queue pressure; Traffic with totals and paired bars oldest→newest; Incidents with open/resolved counts |
| `/alerts` | Summary strip (open split by severity, unacknowledged, resolved 30d, **median** time to resolve), tabs with counts opening on Open, live line with Pause, relative times, bulk acknowledge/re-notify, 14 → 8 columns |
| `/alerts` side panel | Actions at the top, 130px field grid, uppercase TIMELINE with a rail |
| `/notifications` | Inbox: list grouped by recency with counts, reading pane, compact `0 msgs · 0 DLRs · 09-29 → 09-30` lines, amber run-of-empty-reports bar |
| `/alert-response` | Verdict banner with the age of the check, five readiness figures, channels as cards with the fix as a link, escalation chain as a step rail marking skipped steps |
| `/routing`, `/routing-advanced` | One component, two column sets. Summary strip, live tester with per-route verdicts from the engine, tabs with counts, failover as a chain, wildcard lists shortened |
| Route editor | Four-step side panel. Save names what is missing, priority warns when taken, no-fallback warns, days are toggle buttons, a live sentence says what the route will do. Fifth step (change reason) on edit |
| Navigation | 50 entries, 50 distinct icons (was 16 shared across 50) |
| Registers (11 screens) | Column grouping: carriers 16→8, messages 14→7, SMSC 12→6, backup 13→7, sessions 8→5, alert lifecycle 13→7 |
| Backend | `GET /alerts/summary` (whole-table tally incl. median TTR); per-route verdicts from `selectRoute`; `POST /auth/login` 500 → 400 on a malformed body; `CARRIER_*` secrets reaching the API container |

## On `main`, not yet deployed

| Screen | What it got |
|---|---|
| `/sessions-smpp` | **Rebuilt whole.** Verdict line naming the binds that are not bound with a way into the worst (never green on an absence of evidence); four figures; tabs with page counts + live line with Pause at 30s; 13 → **7 columns** (Since / Last observed / Last transition grouped; rate / ceiling / utilisation one cell with the ratio drawn); **bind timeline capped** to a scroll region that states `40 most recent of N`, with a Problems filter; drawer transitions capped too; scope note folded into a disclosure |
| `/alert-lifecycle` | **Rebuilt to the house shape.** Tabs carrying **whole-table** counts from `GET /alerts/summary`, each setting the server-side status filter so the number and the rows agree; a verdict leading on *unclaimed* with the age of the oldest; the live line in place of four controls; severity as a segmented control; the sheet leading with Acknowledge / Resolve / Reopen / Close, then a 130px field grid with relative times, then a capped timeline |
| Shared CSS | The house bands (`.screen-head`, `.status-line`, `.tab`, `.live-line`, `.segmented`, `.table-foot`, `.capped-list`) and the side panel (`.panel-actions`, `.panel-fields`, `.panel-heading`, `.sev-dot`) defined **once** in `workspace-extras.css` instead of four scoped copies. Existing copies still win on specificity, so nothing moved; they come out as each screen is next touched |

**Audits**: layout audit **0 findings** across 50 routes as of `a50a3dd`.
Frontend **750 tests pass** (736 + 14 new); backend **2,045 pass** (run
serially — parallel workers get killed by memory pressure on this machine).

> **The overflow audit could not be re-run on 2026-10-06**: Docker Desktop's
> engine is returning HTTP 500 on every call, so the local stack is down and
> `BASE=http://127.0.0.1:15173` has nothing behind it. `/sessions-smpp` went
> from 13 columns to 7 and every opaque value is capped, so it should be at
> zero — but that is reasoning, not a measurement, and it stays unmeasured
> until the stack is back or the audit is pointed at production.

---

## Resume here

### The overflow backlog is closed

All thirteen screens are at zero, measured on production, including the six
the navigation never linked to. The table of before/after is in
`project/CHANGELOG.md` and in the artifact.

### The create/edit dialogs are done

user · API client · backup · backup schedule · recipient policy · reference
record · inbound rule · content rule · report definition · carrier · route —
all have the grouped shape: a subtitle saying what the record is for, named
fieldsets, a hint under every field, REQUIRED markers, a sentence stating
what will happen, and a Save that **lists what is missing** rather than being
grey for a reason it will not give.

### What is left

1. **The remaining read-only screens.** The sweep captures them all; nothing
   on them is broken, but several have not been looked at with the five-band
   shape in mind — `/api-reference` (4,685px), `/messages` (5,779px),
   `/sessions` (5,187px), `/delivery-reports` (3,953px), `/system` (3,799px).
   Tall is not automatically wrong, but those are the candidates.
2. **The drawers.** The sweep now captures the one behind a row click on
   every register. Alerts, lifecycle, SMSC and carriers have the house sheet;
   the rest are still the generic drawer.
3. **`/traffic` is a second copy of the dashboard** reached by a link and not
   in the navigation. Decide whether it should exist.

## CPaaS integration — state as of 2026-10-06 evening

- **KAMEX approved** and added to CPAAS-SMSONE's allowed senders (audited).
- **Loopback bind fixed.** Both fake SMSCs had been *stopped through the
  admin API* on 2026-09-29 21:45 and never restarted, so bearerbox was not
  listening on 10000 at all. `local-fake` restarted and bound. Not
  `local-fake-b` — it is the MTN route's fallback target.
- **`GET /gateway/messages?foreignId=`** built, deployed, verified.
  `whoami` now returns `customerId`.
- **CPaaS's four live sends were refused at routing.** The KAMEX route exists
  and matched; its only target is `kamdixy`, which is retrying, and it has no
  fallback. `kololo` is bound. **Peter decided 2026-10-06 and again on
  2026-10-07: change nothing** — no re-point, no fallback.
- **Correction, 2026-10-07:** kamdixy is NOT a standing outage. It was bound
  from 2026-09-30 06:20 to **2026-10-06 07:33** — six days — and dropped five
  hours before the CPaaS test. The "refused since 8 September" line was
  `kololo`'s old outage carried forward. **Read bind claims from
  `smsc_bind_transitions`, never from an earlier note.**
- **Peter's own working tests bypassed routing.** His 2 October decision row
  is `outcome = explicit` — the console pinned the smscId, so the route and
  its missing fallback were never consulted. That is why his sends worked and
  CPaaS's did not, on the same configuration.
- **Testing today needs no change:** pin `smscId: "kololo"`, which is bound.
  Told to CPaaS as a temporary, testing-only exception to §9.2.
- **2026-10-07 03:17 UTC — VERIFIED WORKING.** Four messages sent from
  JKANNEL, sender `KAMEX`, pinned to `kololo`; all four reached Peter's
  handsets and all four were ACKed by the carrier. The send path is healthy;
  one carrier bind is down and nothing else.
- **kololo and kamdixy are two binds to ONE upstream** — `8888.ug:4089` and
  `:4098`. The 2 October message went out on kamdixy and its receipt came
  back on kololo. Pinning kololo is the same carrier, not a detour.
- **Still to do:** observe `%d` substitution and `dlr_url` rewriting through
  the restored loopback bind, and answer CPaaS questions 1 and 2 with that
  evidence.

## Worth telling Peter

- **Production has 1 of 3 routes with a fallback.** CPAAS-SMSONE and KAMEX
  have none, so if Kololo or Kamdixy drops, their messages queue rather than
  re-route. A configuration decision, not a defect — but now visible on the
  Routing summary strip.
- **The kamdixy carrier still refuses us.** `8888.ug:4098` rejects the
  connection from `34.134.248.1`. Our side is verified clean: the credential
  resolves in the API container, so "Test connection" attempts a real bind
  and reports the carrier's refusal rather than blaming itself. Open since
  8 September; the drafted message to the carrier is still unsent.

## Constraints that still hold

- Never recreate `jkannel-kamex-bearerbox-1` without asking. Deploys use
  `docker compose up -d --no-deps frontend backend`, which leaves the Kamex
  chain running.
- The 8888.ug and kamdixy credentials never reach the repo.
- On the shared VM, touch only `jkannel` and `cpaas`.
- Production console login is `operator`, password in
  `docs/CREDENTIALS.local.md`, tenant **`default`** — not `1`. Two API logins
  were wasted on that.

## Lessons that cost something, so they are not paid twice

- `vue-tsc -b` does not check template structure, and a failed container
  build leaves the previous image serving — so an audit run straight after
  one measures yesterday. Always read the build result.
- `display: flex` on a `td` destroys its cell semantics; put the flex on a
  span inside. Same for `-webkit-line-clamp`, which needs
  `display: -webkit-box`.
- `.row-id` sets `display: block`; a clamp class at equal specificity loses to
  it. `.row-id.clamp-1` is the form that works.
- `width: 1%` on a column means "1% is my preferred width", not "shrink to
  fit", and can starve the one control the row has.
- A `min-height` is a floor and beats `height`. Three guesses went into the
  dashboard's refresh button before measuring it.
- Grouping columns trades width for height — run **both** audits.
- Every icon name the navigation uses must exist in `AppIcon.vue`; a missing
  one silently falls back to a cog.
- **Do not ship a partial pass as the redesign.** The dashboard was patched at
  the top once and presented as done; it was not, and Peter was right to say
  so. Build the whole screen from the `.dc.html`, then deploy.
