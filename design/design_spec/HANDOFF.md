# JVIDEO — Design Handoff & Build Guide

**Prototype (source of truth):** `JVIDEO.dc.html` — a fully interactive, themeable mockup of both product surfaces. Open it in a browser, use the bottom **Login · Console · Portal** switcher, and toggle light/dark with the sun/moon in the topbar. Every screen below is either built there already or specced here for you to build the same way.

**Target stack:** Vue 3 (`<script setup>`) + Tailwind CSS 4 + a charting lib (ApexCharts or Chart.js). The prototype is framework-agnostic HTML/CSS; the token + component recipes below map 1:1 onto a Tailwind theme.

**Reference design system:** `uploads/design-system.html` (CPaaS-derived language: single accent, hairline structure, tabular numerics). JVIDEO adopts its *structure* with a Vuexy-style skin (Public Sans, navy sidebar, `#7367f0` violet, soft-shadow white cards).

---

## 1. Two surfaces, one token set

| | **Admin Console** (Surface A) | **Customer Portal** (Surface B) |
|---|---|---|
| Device | Desktop-first web app | Mobile-first captive portal (360px) |
| Mood | Light "control room", dense, scannable; dark mode available | Warm, cinematic, featherlight |
| Accent | Violet `#7367f0` | Amber/gold `#ef9a2f` on cream |
| Font | Public Sans + JetBrains Mono (IDs/figures) | Same |

They **share** status colors and badge language; they do **not** share layout or mood.

---

## 2. Design tokens

Defined in the prototype as CSS custom properties on `.jv[data-theme="light|dark"]`. Port these into your Tailwind theme (`@theme` in Tailwind 4, or `tailwind.config` `theme.extend.colors`).

### Console — Light (default)
```
--bg:#f8f7fa      --card:#ffffff    --card-2:#fbfbfc   --topbar:#ffffff
--sidebar:#2f3349 --sidebar-ink:#cfd3ec --sidebar-muted:#7d819e --sidebar-label:#6d7191
--ink:#6f6b7d     --ink-strong:#444050  --ink-muted:#a5a2ad --ink-faint:#b9b7c0
--primary:#7367f0 --primary-strong:#6354e0 --primary-soft:rgba(115,103,240,.14)
--good:#28c76f    --warn:#ff9f43    --bad:#ea5455    --info:#00cfe8   (each has a *-soft at .14 alpha)
--neutral:#a5a2ad --neutral-soft:rgba(75,70,92,.08)
--hair:#ebe9f1    --shadow:0 4px 18px rgba(75,70,92,.10)  --shadow-lg:0 10px 34px rgba(75,70,92,.16)
--input:#ffffff   --input-brd:#dbdade
```
### Console — Dark
```
--bg:#25293c --card:#2f3349 --card-2:#343a55 --topbar:#2f3349 --sidebar:#2b2c40
--ink:#b0b3c7 --ink-strong:#e5e7f0 --ink-muted:#7e819e
--primary:#7367f0 --primary-strong:#8b80f5 --primary-soft:rgba(115,103,240,.22)
(status colors identical; *-soft at .20; --hair:#3b4056; --input:#2f3349 --input-brd:#44496a)
```
Status hexes are the same in both themes — only the *-soft alpha changes. Sidebar stays navy in both themes.

### Portal (warm, single theme)
```
page bg: linear-gradient(165deg,#fff6e6,#fdefd6,#fbe6c2)
surface:#ffffff  ink:#6a4c18  ink-muted:#a9803c  hairline:#f2e2c4
accent:#ef9a2f   accent-grad: linear-gradient(135deg,#f7b955,#ef9a2f)
```

### Scale, radius, elevation
- **Type:** display 24/700 · h1 20/700 · card title 16/600 · body 13–14/400 · label 12.5/600 · caption 11.5/500 · mono for IDs & figures. Headings use `letter-spacing:-.02em`; all figures use `font-variant-numeric:tabular-nums`.
- **Spacing:** 4/8 rhythm; card padding 18–24px; grid gap 16–18px; content inset 22–24px.
- **Radius:** cards/inputs 8–10px, chips/badges 6–8px, pills 999px, phone frame 44px.
- **Elevation:** cards use `--shadow` (no borders in light theme); menus/floating use `--shadow-lg`.

