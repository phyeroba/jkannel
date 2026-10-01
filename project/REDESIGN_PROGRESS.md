# Console redesign — what is done, what is not

Living checklist for the 2026-09/10 redesign. **Update it in the same commit
as the work**, not afterwards: this file exists because a context compaction
already cost one full set of design material, and because "which screens are
done" is otherwise only answerable by clicking through production.

- **Authority**: `docs/handbook/CONSOLE_DESIGN_SPEC.md` (supersedes
  `design/design_spec/` for everything it covers)
- **Source material**: `design/redesign-2026-09/` — six `.dc.html` pages and
  the original write-ups (gitignored; they render against production data)
- **Audits** (both read every route from `navigation.ts`):
  `node scripts/layout-audit.mjs` · `node scripts/overflow-audit.mjs`
- **Build check**: `npm run build` in `frontend/`, not `vue-tsc -b` — only the
  `vite build` half catches an unbalanced template tag

---

## Done and live on production

| Screen | What it got |
|---|---|
| `/alerts` | Summary strip (open split by severity, unacknowledged, resolved 30d, **median** time to resolve), tabs with counts opening on Open, live line with Pause, relative times, bulk acknowledge/re-notify, 14 → 8 columns |
| `/alerts` side panel | Actions at the top, 130px field grid, uppercase TIMELINE with a rail. Holds the columns that were an em dash on most rows |
| `/notifications` | Rebuilt as an inbox: list grouped by recency with counts, reading pane, compact `0 msgs · 0 DLRs · 09-29 → 09-30` lines, amber run-of-empty-reports bar |
| `/alert-response` | Verdict banner with the age of the check, five readiness figures, channels as cards with the fix as a link, escalation chain as a **step rail** marking skipped steps |
| `/routing`, `/routing-advanced` | One component, two column sets. Summary strip, live tester with per-route verdicts, tabs with counts, failover stated as a chain, wildcard lists shortened |
| Navigation | 50 entries, 50 distinct icons (was 16 shared across 50) |
| Registers (11 screens) | Column grouping: carriers 16→8, messages 14→7, SMSC 12→6, backup 13→7, sessions 8→5, alert lifecycle 13→7, dashboard panels 11→6 and 5→4 |
| Backend | `GET /alerts/summary` (whole-table tally), per-route verdicts from `selectRoute`, `POST /auth/login` 500 → 400 on a malformed body, `CARRIER_*` secrets reaching the API container |

## Done, awaiting deploy

| Item | Notes |
|---|---|
| Route editor | Four-step side panel replacing the centre dialog. Save names what is missing, priority warns when taken, no-fallback warns, days are toggle buttons, a live sentence says what the route will do. Fifth step (change reason) on edit |
| Operations dashboard | **Rebuilt whole**, not patched. Controls bar (range, live countdown, refresh); status line naming carriers; Copilot question box with three starters; four figures; Carriers first, 6 columns with per-bind bars and a side panel; Platform merging services and queue pressure; Traffic with totals and paired bars running oldest→newest; Incidents with open/resolved counts |

## Not started

In the order they will be done.

1. **`/sessions-smpp`** — the bind timeline pane is far too long. Cap it to a
   scroll region with a count, as the drawer histories were. Also 588px of
   horizontal overflow across 13 columns.
2. **`/alert-lifecycle`** — columns were grouped but the screen has not had
   the house style: no summary strip, no tabs with counts, and its drawer is
   still the generic one.
3. **Remaining dialogs** — every `ModalDialog` caller that is a create/edit
   form wants the grouped-fieldset treatment the Carriers dialog got.
4. **Overflow backlog** — 16 findings open on production. Worst first:
   `/routing` is now rebuilt so re-measure; then `/roles` +484,
   `/logs-audit` +475, `/sessions-smpp` +440, `/log-explorer` +377,
   `/content-rules` +365, `/live-traffic` +309, `/dlr-performance` +207,
   `/reports` +196, `/configuration` +169, `/queues` +164 and +132,
   `/alert-response` +130.

## Open questions for Peter

- Production has **1 of 3 routes with a fallback**. CPAAS-SMSONE and KAMEX
  have none, so if Kololo or Kamdixy drops, their messages queue rather than
  re-route. Configuration decision, not a defect — but now visible.

## Constraints that still hold

- Never recreate `jkannel-kamex-bearerbox-1` without asking; deploys use
  `docker compose up -d --no-deps frontend backend`.
- The 8888.ug and kamdixy credentials never reach the repo.
- On the shared VM, touch only `jkannel` and `cpaas`.
