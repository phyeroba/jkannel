# JKANNEL console design spec — 2026-10 revision

**This supersedes `design/design_spec/` (July 2026) for everything below.**
Where the two disagree, this wins: it is newer, and it is what was asked for.
The July spec remains the authority for anything this file does not cover.

Source: the six `.dc.html` pages from the 2026-09-30 design pass — Dashboard,
Alerts, Escalation & Maintenance, Notifications, Routing, Advanced Routing —
kept in `design/redesign-2026-09/kamex-pages/` (gitignored; they render against
production data). Values below are read out of that source, not estimated from
screenshots.

Build new screens from this. Modify existing ones toward it.

---

## 1. The shape of a screen

Every screen the design pass touched has the same five bands, in this order.
It is a deliberate order: the verdict, then the filters, then the evidence.

```
  Header          title · subtitle · 1–2 controls, right-aligned
  Summary strip   3–5 measured figures, the question you arrived with
  Tabs + live     tabs carrying counts · "Live · updated Ns ago" + Pause
  Filters         search · segmented control · sort toggle
  Table / list    the rows, then a one-line footer
  Side panel      opened from a row; holds what is empty on most rows
```

A screen that has no verdict to give skips the strip rather than inventing
one. A screen with nothing to filter skips the filter row.

---

## 2. Tokens

### Colour

The palette is `oklch` on hue 250 for neutrals, with four semantic hues. It is
written here in oklch because that is what the source uses and because the
lightness channel is directly comparable across the ramp — `0.55` is the same
perceived lightness whatever the hue.

| Role | Value | Used for |
|---|---|---|
| Page ground | `oklch(0.975 0.004 250)` | `body` |
| Surface | `oklch(0.985 0.003 250)` | panels, cards |
| Surface 2 | `oklch(0.95 0.004 250)` | table heads, inset rows |
| Border | `oklch(0.92 0.005 250)` | every 1px rule |
| Border strong | `oklch(0.88 0.008 250)` | a card that must separate |
| Ink | `oklch(0.24 0.012 250)` | body text |
| Ink strong | `oklch(0.21 0.02 255)` | headings, figures |
| Muted | `oklch(0.55 0.01 250)` | labels, captions, secondary lines |
| Muted light | `oklch(0.72 0.01 250)` | placeholder, disabled |
| **Brand** | `oklch(0.5 0.14 250)` | links, active tab, primary button |
| Brand hover | `oklch(0.4 0.14 250)` | |
| **Good** | `oklch(0.62 0.15 150)` | live, deliverable, healthy |
| Good ink | `oklch(0.45 0.12 150)` | text on a good tint |
| **Warn** | `oklch(0.72 0.15 65)` | degraded, no fallback, skipped step |
| Warn ink | `oklch(0.5 0.13 60)` | text on a warn tint |
| **Bad** | `oklch(0.58 0.2 25)` | critical, cannot deliver, dead |
| Bad ink | `oklch(0.5 0.19 25)` | text on a bad tint |
| Accent | `oklch(0.78 0.09 210)` | chart second series |

Semantic colour never carries meaning alone — §17.1 of the July spec still
holds. The word is the signal; the colour repeats it.

### Type

- **IBM Plex Sans** 400 / 500 / 600 — all UI text
- **IBM Plex Mono** 400 / 500 — identifiers, timestamps, hosts, figures in rows

Sizes, in order of how often the source uses them:

| Size | Role |
|---|---|
| 13px | body, table cell, row title |
| 12.5px | secondary line, button |
| 12px | caption, label under a figure |
| 11.5px | group heading, pill, eyebrow |
| 15px | panel heading |
| 24–30px | a summary-strip figure |

Numbers that line up in a column get `font-variant-numeric: tabular-nums`.

### Spacing and radius

- Gaps: **6 / 8 / 10 / 12 / 14px**. Nothing between.
- Padding: **8px 10px** for a control, **12px 14px** for a card,
  **16px 20px** for a panel.
- Radius: **6px** for a control, **7px** for a card, **10px** for a panel,
  **50%** for a dot.

---

## 3. Components

### Summary strip

Three to five figures in one row, divided by 1px, in a single rounded box.
Label above in muted 12px, figure 24–30px semibold tabular, caption below in
12px. On a narrow screen it becomes 2×2, never a single column that leaves one
card alone on a row.

