# Redesign: Alerts, Escalation & Maintenance, Notifications

Source: Peter's 2026-09-30 message, which carried six screenshots (before and
after for each of the three screens) plus the full write-up from the design
pass. The screenshots are in `design/redesign-2026-09/` — **gitignored**,
because they are production captures showing live alert text, bind names and
the production hostname. The write-up is preserved verbatim beside them in
`design-feedback.md`.

This file exists because that material was lost once already. It arrived as
image attachments on a single message; a context compaction flattened that
message to a six-line summary, the images went with it, and the work that
followed was built from the summary instead of from the design. Anything that
is only in an attachment is one compaction away from being gone, so the
requirement is written down here as text.

**This is the visual authority for these three screens.** Where it disagrees
with `design/design_spec/` (July 2026), this wins — it is newer and it is what
was asked for.

---

## 1. Alerts (`/alerts`)

### What it looks like now

Four stacked panels: a filter block, a separate auto-refresh block, then the
register. Sixteen columns, several of which are `—` on every row (rule,
correlation, suppressed until). A four-line paragraph of lifecycle help sits
above the table. Two separate export buttons.

### Target

**Header row.** Title and subtitle on the left. On the right, two controls
only: `Schedule maintenance` (secondary) and `Export ▾` (a menu — CSV and PDF
are items in it, not two buttons on the toolbar).

**Summary strip.** Four cards in a single row, never stacking to leave one card
alone. Each is: small grey label, large figure, small caption.

| Label | Figure | Caption |
|---|---|---|
| Open | `3` | `2 critical · 1 warning` — critical in red |
| Unacknowledged | `3` | `Oldest opened 56d ago` |
| Resolved · 30 days | `9` | `All closed by the rule evaluator` |
| Median time to resolve | `13h 29m` | `Across resolved alerts` |

**Tabs with counts.** `Open 3` · `Acknowledged 0` · `Resolved 9` · `All 12`.
Underlined active tab, count in a rounded pill. Opens on **Open**, not All.

**Live line.** Right of the tabs, on the same row:
`● Live · updated 3s ago · every 30s` followed by `Pause` and `Refresh`.
This replaces the whole auto-refresh panel — no `Auto refresh [On] Every [30s]`
selects.

**Filter row.** A wide search box (`Filter by condition, resource, rule or ID`),
a severity segmented control (`All` / `● Critical` / `● Warning`), and a sort
toggle reading `Newest first`.

**Table — eight columns.**

1. Checkbox (bulk select)
2. `SEVERITY` — a small colour square plus the word
3. `CONDITION` — the summary, with `source · shortid` in mono underneath
4. `STATUS` — dot plus word in a pill
5. `COUNT` — the occurrence count
6. `OPENED` — relative: `34d ago`. Exact timestamp on hover
7. `DURATION` — `34d 18h`
8. `ASSIGNEE` — or `Unassigned`
9. Actions — `Acknowledge` (primary) and `Re-notify`, then a `›` chevron that
   opens the side panel

**Side panel.** Opens on the chevron or the row. Holds the columns removed from
the table (rule, correlation, suppressed until, notification state), a timeline
— opened → notified → acknowledged → resolved — and the action buttons.

**Bulk actions.** Selecting rows reveals a bar that can acknowledge or re-notify
the selection at once.

**Footer.** One line: `Showing 3 of 12` on the left; on the right the lifecycle
help reduced to a single sentence with links — "Resolve, assign, suppress and
comment from an alert's *lifecycle*. For planned work, use a *maintenance
window*."

---

## 2. Escalation & Maintenance (`/alert-response`)

### What it looks like now

Four full-width stacked panels. The readiness figures are a bare row of numbers
above a one-row channel table. The escalation policy's chain is a single line of
text: `+0m → dashboard Default dashboard · +5m → email · +15m → webhook`. Empty
states are bare sentences in an empty table.

### Target

**Status banner.** Green when an alert firing now reaches somebody, red when it
does not. Heading `An alert firing now reaches somebody`, subtitle
`1 of 3 channels can deliver and 1 escalation policy is enabled.` On the right:
`Checked 51s ago`, `Re-check`, `Re-seed defaults`.

