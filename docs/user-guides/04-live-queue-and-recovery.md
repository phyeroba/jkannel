# 4. Live Queue: watching traffic and recovering a bad bind

This is the workflow you will use at 03:00 when a carrier goes bad. Read it before you
need it.

**The short version:** a bind is failing. You disable that one bind, filter the message
log to resendable failures, and resend them to a healthy bind. The engine and every
other bind keep running throughout. No restart.

---

## Understand the boundary first — it decides what you can and cannot do

The outbound queue exists in three tiers, and JKANNEL can address them very differently.

| Tier | Where it is | What you can do |
|---|---|---|
| **1. Pending spool** (`send_sms`) | JKANNEL's side of the handover | **Reroute** or **cancel** individual messages. But a healthy engine drains this in **under a second**, so it is nearly always empty. |
| **2. Bearerbox internal per-SMSC queue** | Inside the engine | **Nothing per-message.** The engine's admin interface exposes this only as an aggregate `queued` counter per SMSC. Individual messages here cannot be listed, inspected, moved, retargeted or cancelled by any admin command that exists. |
| **3. History** (`sent_sms`) | Terminal | **Resend** — submit a fresh copy to any bind you choose. |

Tier 2 is the one you are picturing when you say "move the queued messages to another
bind", and it is the one the engine does not expose.

This is a deliberate architectural decision, recorded in
[ADR-0008](../adr/ADR-0008-control-plane-boundary.md). JKANNEL could have owned the
outbound queue itself — holding every message and releasing it only when a bind is
confirmed healthy — which would make every message individually addressable. That was
rejected: it duplicates retry, throttling, windowing, store-and-forward, DLR
correlation and SMPP flow control that Kannel has hardened over two decades, and it
would put the control plane on the critical path of every message, turning a
control-plane bug into a message-loss bug.

So instead of pretending, JKANNEL gives you the equivalent **outcome** by another route:

> **Disable the sick bind, then resend the affected traffic to a healthy one.**

That is the supported workflow, and it is built into the screen.

---

## The screen

Go to **Live Queue** (Messaging group). Top to bottom:

1. **Refresh controls** — **Auto refresh** (On/Off), **Every** (2s/5s/10s/30s/60s,
   default 5s), and a **Refresh** button. The status line reads *"Last updated
   14:32:07"*, or *"Waiting for the first snapshot…"* before the first load.
2. **Engine** — seven tiles: **SMS queued out**, **SMS queued in**, **DLR queued**,
   **Pending in spool**, **Oldest pending**, **Uptime**, **Version**.
3. **Binds** — one card per bind the engine reports.
4. **Message log & resend** — the primary operator surface.
5. **Pending spool** — tier 1.

Auto refresh reloads the **Engine** strip and the **Pending spool** only. The message
log and the bind dropdown do not auto-refresh; use their own **Refresh** and **Apply
filters** buttons.

### Trust the honest degradation

If the engine is unreachable or degraded you get a banner:

> *"Engine runtime unreachable — the engine and per-bind counters below are not live and
> must not be read as real zeros. Spool and message data are still live, read straight
> from the message store."*

Take it literally. A zero queue depth on that banner means "not observed", not "empty".

---

## Watching: what each bind card tells you

Each card shows the bind name, a status chip, the engine id, and:

| Field | Reading it |
|---|---|
| **queued on this bind** | The tier-2 counter. **This is the number that matters.** Rising steadily = the bind is not draining. |
| **Failed** | Cumulative failures on this bind. |
| **Sent** / **Received** | Cumulative counts. |
| **Outbound rate** | Throughput. A healthy bind under load has a non-zero rate. |
| **Known SMSC** | Reads *"not configured in console"* if the engine has a bind JKANNEL does not have an SMSC record for. |

**The pattern that means trouble:** queue depth rising, outbound rate at or near zero,
failures climbing, status not `online`.

The **Pending spool** panel is different. Its own note says it plainly: *"A healthy
engine drains this in under a second, so an empty grid here is the normal, healthy
state."* An empty spool is good news, not a missing feature.

---

## Recovering a bad bind — the full workflow

### Step 1 — Confirm which bind is sick

On the **Binds** cards, find the one with rising **queued on this bind**, a low or zero
**Outbound rate**, and climbing **Failed**. Cross-check on
**SMSC Connections → row → SMSC detail → Recent health** if you want the transition
history.

### Step 2 — Stop the bleeding: disable that bind

On the sick bind's card, click **Disable this bind** (you need the `smsc.manage`
permission; without it the card says *"Bind control requires the smsc.manage
permission."*).

The confirmation dialog states exactly what will happen:

> *Disable the bind "Acme Carrier" (acme-carrier)?*
>
> *This stops ONLY this one SMPP bind. The engine and every other bind keep running.
> Traffic already queued for this bind stays put until it is enabled again, rerouted,
> or resent to another bind.*

Confirm. You get *"Bind "Acme Carrier": disable accepted"*.

**What this achieves:** new traffic stops being handed to the failing bind. Routing will
stop selecting it, because candidate binds come from live bind state. What it does
*not* do is move what is already inside tier 2 — that stays there until the bind comes
back or you resend it.

### Step 3 — Find the traffic that needs resending

Scroll to **Message log & resend**. Click the preset **Resendable failures**. It shows
a count badge, and sets the **Status** filter to *"Resendable failures (failed +
rejected)"*.

