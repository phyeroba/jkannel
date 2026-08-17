# JKANNEL redesign plan — design system + Kamex UI functional specification

**Status:** living document. Tick items as they land. Every item is a commit.
**Sources:**
- `design/JKANNEL design system/` — tokens, components, 26-screen UI kit, `readme.md`
- `design/JKANNEL design system/Kamex_UI_Redesign_Functional_Specification-1.pdf`
  (text extracted from the `.docx` twin in `uploads/`; §-numbers below refer to it)

---

## 0. The decision that governs everything else

**The specification is for a pure gateway-operations console. JKANNEL is a superset.**

Spec §1.3 puts these *explicitly out of scope*: customer provisioning, billing,
plans, customer API credentials, customer portal functions. JKANNEL already ships
all of them — customers, quotas, credit ledger, bulk campaigns, API keys — and
they work.

**We are not deleting working functionality to match a narrower spec.** We adopt
the spec's operational hierarchy and IA for the gateway-operations half, and keep
our commercial surfaces alongside it as clearly separate sections. Where the spec
says "Kamex does not own this", we read that as "this is not part of the
gateway-ops IA", not "remove it".

Second governing decision: **the spec asks for things bearerbox cannot report.**
Per-session identity, `enquire_link` round-trip time, PDU-level counters
(`submit_sm`/`submit_sm_resp`/`generic_nack`) and protocol latency are simply not
in `/status.json`, and `instances = N` makes N sessions share one `smsc-id`. We
build what the data supports and say plainly in the UI what is not observable.
Inventing a session list we cannot populate would violate the house rule the
design system itself states: *honesty is the house rule*.

---

## 1. Information architecture

Current: 4 groups / 33 workspaces (Operations, Messaging, Insights, Platform).
Target: the spec's 6 operational sections, plus 3 JKANNEL sections the spec
excludes from Kamex but which are part of this product.

| Section | Screens | Origin |
|---|---|---|
| **Overview** | Dashboard · Alerts · Alert Lifecycle · Escalation & Maintenance · Notifications | have |
| **Connectivity** | Carriers → Carrier detail · SMSCs → SMSC detail · SMPP Sessions | Carriers + Sessions are new |
| **Traffic** | Live Traffic · Queues · DLR Performance | Live Traffic + DLR Performance are new |
| **Routing** | Routes · Advanced Routing · Failover · Route Simulator | Failover + Simulator UI are new |
| **Diagnostics** | Message Trace · SMPP Errors · Events · Log Explorer · Test Tools · Configuration | Trace UI, Errors, Events, Test Tools are new |
| **System** | Services · Nodes · Performance · Runtime Containers · Logs & Audit · Backup | Nodes + Performance are new |
| **Messaging** *(JKANNEL)* | Messages · Bulk Send · Scheduled · Content Filtering · Inbound Routing · Delivery Reports | have |
| **Customers** *(JKANNEL)* | Customers · Analytics & Reports · AI Copilot | have |
| **Platform** *(JKANNEL)* | API Gateway · API Reference · Plugins · Users & Roles · Roles · Sessions · Settings · Docs | have |

---

## 2. Phases

Follows the spec's own delivery sequence (§20), reordered where our existing code
changes the economics. **Each numbered item is one commit.**

### Phase 0 — Brand alignment (visual foundation)

The design system replaces the Vuexy violet `#7367f0` with **DocFlow Blue
`--blue-500 #1a86c8`** house-wide. Everything else in the token set (surfaces,
ink, status hues, sidebar navy, spacing, shadows) was lifted *from* our shipped
stylesheets and already matches.

- [x] **0.1** Adopt the `--blue-50…900` ramp in `frontend/src/style.css`; repoint
      `--brand`, `--brand-2`, `--brand-press`, `--brand-soft`, `--shadow-brand`.
      Keep every other token. Verify light + dark.
- [x] **0.2** Regenerate `frontend/public/favicon.svg` in `--blue-500` (the design
      system ships it still violet, deliberately unmodified, and says to
      regenerate when the frontend adopts the accent).