---

## 3. Status badge language (use everywhere, one system)

Badge = soft-tinted pill + 6px colored dot + capitalized label.

| Domain | States → color token |
|---|---|
| Payments | pending→warn · successful→good · failed→bad · refunded→neutral |
| Entitlements | active→good · expired→neutral · disabled→bad · source: **payment**→neutral outline, **admin-granted**→primary "free" |
| Nodes | online→good · syncing→primary · stale→warn · offline→neutral |
| Sync items | pending→warn · delivered→info · acked→good · failed→bad |
| Media/assets | uploaded→neutral · processing→warn · ready→good · distributed→info · expired→bad |
| Settlement | settled→good · pending→warn |

Money: always `UGX` + whole numbers + thousands separators, tabular figures, right-aligned in tables.

---

## 4. Component recipes (all live in the prototype)

- **Card** — `background:var(--card); border-radius:10px; box-shadow:var(--shadow); padding:18–24px`. No border in light mode.
- **Stat tile** — label + 38px soft-tint icon chip (top-right) + 24/700 figure + delta line (`↑ 12.4%` in good/bad).
- **Data table** — uppercase 10.5px faint headers on a hairline; rows divided by `--hair`; hover row; mono IDs; right-aligned tabular figures; trailing action cell.
- **Filter bar** — pill chips (active = filled primary) OR a row of select-style boxes (Users screen).
- **Segmented control** — used for mutually-exclusive choices (theme-in-form, product type). Active = filled primary.
- **Toggle** — 40×23 pill, knob slides; on = `--primary`.
- **Override-with-preview pattern** (Entitlement grant, Products) — inputs default from the selected reference; a sticky preview card recomputes live (start→expiry, stacking sentence, price). This is the signature interaction — replicate it faithfully.
- **Reveal-once secret** — masked value + eye toggle + warning hint (Node detail).
- **Skeleton loading** — shimmer bars via `@keyframes jshimmer`; every list screen needs one.
- **Mobile product card / big-button stepper** — Portal: one decision per screen, 44–54px touch targets, warm cards.

---

## 5. Screen coverage vs `DESIGN_PROMPT.md`

✅ = built in prototype · 🟡 = partial · ⬜ = to build (spec below)

| # | Screen | Status | Notes |
|---|---|---|---|
| 1 | Dashboard | ✅ | revenue chart, node health strip, popular, recent payments |
| 2 | Sites (list + detail) | ✅ | card grid (summary per card) + table; click a card → detail modal with its nodes & 30d revenue |
| 3 | Nodes (list + detail) | ✅ | card grid + table; sync queue, reveal-once secret, attached tiers, Jellyfin lib IDs |
| 3c | Roles & access | ✅ | role card grid (summary per card) + team table; click a card → permissions modal |
| 4 | Catalog: Categories / Tiers / Movies | ✅ | incl. tier↔category assignment UI, asset-status badges |
| 5 | Products | ✅ | foolproof type→reference picker, active/featured/node-restrict |
| 6 | JVIDEO Users (list) | ✅ | stat tiles, filters, table |
| 6b | User **detail** + entitlement timeline | ✅ | modal popup: profile card + history timeline (payment vs admin-granted) |
| 7 | Entitlement **grant form** | ✅ | override + live stacking preview |
| 7b | Entitlements **table** (payment vs admin-granted) | ⬜ | see §6 |
| 8 | Payments (list + simulate) | ✅ | pending→successful simulate action |
| 8b | Payment **detail** (→ generated entitlement) | ⬜ | see §6 |
| 9 | Revenue | ✅ | gross = platform + owner split, settlement, by-node payout |
| 9b | Revenue **site-owner scoped** variant | 🟡 | note shown; build a `role=owner` filtered view |
| 10 | Media | ✅ | drag-drop, processing progress, distribution, storage meter |
| 11 | Sync queue (standalone) | ⬜ | node-detail has the pattern; build a cross-node screen — see §6 |
| 12 | Login | ✅ | Vuexy split-screen, light + dark |
| — | Modal / Toast / Timeline components | ⬜ | see §6 |

