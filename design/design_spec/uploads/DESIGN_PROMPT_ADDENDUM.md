# JVIDEO — GUI Design Brief, Addendum 1 (Staging, Requests, Storage Reports)
# Paste this into the SAME Claude design conversation as the original brief
# (DESIGN_PROMPT.md). It extends the two surfaces with newly specified
# features — same design system, same tokens, same status-badge language.
# ─────────────────────────────────────────────────────────────────────────────

New platform capabilities have been specified since the original brief. The
architecture context you need: the central server (the **hub**) and all
media nodes (**spokes**) share a VPN; the hub **pushes content to nodes at
night** when traffic is low. Media is uploaded and prepared on the hub
first (**staging**), the admin chooses which nodes get it and when, and the
scheduler moves the bytes during the off-peak window. Nodes report their
local movie library and disk capacity back to the hub. Customers at a node
can search what's available locally and **request movies** that aren't —
requests queue on the node when the network is down and sync up later.

Design the following additions.

## A. Admin Console — new screens

1. **Media staging wizard** (replaces the plain upload screen). Three steps
   on one flow:
   - *Upload & prepare:* file drop → movie association → FFmpeg processing
     progress (uploaded → processing → ready).
   - *Target nodes:* a node picker table showing, per node: site, online/
     stale status, **free disk vs. required size** (clear visual when a node
     doesn't have room), and whether it already has this movie. Multi-select
     with "all nodes carrying this category" shortcut.
   - *Schedule:* when the push happens. Default = "tonight's window
     (01:00–05:00)", options for next window, a specific date/night, or
     "immediately (override — warns about daytime bandwidth)".
   - Confirmation summary: N nodes, total bytes to move, window.
2. **Distribution queue** — the operational heart of content delivery. A
   table of distribution jobs: movie, asset size, target node, status
   (scheduled / transferring / completed / failed / cancelled), scheduled
   window, started/finished time, duration, bytes moved, attempts, error.
   Filters by status/node/date. Row actions: cancel (scheduled only), retry
   (failed). A per-night group header: "Night of 12 Jul — 8 jobs, 6 nodes,
   14.2 GB, 2h 10m". Live progress for currently transferring jobs.
3. **Movie requests** — the demand pipeline from customers to admins.
   Queue table: requested title, node (and site), requester (username or
   phone), source badge (**portal** = typed online vs **node** = queued
   offline and synced later), age, status. Status workflow the design must
   make obvious: `pending → acknowledged → sourced → fulfilled` (or
   `rejected`), where *sourced* links the request to a movie now in the
   catalog and *fulfilled* means it reached the requester's node. Bulk
   acknowledge. A count badge for pending requests belongs in the global
   nav.
4. **Storage & distribution reports** — extends the dashboard/reports area:
   - **Hub storage tile:** total/used/free disk on the mothership media
     store, with a warning threshold.
   - **Per-node storage table/gauges:** each node's disk total/free, last
     reported time, movie count, stale-report warning.
   - **Distribution stats over time:** nights on the x-axis — nodes updated,
     jobs completed vs failed, GB moved, average and total transfer
     duration. Answering: "how many nodes got content last night and how
     long did it take?"
5. **Node detail — new "Library" tab:** the movies currently on that node
   (name, category, size, since-when), its disk gauge, and its pending
   distribution jobs.

## B. Customer Portal — new screens (same lightweight, low-end-Android rules)

6. **Browse what's on this WiFi** — the local catalog. Search box (instant,
   forgiving), category chips, compact poster-or-text list showing what is
   watchable *right now on this node*. Empty-search state invites browsing
   by category. This is discovery for the store — playback still happens in
   Jellyfin.
7. **"Can't find it? Request it."** — visible from search results (especially
   the no-results state) and as its own step:
   - Form: movie title (free text), optional name/username, optional phone.
   - Success state: "Request received — we'll add it to this hotspot soon."
   - The same flow must read fine when the node is offline: the request is
     saved locally and synced later, so the copy must not promise
     immediacy ("your request will be sent when the connection returns").
8. **My requests** (lightweight): given a username, list that user's
   requests with plain-language status ("waiting", "we're getting it",
   "now available — watch tonight!").

## C. Design-system additions

- **New status set — distribution jobs:** scheduled / transferring /
  completed / failed / cancelled, consistent with the existing badge
  language (pending-ish, processing-ish, success, error, neutral).
- **New status set — movie requests:** pending / acknowledged / sourced /
  fulfilled / rejected.
- **Disk gauge component:** used on hub tile, node table, node detail;
  states normal / warning (>80%) / critical (>95%).
- **Bytes + duration formatting rules:** GB with one decimal, durations as
  "2h 10m".
- **Night-window visual:** a compact way to render "01:00–05:00 window,
  night of 12 Jul" that recurs across staging, queue, and reports.

Everything else in the design remains as is.