# 5. Routing

Routing decides which SMSC a message takes when the sender does not pin one. This guide
covers route types, selection strategies, and — most usefully — how to answer *"why did
this message go out over that carrier?"*

---

## Two routing screens, and which to use

The console has two, over two different APIs, with overlapping vocabulary. This is
confusing the first time.

| Screen | Nav item | Use it for |
|---|---|---|
| **Routing** | Messaging → Routing | Simple destination-prefix / sender routes, and the **Validate / Deploy / Rollback** lifecycle. Also has a basic **Route simulator**. |
| **Advanced Routing** | Messaging → Advanced Routing | Route **types** (prefix, country, operator, weighted), selection **strategies**, weighted targets, version history, and the **Resolve preview** that explains a decision. |

**Use Advanced Routing** for anything beyond a plain prefix rule. Its `/routing/resolve`
endpoint is also the same selector the live send path uses, so its preview and
production agree — the two engines were deliberately converged onto one.

---

## Route types

Set on the Advanced Routing editor as **Route type**:

| Type | Matches on | Example |
|---|---|---|
| `static` | Everything that reaches it | The catch-all at the bottom of your priority list. |
| `prefix` | A destination prefix (**Match prefix**) | `25677` for one operator range. |
| `country` | A country code (**Country code**) | `256` for all of Uganda. |
| `operator` | An operator name (**Operator**) | `MTN-UG`. |
| `weighted` | Same as its match fields, but splits traffic across several targets | 70/30 between two carriers. |

`operator` matching uses a **caller-supplied hint**. There is no HLR or MNP lookup — if
your submitter does not tell JKANNEL the operator, an operator route will not match.

## Selection strategies

Set as **Selection strategy**. This decides *which* target wins once a route matches.

