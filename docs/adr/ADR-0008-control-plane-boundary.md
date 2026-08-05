# ADR-0008: JKANNEL is a control plane; the engine owns the data plane

- **ADR Number:** 0008
- **Title:** JKANNEL is a control plane; Kannel/Kamex bearerbox owns the message data plane
- **Status:** Accepted
- **Date:** 2026-08-04
- **Decision owner:** Project owner (Peter Hyeroba), recorded by the maintainer

## Context

Building the Live Queue console surfaced a hard boundary. The outbound message
queue exists in three tiers:

1. **SQLBox spool** (`send_sms`) — rows JKANNEL owns and can address individually.
   Measured against the live stack, bearerbox drains this in **under one second**.
2. **Bearerbox internal per-SMSC queue** — where messages actually accumulate when a
   bind is slow, throttled or down. The Kannel admin HTTP interface exposes this only
   as an aggregate `queued` counter per SMSC. Individual messages here cannot be
   listed, inspected, moved, retargeted or cancelled by any admin command.
3. **History** (`sent_sms`) — terminal; "rerouting" here means submitting a fresh
   message to a different bind.

Operators reasonably ask to "see the queue and move messages to another bind". Tier 2
is the tier they are usually picturing, and it is the one the engine does not expose.

## Problem statement

Should JKANNEL take ownership of the outbound queue — holding messages itself and
releasing them to bearerbox only when a bind is confirmed healthy — so that every
queued message becomes individually addressable and reroutable?

## Alternatives considered

1. **JKANNEL-owned outbound queue.** A JKANNEL table would hold messages; a dispatcher
   would release them into `send_sms` only when the chosen bind is healthy. This makes
   every queued message addressable and reroutable.
   *Rejected.* It duplicates functionality that Kannel has hardened over two decades —
   retry, throttling, windowing, store-and-forward, DLR correlation, SMPP flow control
   — and puts JKANNEL on the critical path of every message. A control-plane bug would
   become a message-loss bug. It also forfeits the reason Kannel/Kamex was chosen.

2. **Patch the engine** to expose per-message queue operations over the admin API.
   *Rejected.* It forks a battle-tested upstream, creates a permanent maintenance
   burden, and would have to be re-applied for every engine JKANNEL supports — directly
   contradicting the generic Engine Adapter design (ADR-0007).

3. **Accept the boundary and give operators equivalent outcomes by other means.**
   *Chosen.*

## Decision

**JKANNEL is a control plane. The engine remains the data plane and the sole owner of
in-flight message state.** JKANNEL will not build a competing outbound queue, and will
not fork the engine to obtain per-message queue control.

Where the engine does not expose a capability, JKANNEL reports that honestly rather
than simulating it. Concretely, for queue control JKANNEL provides:

- **Visibility** — per-bind status, queue depth, failure and throughput counters,
  polled from the engine's own status interface.
- **Tier-1 reroute** — retargeting messages still in the spool (`UPDATE smsc_id`),
  correctly framed as a narrow window given the sub-second drain.
- **Bind control** — starting, stopping and reconnecting a *single* bind without
  restarting the engine, so traffic can be steered away from an unhealthy carrier.
- **Resend** — bulk resubmission of failed or undelivered traffic to a chosen bind,
  driven by DLR-derived delivery status. This is the primary operator path.

The supported answer to "move the traffic off this bad bind" is therefore: **disable
the bind, then resend the affected messages to a healthy one** — an outcome equivalent
to per-message rerouting, achieved without owning the data plane.

## Consequences

- Messages already inside bearerbox cannot be individually listed or moved. This is an
  accepted, documented product boundary — not a defect, and not something to be worked
  around by silently pretending otherwise in the UI or API.
- JKANNEL stays off the message critical path, so a control-plane outage degrades
  observability and management, not delivery.
- Engine portability is preserved: the capability set required here (status snapshot,
  per-bind start/stop) is small and expressible through the Engine Adapter contract, so
  a second engine remains viable.
- Queue-related features must be designed against what the adapter can honestly report.
  Any future engine exposing richer queue introspection can surface it as an additional
  capability without changing this decision.

## Risks

- **Operator expectation gap.** Users may still expect per-message control over tier 2.
  *Mitigation:* the Live Queue UI and API docs state the boundary plainly and route the
  user to the disable-and-resend workflow.
- **Resend duplicates.** Resending a message whose original later succeeds can deliver
  twice. *Mitigation:* resend is explicit and operator-initiated, is audited, and is
  driven by DLR-derived failure status rather than by guesswork.
- **Engine opacity during incidents.** Aggregate counters may be insufficient for deep
  diagnosis. *Mitigation:* pair queue depth with per-bind health polling and alerting so
  problems are caught before the queue becomes the only signal.

## Future review

Revisit if any of the following becomes true:

