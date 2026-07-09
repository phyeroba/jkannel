# JVIDEO — Claude Code Handoff & Wiring Guide

> **Purpose.** You (Claude Code, in VS Code) are receiving a finished, high‑fidelity **design prototype** for JVIDEO — a platform that sells locally‑hosted movies over hotspot WiFi in Uganda. This document tells you what the files are, how to pull the whole project in, what every screen means, and how to wire it into a real, production application. Read this first, then download every file listed in §2.

---

## 1. What JVIDEO is (domain model — read once)

A **hub** (central server) holds the master catalog and pushes movies overnight to **nodes** (spoke media servers) at partner **sites** (lodges, trading centers, campuses). Customers on a site's WiFi hit a **captive portal**, buy time/category/movie passes with **mobile money** (MTN MoMo / Airtel Money), and watch via Jellyfin on the node. **Hotspot owners** (the businesses hosting nodes) earn a **revenue share** and withdraw earnings by mobile money, minus a **reserve fund** (minimum balance).

Core entities: `Site` → has many `Node`s → each node runs `Jellyfin libraries`; `Category` (bundled into `Tier`s) → has many `Movie`s; `Product` (tier/category/movie, priced, durationed); `Payment` (mobile money) → generates an `Entitlement` (access window, stackable, admin grants are free); `MovieRequest` (portal or node origin); `DistributionJob` (overnight push); `Owner` (balance/reserve/withdrawable) → `Withdrawal`. Movies enter by **hub upload** or **node ingest** (USB at the node).

---

## 2. The files to download

Pull the **entire project** (everything in the project root):

| File | Role |
|---|---|
| `JVIDEO.dc.html` | **The whole design.** Single self‑contained Design Component: markup template + a `Component` logic class. All 5 surfaces + every screen live here. |
| `support.js` | The Design‑Component runtime that renders `.dc.html`. Do **not** edit; you are replacing it, not shipping it. |
| `image-slot.js` | Web component for user‑fillable images (used for category banner/DP). Reference only. |
| `HANDOFF.md` | Earlier build guide — tokens, status‑badge language, component recipes, screen coverage matrix, and a **Vue 3 + Tailwind 4 mapping**. Read it alongside this file. |
| `CLAUDE_CODE_HANDOFF.md` | This file. |

> **How to read the design:** open `JVIDEO.dc.html`. The `<x-dc>` body is the markup (inline styles only). The `<script data-dc-script>` block is the `class Component extends DCLogic` — its `renderVals()` returns every value the template interpolates via `{{ … }}`, and `buildXxx()` methods return `React.createElement` subtrees for the richer views (portal flow, owner app, ingest station, modals, reports charts). Treat this class as the **source of truth for behavior and data shape**; treat the template as the source of truth for **layout, spacing, and tokens**.

---

## 3. Architecture of the prototype (so you can port it)

- **Format:** a "DC" — one HTML file, rendered by `support.js`. The template uses `{{ dotted.path }}` holes, `<sc-if>`, and `<sc-for>`; the logic class supplies values. This is a *prototype runtime*, not a production framework.
- **Styling:** **inline styles only**, driven by CSS custom properties on `.jv[data-theme="light|dark"]` (defined in the `<helmet><style>` at the top of the file). Light is the default; a topbar sun/moon toggles dark and persists to `localStorage["jvideo-theme-2"]`.
- **Fonts:** Public Sans (UI) + JetBrains Mono (IDs, phone numbers, figures).
- **State:** all in `this.state` of the one `Component` class (surface, current screen, wizard steps, modal flags, sample data arrays).
- **No backend.** All data is hardcoded sample arrays in the class (e.g. `NODES`, `OWNERS`, `WITHDRAWALS`, `DIST_JOBS`, `OWNER_TOP_MOVIES`). These define the **exact fields your API/DTOs should return**.

### Recommended production stack
Port to **Vue 3 (`<script setup>`) + Tailwind CSS 4 + a charting lib** (ApexCharts or Chart.js), per the mapping already written in `HANDOFF.md §7`. (React + Tailwind is equally fine — the component recipes are framework‑agnostic.) Do **not** ship `support.js`/`.dc.html` to production; re‑implement the screens as real components using the tokens and data shapes below.

---

## 4. The five surfaces (a "surface switcher" pill at bottom toggles them in the prototype)

1. **Login** — Vuexy split‑screen (illustration + form). Production: real auth.
2. **Console** (admin) — the main app: sidebar nav + topbar + routed screens. Most of the work.
3. **Portal** (customer) — mobile captive‑portal flow in a 360px phone frame; warm amber theme.
4. **Ingest** (node station) — a tiny LAN‑only surface that runs *on the node* for USB imports.
5. **Owner** — the hotspot‑owner view, **intended to become a mobile app later**. Its functionality is *also* embedded in the console (see Owner workspace + Reports), which is what owners use today.

In production these are **separate route groups / apps**, gated by role (`super_admin`, `admin`, `finance`, `site_owner`, `support`, `read_only`). The prototype's bottom switcher only exists to demo them side‑by‑side — drop it.

---

## 5. Console screens (nav order) → what to wire

**Operations:** `dashboard` (revenue chart, node‑health strip, most‑watched, recent payments) · `sites` (card grid + table; click → site modal with its nodes & 30‑day revenue) · `nodes` (card grid + table; click → **node detail** with **Sync & config** and **Library** tabs, reveal‑once API secret, attached tiers, disk gauge, ingest history).

