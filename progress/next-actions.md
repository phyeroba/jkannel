# Next Actions

Updated: 2026-08-05, after commit `d58a3d2`. Ordered by value per hour, following the
build order in [`project/SPEC_GAP_ANALYSIS.md` §6](../project/SPEC_GAP_ANALYSIS.md) and
the residual findings in
[`project/IMPLEMENTATION_VERIFICATION.md`](../project/IMPLEMENTATION_VERIFICATION.md),
minus what [`pending.md`](pending.md) records as closed since.

## 1. Finish the console catch-up

`d58a3d2` was backend-only; the Roles admin, Alert Lifecycle and Log Explorer screens
and the message date filters have since landed. Two loose ends remain, both small and
both about the product telling the truth about itself.

1. **Delete the stale in-page note on the Alerts workspace** — it still says there is no
   manual resolve, assign or per-alert suppress endpoint. Those actions now exist on the
   **Alert Lifecycle** screen. Copy that denies a shipped capability is the same class
   of error as a ledger that claims an unshipped one.
2. **Make the Log Explorer state its own limits prominently.** The endpoint returns
   `durable: false` and `scope: process`; the screen must not let an operator mistake a
   1000-line in-memory buffer for a log store, least of all during an incident.

## 2. Fix what still misleads

5. **Encrypt notification-channel secrets at rest, redact them on read, and replace the
   static `x-jkannel-signature` with an HMAC.** Any holder of `alerts.view` can read a
   webhook secret in plaintext. This is now the most serious remaining security defect.
6. **Surface `requiredSecrets` in the configuration UI.** The backend returns it; the
   frontend drops it, so an operator cannot see which environment variables the engine
   needs.
7. **Expose `credentialSecretRef` / `systemId` / bind mode / TON / NPI in the SMSC
   form.** Still API-only, which makes the create → deploy → bind chain unusable from
   the console alone — and it is also what forces the bind probe to fall back to TCP.
8. **Reconcile the message export cap.** `exportLimits()` advertises
   `SQLBOX_EXPORT_MAX_ROWS` (default 5000) while `list()` clamps to 500. Either page
   internally or advertise the real number.
9. **Route the raw `console.warn` callers through the structured logger** (notification
   readiness, customer rate limit) so their warnings are actually queryable.

## 3. Make the remaining partials whole

10. **A durable log path.** The ring buffer is triage convenience. Ship Loki dashboards
    with the `observability` profile, or persist warn/error lines.
11. **Real-time push** for the queue and log tails. SSE is sufficient;
    `useLiveResource` already establishes the client-side contract.
12. **A `pg_trgm` index for free-text message search**, and run `ensureIndexes()`
    automatically rather than requiring a manual `POST /messages/indexes`.
13. **Per-recipient retry in bulk send** (`attempts` / `next_attempt_at`), so a
    transient blip is not terminal.
14. **Cursor + `?fields=` across the remaining 14 grids** — each is a one-line
    delegation to the existing `grid-runner`.
15. **The `monitoring` workspace**: the specification's primary NOC console is a one-row
    table over a hardcoded endpoint.
16. **A distributed lock on configuration and route deploy**, so two replicas cannot
    race an engine config push.
17. **cAdvisor / node_exporter**, and replication-lag / Sentinel-role metrics.
18. **PITR / WAL archiving**, and an Azure or SFTP backup destination if needed.
19. **Multi-part segment billing** — segment counts are recorded now, so the data exists;
    the rating model does not.

## 4. Raise the quality floor

20. **Convert navigation-smoke e2e tests into mutating workflow tests.** 26 of 40 cases
    are one loop; 5 are genuine workflows. Priority: the create → validate → deploy →
    bind chain, and the Live Queue disable-then-resend recovery workflow.
21. **Ratchet the coverage gates** off the current floor.
22. **Make the CI `security` job blocking** once existing `npm audit` findings clear.
23. **Re-run the independent verification against `d58a3d2`.** `FEATURES.md` and
    `IMPLEMENTATION_VERIFICATION.md` are both anchored to `eefa320` and now understate
    the product. They are the documents everyone is told to trust, so leaving them stale
    is its own accuracy problem.

## 5. Then the external gates

Only once the above is done — see [`blockers.md`](blockers.md) for why each is gated on
something other than code.

24. Carrier live send (needs carrier IP allow-listing; a generated config has still
    never bound to a real carrier).
25. Independent penetration test.
26. Production-scale soak against a seeded multi-million-row dataset.
27. Multi-node HA failover drill with measured RPO/RTO, and a restore-to-production
    drill.