**Every figure is a whole-table measurement from the server.** Deriving one
from the loaded page gives the size of the page: on a register paginated at
fifty, the tab reads "open 50" while three hundred are open. A wrong count is
worse than no count, because it looks like an answer. If the tally fails, the
strip renders nothing — zeros would report an empty system.

### Tabs with counts

Underlined active tab, count in a rounded pill beside the label. The page opens
on the tab that matters (Open alerts, Unread notifications), not on All. Tabs
that filter a list that stays on screen are **buttons in a `role="group"`**,
not a `tablist` — a tablist promises panel-swapping that is not happening.

### The live line

One line, not a panel:

```
● Live · updated 3s ago · every 30s   [Pause] [Refresh]
```

This replaces `Auto refresh [On] Every [30s] (Refresh now)`. Those were three
labelled controls in their own band stating one idea.

### Segmented control

For a choice that is mutually exclusive and short: severity, match type,
selection strategy, Always/Time window. Inset track, active segment on
`surface` with a 1px shadow. Never checkboxes for a choice that is exclusive,
and never seven stacked checkboxes for days of the week — those are toggle
buttons in a row.

### Table rows

- **Six to eight columns.** Fields that answer one question share a cell:
  value first, label second, stacked, so the eye runs down the values.
- **Relative times** — `34d ago`, `13h 29m` — with the exact instant in
  `title`. A register is not the place to read milliseconds.
- **Identity cell**: name on the first line, `source · shortid` in mono on the
  second.
- **Opaque values** (UUID, checksum, user agent, request path) are capped with
  the full text in `title`. They are matched or copied, never read end to end,
  so wrapping one makes the row tall without making it legible.
- **Prose** wraps and clamps to one or two lines.
- Actions on the row are the one or two that resolve most rows; the rest live
  in the side panel.

### Side panel

Opened by clicking the row or its `›`. Holds the fields that are an em dash on
most rows, a timeline of what happened, and the full action set. This is what
takes a sixteen-column table down to eight without losing anything.

### Empty state

Centred, with a heading and a sentence saying what would appear here and how to
make it appear. Never one grey line in an empty table.

### Export

One `Export ▾` menu, not one button per format.

### Status banner

For a screen that exists to answer a yes/no: green or red, the verdict as a
heading, the evidence as a subtitle, and **the age of the check** beside it. A
claim about "now" is worth nothing without saying how old it is.

### Step rail

For an ordered process with timing — an escalation policy, a failover chain.
Offset on the left, a node on a vertical rail, a card on the right. A step that
cannot run is tinted warn and says why. Showing the shape beats describing it:
"+0m → dashboard · +5m → email · +15m → webhook" in a table cell is a policy
described, not a policy shown.

### Inbox

For a list of things that are read rather than scanned: notifications. List on
the left grouped by recency with a count per group, reading pane on the right.
Opening marks read; the open row stays in place even when the filter would drop
it. On a narrow screen the reading pane goes **below** the list, not beside it.

---

## 4. Rules that cost me something to learn

- `vue-tsc -b` does not check template structure. `npm run build` is
  `vue-tsc -b && vite build`; only the second half catches an unbalanced tag.
- A container keeps serving the previous image when a build fails, so an audit
  run straight after a failed build measures yesterday. Check the build result.
- `display: flex` on a `td` destroys its cell semantics and the column stops
  aligning with its header. Put the flex on a span inside the cell.
- `-webkit-line-clamp` needs `display: -webkit-box`, so the same rule applies:
  clamp an inner element, never the cell.
- `.row-id` sets `display: block`. A clamp class at equal specificity loses to
  it depending on stylesheet order — `.row-id.clamp-1` is the form that works.
- `width: 1%` on a column means "1% is my preferred width", not "shrink to
  fit". It hands the slack to other columns and can starve the one control the
  row has.
- Grouping columns trades width for height. Check both audits:
  `scripts/overflow-audit.mjs` and `scripts/layout-audit.mjs`, both of which
  read every route from `navigation.ts`.
- Every icon name the navigation uses must exist in `AppIcon.vue`. A missing
  one silently falls back to a cog, which is how duplicates appear that nobody
  can see.