**Catalog:** `catalog` (tabs: Categories / Tiers / Movies; category click → banner+DP detail modal; movies carry a **hub vs node origin badge** + a "Review" action for node‑ingested titles) · `products` (type→reference create form) · `media` (upload/library).

**Delivery:** `staging` (3‑step wizard: upload & FFmpeg prep → target‑node picker with free‑disk vs required‑size checks → schedule to a night window) · `distribution` (night‑grouped job queue: scheduled/transferring/completed/failed/cancelled, cancel/retry) · `storage` (hub disk tile + per‑node disk gauges + distribution‑over‑time chart).

**Access & money:** `users` (viewer accounts; row → user detail modal with entitlement‑history timeline) · `roles` (role cards + team table; "Add New Role" permissions modal with Read/Write/Create per area) · `entitlements` (admin **grant form** with override duration/amount + live stacking preview) · `payments` (mobile‑money table, simulate pending→successful) · `revenue` (gross = platform + owner split, settlement) · `requests` (**movie requests**: pending→acknowledged→sourced→fulfilled/rejected, portal vs node source) · `owners` (hotspot‑owner accounts: balance, reserve, share%, lifetime) · `ownerspace` (**Owner workspace**: "viewing as owner", balance card with **Withdraw**, most‑watched, downloadable payments‑through‑their‑network) · `oreports` (**Reports** dashboard — earning bars, delivery donut, revenue grouped bars, watch‑time rings, KPI sparkline, most‑watched) · `withdrawals` (**payout queue**: approve / mark‑paid + reference / reject + reason; column is **Withdrawable‑at‑request**).

**System:** `sync` (sync queue) · `sysconfig` (**System settings**, super‑admin: default revenue share %, default reserve fund, off‑peak window; reusable *setting‑row* pattern — label / description / control / default hint / per‑entity override note) · `settings` (Settings & team: ISP profile, branding/white‑label, team, API keys, notifications).

**The withdraw flow is an in‑console modal** (opened from the Owner workspace balance card and the Reports action bar): shows **Balance − Reserve = Withdrawable**, caps the amount (and "withdraw all") at Withdrawable, requires a **reason**, submits to the payout gateway → pending → approved → paid / rejected.

---

## 6. Design system to preserve (tokens live in `HANDOFF.md §2` — copy them verbatim)

- **Console:** light default (`--bg #f8f7fa`, white cards, soft shadows, **navy `#2f3349` sidebar**, violet **`#7367f0`** primary) + a full dark token set. Same status hexes in both themes; only the soft‑tint alpha changes.
- **Portal:** warm cream/amber (`#ef9a2f`) on a light gradient; portal‑grade lightness (works at 360px, degrades offline).
- **Status‑badge language (one convention everywhere):** payments (pending/successful/failed/refunded), entitlements (active/expired/disabled + payment vs admin‑granted), nodes (online/syncing/stale/offline), sync (pending/delivered/acked/failed), assets (uploaded/processing/ready/distributed), **distribution** (scheduled/transferring/completed/failed/cancelled), **requests** (pending/acknowledged/sourced/fulfilled/rejected), **withdrawals** (pending/approved/paid/rejected). Origin badge pair: **hub vs node**.
- **Reusable patterns:** stat tile, data table (uppercase faint headers, hairline rows, mono IDs, right‑aligned tabular figures), status badge (dot + soft pill), toggle, segmented control, **disk gauge** (normal/warning >80%/critical >95%), **balance triplet** (Balance · Reserve · Withdrawable), **setting‑row anatomy**, **override‑with‑live‑preview** (entitlement grant, product create). Money: `UGX` + thousands separators + tabular numerics; durations "2h 10m"; bytes "GB, one decimal".

---

## 7. Suggested wiring order (for the real build)

1. **Scaffold:** Vue 3 + Tailwind 4; drop the token blocks into a global stylesheet as CSS vars, expose via `@theme`. Theme store → `localStorage`, `data-theme` on `<html>`.
2. **Shared components first:** `StatusBadge(domain,state)`, `DataTable`, `StatTile`, `DiskGauge`, `Toggle`, `SegmentedControl`, `BalanceTriplet`, `SettingRow`, `Modal`, `Money`/`formatUGX`, chart wrappers.
3. **Auth + role‑gated routing:** the six roles in §4; `site_owner` lands on the owner workspace scoped to their sites, admin nav hidden.
4. **Data layer:** turn every sample array in the `Component` class into an API DTO — the field names ARE the contract. Wire read endpoints screen‑by‑screen in nav order (dashboard → sites → nodes → …).
5. **Money flows last & carefully:** payments → entitlement generation; reserve‑fund math on withdraw (cap at withdrawable everywhere); withdrawal state machine (pending→approved→paid/rejected) with payout‑gateway dispatch and reference capture.
6. **Charts:** reproduce the Reports dashboard with ApexCharts using `--primary`/`--primary-soft`; keep tabular numerics on axes.

**Fidelity rule:** match the prototype's spacing, tokens, copy, and interactions. When a detail is ambiguous, open `JVIDEO.dc.html` and read the exact markup/logic for that screen — it is the specification.