- The engine gains per-message queue introspection or extraction upstream.
- A regulatory or contractual requirement demands per-message custody guarantees that
  only a JKANNEL-owned store can provide.
- JKANNEL is required to route across multiple independent engines simultaneously, where
  a coordinating queue above the engines may become unavoidable.

---

## Amendment 1 — Scheduled sends are held by JKANNEL (2026-08-05)

**Status:** Accepted. Additive; the decision above is unchanged.

### What prompted it

"Send later" did not work. `scheduledAt` was written onto the engine row as
`send_sms.deferred`, which sqlbox turns into SMPP `schedule_delivery_time` — a
**request to the carrier**, not a hold. Most carriers refuse it (Kannel's own
documentation warns the parameter "is hated by the SMSC in 99% of the cases"),
and the `smsc = fake` bind this deployment runs ignores it outright:
`gw/smsc/smsc_fake.c` contains no reference to `deferred` at all. A message
scheduled for 09:00 tomorrow was recorded faithfully and then delivered
immediately. The console said "scheduled"; the handset disagreed.

### Decision

**JKANNEL holds explicitly deferred messages itself and releases them into the
existing send path at the scheduled instant.** The engine is not modified, not
forked, and not asked to do anything it does not already do.

### Why this is not the outbound queue this ADR rejected

The rejected alternative was a JKANNEL table in front of **every** message, with
JKANNEL deciding when each one was safe to release based on bind health. That
would have duplicated retry, throttling, windowing, store-and-forward, DLR
correlation and SMPP flow control, and put the control plane on the critical
path of all traffic — so a control-plane bug would become a message-loss bug.
Every word of that reasoning still stands.

Scheduling is a different thing in three specific ways:

| | Rejected outbound queue | Scheduled-send hold |
|---|---|---|
| **What it holds** | all outbound traffic | only messages an operator explicitly deferred |
| **When it holds** | after the send decision, in front of the bearer | before the message enters the data plane at all |
| **What it decides** | *whether the bind is healthy enough to release* — an engine concern | *whether the requested instant has arrived* — a control-plane concern |

Once released, the message goes through `MessageSendService` exactly as an
immediate send does and the engine's behaviour is byte-for-byte unchanged.
Immediate traffic — the overwhelming majority — never touches the hold. The
control plane is not on the critical path of anything it was not already on.

The distinction in one line: **"when should this be submitted?" is a
control-plane question; "how is it delivered once submitted?" remains the
engine's.** Nothing here gives JKANNEL custody of in-flight message state, which
is what the decision above protects.

`validityMinutes` is deliberately **not** reimplemented. Real SMPP carriers do
honour `validity_period`, so it stays an engine concern and is still written onto
the `send_sms` row of the eventual submission.

### Implementation, in brief

A held send is a `scheduled_messages` row (migration 042) plus an `api_jobs` row
of type `message.scheduled.release` whose `next_attempt_at` **is** the scheduled
instant. No new scheduler was written: the existing job queue already claims due
work with `FOR UPDATE SKIP LOCKED` (so N replicas release a message exactly
once), and already provides backoff, bounded attempts, dead-lettering and
stale-claim reaping.

Three consequences worth recording:

- **Entitlements are evaluated at release, never at schedule time.** Quota,
  credit, sender-ID approval, blocklist and routing are all checked at the
  moment of sending, so a message scheduled at midnight consumes the 09:00
  quota and is refused if the customer's standing has changed overnight.
- **Missed windows have a decided outcome.** If the platform is down across the
  scheduled instant, the message is released late and flagged, up to a
  configurable staleness ceiling (`SCHEDULED_SEND_MAX_LATENESS_MINUTES`,
  default 120). Beyond that it is marked `expired` and **not** sent, because an
  SMS arriving three days late can be worse than one that never arrives.
- **Held messages are cancellable and reschedulable; released ones are not,**
  and the API answers 409 saying so rather than reporting a cancellation that
  stopped nothing.

### New risk this introduces

JKANNEL now holds message content at rest for the duration of a hold, and a
JKANNEL outage spanning a scheduled instant delays — or, past the ceiling,
prevents — that delivery. That is inherent to scheduling anywhere, and is the
cost of the capability being real; it is bounded to deferred traffic only, and
immediate delivery remains independent of the control plane exactly as this ADR
requires.

### Future review

Revisit if an engine JKANNEL supports gains a *reliable* server-side hold (not
`schedule_delivery_time` passed to a carrier), at which point delegating the
wait to the adapter would be preferable to holding it here.

## References

- ADR-0007 — heterogeneous engine support via the Engine Adapter contract
- `project/SPEC_GAP_ANALYSIS.md` — three integration voids and the build order
- `backend/src/queue-console/` — the implementation of the capabilities listed above
- `backend/src/messaging-depth/scheduled-send.service.ts` — the scheduled-send hold (Amendment 1)
- `database/migrations/042_scheduled_messages.up.sql` — the hold's storage and RLS