**Five readiness figures** beneath the banner, in one row, divided:
Deliverable channels · Open alerts · Reached nobody · Not yet attempted ·
Enabled policies.

**Two columns below.**

*Left — Notification channels.* `1 of 3 can deliver right now`, `Add channel`
button. One block per channel: name, transport in mono, a `Deliverable` /
`Not deliverable` pill, and — when not deliverable — the reason and the fix as
a link (`email · SMTP_URL not set` / `Used by step 2 of Default escalation.`
**Configure SMTP**). A closing note defines what "deliverable" means.

*Right — Escalation policies.* `New policy` button. Per policy: name, then
`id · created by … · updated 56d ago` in mono, an `Enabled` toggle switch, and
`Edit` / `Delete`. **The chain renders as a vertical timeline**, not a sentence:
a rail with a node per step, the offset (`+0m`, `+5m`, `+15m`) to the left of
the rail, and a card to the right holding the channel name and its state. A
skipped step's card is tinted amber and reads `Not deliverable, this step is
skipped`.

**Maintenance windows.** `0 scheduled · 0 active now`, `Schedule window`
button. The empty state is a centred block: heading `No maintenance scheduled`,
then an explanation of what a window does and how to silence a single alert
instead — not an empty table with a one-line caption.

**Correlated alert groups.** When empty, one line only: the heading, the
sentence "No unresolved alerts are correlated into groups. Groups appear here
when related alerts fire together.", and `Refresh`. No empty table.

---

## 3. Notifications (`/notifications`)

### What it looks like now

A five-column table — Received / Category / Title / Body / Status — with the
full body sentence repeated on every row, and a `Mark read` button per row.

### Target — an inbox, not a register

**Header.** `Report schedule` and `Mark all read` on the right.

**Warning bar** (amber) when every recent report is empty:
`No traffic in 44 consecutive reports. Every daily report since 2026-08-17
shows 0 messages and 0 delivery reports.` with a `Check SMSC binds` link on the
right. Dismissible.

**Two panes.**

*Left — the list.*
- Tabs with counts: `Unread 50` · `All 50`
- Filter buttons: `All reports` / `Daily` / `Weekly` (pill group, wrapping under
  the tabs on narrow screens rather than clipping)
- Search box and a `Newest first` sort toggle
- **Grouped by recency** with a sticky group header carrying a count:
  `TODAY 1`, `YESTERDAY 1`, `THIS WEEK 6`, `LAST WEEK 8`, `EARLIER`
- Each row: an unread dot, the title in bold, a `Weekly` tag where it applies,
  the relative time (`9h ago`, `2d ago`), a `Mark read` link, and a **compact
  one-line summary in mono** — `0 msgs · 0 DLRs · 09-29 → 09-30` — truncated
  with an ellipsis rather than wrapped. The full body belongs in the reading
  pane.
- The selected row is tinted with a left accent bar.
- The list scrolls inside its own pane.

*Right — the reading pane.*
- A category tag (`Daily report`) and the exact timestamp in mono
- The title as a heading, then `Period 2026-09-29 → 2026-09-30`
- Two large figures side by side: Messages, Delivery reports
- The full body text
- `Open in Reports` (primary) and `Mark read`

**Behaviour.** Clicking a notification opens it in the reading pane and marks it
read; the unread count in the tab and the header badge both update. The first
notification is open, and read, on load. On narrow screens the reading pane
drops below the list instead of squeezing it.

---

## Applies to every screen

The three above are worked examples of one house style, and it is the style to
carry across the console:

- A **summary strip** answering the question the operator arrives with, before
  any table.
- **Tabs with counts** in place of a status dropdown, opening on the tab that
  matters rather than on "All".
- **One live-refresh line** (`● Live · updated Xs ago · every 30s` + Pause +
  Refresh) instead of a panel of selects.
- **Relative times** in rows, exact instants on hover.
- **A side panel** for the fields that are empty on most rows, so they leave the
  table.
- **Empty states that explain**, centred, rather than one grey line in an empty
  table.
- **Export as a menu**, not one button per format.
