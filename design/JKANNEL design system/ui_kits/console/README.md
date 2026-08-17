# Kamex — Gateway Operations Console

Click-through recreation of the console described in
**Kamex UI Redesign Functional Specification** (uploaded; extracted text kept at
`uploads/spec-clean.txt`).

**Sign in** with the prefilled operator credentials, then work the estate.

## Information architecture (spec §2)

| Section | Screens |
|---|---|
| Overview | Dashboard · Alerts |
| Connectivity | Carriers (register) → Carrier detail · SMSCs (register) → SMSC detail · SMPP Sessions (register → drawer) |
| Traffic | Live Traffic · Queues · DLR Performance |
| Routing | Carrier Routes · Failover · Route Simulator |
| Diagnostics | Message Trace · SMPP Errors · Events · Logs · Test Tools · Engine Configuration |
| System | Services (register) → Service detail · Nodes · Performance · Audit Trail · Users & Roles |

Built on the operational hierarchy **Carrier → SMSC → SMPP Session → Route →
Queue → Message → Delivery Receipt**. Customer provisioning, billing, plans,
customer API credentials and bulk campaigns are out of scope per §1.3 and are
absent — not hidden. Engine configuration survives only as read-only engineering
diagnostics that names which operational object owns each directive.

## What the specification asked for, and where it shows

- **Health semantics (§3.3)** — healthy / degraded / critical / unknown, and
  unknown is never rendered as healthy. Smile Telecom carries stale telemetry
  throughout so the unknown path is always visible.
- **Safe control (§1.1, §16)** — reconnect, suspend, resume, failover, service
  restart and test send all go through `ConfirmAction`, which states impact
  before the verb and captures a reason for the audit trail.
- **Correlation by default** — one correlation ID threads alerts, events, logs
  and audit. Events and Logs both filter to a single incident.
- **Progressive disclosure** — grids answer health and impact; bind timelines,
  message lifecycles and decoded SMPP statuses live one click down. Registers
  that grow (Carriers, SMSCs, Services) keep detail on its own route; SMPP
  Sessions opens a session in a half-width `Drawer` so the operator keeps their
  place in the table.
- **Multi-market estate** — every carrier and SMSC carries a country/territory,
  and the SMSC register scopes by country chip, country, carrier and state before
  it scopes by anything else.
- **Honest states (§17)** — a drain estimate with zero egress reads
  "unavailable"; a short DLR window warns that receipts are immature; the metrics
  collector's failed scrape marks dependent health unknown.
- **Real-time but calm (§6)** — the live traffic table updates in place and holds
  row order unless ranking is switched on, and both the chart and the log tail
  can be paused for reading.
- **Global shell (§2.1)** — production environment chip, global range control on
  analytical screens, telemetry freshness pill, alert bell with counts,
  hierarchy-preserving breadcrumbs, and search across carrier, SMSC, session,
  message ID and MSISDN.

## Detail pages

A carrier opens at `/carriers/<id>` and a service at `/services/<name>`, rather
than expanding under their lists. The register is expected to grow to dozens of networks across several
markets, so it stays a plain filterable, sortable, paged list; the detail page
then owns the incident context (carrier, health, window) and the global range
control, so drilling into an SMSC or event never loses it. Services follow the same pattern: the register filters and sorts, and the detail
page carries the dependency view, process history and the impact-first restart.
Breadcrumbs (Connectivity / Carriers / MTN Uganda, System / Services / bearerbox)
are the way back, and the parent nav item stays active on any detail page.

## Deviations from the specification

- **MSISDNs and message bodies are shown in full.** §10 and §18 ask for
  masked-by-default with a privileged audited reveal; the brief for this build
  asked for them unmasked.
- **Users & Roles is kept** (under System) as operational access administration,
  scoped to the five personas in §1.2.
- Wallboard mode and dark-first NOC density were not taken up — the existing
  light skin is unchanged.

Sample estate: the Ugandan mobile networks (MTN, Airtel, Lycamobile, UTL, Smart,
Smile) with representative, not live, figures.