Narrow it further if you need to:

| Control | Use |
|---|---|
| **Bind** | Select the sick bind so you only see its traffic. |
| **Search** | *"Sender, receiver, reference, or text"*. Press Enter or click **Apply filters**. |
| **Status** | Any of: All · Resendable failures (failed + rejected) · In flight (pending + buffered) · Failed · Rejected · Delivered · Accepted by SMSC · Buffered at SMSC · Pending (no report yet) · Unknown |

The other presets are **In flight**, **Delivered** and **All**.

The counts next to each option cover **every message in the current search/bind scope**,
not just the page you are looking at — the footer note tells you which of the two
you are seeing.

### Step 4 — Resend to a healthy bind

Two ways, both in the bulk bar (needs the `messages.send` permission):

**Selected rows.** Tick the rows you want — the header checkbox selects all resendable
rows on the page — pick a bind in **Resend to bind**, and click
**Resend {n} selected**.

**Everything matching the filter.** With a status filter set (not "All"), click
**Resend all {n} matching**. The confirmation reads:

> *Resend every message matching the "Resendable failures" filter (1,284) to Backup
> Carrier?*
>
> *Each one is submitted again as a new message; at most 500 are sent per batch.*

Repeat until the count reaches zero.

You get back *"482 of 500 message(s) re-queued on Backup Carrier. 18 skipped — see the
per-message reasons below."* Each result row shows either `re-queued as {id}` or the
reason it was skipped.

Common skip reasons, and what they mean:

| Reason | Meaning |
|---|---|
| *delivery reports are receipts, not messages, and cannot be resent* | You selected a DLR row. Receipt rows are not resendable — their checkbox is disabled and the tooltip says so. |
| *the logged message has no receiver or body to resend* | The history row is incomplete. Nothing to reconstruct. |
| *not found in the sent history visible to your tenant* | Not yours, or already aged out. |

### Step 5 — Confirm recovery

Watch the healthy bind's card: **Outbound rate** should climb and its **queued on this
bind** should stay low. Switch the log preset to **Delivered** and confirm the resent
traffic is landing.

### Step 6 — Bring the original bind back

Once the carrier confirms the problem is fixed, click **Enable** on the disabled bind's
card. Watch its counters for a few minutes before routing depends on it again.

---

## Two things about resending you must know

### Resending creates a new message

*"Resending re-queues a fresh copy of each message on the chosen bind; the original
history row is left untouched."*

So:

- The original stays in history with its original failed status. Your delivered/failed
  counts will show both.
- **If the original later succeeds after all, the recipient gets it twice.** Resend is
  explicit, operator-initiated and audited precisely because this risk is real. Resend
  from DLR-derived failure status, not from a hunch.

### Operator resend bypasses routing and entitlements — by design

A resend targets **the bind you picked**. It does not run route selection, and it does
**not consume the customer's quota or credit**.

That is intentional. This is an operator recovery action on traffic the customer already
paid for; charging them twice for your carrier's outage would be wrong, and re-routing
would defeat the point of you choosing a specific healthy bind. But it does mean:

- **Quota and credit reporting will not reflect resent volume.** If you resend 50,000
  messages, the customer's quota counter does not move.
- **Route configuration has no effect on a resend.** If you pick a bind that is also
  unhealthy, the resend will fail on that bind too.

Every resend is audit-logged (`queue.resent`), so the record of who moved what, where,
and when is complete.

---

## Tier 1: the pending spool

The **Pending spool** panel handles messages accepted but not yet handed to a bind.
Columns: **Sender**, **Receiver**, **Text**, **Target bind**, **Age**, **SQL ID**.

| Action | What it does |
|---|---|
| **Reroute {n} selected** | Retargets the selected spool rows to the bind chosen in **Reroute to bind**. A true zero-restart retarget. |
| **Cancel selected** | Removes them. The confirmation says *"They are removed from the spool and will never be delivered."* |

Expect skips here, and do not read them as errors. The notice explains:

> *"…those were already handed to the engine between loading the grid and clicking
> reroute. That is expected on a healthy engine (it drains the spool in under a second),
> not an error. Resend them from the message log instead."*

That is the boundary in action. The spool is a narrow window, which is exactly why the
message log — not the spool — is the primary recovery path.

---

## Quick reference

| I want to… | Do this |
|---|---|
| See whether a bind is healthy | **Binds** cards: queue depth, outbound rate, failed count |
| Stop traffic going to a bad carrier | **Disable this bind** on its card |
| Move already-queued traffic off a bad bind | You cannot, per-message. Disable the bind, then resend from the log |
| Resend failed traffic somewhere healthy | Log → preset **Resendable failures** → **Resend to bind** → **Resend all {n} matching** |
| Retarget something not yet handed to the engine | **Pending spool** → **Reroute to bind** |
| Drop something that must not go out | **Pending spool** → **Cancel selected** (only works before the engine takes it) |
| Restart just one bind | **Disable this bind**, wait, then **Enable** |
| Restart the whole engine | Not from here, and you almost never need to |

---

## Required permissions

| Action | Permission |
|---|---|
| View the Live Queue, spool and log | `messages.view` |
| Resend, reroute, cancel | `messages.send` |
| Enable / disable / reconnect a bind | `smsc.manage` |

---

Next: [Routing →](05-routing.md)
