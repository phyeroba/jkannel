# JKANNEL operator guides

Task-oriented manuals for running JKANNEL. Each page covers one job, with numbered
steps that name the actual screens, buttons and fields in the console.

Written for a telecom operator who has never seen this console before. No prior
Kannel knowledge is assumed, though it helps.

## Start here

| # | Guide | Read it when you want to |
|---|---|---|
| 1 | [Getting started and console tour](01-getting-started.md) | Sign in for the first time, learn the navigation, and understand the conventions every screen shares. |
| 2 | [Connecting an SMSC](02-connecting-an-smsc.md) | Add a gateway connection, generate and deploy its configuration, and get a carrier bind up. |
| 3 | [Sending messages](03-sending-messages.md) | Send one message, run a bulk campaign, or submit over the REST API with an API key. |
| 4 | [Live Queue: watching traffic and recovering a bad bind](04-live-queue-and-recovery.md) | A bind has gone bad and traffic is failing. **This is the flagship operator workflow.** |
| 5 | [Routing](05-routing.md) | Decide which carrier a message takes, and answer "why did this message go that way?" |
| 6 | [Monitoring and alerts](06-monitoring-and-alerts.md) | Know when something breaks, and make sure a human actually hears about it. |
| 7 | [Reports and exports](07-reports-and-exports.md) | Get numbers out — on screen, as CSV/PDF, or on a schedule. |
| 8 | [Customers, quotas, credit and sender IDs](08-customers-and-quotas.md) | Control what each account may send, and how much. |
| 9 | [Backup and restore](09-backup-and-restore.md) | Protect the control plane's data and prove a backup is usable. |
| 10 | [Users, roles and permissions](10-users-and-roles.md) | Give people access — and understand what is read-only today. |
| 11 | [Troubleshooting and FAQ](11-troubleshooting.md) | Something is wrong and you want the short answer. |

## Before you rely on a capability

These guides describe what the console does today, honestly, including the parts that
do not work yet. Where a workflow is incomplete you will find a line that says so and
points at the workaround — never a quiet omission.

The two documents behind that discipline:

- **[FEATURES.md](../../FEATURES.md)** — the verified capability list, with a
  deliberately long "Not yet implemented" section.
- **[project/IMPLEMENTATION_VERIFICATION.md](../../project/IMPLEMENTATION_VERIFICATION.md)**
  — the file-by-file evidence behind every claim in it.

> **A dating caveat.** Both were written against commit `eefa320`. A later commit closed
> several gaps they still list as open — role administration, alert lifecycle, message
> date-range search and export parity, a real SMPP bind test, a genuine reconnect cycle,
> an S3 backup destination and a log query endpoint. **These guides reflect the later
> state.** Where a guide and FEATURES.md disagree, prefer the later document, and treat
> `/api/v1/openapi.json` — generated from the live route table — as the final word on
> which routes exist.

Those capabilities landed in the backend first and the console has since caught up, so
two screens still display in-page notes denying a capability that now exists — the
guides flag each one. Where a workflow has no console screen at all (customer quotas and
credit, API-key issuance, notification channels), the guide says so and gives you the
`curl`.

## The one architectural idea to absorb first

JKANNEL is a **control plane**. The gateway engine is the **data plane** and owns
in-flight messages. You can see per-bind queue depth, you can stop a single bind, and
you can resend failed traffic anywhere you like — but you cannot reach into the
engine's internal queue and move an individual message, because the engine does not
expose that. [ADR-0008](../adr/ADR-0008-control-plane-boundary.md) explains the
decision, and [guide 4](04-live-queue-and-recovery.md) shows the supported workaround
that gets you the same outcome.

## Related documentation

- [Deployment and quick start](../../README.md) — running the stack.
- [`infrastructure/nginx/README.md`](../../infrastructure/nginx/README.md) — reverse
  proxy and TLS topologies.
- [Engineering specifications](../specifications/) — the canonical, detailed
  requirements each module was built against.
