# 6. Monitoring and alerts

What JKANNEL notices on its own, what it does about it, and — the part that trips
everyone up — **why a fresh install tells nobody anything until you configure a
channel**.

---

## Start here: alerts reach the console out of the box — nothing else, yet

**Alerts are always visible in-app.** A readiness check runs at boot: if a tenant has no
dashboard channel it seeds one ("Default dashboard"), and if it has no enabled
escalation policy it seeds one ("Default escalation") with that dashboard channel as
step 0. So an alert is never silently lost.

> **What a fresh install does *not* have is any channel that reaches a human who is not
> looking at the console.** The seeded policy's email and webhook steps are created with
> empty targets. Email needs `SMTP_URL` **and** a configured recipient; a webhook needs a
> URL; SMS needs an MSISDN. Those steps now record **`undeliverable` with a reason**
> rather than being silently skipped, so the gap is visible instead of invisible.
>
> Configure a channel before you rely on being paged. Jump to
> [Make sure an alert reaches a human](#make-sure-an-alert-reaches-a-human).

Check exactly where you stand:

```bash
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/monitoring/notifications/readiness
```

It reports per-channel deliverability. A **boot warning fires when a tenant has open
alerts but nothing deliverable** — that is the condition to watch for.

Read "deliverable" precisely: it is a **static configuration check, not a live probe**.
Email counts as deliverable when `SMTP_URL` is set in the API container, a webhook when
its config carries an `http(s)` URL, SMS when it carries an MSISDN. It does not prove
your SMTP server accepts mail or that your webhook endpoint is up.

`POST /monitoring/notifications/readiness/repair` (needs `system.manage`) re-runs the
seeding on demand.

> Boot seeding is skipped when `NOTIFICATION_READINESS_CHECK=false`, and it swallows its
> own errors — if the database is slow at that moment you get neither the seed nor a
> loud failure. Run the readiness check yourself rather than assuming.

---

## What is detected automatically

You do not have to configure any of this. It runs by itself.

| Detector | What it watches | What it produces |
|---|---|---|
| **Bind poller** | Every SMSC bind, continuously | Records bind state, writes a transition history, and raises a **deduplicated** alert on degradation with anti-flap confirmation (so a one-second blip does not page you). Every transition is audited. |
| **Alert rule evaluator** | Your own alert rules, on a schedule | Opens real alert instances when a rule's condition is met over its sustained threshold. |
| **Anomaly detection** | Daily traffic snapshots | Statistical volume drop, volume spike and delivery-failure detection, opening deduplicated alerts. |
| **Health probe** | PostgreSQL and Redis | `GET /api/v1/health` returns 503 when genuinely unhealthy and recovers by itself. Compose, nginx and the watchdog all point at it. |
| **Backup failures** | Backup and verification jobs | Open alert instances rather than failing silently. |

### Metrics

`GET /api/v1/metrics` exposes Prometheus text metrics. The SMS-specific ones:

| Metric | Meaning |
|---|---|
| `jkannel_smsc_bind_up` | Per-bind up/down. |
| `jkannel_smsc_queued` | Per-bind queue depth. |
| `jkannel_smsc_failed_total` | Per-bind cumulative failures. |
| `jkannel_smsc_messages_total` | Per-bind message count. |
| `jkannel_smsc_throughput_messages_per_second` | Per-bind throughput. |
| `jkannel_engine_dlr_queued` | DLR backlog. |
| `jkannel_backend_up` | Driven by the real dependency probe, not hardcoded. |

Plus HTTP counters, a latency histogram, and PostgreSQL/Redis metrics.

Two Grafana dashboards ship with the `monitoring` profile:

- **JKANNEL SMS Operations** — bind health, per-SMSC queue depth, throughput, failures,
  DLR pending. This is the NOC dashboard.
- **JKANNEL Overview** — platform-level.

Start them with `docker compose --profile monitoring up -d`. Grafana is on port 3001,
Prometheus on 9090.

> **No host or container metrics.** There is no cAdvisor and no node_exporter, so CPU,
> RAM, disk and network are not observable through JKANNEL. Use your host's own
> monitoring for those.

---

## Working alerts on the Alerts screen

Go to **Alerts**. Columns: **Severity**, **Condition**, **Status**, **Source**,
**Rule**, **Occurrences**, **Correlation**, **Opened**, **Acknowledged**, **Resolved**,
**Actions**.

Filter by **Status** (open / acknowledged / resolved), **Severity** (info / warning /
critical) or **Rule ID**. Turn on **Auto refresh** (it is off by default here) if you
are watching an incident.

### The lifecycle actions

A full lifecycle now exists. The **Alerts** screen carries **Acknowledge** and
**Re-notify**; the rest live on the **Alert Lifecycle** screen (Operations group).

> The **Alerts** screen still shows an in-page note saying there is no manual resolve,
> assign or per-alert suppress endpoint. **That note is out of date** — those actions
> exist. Use **Alert Lifecycle**, or the API below.

| Action | Route | Permission |
|---|---|---|
| Acknowledge | `POST /alerts/:id/acknowledge` | `alerts.acknowledge` |
| Resolve | `POST /alerts/:id/resolve` | `alerts.acknowledge` |
| Assign | `POST /alerts/:id/assign` | `alerts.acknowledge` |
| Suppress | `POST /alerts/:id/suppress` | **`system.manage`** |
| Reopen | `POST /alerts/:id/reopen` | `alerts.acknowledge` |
| Close | `POST /alerts/:id/close` | `alerts.acknowledge` |
| Comment | `POST /alerts/:id/comments` · `GET /alerts/:id/comments` | `alerts.acknowledge` / `alerts.view` |
| Full history | `GET /alerts/:id/lifecycle` | `alerts.view` |

Things that will bite you:

- **Transitions are validated.** An illegal move returns 409 naming the current state —
  you cannot acknowledge an alert that is already resolved, for example.
- **Suppress needs `system.manage`.** An `Operations Engineer` or `Support Engineer`
  cannot suppress; only a `Super Administrator` can. For planned work, a
  [maintenance window](#maintenance-windows--suppressing-planned-work) is the better
  tool and needs the same permission.
- **Suppression is capped at 30 days**, and it lapses back to `open` when the escalation
  sweep next runs rather than on its own timer.
- **Assign resolves against real users** in your tenant and 404s on an unknown one. It
  is not a free-text field.
- Comments are capped at 4000 characters and the list returns at most 500.

**Still absent:** ticketing or ITSM integration of any kind — there is no ticket field
and no ticket route. Bulk actions across several alerts. An explicit "un-suppress" verb.
No MTTA or MTTR reporting.

One honest quirk: a deduplicated alert does not re-word its summary when the condition
worsens. An alert that opened as *"bind is connecting"* still reads that way after the
bind goes fully `disconnected`, though its occurrence count rises. Check the bind itself
on [Live Queue](04-live-queue-and-recovery.md) rather than trusting the alert text
alone.

---

## Make sure an alert reaches a human

Two pieces are involved: **notification channels** (where messages go) and
**escalation policies** (who gets told, after how long, if nobody acknowledges).

### Option A — escalation policy steps (fully in the console)

This is the path with a UI, and for most deployments it is all you need. An escalation
step carries its own channel type and target, so you do not need a separate channel
record.

1. Go to **Escalation & Maintenance**.
2. Click **New policy**.
3. Enter a **Name** (e.g. `On-call tier 1`) and set **Enabled** to Yes.
4. Fill in the step table. Each step has:

   | Column | Options |
   |---|---|
   | **After (minutes)** | How long the alert must stay open (unacknowledged) before this step fires. |
   | **Channel** | `dashboard` · `webhook` · `email` · `sms` |
   | **Target** | The address, URL or number — placeholder: *"noc@example.com / https://hooks…"* |
   | **Minimum severity** | any · info · warning · critical |

5. Click **Add step** for each tier. A sane first policy:

   | After | Channel | Target | Minimum severity |
   |---|---|---|---|
   | 0 | email | noc@example.com | warning |
   | 15 | sms | +256700000000 | critical |
   | 30 | webhook | your PagerDuty/Opsgenie inbound URL | critical |

6. Click **Save policy**.

The panel explains the semantics: *"A policy fires its steps in order once an alert has
stayed open (unacknowledged) for the step's "after" interval. Acknowledging an alert
stops its escalation."*

Until you create one, the grid says exactly what that means: *"No escalation policies
are defined — an alert that nobody acknowledges will never be escalated to anyone."*

### Option B — notification channels (API only today)

Channels are what **Re-notify** uses, and what scheduled reports deliver to. The backend
supports them; **there is no console screen for them yet.** Create them over the API
(you need `system.manage`):

```bash
# Email
curl -X POST https://your-console/api/v1/alerts/channels \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"NOC email","type":"email","severities":["warning","critical"],
       "config":{"to":"noc@example.com"}}'

# Webhook
curl -X POST https://your-console/api/v1/alerts/channels \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"Ops webhook","type":"webhook","severities":["critical"],
       "config":{"url":"https://hooks.example/jkannel","secret":"shared-secret"}}'

# SMS (sent through the platform's own send path)
curl -X POST https://your-console/api/v1/alerts/channels \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"On-call SMS","type":"sms","severities":["critical"],
       "config":{"msisdn":"+256700000000","sender":"JKANNEL","smscId":"backup-carrier"}}'
```

`GET /alerts/channels` lists them. `severities` defaults to `["warning","critical"]`.

Delivery caveats, stated plainly:

- **Email needs `SMTP_URL`.** Without it the email channel reports "unavailable" rather
  than pretending to have sent.
- **Webhooks make one attempt with a 5-second timeout and no retry.** If your endpoint
  is down when the alert fires, that notification is lost.
- **The webhook "signature" is a static shared secret**, sent as
  `x-jkannel-signature`. It is replayable and is not an HMAC. Treat it as a weak shared
  token, not as proof of authenticity, and put the endpoint behind your own auth.
- **Channel secrets are stored and returned as plaintext** to anyone with the
  `alerts.view` permission. Do not put a high-value credential in one.
- **SMS goes out through JKANNEL's own send path**, so it needs a working bind. It is
  not a good channel for "the gateway is down".

### Test it

Open any alert on the **Alerts** screen and click **Re-notify**. You should get *"Alert
re-sent to {n} notification channel(s)."* If you get *"No notification channels are
configured, so nothing was sent."*, the channel did not save — check the response from
the API call.

---

## Alert rules

Alert rules are evaluated on a schedule and open real alert instances. Rules define a
metric, an operator, a threshold and a severity.

The metric stream they evaluate against is written by the bind poller, so rules over
bind state, queue depth, failures and throughput have real data behind them.

---

## Maintenance windows — suppressing planned work

A per-alert suppress now exists, but a maintenance window is still the right tool for
planned work: it covers a scope and a time range rather than one alert at a time.

1. Go to **Escalation & Maintenance**.
2. Click **Schedule window**.
3. Fill in:

   | Field | Notes |
   |---|---|
   | **Name** | e.g. `Carrier SMPP upgrade`. |
   | **Starts** / **Ends** | Both required; end must be after start. |
   | **Scope** | **Everything**, or **Selected SMSCs**. |
   | **SMSCs in scope** | Tick the connections, when scope is Selected SMSCs. |
   | **Reason (audited)** | Recorded in the audit trail. |

4. Click **Save window**.

The panel explains: *"During a window, alert rule evaluation and escalation are
suppressed for everything in its scope."* (Its closing clause, that there is no
per-alert suppress action, is now out of date — see the lifecycle table above.)

An empty scope suppresses nothing — the form rejects it with *"Select at least one
SMSC, or scope the window to everything — an empty scope suppresses nothing."*

While a window is active you get a banner at the top of the screen naming it.

## Correlated alert groups

The **Correlated alert groups** panel groups related unresolved alerts:
**Group**, **Alerts**, **Occurrences**, **Max severity**, **First seen**, **Last seen**.
Useful for spotting that fifteen alerts are one carrier problem.

---

## Where else to look during an incident

| Screen | Gives you |
|---|---|
| **Operations** (dashboard) | Queue depth, latest daily volume, alert count, **Platform health** rows for the engine, the SQLBox message store and the JKANNEL API. |
| **Live Queue** | The real per-bind truth: status, queue depth, failures, throughput. See [guide 4](04-live-queue-and-recovery.md). |
| **Runtime Containers** | Declared services with live-probed health. Its note is honest: *"Services the API cannot probe are reported as "unknown" rather than assumed healthy."* |
| **Logs & Audit** | Who did what, when, from where — with old/new values on each event. |
| **Log Explorer** | Recent backend log lines, searchable by correlation ID. Small in-memory buffer — see [guide 11](11-troubleshooting.md#where-the-logs-are). |
| **AI Copilot** | Ask "any open alerts?" or "how's traffic today?" — read-only, permission-scoped, audit-logged, and it cannot change anything. |

---

## Not available

- **Real-time push.** Nothing streams. Three screens poll; everything else needs a
  manual refresh.
- **Container / host resource metrics.** No cAdvisor, no node_exporter.
- **MTTA, MTTR, RCA reporting or ticketing integration.** Assignment and comments exist;
  the metrics and the ITSM link do not.
- **A durable log store.** There is a log query endpoint, but it reads a small
  in-memory, per-process ring buffer — see
  [troubleshooting](11-troubleshooting.md#where-the-logs-are).

---

Next: [Reports and exports →](07-reports-and-exports.md)
