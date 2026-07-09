# JVIDEO — GUI Design Brief
# Paste this entire document into Claude (claude.ai) to generate the visual design
# for JVIDEO. Ask for interactive HTML/Tailwind mockups (artifacts) — they map
# directly to our Vue 3 + Tailwind CSS 4 implementation.
# ─────────────────────────────────────────────────────────────────────────────

You are designing the complete GUI for **JVIDEO**, a decentralized video
monetization platform. Produce a cohesive design system and screen designs for
the two product surfaces described below. Deliver interactive HTML mockups with
Tailwind-style utility classes, plus a short design-token spec (colors,
typography, spacing, radii, elevation) that a Vue 3 + Tailwind team can adopt
directly.

## 1. What the product is

JVIDEO lets WiFi hotspot operators, campuses, lodges, and trading centers sell
access to **locally hosted movies and series**. A media server (Jellyfin) sits on
the local network at each site, so customers can stream video cheaply and fast
even when upstream internet is slow, expensive, or down. Video subscriptions are
sold **separately** from internet vouchers.

Context that must shape the design:
- Market: East Africa (Uganda first). Payments are mobile money (MTN MoMo,
  Airtel Money). Currency display: UGX, whole numbers, thousands separators.
- Customers buy on their phones through a hotspot **captive portal**, often on
  low-end Android devices over congested WiFi. The purchase page must be
  featherlight, legible outdoors, and operable one-handed.
- Viewer accounts are **username-based** (one payer may buy for several people).
  Credentials arrive by **SMS**. Manual login must always be possible.
- The business owner and staff manage everything from a central **Admin Console**.
  Site owners (hotspot partners) get a restricted view of their own sites'
  revenue.

## 2. Surface A — Admin Console (desktop-first web app)

**Personality:** dark, high-density operations dashboard — a control room, not a
brochure. Think of it as the operating system for a video business: fast
scanning, strong information hierarchy, minimal chrome. Light theme optional;
dark is the default.

**Global chrome:** left sidebar navigation with sections (Dashboard, Sites,
Nodes, Catalog, Products, Users, Entitlements, Payments, Revenue, Media, Sync),
top bar with global search, environment badge, and the signed-in admin. Every
list screen: filterable/sortable table, status badges, row actions, empty state,
and skeleton loading state.

Screens to design:

1. **Dashboard** — today's revenue, revenue by site and by node (bar/line),
   active viewers per node, most popular movies and categories, node health
   strip (online / syncing / stale / offline), recent payments feed.
2. **Sites** — list + detail. A site = a physical business/partner (name, owner,
   phone). Detail shows its nodes and its revenue summary.
3. **Nodes** — list + detail. A node = a media server at a site. Show: status,
   last sync time, sync backlog count, commission %, attached tiers/categories
   (with per-node Jellyfin library IDs), API secret management (reveal-once
   pattern). Sync status is a first-class visual: badge colors for pending /
   delivered / acked / failed instructions.
4. **Catalog** — three related screens: Categories (unique names, e.g. Sports,
   Kids, Premium Releases, Local Movies, Series), Tiers (a tier bundles selected
   categories — design the tier↔category assignment UI), Movies (poster
   thumbnail, category, premium flag, media asset status: uploaded → processing
   → ready → distributed).
5. **Products** — the sellable items. A product is one of three types: **tier
   package**, **category unlock**, or **movie unlock**; each has price (UGX),
   duration in hours, active/featured flags, optional node restriction. Design
   the create/edit form so the type→reference picker is impossible to get wrong.
6. **JVIDEO Users** — viewer accounts: username, payer phone, node, last seen,
   active entitlements. Detail view shows entitlement history timeline.
