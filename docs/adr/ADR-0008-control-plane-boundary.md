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

## References

- ADR-0007 — heterogeneous engine support via the Engine Adapter contract
- `project/SPEC_GAP_ANALYSIS.md` — three integration voids and the build order
- `backend/src/queue-console/` — the implementation of the capabilities listed above
