# JVIDEO — GUI Design Brief, Addendum 2 (Node Ingest Station + Hotspot Owner Portal)
# Paste this into the SAME Claude design conversation as DESIGN_PROMPT.md and
# Addendum 1. Same design system, same tokens, same status-badge language.
# ─────────────────────────────────────────────────────────────────────────────

Two more capability areas have been specified. Context you need on top of the
previous briefs:

1. **Movies can also enter the system AT the node**, not only by hub push.
   An operator at a hotspot can plug a **flash drive / USB disk** into the
   node machine. Two ingest modes: (a) a small node-local web interface for
   manually uploading and classifying movies, and (b) fully automatic — if
   the disk carries a known folder structure and manifest, the node ingests
   it hands-free. Either way the node classifies what it received and
   reports it up to the mothership, which registers the movies in the
   central catalog.
2. **Hotspot owners are first-class account holders.** The businesses that
   host our nodes get platform accounts. We configure their revenue-share
   percentage; they can see the revenue their sites generate, and they can
   **withdraw their earnings at any time** (mobile money payout). The
   platform tracks balances, withdrawal requests, payout processing, and
   reporting on all of it.

Design the following.

## A. Node Ingest Station (runs ON the node — a third, tiny surface)

This is a local web page served by the node machine itself, used by a
non-technical hotspot operator standing next to it. It must work with no
internet (LAN only), on whatever cheap screen/phone is at hand. Keep it to a
handful of screens, big targets, unmissable states.

1. **Ingest home / drive detection** — idle state shows node name, disk
   gauge, movie count, "last synced with HQ" time. When a USB drive is
   plugged in: a large card announcing the detected drive, its size, and —
   if it matches the known folder structure + manifest — a **"Auto-import
   N movies"** primary action with a preview list (title, category from the
   manifest, size). If the structure is NOT recognized: fall through to
   manual mode with a gentle explanation.
2. **Manual upload & classify** — pick files from the drive, then a
   classification step per movie (or bulk): title (pre-filled from
   filename, cleaned), category picker (the node's categories), premium
   flag. Show per-file copy progress and disk-space impact ("after import:
   142 GB free").
3. **Import progress & result** — clear running state (N of M copied,
   current file, ETA), then a result screen: imported / skipped
   (duplicates) / failed, and a prominent status line: **"HQ will be
   notified on next sync"** → flips to "HQ notified ✓" when the report is
   acked. Design the offline case explicitly: importing works fully
   offline; only the HQ notification waits.
4. **Local library** — simple list of what's on this node (mirrors the
   admin Library tab but read-only, operator-friendly).

## B. Admin Console — ingest visibility additions

5. **Catalog / movie list**: an **origin badge** per movie — `hub upload`
   vs `node ingest` (with the node's name). Node-ingested movies may need
   catalog cleanup, so design a lightweight **"review ingested"** filter/
   queue: confirm title, category, premium flag, merge-with-existing-movie
   action for duplicates under a different name.
6. **Node detail / Library tab**: ingested-locally marker on rows; an
   ingest-history strip (when, how many, from what drive/manifest).

## C. Hotspot Owner Portal (the site_owner experience in the Admin Console)

The owner logs into the same console but sees a focused, friendlier subset.
This is a business partner reading their earnings on a phone or cheap
laptop — clarity over density here (unlike the operator screens).

7. **Owner dashboard** — the money view first: **Available balance** (big),
   pending withdrawals, lifetime earned, this month vs last month. Then
   their sites/nodes: status, viewers, revenue per node. Their configured
   revenue-share % must be visible (read-only to them).
8. **Earnings detail** — per-day/per-node earnings table + simple chart;
   each row traceable to payments (count, gross, their share). Date-range
   picker with sensible presets (today / 7d / this month).
9. **Withdraw flow** — from the balance card: amount entry (with
   available-balance validation and a "withdraw all" shortcut), payout
   destination (mobile money number, pre-filled from profile, editable with
   confirmation), review step, then a submitted state:
   "Withdrawal requested — usually paid within X". Statuses the design must
   carry: **pending → approved → paid** or **rejected** (with reason).
10. **Withdrawal history** — table: date, amount, destination, status
    badge, payout reference once paid, running balance column.

## D. Admin Console — payout operations (super admin side)

11. **Withdrawal queue** — all owner withdrawal requests: owner, site(s),
    amount, available-balance-at-request, destination, age, status. Row
    actions: approve, mark paid (capture payout reference), reject (reason
    required). Bulk approve. A pending-payouts badge in the global nav.
12. **Revenue-share & payout reports** — per owner/site: earned vs
    withdrawn vs balance over time; platform-wide totals: liability (sum of
    unpaid owner balances), payouts this month, share split trend. One
    clear chart answering "how much do we owe our partners right now?"
13. **Owner account management** — create/edit hotspot-owner accounts, link
    them to their site(s), set the revenue-share % (with an effective-from
    note), set payout destination defaults, deactivate.

## E. Design-system additions

- **New status set — withdrawals:** pending / approved / paid / rejected,
  consistent with the existing badge language.
- **Origin badge pair:** `hub` vs `node` (used for movie origin and
  request source — keep one visual convention).
- **Money display rules for balances:** big-number balance style, always
  with currency; negative/zero states designed (zero balance disables the
  withdraw button with a friendly note).
- **Drive-detected card + copy-progress** patterns for the ingest station.
- The ingest station inherits portal-grade lightness (no webfonts, works at
  360 px) but with the console's operational tone.

Everything else in the design remains as it has been.