| Strategy | Behaviour |
|---|---|
| `priority` | Lowest priority number wins. Deterministic. |
| `least-cost` | Cheapest **Cost per message** among healthy candidates. |
| `load-balance` | Spreads across candidates. |
| `round-robin` | Rotates through candidates in turn. |
| `time-based` | Only active inside the **Window start**/**Window end** and **Active days** you set. |

> **Round-robin rotation is per-process.** Each backend replica keeps its own counter,
> so distribution across replicas is only approximately fair. On a single-replica
> deployment it is exact.
>
> **There is no per-route or per-SMSC throughput throttling.** The `TPS limit` on an
> SMSC record is rendered into the engine configuration, but JKANNEL itself does not
> shape traffic between routes.

## Health-aware failover

Candidate binds come from **live bind state**, written by the background bind poller.
So a bind that is down is not selected, and failover to your **Fallback SMSC** actually
fires rather than being decorative.

If no bind rows exist yet — a fresh install — the selector degrades honestly to "health
unobserved" rather than assuming everything is fine.

If nothing matches, the send **fails closed**. JKANNEL will not guess a bind.

---

## Creating a route

1. Go to **Advanced Routing**.
2. Click **New route**.
3. Fill in the editor:

   | Field | Notes |
   |---|---|
   | **Name** | Required. |
   | **Priority (lower wins)** | Defaults to 100. |
   | **Enabled** | Yes / No. |
   | **Route type** | static · prefix · country · operator · weighted |
   | **Selection strategy** | priority · least-cost · load-balance · round-robin · time-based |
   | **Match prefix** / **Country code** / **Operator** | Shown only for the matching route type. |
   | **Destination prefix (legacy match)** | Kept for compatibility with the simple Routing screen. |
   | **Sender match** | Optional sender-ID condition. |
   | **Cost per message** | Used by `least-cost`. |
   | **Primary target SMSC** | Required. |
   | **Fallback SMSC** | Optional; must differ from the primary. |
   | **Window start (HH:MM)** / **Window end (HH:MM)** | Both or neither. |
   | **Active days** | Sun–Sat checkboxes. None ticked = every day. |
   | **Change reason (audited)** | Recorded in the version snapshot. |

4. For a **weighted** route, use the **Weighted targets** table: **Add target**, then
   set **SMSC**, **Weight**, **Cost** and **Enabled** per row. The note explains:
   *"Traffic is split across enabled targets in proportion to their weights. A weight of
   0 removes a target from the split without deleting it."*
5. Click **Save route**. You get *"Route "…" created; a new version snapshot was
   recorded."*

### Deploy it, or it does nothing

> **Routes default to `draft` and a draft route is not selectable.** Only routes whose
> deployment state is `deployed` are considered on the send path.

Deployment lives on the **Routing** screen (not Advanced Routing). Find the route in
the grid and use the row actions:

1. **Validate** — dry-run check, including duplicate-priority and scope conflicts.
2. **Deploy** — makes it live.
3. **Rollback** — reverts it.

Each records a reason and is audited.

### Version history

On **Advanced Routing**, the row action **History** opens **Version history — {route}**
with **Version**, **Reason**, **By**, **Recorded** and a **View definition** action.

History is read-only. There is no "restore this version" button — read the old
definition and re-enter it.

### Archiving

Row action **Archive**. The confirmation reads: *"Archive the route "…"? It is disabled
(not deleted) and a version snapshot is recorded. Traffic that matched it will fall
through to the next matching route."*

---

## Answering "why did this message take that carrier?"

This is the question routing screens exist for. There are two tools.

### The Resolve preview — before you send

At the top of **Advanced Routing**, the **Resolve preview** panel: *"Which SMSC a
destination would be sent through right now, and why."*

1. Enter **Destination MSISDN** (pre-filled with `+256700000000`).
2. Optionally enter **Sender** and **Operator** — supply the operator if you want to
   test an operator route.
3. Optionally set **Rotation**. The helper text explains it: *"Rotation is the
   round-robin / load-balance counter — increment it to see the next target the engine
   would pick. This is a preview only; nothing is sent and no counter is advanced."*
4. Click **Resolve**.

You get five values and an explanation:

| Result | Reads |
|---|---|
| **chosen SMSC** | The bind that would be used, or `no SMSC`. |
| **controlling route** | The route that decided it, or `no route matched`. |
| **strategy** | Which strategy did the choosing. |
| **fallback used** | `yes` / `no`. |
| **routes considered** | How many candidates were evaluated. |

Below that, a free-text **reason** and a numbered **decision trace** — the step-by-step
record of what was evaluated and why it was kept or discarded.

This is the same selector the send path runs, evaluated against live bind health and
your deployed routes. It is the authoritative "why".

### Decision audit — after you sent

Every routed message records its decision: the chosen bind, the matched route, the
strategy, whether fallback was used, and the reason. Refusals are recorded too, so a
send that failed closed leaves a trace of *why* nothing matched.

Read it back over the API:

```bash
curl -H "X-API-Key: $KEY" \
  "https://your-console/api/v1/gateway/routing-decisions?limit=20"
```

> The recorded decision is **not** joined into the console's **Message trace** panel.
> The API is the way to get it per message today.

---

## A worked troubleshooting sequence

*"Traffic for +25677… is going to the expensive carrier."*

1. **Advanced Routing → Resolve preview.** Enter the MSISDN. Click **Resolve**. Read
   **controlling route** and the decision trace.
2. If **controlling route** reads `no route matched`, your intended route either does
   not match that prefix or is not deployed. Check both.
3. If the wrong route is controlling, check its **Priority** — lower wins. A catch-all
   `static` route with priority 10 will beat a specific prefix route with priority 100.
4. If the right route is controlling but the wrong SMSC was chosen, check the
   **strategy**:
   - `least-cost` → compare **Cost per message** on the targets.
   - `priority` → check the target SMSCs' priorities.
   - `weighted` → check the target weights; a weight of 0 removes a target.
   - `time-based` → check the window and active days against the current time.
5. If **fallback used** reads `yes`, the primary bind is unhealthy. Go to
   [**Live Queue**](04-live-queue-and-recovery.md) and look at its card.
6. Change the route, **Save route**, then **Deploy** it on the Routing screen. Re-run
   Resolve to confirm.

---

## Not available

- **Visual route builder.** Advanced Routing is a form and a grid.
- **Route groups, conditions and actions** as separate objects.
- **HLR / MNP lookup.** Operator is a hint from the caller.
- **Per-route or per-SMSC throttling.**
- **Restore a previous route version** from the history panel.

---

Next: [Monitoring and alerts →](06-monitoring-and-alerts.md)