- [x] **0.3** Sweep hard-coded `#7367f0` / violet rgba literals out of
      `design-authority.css` and any component styles; they must all read tokens.
- [x] **0.4** Add the design system's missing semantic aliases
      (`--surface-page`, `--surface-card`, `--border-default`, `--text-muted`,
      `--radius-*`, `--shadow-focus`, `--ease-standard`) so component code can be
      shared with the kit.

### Phase 1 — Global shell and honest-state primitives (§2.1, §17)

Foundational: every later screen depends on these.

- [x] **1.1 Environment indicator.** No backend source exists. Add
      `GET /system/info` returning environment, version, build and gateway
      timezone; render a persistent chip with strong visual distinction.
- [x] **1.2 Telemetry freshness indicator.** The ingredients exist
      (`source.status`, `observedAt`, `jkannel_engine_snapshot_age_seconds`,
      `KamexRequestGate`) but nothing rolls them up. Add a single freshness
      endpoint + a shell indicator: live / delayed / disconnected, with age.
- [x] **1.3 UX state model.** A shared set of components for the eight states in
      §17 — loading (skeletons, never zero-that-looks-real), live, stale, empty,
      partial, error, in-progress, permission-denied. We already do this ad hoc
      and well; make it a primitive so new screens inherit it.
- [x] **1.4 Global search** across carrier, SMSC, session, message ID and MSISDN
      (permission-scoped).
- [x] **1.5 Breadcrumbs** preserving hierarchy (Carriers / MTN Uganda / MTN-P1 / TRX-02).
- [x] **1.6 Global time-range control** shared across analytical screens, with
      the range preserved when navigating between Traffic → SMSC → Diagnostics
      (§6 UI requirement).
- [x] **1.7 Nav restructure** to the 9 sections in §1 above.

### Phase 2 — Carrier aggregate and connectivity (§4, §5)

- [x] **2.1 Carrier object.** Greenfield: migration for `carriers`
      (name, country/market, network code, operational status) and
      `smsc_definitions.carrier_id`. Backfill leaves existing SMSCs unassigned
      rather than guessing.
- [x] **2.2 Carrier aggregation read model** — SMSC count, healthy/failed binds,
      current TPS, queue, delivery %, open alerts, rolled up per carrier.
- [x] **2.3 Carriers register + Carrier detail** screens.
- [x] **2.4 SMSC detail** screen to spec §4.2 — state, sessions, TPS, capacity
      and utilisation, queue depth + oldest age, DLR rate, last event, actions.
- [x] **2.5 SMPP Sessions** screen — built strictly on what bearerbox reports,
      with an explicit, prominent statement of what it cannot (per-session
      identity under `instances > 1`, enquire-link RTT, PDU counters). Bind
      timeline from `smsc_bind_transitions`, which we already keep forever.
- [x] **2.6 Capacity utilisation.** `smsc_definitions.tps` is currently consumed
      only by the config generator; compare observed rate against it and surface
      utilisation. Note the earlier finding: `throughput` is per connection, so
      with `instances = N` the effective ceiling is `N × tps`.

### Phase 3 — Traffic, queues, DLR quality (§6, §7, §8)

- [x] **3.1 Queue metrics** — ingress/egress rate, growth rate, drain estimate
      (explicitly `unavailable` when egress is zero, per §7), expiry. Derivable
      from snapshots we already store.
- [ ] **3.2 Live Traffic** screen — MT/MO/DLR split (currently one aggregate
      outbound rate), current/average/peak, stable in-place table updates that do
      not reorder rows unless ranking is enabled.
- [ ] **3.3 DLR Performance** — delivery funnel, status breakdown, P50/P95/P99
      (already exist), per-carrier comparison over *identical* windows (today's
      endpoints have no window parameter), and the **DLR maturity warning** for
      windows too recent for final receipts.

### Phase 4 — Diagnostics (§10, §11, §12)

