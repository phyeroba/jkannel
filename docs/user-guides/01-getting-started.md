# 1. Getting started and console tour

This guide gets you signed in and oriented. Read it once; the conventions here apply to
every other guide.

---

## Before you start

You need:

- A URL for the console. On a local Docker stack that is **http://127.0.0.1:5173**
  (use `127.0.0.1`, not `localhost` — see [troubleshooting](11-troubleshooting.md)).
  On the reference deployment it is `https://jkannel.34-134-248-1.sslip.io`.
- A **tenant**, a **username** and a **password**. The first operator is created with
  the `provision:dev-operator` command described in the
  [repository README](../../README.md#quick-start).

## Sign in

1. Open the console URL. You land on the **Sign in** page.
2. Fill in the field labelled **Email or Username**.

   > **There is no email login.** The users table has a `username` column and no email
   > column. The label is misleading — type your **username** (for example `operator`).
   > An email address will simply not match anything.

3. Fill in **Password**. Passwords are a minimum of 12 characters. Use the eye button
   (**Show password** / **Hide password**) if you need to check what you typed.
4. Optionally tick **Remember Me**. This remembers your *username* in the browser, not
   your password.
5. Click **Sign in**.

There is no visible tenant field. The form submits a hidden tenant of `default`. If
your deployment uses a different tenant, that is a deployment-time change, not
something you can choose on the login screen.

Forgotten your password? Use **Forgot Password?** next to the password label. It opens
the self-service reset page. Invited but never signed in? Use the link in your
invitation, which opens the **Accept invitation** page.

On success you land on the **Operations Dashboard**.

## The navigation

The left sidebar has four groups. Which items you see depends on your permissions —
an item whose permission you lack is not rendered at all.

### Operations

| Item | What it is for |
|---|---|
| **Operations** | The dashboard. Queue depth, latest daily volume, alert count, message-volume bars and platform health. |
| **Monitoring** | Component state from the engine adapter. Today this is a single-row table (see the note below). |
| **Alerts** | Open, acknowledged and resolved alert instances, with Acknowledge and Re-notify actions. |
| **Alert Lifecycle** | The fuller lifecycle — resolve, assign, suppress, reopen, close and comments. |
| **Escalation & Maintenance** | Who an unacknowledged alert escalates to, and windows during which alerting is suppressed. |
| **Notifications** | Your in-app notification centre. Also reachable from the bell in the top bar. |

### Messaging

| Item | What it is for |
|---|---|
| **Messages** | The message explorer — search, filter, trace, export, and the send composer. |
| **Live Queue** | Live per-bind state, the pending spool, and the resend workflow. See [guide 4](04-live-queue-and-recovery.md). |
| **Queues** | A simpler paginated view of what is waiting in the spool. |
| **Delivery Reports** | Delivery receipts as their own grid. |
| **Bulk Send** | Fan one message body out to many recipients as a campaign. |
| **SMSC Connections** | Your gateway connections: create, edit, test, enable/disable/reconnect. |
| **Routing** | The basic route grid, with Validate/Deploy/Rollback and a route simulator. |
| **Advanced Routing** | Route types, selection strategies, weighted targets, version history and the **Resolve preview**. |
| **Configuration** | Generate, validate, approve, deploy and roll back engine configuration versions; drift check; templates. |

> Routing appears twice on purpose. **Routing** and **Advanced Routing** are two
> different screens over two different APIs. [Guide 5](05-routing.md) explains which
> one to use.

### Insights

| Item | What it is for |
|---|---|
| **Analytics & Reports** | KPI cards, traffic trend, per-SMSC and per-route breakdowns, heatmap, latency percentiles, saved report definitions. |
| **Customers** | Customer accounts, quotas, rate limits and allowed sender IDs. |
| **AI Copilot** | A read-only, permission-scoped assistant. It answers questions from data you are allowed to see and cannot change anything. |

### Platform

| Item | What it is for |
|---|---|
| **API Gateway** | The API client registry. Read [guide 3](03-sending-messages.md#send-over-the-rest-api) before using it — the credential story has a sharp edge. |
| **Runtime Containers** | Declared Compose services with live-probed health, and honest "unknown" for anything the API cannot probe. |
| **Logs & Audit** | The immutable operator audit trail: who did what, when, from where. |
| **Log Explorer** | Recent backend log lines, searchable by correlation ID. Read the caveat in [guide 11](11-troubleshooting.md#where-the-logs-are) — it is a small in-memory buffer, not a log store. |
| **Plugins** | The plugin registry (enable/disable). Plugins are registered and validated but **not executed** — there is no plugin runtime yet. |
| **Backup & Restore** | Backup catalog, schedules, verify and restore-request. |
| **Users & Roles** | Create, edit, archive users; assign roles; send invitations. |
| **Roles & Permissions** | The role catalogue and permission matrix, with create and edit controls. Eight standard roles are seeded. |
| **Sessions** | Active session administration, with revoke. |
| **System Settings** | Grouped platform settings with inline editing of the editable ones. |

## Conventions every grid shares

Once you know these, every screen is familiar.

- **Search** — a single box whose placeholder tells you which fields it covers (for
  example, on SMSC Connections it reads *"Name, protocol, host, or connection state"*).
- **Sort** — a dropdown of sortable fields plus a direction toggle that reads
  **Asc ↑** / **Desc ↓**.
- **Filters** — one dropdown or text box per filterable field. Every dropdown's first
  option is **All**.
- **Export CSV** and **Export PDF** — server-rendered, bounded, and audit-logged. The
  export records who asked, with which filters.
- **Pager** — reads `Showing 12–24 of 87`, with **Previous** and **Next**.
- **Row click** — on most grids, clicking a row opens a detail panel on the right with
  a **Close** button.
- **Primary action** — the button at the top right of the panel. Its label changes to
  **Working…** while a request is in flight.
- **Honest empty states** — a grid that cannot reach its backend says so
  (*"Workspace API not available yet"*, with the expected endpoint and a **Retry**
  button) rather than showing an empty table that looks like real zero.

### Auto refresh

Most screens are **manual refresh only**. There is no real-time push anywhere in the
product — no WebSocket, no server-sent events.

Four surfaces poll on a timer:

| Screen | Default interval | Control |
|---|---|---|
| Operations Dashboard | 30 s | **Auto refresh** On/Off, **Every** 15s/30s/60s/300s |
| Live Queue | 5 s | **Auto refresh** On/Off, **Every** 2s/5s/10s/30s/60s |
| Alerts, SMSC Connections, Monitoring workspaces | 30 s, **default off** | **Auto refresh** On/Off, **Every** 10s/30s/60s/300s, plus **Refresh now** |

Polling pauses automatically while the browser tab is hidden, and while an action you
started is still running. When auto refresh is off, the status line tells you:
*"Last updated 14:32:07 — auto refresh is off"*.

## What to do on a fresh install

A brand-new deployment is deliberately empty. In order:

1. **Add at least one SMSC connection.** Until you do, the Operations Dashboard shows
   the engine as `degraded` and the Live Queue reports *"The engine reports no binds"*.
   That is correct, not a fault — see
   [guide 2](02-connecting-an-smsc.md) and
   [troubleshooting](11-troubleshooting.md#platform-health-is-degraded-on-a-fresh-install).
2. **Generate and deploy a configuration** so the engine knows about that SMSC.
3. **Configure somewhere for alerts to go.** A "Default dashboard" channel is seeded, so
   alerts always reach the console — but nothing reaches a human who is not looking at
   it until you add an email, webhook or SMS destination. See
   [guide 6](06-monitoring-and-alerts.md#make-sure-an-alert-reaches-a-human).
4. **Set a backup encryption key and a schedule.** Backups refuse to run without a
   real `BACKUP_ENCRYPTION_KEY`, and no schedule exists until you create one — see
   [guide 9](09-backup-and-restore.md).
5. **Create the users who need access** and assign them one of the eight seeded roles —
   [guide 10](10-users-and-roles.md).
6. **Review the security policy** on **System Settings**. Password rules, lockout,
   session idle timeout and the concurrent-session cap are enforced, but the session cap
   ships switched off.

## Where things happen when you click

Two things are always true and worth knowing:

- **Every state-changing action is audit-logged** with actor, action, entity,
  correlation ID and source IP. You can read it back on **Logs & Audit**, and the audit
  log is append-only with a database-enforced hash chain you can verify.
- **Tenant isolation is enforced in the database**, not in application code. You
  cannot see or touch another tenant's rows even if a query tried to.

---

Next: [Connecting an SMSC →](02-connecting-an-smsc.md)