7. **Entitlements (Access Purchases)** — the heart of the business logic. Table:
   user, product, node, starts/expires, amount paid, active flag, source badge
   (**payment** vs **admin-granted** — visually distinct, admin grants are
   "free"). The grant form must clearly show: product defaults (duration, price)
   with optional **override duration** and **override amount** fields, and a
   live preview of the computed start→expiry, including **stacking** ("this
   user's current access ends Fri 10:00 — new access will run Fri 10:00 → Sat
   10:00").
8. **Payments** — financial transactions, strictly separate from entitlements.
   Status lifecycle badges: pending / successful / failed / refunded. Columns:
   amount, currency, provider, provider reference, node, payer. Detail shows the
   entitlement it generated (if any). Include a **"Simulate payment"** action
   (dev/test tool) that walks pending → successful.
9. **Revenue** — per-payment revenue entries: gross = platform share + site
   owner share at the node's commission %. Summaries by day, node, site;
   settlement status. This is what site owners see (scoped to their sites only —
   design that restricted variant).
10. **Media** — upload flow for movie files: drag-drop upload → processing
    (FFmpeg) progress → ready → distribution status per node. Show storage usage
    and retention warnings.
11. **Sync queue** — per-node instruction log (user_create, permission_update,
    media_add, jellyfin_refresh, …) with status, attempts, last error; retry
    action.
12. **Login** — simple, dark, badge "Admin Console".

## 3. Surface B — Customer Portal (mobile-first, captive-portal web page)

**Personality:** completely different from the console — warm, cinematic,
inviting, but *lightweight*. Big touch targets, one decision per screen, works
beautifully at 360px wide. No heavy imagery beyond small poster thumbnails; it
must load fast through a walled garden. This page is often the customer's first
impression of JVIDEO.

Flow to design (each step one screen):

1. **Home / product picker** — "Watch movies on this WiFi — no internet bundle
   needed." Featured products as cards: name, what it unlocks (e.g. "All Sports
   + Kids for 24 hours" or "Premiere: <movie>"), price in UGX, duration. Group:
   time bundles / category passes / single movies.
2. **Account step** — two clear paths: **"I'm new"** (we'll create your username
   and SMS you the password) vs **"I have an account"** (enter existing username
   to renew/extend — show current expiry if active, and explain stacking in
   human words: "your new time is added after your current time ends").
   Payer phone number input (this is who pays and receives the SMS — may differ
   from the viewer).
3. **Pay** — product summary + phone + provider (MTN MoMo / Airtel Money), big
   pay button, then a **waiting state**: "Approve the prompt on your phone" with
   gentle progress, timeout handling, and retry.
4. **Success / credentials** — username + "password sent by SMS to 07XX…", a
   prominent **"Start watching"** button (opens the local Jellyfin), and a
   fallback card: "Can't tap the button? Open <local address> and log in
   manually." Failure variant: payment failed / cancelled, with retry.
5. **Check my account** — lightweight lookup: enter username → see active
   entitlements and expiry times.

## 4. Design system deliverables

- **Tokens:** dark-theme palette for the console (background layers, surface,
  border, text hierarchy, brand accent), a distinct warmer accent for the
  portal; semantic status colors used consistently across both surfaces
  (success/active, pending/processing, warning/stale, error/failed, neutral/
  expired); type scale, spacing scale, radii, elevation.
- **Status badge language:** payments (pending/successful/failed/refunded),
  entitlements (active/expired/disabled, payment-sourced vs admin-granted),
  nodes (online/syncing/stale/offline), sync items (pending/delivered/acked/
  failed), media (uploaded/processing/ready/distributed/expired). One coherent
  system.
- **Core components:** data table (dense, sortable, filter bar), stat tile,
  chart frames (revenue over time, revenue by node), form patterns (including
  the override-with-default-preview pattern from screen 7), modal, toast,
  timeline (entitlement history), empty/loading/error states, mobile product
  card, big-button mobile stepper.
- **Accessibility:** WCAG AA contrast in both themes; the portal must be
  readable in bright sunlight (high contrast, large type).

## 5. What NOT to do

- Don't design a consumer streaming app — playback happens in Jellyfin, not in
  our UI. Our surfaces are the *store* and the *control room*.
- Don't merge the two surfaces' personalities; they share tokens and status
  language, not layout or mood.
- No heavyweight illustrations, video backgrounds, or webfonts on the portal;
  assume 2G-grade connectivity through a captive portal.
- Don't invent features not listed here (no watch history, no ratings, no social).

Start with: (1) the token spec, (2) the Admin Console dashboard + entitlement
grant form, (3) the full customer portal flow — these anchor everything else.
