# 3. Sending messages

Three ways to send: one message from the console, a bulk campaign, or over the REST API
with an API key. All three go through the **same send pipeline**, so the same rules
apply to all of them.

---

## What happens on every send

Whichever path you use, one service handles it and does all of this **inside a single
database transaction**:

1. Normalise the destination to E.164.
2. Check the blocklist / allowlist / DND list.
3. Pick a route — unless you pinned an SMSC, in which case that bind is used.
4. Check the customer's entitlements: quota, prepaid credit, approved sender ID,
   allowed routes.
5. Record the routing decision.
6. Submit to the engine.

If step 4 fails, **nothing is sent and nothing is charged**. If no route matches, the
send **fails closed** rather than picking an arbitrary bind.

There is one deliberate exception, covered in [guide 4](04-live-queue-and-recovery.md):
an operator **resend** from the Live Queue bypasses routing and entitlements by design.

---

## Send a single message from the console

1. Go to **Messages**.
2. Click **Send message**. The **Send message** composer opens.
3. Fill in:

   | Field | Notes |
   |---|---|
   | **SMSC connection** | Required. Choose from your own connections, shown as `Name (engine-id)`. |
   | **Sender** | The sender ID, e.g. `JKANNEL`. |
   | **Recipient** | E.164, e.g. `+256700000000`. |
   | **Message text** | The body. |

4. Click **Send**. You get the notice *"Message submitted for delivery."*

The console composer **requires** you to pick an SMSC. The API does not — omit it there
and routing chooses. If you want the routing engine to decide, use the API, or set up
routes and check the decision afterwards.

## Read what happened

The **Messages** grid columns are: **When**, **Dir**, **Delivery**, **Sender**,
**Receiver**, **Message**, **SMSC**, **DLR**, **Service**, **Account**, **Reference**.

**Delivery** is derived from the message's latest correlated delivery receipt, not from
what you asked for. The values you will see:

| Status | Meaning |
|---|---|
| `delivered` | The handset confirmed it. |
| `failed` | The network gave up. |
| `rejected` | The SMSC refused it. |
| `buffered` | Held at the SMSC for retry. |
| `accepted` | The SMSC took it; no final outcome yet. |
| `pending` | Submitted; no delivery report has arrived. |
| `unknown` | No classification available. |

### Filtering

Open **Message search filters**:

| Filter | Options |
|---|---|
| **Delivery status** | Any delivery status · Resendable failures (failed + rejected) · In flight (pending + buffered) · Delivered · Failed · Rejected · Accepted by SMSC · Buffered at SMSC · Pending (no report yet) · Unknown · Delivery receipts only |
| **Direction** | Any · MT (outbound) · MO (inbound) · DLR (receipt) |
| **SMSC** | Free text: the engine SMSC id |
| **From** / **To** | Date-time |
| **Rows** | 50 · 100 · 250 · 500 |

Click **Apply filters**.

**The date range is now a real server-side filter.** The API takes `from` and `to`, both
inclusive, as strict ISO 8601 — `2026-08-04T00:00:00Z`, not `2026/08/04`, or you get a
400. No timezone offset means UTC. `from` later than `to` is a 400.

**Export now matches the grid.** CSV, PDF and the on-screen list all run the same filter
parser, so a delivery-status filter is honoured everywhere and an unknown status token
is a 400 on all three rather than silently widening the result.

> **The one export caveat that remains:** a single export returns **at most 500 rows**,
> regardless of what `SQLBOX_EXPORT_MAX_ROWS` is set to. Truncation is signalled only by
> an `x-jkannel-next-cursor` response header, and nothing pages automatically. For a
> larger extract, page through the API with that cursor.

Free-text search matches sender, receiver, reference and body. It still uses a leading
wildcard with **no trigram index**, so `query=` is a full scan on a large `sent_sms`;
the date-range and SMSC filters *are* index-backed. Narrow by date or SMSC first, then
add search text.

