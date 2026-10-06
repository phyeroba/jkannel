# Console redesign — what is done, what is not

Living checklist for the 2026-09/10 redesign. **Update it in the same commit
as the work**, not afterwards: this file exists because a context compaction
already cost one full set of design material, and because "which screens are
done" is otherwise only answerable by clicking through production.

**Resumed 2026-10-06.** `/sessions-smpp` and `/alert-lifecycle` are done and on
`main`; production is still on `a50a3dd` until the next deploy. Next task is
the dialogs — see "Resume here".

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

### 1. Remaining dialogs — next task

Every `ModalDialog` caller that is a create/edit form wants the grouped
fieldset treatment the Carriers dialog got; the bigger ones want the
four-step side panel the route editor got. **Walk the links and buttons on
each screen** — Peter's repeated point was that drill-downs were being
missed while the top of the page got rebuilt.

### 2. Overflow backlog

16 findings open on production. Re-measure first: `/routing` has been rebuilt
since the list was taken. Worst first after that:
`/roles` +484 · `/logs-audit` +475 ·
~~`/sessions-smpp` +440~~ (rebuilt, unmeasured) · `/log-explorer` +377 · `/content-rules` +365 · `/live-traffic` +309 ·
`/dlr-performance` +207 · `/reports` +196 · `/configuration` +169 ·
`/queues` +164 and +132 · `/alert-response` +130.

---

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
