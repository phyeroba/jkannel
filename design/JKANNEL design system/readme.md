# JKANNEL Design System

Brand and UI foundations for **JKANNEL** — an operator control plane for SMS
messaging built on top of **Kamex / Kannel**. This project is the source of
truth for how JKANNEL looks and reads: tokens, type, icons, component
primitives and a click-through recreation of the admin console.

> JKANNEL is a telecom control plane: connect SMSCs over SMPP, submit and route
> traffic, watch a live queue, recover bad binds, monitor and alert, report and
> export, and manage customers, quotas and roles. Uganda-facing carriers
> (MTN UG, Airtel UG) and Kamex containers are the operating context.

## Sources

Derived **from the production codebase, not screenshots**.

Structure, card conventions and the self-contained UI-kit pattern follow the
**DocFlow Enterprise design system** (SMSONE), so both systems read the same way:
the same section order in this guide, `tokens/` + `guidelines/` + `components/` +
`ui_kits/` layout, and DocFlow-parallel semantic token aliases
(`--surface-page`, `--surface-card`, `--border-default`, `--text-muted`,
`--primary`, `--radius-*`, `--shadow-focus`, `--ease-standard`) mapped onto
JKANNEL's own values. Where DocFlow *defines* a future frontend, this system
*records an existing one* — every value here is lifted from shipped code.

- **Repository:** `github.com/dmushabe/jkannel` (branch `main`) — a monorepo:
  NestJS backend, PostgreSQL migrations, Docker/Kamex runtime, and a
  **Vue 3.5 + Vite + Tailwind 4** frontend.
- **Token + style source of truth:** `frontend/src/style.css` (`:root` and
  `[data-theme='dark']` custom properties, component classes) refined by
  `frontend/src/design-authority.css`, which loads last and wins — it is the
  "direct production mapping" of the design handoff.
- **Design handoff:** `design/design_spec/HANDOFF.md` + the `JVIDEO.dc.html`
  prototype in the same folder (a sibling product spec that established this
  skin: Public Sans, navy sidebar, `#7367f0` violet, soft-shadow white cards).
- **Icons:** ported verbatim from `frontend/src/components/AppIcon.vue` into
  `assets/icons.js`.
- **Nav, labels and copy:** `frontend/src/navigation.ts`, `views/LoginView.vue`,
  `views/OperationsOverview.vue`, `views/AnalyticsView.vue`, `docs/user-guides/`.
- **Reference screenshots:** `assets/reference/` (from `docs/screenshots/`).
- **Logo:** the repo ships only `frontend/public/favicon.svg`
  (`assets/img/jkannel-favicon.svg`). There is no wordmark asset — the brand
  lockup is the icon tile plus **JKANNEL** set in Public Sans. Nothing has been
  drawn or invented here. Note the shipped favicon is still filled with the old
  violet `#7367f0`; it is kept **verbatim** rather than recoloured — regenerate
  it from the repo in `--blue-500` when the frontend adopts the shared accent.

There is no Figma file referenced anywhere in the repository.

## Products / surfaces

| Surface | Audience | Device | Notes |
|---|---|---|---|
| **Admin Console** | Operators, NOC, administrators | Desktop-first | 33 workspaces in four nav groups (Operations, Messaging, Insights, Platform); light + dark |
| **Public auth pages** | Anyone with an invite or reset link | Desktop + mobile | Login split-screen, accept invitation, password reset |

One token set serves both. The console is the product; the auth pages are the
only unauthenticated surface.

---

## CONTENT FUNDAMENTALS

**Voice — an engineer explaining the system, plainly and without spin.** The
console tells you what it observes and what it does not. Sentences are short,
declarative and specific to telecom work.

- **Person:** The product addresses the operator directly but sparingly
  ("Please sign in to your account and start managing."). Guides use second
  person and a "Read it when you want to…" framing. The product calls itself
  "JKANNEL", never "we".
- **Tone:** Operational and calm. Page subtitles say what the screen is in one
  line: "Live situational awareness across the messaging platform.",
  "Observed dependency state", "Daily total-scope report snapshots".
