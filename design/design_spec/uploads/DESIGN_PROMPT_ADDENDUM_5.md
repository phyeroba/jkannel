# JVIDEO — GUI Design Brief, Addendum 5 (Node Enrollment + Headless Ingest Note)
# Paste into the SAME Claude design conversation as the previous briefs.
# ─────────────────────────────────────────────────────────────────────────────

Two refinements.

## A. Admin Console — Node Enrollment (new screen / node-create flow)

Nodes are headless Ubuntu boxes provisioned with ONE command — no manual
VPN typing. Design:

1. **Create-node flow ends in an enrollment card:** the one-time enrollment
   token and a copy-paste one-line installer command
   (`curl -fsSL https://hub.../install.sh | sudo bash -s -- <TOKEN>`), with
   copy buttons, the token's expiry countdown, and a plain-language "hand
   this to whoever racks the box" framing. Token shown once — same
   reveal-once pattern as the node API secret.
2. **Node lifecycle strip** on the node list/detail:
   `created → enrolled → vpn-up → active` as a stepper with timestamps;
   stuck states get a hint ("installer not run yet", "tunnel not up —
   check connectivity"). Actions: revoke + re-enroll (generates a fresh
   token, invalidates old credentials — destructive confirm).
3. **VPN health chip** on node rows: tunnel address + last handshake age.

## B. Ingest Station reframing (amends Addendum 2 §A)

The node has NO screen or keyboard. **Automatic USB ingest is the primary
mode:** someone plugs in a USB drive; the box detects it, reads
`jvideo-manifest.json` (which declares each file's category), copies
content, and notifies HQ — immediately if online, later when the network
returns. Nobody interacts with a UI for this to work.

Design consequences:
- The Ingest Station web page (Addendum 2) is a **secondary monitoring/
  manual surface opened from a phone on the hotspot WiFi** — reframe its
  idle screen around "what happened automatically": last auto-import
  result (N imported / skipped / failed, from which drive, when), HQ
  notification state ("queued — will send when online" vs "HQ notified ✓"),
  and manual classify only as the fallback for unrecognized drives.
- Add a small **"prepare a drive" helper** in the ADMIN console: pick
  movies/categories → download a generated `jvideo-manifest.json` (+ folder
  layout instructions) to copy onto a USB drive. This is how office staff
  prepare content drives for the field.
- The node detail's ingest-history strip (Addendum 2 §B6) should mark
  auto vs manual imports.

Everything else from the previous briefs stands.