- [ ] **4.1 Message Trace enrichment.** Highest value for lowest cost: join
      `message_route_decisions` into the existing trace on `foreign_id` — the
      data is already captured and simply never queried — and compute per-stage
      latency. Also join the delivery-retry chain.
- [ ] **4.2 Message Trace screen** — chronological lifecycle, first abnormal
      stage highlighted, copyable IDs, links to related evidence.
- [ ] **4.3 SMPP error intelligence.** Promote the 13-entry private
      `COMMAND_STATUS` map in `smpp-bind-prober.ts` to a full decoder with human
      explanations; aggregate by SMSC/time with first seen, last seen, trend.
- [ ] **4.4 Operational events.** Greenfield `operational_events` table +
      emitters for the §12.1 list, with severity and correlation id.
- [ ] **4.5 Correlation threading.** `correlation_id` exists on `audit_log`,
      logs and gateway requests but not on `alert_instances`, events or traces.
      Thread it so alert → event → log → audit → message is one click.

### Phase 5 — Safe control (§4, §9, §15, §16)

- [ ] **5.1 Impact-first confirmations.** Every disruptive action states impact
      and captures a reason before the verb (§1.1, §16). Reconnect/enable/disable
      currently take an idempotency key but **no reason**.
- [ ] **5.2 Manual route failover** with target health/capacity comparison,
      reason capture, audit and an operational event.
- [ ] **5.3 Suspend / resume traffic** on an SMSC, visually distinct from
      carrier-disconnected.
- [ ] **5.4 Route Simulator screen.** Backend is done (three endpoints); this is
      UI only, and must be labelled explicitly non-transmitting.
- [ ] **5.5 Test tools** — tagged test SMS (needs an `is_test` concept so test
      traffic is distinguishable in traces and excluded from reports), DLR
      lookup, number/prefix lookup. Connectivity test and the segment analyzer
      already exist server-side.

### Phase 6 — Privacy (§17, §18)

- [ ] **6.1 MSISDN and content masking by default** on every operational read
      path (`/messages`, exports, `/queues`, `/reports/delivery`, `/mo/messages`
      all currently return sender, receiver and body in the clear).
- [ ] **6.2 Privileged reveal** — time-limited, permissioned, and audited as its
      own action type.

### Phase 7 — System and platform health (§14)

- [ ] **7.1 Services board** — bearerbox, smsbox, DLR store, database, metrics
      collector. Two of five are covered today.
- [ ] **7.2 Nodes / Performance.** No node telemetry exists and the backend has
      no Docker socket. Either add a collector or state the limit honestly rather
      than shipping an empty screen.

---

## 3. Standing rules for every item

1. **No dead controls.** Every filter, sort and button must map to a parameter
   the backend honours.
2. **No copy that asserts something false.** If a value is not observable, the
   screen says so — `unavailable`, `unknown`, or a sentence. Never a zero that
   looks real.
3. **Health is never encoded by colour alone** (§17.1) — always text or icon too.
4. **Server-side filtering, sorting and pagination** for every high-volume grid.
5. Tests with each item; `npm run build`, `vitest`, `jest`, `lint` stay green.
6. One commit per item, message stating what changed and why.

---

## 4. Progress log

| Date | Item | Commit |
|---|---|---|
| 2026-08-06 | Plan committed | b844ab5 |
| 2026-08-06 | 0.1–0.4 brand alignment: DocFlow Blue accent, favicon, token sweep | ada2c86 |
| 2026-08-06 | 1.1 environment indicator + 1.2 telemetry freshness | 7febcff |
| 2026-08-06 | 1.3 UX state model (DataState + displayValue) | dae5c89 |
| 2026-08-06 | 1.5 hierarchical breadcrumbs + 1.6 shared time range | acfcc4e |
| 2026-08-06 | 1.4 global estate search | f91f93d |
| 2026-08-06 | 1.7 nav restructured to the specification IA — **Phase 1 complete** | 2faf9f7 |
| 2026-08-06 | 2.1 carrier object (migration 048) + 2.2 aggregation read model | a22f7ed |