- **Honesty is the house rule.** When a source is not observable the UI writes
  `unavailable`, `—`, `checking`, or a full sentence — "SQLBox queue not
  observable", "Volume report data is unavailable.", "No alert instances
  recorded." A number is never faked, and an empty state is never dressed up.
  Comments in the code make the same point: blanking a NOC screen every 30
  seconds is worse than a number a few seconds old.
- **Casing:** Sentence case for buttons ("Refresh dashboard", "Ask AI Copilot",
  "Sign in"), Title Case for nav items and page titles (as shipped: "Live
  Queue", "SMSC Connections", "Analytics & Reports"). UPPERCASE is reserved for
  sidebar group headers and table headers (letter-spaced).
- **Domain vocabulary, unabbreviated:** SMSC, bind, SQLBox, DLR, MO/MT, sender
  ID, quota, tenant, Kamex, throughput. Instructions read as identifiers
  (`user_create`, `jellyfin_refresh`), engine versions as `kamex 1.8.3`.
- **Numbers & identifiers:** All figures are tabular; grouped thousands
  (`184,902`); rates as one decimal (`98.7%`); durations as `00:06:48`.
  IDs, MSISDNs, bind names, config keys and build SHAs are mono
  (`msg_01HXQ4K2R9`, `+256 772 000 118`, `mtn_ug_tx`). Money, where it appears
  in the wider spec, is `UGX` + whole numbers.
- **Status language:** one word per state — healthy / available / connected /
  active / degraded / checking / unknown / pending / delivered / acked /
  failed / offline / expired.
- **Emoji:** one, deliberately: 👋 in "Welcome to JKANNEL! 👋" on the login
  card. Never in console chrome.

---

## VISUAL FOUNDATIONS

**Overall vibe:** a light, dense control room. Parchment canvas, white
soft-shadow cards, a single violet accent doing all the work of action and
selection, and a navy sidebar that never changes colour. It reads like
well-made monitoring software — Vuexy-skinned, not startup-flashy.

- **Color:** one accent, **DocFlow Blue** — the `--blue-50…900` azure ramp is
  shared verbatim with the DocFlow design system, with `--blue-500 #1a86c8` as
  the brand primary (hover `--blue-600 #146ba3`, press `--blue-700 #12567f`,
  soft tint `rgba(26,134,200,.14)`; dark mode lifts the accent to
  `--blue-400 #3fa1d6`). This replaces the Vuexy violet `#7367f0` the frontend
  currently ships — a deliberate house-wide alignment, not a value read from the
  code; everything else (surfaces, ink, status, sidebar, spacing, shadows) is
  still lifted from the shipped stylesheets. Canvas `#f8f7fa`, cards `#ffffff`, secondary
  surface `#fbfbfc`, hairline `#ebe9f1`. Ink is cool grey: `#444050` strong,
  `#6f6b7d` body, `#a5a2ad` muted. Status: green `#28c76f`, amber `#ff9f43`,
  red `#ea5455`, cyan `#00cfe8` — **identical hexes in dark mode**, only the
  tint alpha changes (.14 → .20). Dark mode is a real theme
  (`data-theme="dark"`): `#25293c` canvas, `#2f3349` cards, `#3b4056` hairlines.
  The **sidebar stays navy** (`#2f3349` light, `#2b2c40` dark) in both.
- **Type:** **Public Sans** for everything in the UI; **JetBrains Mono** (mono
  fallback `ui-monospace`) for IDs, MSISDNs, config and build stamps. Page h1
  24/700 at `-0.02em`; card titles 16/600; body 14; dense rows 13; labels
  12.5/500–600; captions 11.5; table headers 10.5/700 uppercase at `.06–.08em`.
  Every figure carries `font-variant-numeric: tabular-nums`.
- **Backgrounds:** flat. No photography, no illustration, no texture. Gradients
  appear in exactly three places: the CSS bar chart fill (violet → 35% violet),
  the login illustration's soft rings, and the brand tile's shadow bloom. The
  login "illustration" is built from a hairline ring, a tinted disc and three
  floating stat cards — geometry, not artwork.
- **Corners:** 6px chips, 8px buttons and inputs, 9–10px nav items and cards,
  12–14px dialogs and floating stat cards, pills for badges.
- **Borders & cards:** in light mode a card is **white + `--shadow` + 10px
  radius + 18–20px padding, with no border**; hairlines are reserved for row
  rules, table tops, toolbars and dark mode. The topbar is itself a floating
  card: 52px tall, inset `14px 24px 0`, 10px radius, shadow, no border.
- **Shadows:** `--shadow` `0 4px 18px rgba(75,70,92,.10)` for cards;
  `--shadow-lg` `0 10px 34px rgba(75,70,92,.16)` for menus and floating cards;
  primary buttons carry a violet `0 4px 12px` bloom; the command dialog goes
  deeper (`0 24px 70px rgba(0,0,0,.35)`).
- **Animation:** functional only. `0.18s ease` on buttons and links, `0.15s` on
  nav hover, `0.18s` chevron rotation on collapse, `0.2s` sidebar slide on
  mobile. No bounces, no looping motion, and a `prefers-reduced-motion` block
  that kills transitions outright.
- **Hover / press / focus:** hover = a surface fill (`--surface-2`, or 6–7%
  white in the sidebar) or a darkening to `--brand-2` on primary buttons. There
  is no press-scale. Focus is a 3px `brand 35%` outline at 2px offset — visible
  everywhere, including a skip link that drops in at the top of the page.
- **Active nav:** filled violet pill with white text and the violet drop shadow.
  Group headers are white, uppercase, 12.5/700 at `.08em`, and click to collapse.
- **Transparency & blur:** only for overlays — the command-palette scrim is
  `rgba(3,10,20,.68)`; status tints are `color-mix` alphas of the status hue.
  (The base stylesheet's blurred topbar is overridden by design-authority to a
  solid floating card.)
- **Layout:** fixed 260px sidebar + fluid shell; `76px / 1fr / 34px` shell rows
  (topbar band, workspace, status bar); workspace inset `22px 24px 38px`; grid
  gaps 14–16px; metrics in a 4-up grid collapsing to 2-up under 1050px and 1-up
  under 760px, where the sidebar becomes an off-canvas drawer. Sidebar nav
  scrolls independently with a thin violet scrollbar; a collapsed nav group is
  exactly as tall as its header.
- **Imagery:** none in product. Avatars are single-initial violet discs.
- **Charts:** dependency-free. CSS gradient bars on the dashboard; hand-rolled
  SVG line charts with dashed `--border` grid lines, tabular tick labels, violet
  then cyan series, and a swatch legend below.
- **Empty / loading:** every list ships three states — loading ("Loading
  alerts…"), empty ("No alert instances recorded."), unavailable ("Alert data is
  unavailable."), all centred, muted and low-chrome.

---

## ICONOGRAPHY

- **System:** a **bespoke in-house line set of 30 glyphs**, ported verbatim from
  `frontend/src/components/AppIcon.vue` into `assets/icons.js`. They are
  **24×24, `fill:none`, `stroke: currentColor`, stroke-width 1.7, round caps and
  joins**, rendered at 18px in chrome, 20px in metric chips, 27px in the login
  lockup.
- **No icon font, no third-party set.** Do not substitute Lucide/Heroicons
  (they are Lucide-adjacent in spirit but not identical) — use the bundled set.
- **Usage:** vanilla — `window.jkIcon(name, size, class)` returns the raw SVG
  string and `jkHydrateIcons()` fills every `<i data-ico="name">`;
  React — `components/core/Icon.jsx` (`<Icon name="queue" size={18} />`,
  `ICON_NAMES` for the list).
- **Names:** home, sms, queue, check, chevron, server, route, cog, chart, alert,
  users, api, docker, terminal, plugin, db, shield, search, bell, sun, moon,
  menu, logout, eye, eyeoff, spark, key, help, external.
- **Semantics that matter:** `sms` is the brand glyph (it fills the sidebar tile
  and the login lockup); `chevron` points down when a nav group is open and
  rotates `-90deg` when collapsed; `eye`/`eyeoff` is the password reveal;
  `spark` marks AI Copilot; unknown names fall back to `cog`.
- **Emoji:** 👋 on the login card only. **Unicode:** `↑ / ↓` for deltas, `—` for
  "no value", `⌘K`/`Ctrl K` in a `<kbd>` on the search trigger.

---

## Index / Manifest

**Root**
- `styles.css` — global entry, `@import` lines only.
- `readme.md` — this guide. `SKILL.md` — Agent-Skill front matter.
- `github.md` — source repository and sync record.

**`tokens/`**
- `fonts.css` — Public Sans + JetBrains Mono (Google Fonts).
- `colors.css` — surfaces, ink, brand, status, sidebar, elevation + dark theme.
- `typography.css` — font vars, console type scale, helper classes.
- `spacing.css` — 4/8 spacing scale, radii, grid gaps, insets.
- `base.css` — reset, element defaults, focus rings, reduced motion.
- `components.css` — panel/metric/button/form/table/status/chart/overlay classes.
- `layout.css` — app shell: sidebar, nav, topbar, workspace, status bar.

**`assets/`**
- `icons.js` — the 30-glyph set (`jkIcon`, `jkHydrateIcons`).
- `img/jkannel-favicon.svg` — the only brand asset in the repo.
- `reference/` — production screenshots (dashboard, login, analytics).

**`components/`** (React primitives, plain JSX + `.d.ts`)
- `core/` — Icon, Button + IconButton, Panel, MetricCard, StatusBadge + StatusDot.
- `forms/` — Field, TextInput, PasswordInput, FilterSelect.
- `data/` — DataTable, MiniChart + BarChart.
- `feedback/` — Dialog, CommandPalette.

**`ui_kits/console/`** — click-through **Kamex gateway operations console**: 20
screens across Overview, Connectivity, Traffic, Routing, Diagnostics and System,
built to the uploaded UI redesign specification. Carrier → SMSC → SMPP session →
route → queue → message → DLR, with impact-first confirmations and honest
unknown states.
`index.html` is **self-contained** — it inlines the component and screen source
and transpiles in-browser, so it renders when opened directly with no build step.
The `.jsx` + `.d.ts` + `.prompt.md` files stay the canonical source; `login.css`
holds the unauthenticated-page styles.

**`guidelines/`** — foundation specimen cards (colors, type, spacing, brand).

### Intentional additions
- `Button`, `Panel`, `DataTable`, `Field`/`TextInput`/`FilterSelect`,
  `StatusBadge`/`StatusDot` exist as CSS classes in the production stylesheet but
  not as Vue components; they are wrapped here so consumers get the same markup
  without re-deriving it.
- `BarChart` is the dashboard's inline CSS bar chart, extracted.

### Not ported
- `MessagePriority.vue`, `SegmentCounter.vue`, `SendSchedule.vue` — GSM-segment
  and scheduling widgets whose behaviour lives in `src/utils/`. Their look
  follows the form and badge recipes here; port them if you need those screens.
- `ModuleWorkspace.vue` (220 KB, the generic module workspace) and 30 of the 33
  console workspaces are not recreated in the UI kit.
- `LiveQueueView.vue` and `AnalyticsView.vue` were read for panel titles, filters
  and controls, not line by line; in those two kit screens the panels and
  controls are grounded and the individual columns and figures are approximate.

## Using this system

```html
<link rel="stylesheet" href="styles.css" />
<button class="primary-button">Refresh dashboard</button>
```

> **Sharing:** set the file type to **Design System** in the Share menu so others in the org can view this.

Set `data-theme="dark"` on `<html>` (or any wrapper) for dark mode. The React
primitives are dependency-free JSX and read their styling from the same tokens.