> Those read indexes are not created automatically. An operator has to call
> `POST /messages/indexes` (needs `system.manage`) once per deployment.

Message records now carry encoding and segmentation detail — `coding`, `charset`,
`udhData`, `validity`, `deferred`, `mclass`, `pid`, `binfo`, `metaData`, a derived
`segments` count, and a `segmentation` object describing the alphabet and per-part
capacity. Segment counts follow the usual rules (GSM-7 160/153, UCS-2 70/67, 8-bit
140/134), and a UDH that declares its own part count wins. The same columns appear in
the CSV export.

Note that **segment counts are informational only** — billing still counts a multi-part
message as one. See [guide 8](08-customers-and-quotas.md#prepaid-credit).

### Tracing one message

Click any row. The **Message trace** panel shows **Message ID**, **Direction**,
**Status**, **Sender**, **Receiver**, **SMSC**, **Created**, **Updated**, and a
**Trace events** list.

The trace covers spool and delivery-report events. It does **not** include the route
trace or the SMSC trace — the recorded routing decision is exposed on the API
(`GET /gateway/routing-decisions`) but is not joined into this panel.

### Resending or re-issuing one message

In the trace panel, under **Message operations** (needs the configuration-manage
permission), the note reads: *"Re-submit this message through the engine. Each action
creates a new, independently traceable message."*

| Button | Use it when |
|---|---|
| **Replay** | You want the same message sent again as-is. If the original bind is no longer available, the replay is automatically re-routed. |
| **Clone…** | You want to change the sender, recipient or text. Leave a field blank to keep the original value, then **Submit clone**. |
| **Requeue** | You want it put back in the queue. |

There is no "Replay DLR".

### Exporting

**Export CSV** and **Export PDF** on the toolbar. They honour every filter the grid
does, and return at most 500 rows per call — see the caveat above.

### Retention

The **SQLBox retention** panel on the Messages screen prunes old rows:

1. Set **Keep sent message rows for days** (1–3650, default 90).
2. Click **Dry-run cleanup** to see the count without changing anything.
3. Click **Apply retention** to delete.

> **Retention deletes the engine's rows. It does not archive them.** JKANNEL keeps no
> independent copy, so once you apply retention that history is gone. Export first if
> you need it.

---

## Send a bulk campaign

1. Go to **Bulk Send**.
2. In **New bulk send campaign**, fill in:

   | Field | Notes |
   |---|---|
   | **Campaign name** | e.g. "July balance reminder". |
   | **SMSC connection** | Required. One bind for the whole campaign. |
   | **Message text** | One body, fanned out to every recipient. |
   | **Recipients** | Paste into the textarea: one number per line, or comma- or semicolon-separated. |

   A live counter under the box reads *"{n} recipient(s) parsed."*

3. Click **Queue campaign**.

Limits and behaviour:

- **Up to 5000 recipients per job**, as the in-page hint says.
- **There is no CSV upload.** Paste the list.
- A background worker processes the job, routing per recipient and tracking each
  outcome.
- **There is no per-recipient retry.** A transient failure — a momentary SQLBox blip,
  say — marks that recipient failed permanently. Re-queue those recipients in a new
  campaign, or resend them from the Live Queue log.

Track progress in the **Bulk send jobs** grid: **Campaign**, **Status**, **Total**,
**Submitted**, **Failed**, **Created**. Click a job for **Job detail**, which shows
**Status counts** and a per-recipient table (**Receiver**, **Status**, **Foreign ID**,
**Error**).

---

## Send over the REST API

### Step 1 — Get a real API key

> **Read this before you use the API Gateway screen.** The console's **API Gateway**
> screen manages `api_gateway_clients`, a registry that **no longer authenticates
> anything**. A client created there cannot call the API by itself. The credential that
> actually works is an **API key**, issued by `POST /auth/api-keys`, and there is
> currently **no console UI for it.** Use the API.

Issue a key (you need the `users.manage` permission):

```bash
curl -X POST https://your-console/api/v1/auth/api-keys \
  -H "Authorization: Bearer <your access token>" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "billing-system",
        "scopes": ["sms.send", "sms.read"],
        "expiresAt": "2027-01-01T00:00:00Z"
      }'
```

The response contains `key`, in the form `jk_<prefix>.<secret>`. **It is shown once and
is never retrievable again** — only a hash is stored. Copy it now.

`GET /auth/api-keys` lists keys (metadata only), and `DELETE /auth/api-keys/{id}`
disables one.

### Step 2 — Know the scopes

API-key scopes are a **separate vocabulary** from console permissions, on purpose: a
machine key must not inherit an operator's console rights.

| Scope | Grants |
|---|---|
| `sms.send` | `POST /api/v1/gateway/messages` |
| `sms.read` | `GET /api/v1/gateway/messages` |
| `routing.read` | `GET /api/v1/gateway/routing-decisions` |
| `audit.read` | Read the caller's own gateway audit trail |

Grant only what the client needs.

### Step 3 — Submit a message

Present the key as `X-API-Key`, or as `Authorization: ApiKey <key>`.

```bash
curl -X POST https://your-console/api/v1/gateway/messages \
  -H "X-API-Key: jk_a1b2c3d4.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea1e-4d54-9c1a-2b6b8d0c0001" \
  -d '{
        "sender": "JKANNEL",
        "receiver": "+256700000000",
        "text": "Your balance is 12,500 UGX.",
        "dlrUrl": "https://your-app.example/dlr",
        "dlrMask": 31,
        "reference": "invoice-90210"
      }'
```

| Field | Required | Notes |
|---|---|---|
| `sender` | yes | |
| `receiver` | yes | |
| `text` | yes | |
| `smscId` | no | **Omit it** and the routing engine picks the bind and records why. Supply it to pin a bind (still validated as one of your own). |
| `dlrUrl` | no | Where the engine posts delivery reports. |
| `dlrMask` | no | 0–31, defaults to 31 (all events). |
| `foreignId`, `reference`, `operator` | no | Passed through for correlation. |

**The customer is taken from the key, never from the body.** `api_keys.customer_id`
decides whose quota, credit, sender IDs and route bindings are enforced. A client
cannot submit as somebody else. A key with no customer submits as the tenant and
consumes no entitlements.

### Step 4 — Read back

```bash
# History for your tenant
curl -H "X-API-Key: $KEY" \
  "https://your-console/api/v1/gateway/messages?limit=50&status=resendable"

# Why a message took the bind it took
curl -H "X-API-Key: $KEY" \
  "https://your-console/api/v1/gateway/routing-decisions?limit=20"
```

### What the gateway enforces on every request

| Control | Behaviour |
|---|---|
| **Authentication** | Missing, disabled or expired key → **401**. |
| **Scope** | Key lacks the scope → **403**. |
| **IP allowlist** | Per-key IP/CIDR list; caller not allowed → **403**. An empty list allows all. The client IP is derived by the platform, so a spoofed `X-Forwarded-For` cannot defeat it. |
| **Rate limit** | Per-key, per-minute, atomic in Redis → **429** with `Retry-After`. If Redis is down it **fails open** rather than blocking traffic. |
| **Audit** | Every request is logged with method, path, status and duration. |
| **Idempotency** | Send an `Idempotency-Key` header on mutating requests. A replay returns the original response; a crashed request releases its key instead of blocking retries forever. |

### The full reference

`GET /api/v1/openapi.json` is auto-generated from the live route table, so it is never
out of date with the code.

### Not available

- No OAuth2 or OIDC.
- No webhook framework. The alert webhook makes one 5-second attempt with no retry, and
  its "signature" is a static shared secret, not an HMAC.
- No generated client SDK, no batch operations.

---

Next: [Live Queue and recovering a bad bind →](04-live-queue-and-recovery.md)
