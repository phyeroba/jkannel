# 11. Troubleshooting and FAQ

Short answers to the things that actually go wrong.

---

## Signing in

### "Invalid credentials" and I am sure the password is right

You are probably typing an email address. **There is no email login.** The field is
labelled *"Email or Username"* but the users table has a `username` column and no email
column, so an email address matches nothing. Type the username — `operator`, for
example.

### "Failed to fetch" on the login page, and nothing reaches the backend

Three causes, in order of likelihood:

1. **You used `localhost` instead of `127.0.0.1`.** On Windows and macOS the browser
   resolves `localhost` to IPv6 (`::1`) first, but Docker publishes ports on IPv4.
   Open `http://127.0.0.1:5173`.
2. **Your browser origin is not in `FRONTEND_ORIGIN`.** That variable is the CORS
   allowlist. If you reach the console on a hostname that is not listed, the preflight
   is blocked. Add the origin and restart the backend.
3. **`VITE_API_BASE_URL` points somewhere unreachable.** Behind a reverse proxy it must
   be your public origin plus `/api`, not the internal container address.

### The whole console returns 403 through the proxy

The Vite dev server performs a host check and rejects a `Host` header it does not
recognise. Behind a proxy it receives the **public** hostname. Add that hostname to
`VITE_ALLOWED_HOSTS` (comma-separated; a leading dot allows a whole suffix) and recreate
the frontend container.

### My account is locked

Wait for the lockout window to expire, then sign in normally — a locked account
recovers by itself and a successful login clears the counter. If you cannot wait, an
administrator can set your status back to `active` on **Users & Roles → user → Edit**.

### A navigation item has vanished

You lack its permission. Items you cannot use are not rendered. Check **Roles &
Permissions → Your effective access**. Remember that permissions are resolved when your
token is issued, so **a role change takes effect on your next sign-in**.

---

## "Platform health is degraded on a fresh install"

### Why does the engine row say `degraded`?

Because **zero SMSCs are registered and nothing is bound**, and that is the correct
answer, not a fault.

This happened on the production VPS at first launch. The Operations Dashboard's
**Platform health** panel reads the engine's own health endpoint, and **Kamex reports
itself unhealthy when `smscs.online` is 0**. A fresh install has no SMSC records at all,
so the count is zero and the engine is honestly degraded. A stack running only the
built-in `fake` SMSC with no peer attached shows the same thing, for the same reason.

**The fix is to register an SMSC and get it bound** — see
[guide 2](02-connecting-an-smsc.md). Once a bind establishes, `smscs.online` becomes
non-zero and the row turns healthy.

> **For a demo you can attach a loopback bind** to make the count non-zero. Be clear
> about what that buys you: a loopback bind **discards messages**. It is not a carrier,
> it delivers nothing, and it must never be mistaken for a working route to a handset.

Related honest states you will see on a fresh install:

| Where | Says | Means |
|---|---|---|
| Live Queue → Binds | *"The engine reports no binds. Add an SMSC connection to start delivering traffic."* | Correct. No SMSCs registered. |
| Live Queue → Pending spool | *"Spool is empty — the engine is accepting messages as fast as they arrive."* | Healthy. An empty spool is the normal state. |
| Operations → Queue depth | `unavailable` / *"SQLBox queue not observable"* | The SQLBox store could not be reached. Check the `engine-kamex` profile is up. |
| Analytics → Volume snapshots | *"No volume snapshots have been generated yet."* | The reporting job has not run. Click **Generate now**. |
| Escalation & Maintenance | *"No escalation policies are defined — an alert that nobody acknowledges will never be escalated to anyone."* | Correct, and you should fix it. See [guide 6](06-monitoring-and-alerts.md). |

The design rule throughout: **when a source cannot be observed, the console says
"unavailable" or "unknown" rather than showing a zero that looks like data.** Read those
words literally.

---

## Messaging

### I sent a message and it is stuck at `pending`

