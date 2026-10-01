# Console redesign — what is done, what is not

Living checklist for the 2026-09/10 redesign. **Update it in the same commit
as the work**, not afterwards: this file exists because a context compaction
already cost one full set of design material, and because "which screens are
done" is otherwise only answerable by clicking through production.

**Stopped 2026-10-01 at commit `a50a3dd`, which is also what production is
running.** Local tree clean. Next task is `/sessions-smpp` — see "Resume
here".

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

**Audits at the stopping point**: layout audit **0 findings** across 50
routes. Frontend **736 tests pass**; backend **2,045 pass** (run serially —
parallel workers get killed by memory pressure on this machine).

---

## Resume here

### 1. `/sessions-smpp` — next task, not started

Peter's report: *"the bind timeline pane is too long, either paginate it or
make it look better"*. Two separate problems on that screen:

- The **bind timeline pane** grows without bound. Fix it the way the SMSC
  drawer histories were: cap to a scroll region of about six rows with a
  count beside the heading (`.drawer-body .sample-list` in
  `workspace-extras.css` is the existing pattern), or paginate with
  `TablePager`.
- **588px of horizontal overflow across 13 columns.** Group them as the other
  registers were — three separate timestamp columns (Since, Last observed,
  Last transition) are one "Age" cell.

Also: Peter reported earlier that this page "does not work". It loads and
every API call returns 200 in both environments, so the timeline is the most
likely reason it looked broken.

### 2. `/alert-lifecycle`

Columns were grouped but the screen never got the house style: no summary
strip, no tabs with counts, and its drawer is still the generic one. Follow
`/alerts` — closest sibling, settled pattern.

### 3. Remaining dialogs

Every `ModalDialog` caller that is a create/edit form wants the grouped
fieldset treatment the Carriers dialog got; the bigger ones want the
four-step side panel the route editor got. **Walk the links and buttons on
each screen** — Peter's repeated point was that drill-downs were being
missed while the top of the page got rebuilt.

### 4. Overflow backlog

16 findings open on production. Re-measure first: `/routing` has been rebuilt
since the list was taken. Worst first after that:
`/roles` +484 · `/logs-audit` +475 · `/sessions-smpp` +440 ·
`/log-explorer` +377 · `/content-rules` +365 · `/live-traffic` +309 ·
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