---

## 6. Build instructions for the remaining screens

Reuse the exact tokens + component recipes above. For each, copy the closest built screen and adapt.

- **Sites (list + detail).** Copy the **Nodes** list. Columns: Site, Owner, Phone, Nodes (count), Revenue (30d), Status. Detail = header + stat tiles (nodes, active viewers, 30-day revenue) + a nodes sub-table (reuse node rows) + a revenue summary card (reuse Revenue bars). A site groups nodes.
- **Entitlements table** (screen 7 has two parts — grant form is built, table is not). Copy the **Payments** table. Columns: User (mono) · Product · Node · Starts→Expires (tabular) · Amount paid · Active flag · **Source badge**. Make source visually distinct: `payment` = neutral outline pill; `admin-granted` = primary pill labelled "Free". Add a "Grant access" button that routes to the built grant form.
- **User detail + entitlement history timeline.** Left profile card (avatar, username, payer phone, node, last seen) + right **timeline**: vertical hairline with dot nodes, each = an entitlement (product, node, start→expiry, source badge, amount). Order newest-first. Timeline dot color follows entitlement status.
- **Payment detail.** Two-column: left = payment facts (amount, provider, provider reference (mono), payer, node, status lifecycle as a horizontal stepper pending→successful) · right = the **entitlement it generated** (or an empty state if none).
- **Sync queue (standalone).** Copy the node-detail sync table but add a **Node** column and a node filter. Columns: Node · Instruction (`user_create`, `permission_update`, `media_add`, `jellyfin_refresh`) · Status (pending/delivered/acked/failed) · Attempts · Last error · Retry. Failed rows get a Retry action.
- **Revenue — site-owner variant.** Same screen, but scope to one owner's sites: hide the "platform share" tile, keep gross + your-share + pending-settlement, and filter the entries table to their nodes. Gate behind `role === 'owner'`.
- **Modal / Toast / Timeline.** Modal = centered `--card` on a dim scrim, `--shadow-lg`, 12px radius. Toast = bottom-right `--card` pill with a status dot + message, auto-dismiss. Timeline = as described in User detail.
- **Empty & error states.** Every list needs: skeleton (built), empty ("No X yet" + primary CTA), and error (bad-tint card + retry). Follow the skeleton's centered, low-chrome style.

---

## 7. Mapping to Vue 3 + Tailwind 4

1. **Tokens:** put the light/dark var blocks in a global stylesheet under `:root` / `[data-theme="dark"]`; expose them to Tailwind via `@theme { --color-primary: var(--primary); … }` so you can write `bg-primary`, `text-ink-strong`, etc.
2. **Theme toggle:** a Pinia store holding `theme`, written to `localStorage` (key `jvideo-theme`), applied as `data-theme` on `<html>`. The prototype does exactly this.
3. **Components:** each recipe → a `.vue` component — `StatTile`, `DataTable`, `StatusBadge` (props: `domain`, `state`), `Toggle`, `SegmentedControl`, `OverridePreview`, `MobileProductCard`, `Stepper`.
4. **Charts:** the prototype uses plain CSS bars for fidelity; swap for ApexCharts using the same `--primary` / `--primary-soft` fills. Keep tabular numerics on axes.
5. **Money & i18n:** central `formatUGX(n)` → `UGX ` + `toLocaleString('en-US')`. Currency is UGX, whole numbers only.
6. **Portal:** ship as its own lightweight bundle (no webfonts if possible, small poster thumbnails only) — it loads through a captive portal on low-end Android over congested WiFi.

---

*Generated from the `JVIDEO.dc.html` prototype. When in doubt, open that file — it is the canonical spec for spacing, color, and interaction.*