`pending` means submitted with no delivery report yet. Check, in order:

1. **Live Queue → Binds.** Is the target bind `online` with a non-zero outbound rate?
2. **Live Queue → Engine tiles.** Is **SMS queued out** rising? Traffic is entering the
   engine but not leaving it.
3. **Is a DLR expected at all?** If `dlrMask` was 0, no receipt will ever arrive and the
   message will sit at `pending` forever.
4. **Is the carrier returning receipts?** Some carriers do not.

### My message export is missing rows

Exports honour every filter the grid does, but return **at most 500 rows per call**
regardless of `SQLBOX_EXPORT_MAX_ROWS`. Check the `x-jkannel-next-cursor` response
header — if it is present, your export was truncated. Page through the API with that
cursor for a full extract. See
[guide 7](07-reports-and-exports.md#exporting-from-any-grid).

### My date filter returns a 400

Dates must be **strict ISO 8601** — `2026-08-04T00:00:00Z`. Something `Date.parse` would
accept, like `2026/08/04`, is rejected. A value with no timezone offset is read as UTC,
and `from` later than `to` is also a 400.

### Message search is slow

Free-text `query=` is a leading-wildcard match with **no trigram index**, so it scans.
Narrow by **From**/**To** or **SMSC** first — those are index-backed — then add search
text.

If even date-filtered queries are slow, the read indexes may never have been created.
They are not automatic: call `POST /messages/indexes` once (needs `system.manage`).

### Messages went missing after retention ran

Retention **deletes the engine's rows and archives nothing**. Once applied, that history
is gone. Always **Dry-run cleanup** first, and export anything you need to keep.

### Bulk send marked recipients failed for no reason

There is no per-recipient retry. A transient failure — a momentary SQLBox blip — is
terminal for that recipient. Resend them from the Live Queue log, or queue a new
campaign for the failed list.

---

## SMSCs and binds

### "Test connection" passed but the bind never comes up

**Read the verification level, not just the pass.** Test now attempts a real SMPP bind,
but it falls back to a plain TCP connect when the API container cannot resolve the
credential — and the standard deployment keeps SMSC credentials in the *engine*
container.

| Result | What it proved |
|---|---|
| `smpp_bind` | Credentials are good. |
| `tcp_socket` | Only that a socket opened. The detail says *"This is NOT an SMPP bind — …"* with the reason. |
| `not_applicable` | Nothing. A `fake` SMSC always lands here and always passes. |

If you got `tcp_socket`, make the credential resolvable where the API runs, or test the
bind from the engine side. If you got an `ESME_*` error, a real bind was attempted and
the carrier rejected it — the status code names the reason. See
[guide 2](02-connecting-an-smsc.md#step-5--bring-the-connection-up-and-verify-it).

### "Reconnect" did nothing

Reconnect now performs a genuine stop-then-start cycle. Check what it reported:

- **`bind_cycled`** — the drop was observed; it really cycled.
- **`command_accepted`** — the commands fired but the cycle could not be confirmed,
  either because bearerbox's status was unreadable or because the carrier was slower
  than the bounded wait (5 s to stop, 10 s to start). This is common with a slow carrier
  and does not mean nothing happened.

If reconnect is refused outright, the engine is not advertising the
`runtime.smsc.reconnect` capability. Use **Disable this bind**, wait, then **Enable**.

### Connection refused from the carrier

The carrier has not allow-listed your egress IP. Give them the public egress IP of the
host running the engine container and ask for SMPP access. Nothing in the software can
work around this.

### The engine log shows a literal `${SOMETHING}`

A secret placeholder was not expanded, because that variable is missing from the
**engine container's** environment. The generate response's `requiredSecrets` array
lists every variable the rendered configuration expects. See
[guide 2, step 3](02-connecting-an-smsc.md#step-3--read-requiredsecrets-and-put-them-in-the-engine-environment).

### I cannot archive an SMSC

*"This SMSC is still referenced by one or more routes and cannot be archived."*
Repoint or archive those routes first — [guide 5](05-routing.md).

---

## Routing

### Changing a route made no difference

**Routes default to `draft`, and a draft route is not selectable.** Deploy it from the
**Routing** screen's row actions. Then use **Advanced Routing → Resolve preview** to
confirm the change took effect.

### Traffic is going to the wrong carrier

Use **Advanced Routing → Resolve preview**. It gives you the chosen SMSC, the
controlling route, the strategy, whether fallback was used and a numbered decision
trace. There is a worked sequence in
[guide 5](05-routing.md#a-worked-troubleshooting-sequence).

### The send was refused with no route

Routing **fails closed** rather than guessing a bind. Either no route matched, or every
candidate bind is unhealthy, or the customer's route bindings exclude them all.

---

## Alerts

### Alerts appear on screen but nobody is paged

Expected on a fresh install. A "Default dashboard" channel and a "Default escalation"
policy are seeded, so alerts always reach the console — but the policy's email and
webhook steps have empty targets and record `undeliverable` with a reason.

Ask the platform what is actually deliverable:

```bash
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/monitoring/notifications/readiness
```

Then configure a real destination — see
[guide 6](06-monitoring-and-alerts.md#make-sure-an-alert-reaches-a-human).

### Email notifications are not arriving

`SMTP_URL` is unset. Without it the email channel reports "unavailable" rather than
pretending to send.

### A webhook notification was lost

Webhooks make **one attempt with a 5-second timeout and no retry**. If your endpoint was
down when the alert fired, it is gone. Add a second channel (email) as a fallback.

### I cannot resolve an alert from the Alerts screen

Resolve, assign, suppress, reopen, close and comments live on the **Alert Lifecycle**
screen, not **Alerts**. The in-page note on **Alerts** saying those endpoints do not
exist is out of date. See the lifecycle table in
[guide 6](06-monitoring-and-alerts.md#the-lifecycle-actions).

If the API returns **409**, the transition is illegal from the alert's current state —
the error names that state. If **403** on suppress, note that suppress needs
`system.manage`, unlike the other lifecycle actions.

For planned work, a **maintenance window** on **Escalation & Maintenance** is still the
right tool: it covers a scope and a time range rather than one alert.

### The alert text is stale

A deduplicated alert does not re-word itself when the condition worsens. Its occurrence
count rises but the summary stays as first written. Check the bind on **Live Queue** for
the current truth.

---

## Where the logs are

| What | Where |
|---|---|
| **Operator audit trail** — who did what, when, from where, with old/new values | **Logs & Audit** in the console. Searchable, filterable, exportable. Append-only with a database-enforced hash chain. |
| **Application logs** (backend, frontend) | `docker compose logs -f backend` / `frontend`. Structured JSON. |
| **Engine logs** (bearerbox, smsbox, sqlbox) | `docker compose logs -f kamex-bearerbox` (and the others). This is where SMPP-level detail lives. |
| **Nginx access/error** | `docker compose logs -f reverse-proxy`, plus your own upstream nginx. |
| **Recent backend log lines, queryable** | The **Log Explorer** screen (Platform group), or `GET /api/v1/observability/logs` (needs `system.view`). Filter by `correlationId`, `requestId`, `level`, `minLevel`, `tenantId`, `userId`, `route`, `contains`, `since`, `until`, `limit`. |
| **Centralised logs** | Start the `observability` profile for Loki + Promtail. No dashboards ship with it. |

**Log lines now carry a correlation ID**, along with request ID, user, tenant, method,
route and client IP. The API also returns an `x-correlation-id` response header, so you
can take the ID straight from a failing request and search for it.

> **Understand what the log endpoint is before you rely on it.** It reads an
> **in-memory, process-local ring buffer** — 1000 lines by default (configurable via
> `LOG_BUFFER_SIZE`, hard maximum 20 000), oldest evicted first with a dropped counter.
> Every response says so: `durable: false`, `scope: "process"`.
>
> That means: it is **lost on restart**; each replica sees only its own lines; and there
> is **no retention window at all** — on a busy API the buffer may hold only the last few
> seconds. It is an incident-triage convenience, not a log store. For anything you need
> to keep, use the container logs or the Loki profile.
>
> One more gap: only lines written through the structured logger are captured. A few
> components still write directly to stdout — notably the notification-readiness and
> customer rate-limit warnings — and those will **not** appear in a query.

**Logs & Audit** in the console remains *audit events only* — who did what, when — which
is a different thing from application log lines. It does record the correlation ID, so
it is a good place to start a trace.

---

## Checking engine health

```bash
# JKANNEL's own probe — 503 when genuinely unhealthy
curl -s http://127.0.0.1:3000/api/v1/health

# Container state
docker compose ps

# Engine status (needs the status password from your .env)
curl -s "http://127.0.0.1:13000/status.json?password=$KAMEX_STATUS_PASSWORD"

# Prometheus metrics, including per-bind state
curl -s http://127.0.0.1:3000/api/v1/metrics | grep jkannel_smsc
```

In the console: **Runtime Containers** shows declared services with live-probed health.
Its note is honest — *"Services the API cannot probe are reported as "unknown" rather
than assumed healthy."*

`/api/v1/health` probes PostgreSQL (required) and Redis (optional) with bounded
timeouts, redacts driver detail, and returns 503 when unhealthy. It recovers by itself
when the dependency comes back. There are no separate `/health/live`, `/health/ready`,
`/health/version` or `/health/dependencies` endpoints — just the one.

---

## FAQ

**Can I move messages out of a bad bind's queue one by one?**
No, and no version will. Messages already inside the engine are exposed only as an
aggregate per-bind counter. Disable the bind and resend from the log —
[guide 4](04-live-queue-and-recovery.md) and
[ADR-0008](../adr/ADR-0008-control-plane-boundary.md).

**Does an operator resend consume the customer's quota?**
No, deliberately. Operator recovery actions bypass routing and entitlements.

**Why do the same message counts appear twice after a resend?**
A resend creates a *new* message; the original history row is untouched.

**Will a resent message be delivered twice?**
It can be, if the original later succeeds. Resend from DLR-derived failure status, not
from a hunch.

**Can I create a read-only auditor account?**
Yes — an `Auditor` role is one of eight seeded roles. Assign it from **Users & Roles →
user → Edit → Roles**. Creating custom roles works too, from **Roles & Permissions** —
[guide 10](10-users-and-roles.md).

**Does JKANNEL terminate TLS?**
Not in the default topology. The shipped reverse proxy is HTTP-only and expects your own
edge to hold the certificate — that is how the live deployment runs, with a system nginx
terminating TLS upstream. An **opt-in `tls` profile** exists if you want JKANNEL to
terminate it instead. See
[`infrastructure/nginx/README.md`](../../infrastructure/nginx/README.md).

**Does anything update in real time?**
No. There is no WebSocket or SSE anywhere. Three screens poll on a timer; everything
else needs a manual refresh.

**Can I run plugins?**
You can register, validate, enable and disable them. **They do not execute** — there is
no plugin runtime.

**Is there an SDK?**
No generated SDK. The OpenAPI document at `/api/v1/openapi.json` is auto-derived from
the live route table and is never stale, so generate your own client from it.

**Where is the definitive list of what works?**
[FEATURES.md](../../FEATURES.md), with the evidence in
[`project/IMPLEMENTATION_VERIFICATION.md`](../../project/IMPLEMENTATION_VERIFICATION.md).
Both were written against commit `eefa320`; a later commit closed several of the gaps
they list, and these guides reflect that. Where they disagree, prefer whichever is
dated later, and treat the API's own `/api/v1/openapi.json` as the final word on what
routes exist.

---

[← Back to the guide index](README.md)
