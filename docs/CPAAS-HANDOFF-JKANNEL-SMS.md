# Handoff: integrating CPAAS with the JKANNEL SMS gateway

**Audience:** whoever is building the SMS integration inside CPAAS.

This is a working brief, not a specification. Everything in it was exercised
against the live gateway on 2026-09-03 — endpoints, payloads and error strings
are copied from real responses, not from a schema. Where something does not work
yet, it is marked and the reason is given, so you do not spend time debugging a
gap that is already known.

Read §9 before you write any code. Four of the traps in it cost real time to
find and all four look like bugs in your integration when you hit them.

---

## 1. Connection

| | |
|---|---|
| Base URL | `https://gw1.speedamobile.com/api/v1` |
| Auth | header `X-API-Key: jk_<prefix>.<secret>` |
| Account | `CPAAS-SMSONE` |
| Key prefix | `12a88b72` (the secret is supplied separately — see §2) |
| Sender ID | `8888` — mandatory, see §9.1 |
| Rate limit | 600 requests/minute |
| Daily quota | 100,000 messages |
| Max body | 1,530 characters |
| Server time | UTC |

CPAAS and JKANNEL run on the same host, so this call does not leave the machine.
Use the public URL anyway unless you have a reason not to: it is the address the
key was tested against, and the loopback path has not been.

---

## 2. Credentials

The API key is a single opaque string of the form `jk_<prefix>.<secret>`. It was
displayed exactly once when created and is **not recoverable** — if it is lost,
a new key must be issued and this one disabled.

It is deliberately **not in this file**. Take it from the secure channel it was
delivered on and put it in the CPAAS environment:

```bash
JKANNEL_API_BASE=https://gw1.speedamobile.com/api/v1
JKANNEL_API_KEY=jk_12a88b72.<secret>
JKANNEL_SENDER_ID=8888
```

Never log the key, never put it in a URL query string, never commit it. The
prefix `12a88b72` is public and safe to log — use it to identify which
credential a request used.

---

## 3. First call — prove the credential before anything else

```http
GET /gateway/whoami
X-API-Key: jk_12a88b72.<secret>
```

```json
{ "success": true, "data": {
    "apiKeyId": "e726afc2-a45c-4249-a553-164d3b9fa0ea",
    "keyPrefix": "12a88b72",
    "tenantId": "1",
    "scopes": ["sms.send", "sms.read", "routing.read", "audit.read"],
    "rateLimit": 600 } }
```

Reaching this handler means the key passed authentication, expiry checks, the IP
allowlist and the rate limiter — all four. Wire it up as the integration's
health check; a 200 here means the credential is genuinely usable, not merely
well-formed.

**Scopes held.** `sms.send` (submit), `sms.read` (history and status),
`routing.read` (routing decisions). `audit.read` is also on the key but **no
endpoint requires it today** — it grants nothing; do not build against it.

---

## 4. Sending a message (MT)

```http
POST /gateway/messages
X-API-Key: jk_12a88b72.<secret>
Content-Type: application/json
```

```json
{
  "sender": "8888",
  "receiver": "+256782479192",
  "text": "Your code is 123456",
  "dlrMask": 31,
  "reference": "cpaas-order-91021"
}
```

### Fields

| Field | Req | Type | Notes |
|---|---|---|---|
| `sender` | yes | string | **Must be `8888`.** See §9.1. |
| `receiver` | yes | string | E.164, with or without `+`. Both normalise identically. |
| `text` | yes | string | ≤ 1530 chars; longer is a 400. |
| `smscId` | no | string | Pins the carrier bind. **Do not set it** — see §9.2. |
| `dlrUrl` | no | string | Per-message receipt callback URL. |
| `dlrMask` | no | int | 0–31; which receipt events to request. 31 = all. |
| `foreignId` | no | string | Your id, carried into the engine row. |
| `reference` | no | string | Free-text tag; returned in history and routing decisions. Use it to correlate. |
| `operator` | no | string | Hint for operator-typed routes. Not needed here. |
| `priority` | no | int | 0 (bulk) – 3 (highest). Only observable under backlog. Omitting ≠ sending 0. |

`customerId` is **not** accepted from the body — a client cannot submit as
another customer. It is taken from the key.

### Success — HTTP 201

```json
{ "success": true, "data": {
    "sqlId": "35",
    "status": "queued",
    "source": "kamex-sqlbox",
    "smscId": "kololo",
    "destination": "256782479192",
    "routeId": "e575e305-a0d3-4917-8a52-aa185cd3a398",
    "routeName": "CPAAS-SMSONE Uganda mobile",
    "strategy": "priority",
    "fallbackUsed": false,
    "outcome": "routed",
    "reason": "primary target" } }
```

Persist `sqlId` against your own record — it is the engine's row id and the
handle for everything afterwards.

`status: "queued"` means **the engine accepted it**. It does not mean sent, and
it certainly does not mean delivered. Do not report success to a user on the
strength of a 201.

---

## 5. Delivery status

### Polling

```http
GET /gateway/messages?limit=50&offset=0
GET /gateway/messages?status=delivery_report
```

**Always check `source.status` in the response.** When the engine's message
store is unreachable the call still returns **200** with
`source.status: "unavailable"` and an empty `items` array. An empty list is
otherwise indistinguishable from "no traffic", and treating one as the other
will make the integration report every message as missing during an outage.

```json
{ "items": [ … ], "source": { "status": "available", "type": "kamex-sqlbox" } }
```

### Webhook

Set `dlrUrl` on the submit for a push instead. Preferred over polling at volume.

### What this carrier actually sends — important

A standard SMPP delivery receipt carries
`id: sub: dlvrd: submit date: done date: stat: err:`.

**This carrier sends none of it.** The receipt body is the bare string `ACK/`.
Verified across 33 receipts on this bind: `dlr_time` was null on every one, and
the only usable signal was the event mask (delivered / accepted).

So:

- Treat the **arrival** of a receipt as the delivery signal.
- Do **not** branch on `stat` or `err` — they are absent at source, not lost in
  transit, and no amount of parsing will produce them.
- Do not raise "malformed DLR" alarms for this bind; that is its normal output.

---

## 6. Receiving messages (MO) — not active yet

**Status: blocked on one input from your side.**

A routing rule exists and is **disabled**:

```
name        CPAAS-SMSONE inbound
id          c7798671-097a-4e5e-9b49-66d19fd158dd
match       destination = 8888 (exact)
customer    CPAAS-SMSONE
enabled     false
```

It is disabled because it has no destination. A rule with no destination matches
inbound traffic and delivers it nowhere, so enabling it early would take messages
away from the catch-all recorder and silently drop them.

**What is needed from CPAAS:** the inbound webhook URL, the HTTP method it
expects (POST or PUT), and an HMAC secret if you want the payload signed.

Then, on the JKANNEL side:

```http
POST /mo/rules/c7798671-097a-4e5e-9b49-66d19fd158dd/destinations
{ "kind": "webhook",
  "target": "https://<cpaas-host>/<inbound-path>",
  "maxAttempts": 5,
  "config": { "method": "POST",
              "secret": "<hmac secret>",
              "headers": { "X-Source": "jkannel" } } }

PATCH /mo/rules/c7798671-097a-4e5e-9b49-66d19fd158dd
{ "enabled": true }
```

Notes on `config`: unknown keys are **dropped, not stored** (so a header that
looks configured but is not cannot happen silently), and `Host` /
`Content-Length` are refused. `maxAttempts` is 1–20.

Nothing is being lost in the meantime — a catch-all rule already records every
inbound message. Read them with `GET /mo/messages`, and delivery attempts with
`GET /mo/deliveries` (retry with `POST /mo/deliveries/{id}/retry`).

---

## 7. Errors and retry policy

| Status | Meaning | Retry? |
|---|---|---|
| 400 `No route is available for …` | Destination matches no deployed route for this sender | **No.** Config problem — escalate. |
| 400 `text must be at most 1530 characters` | Body too long | No. Split before sending. |
| 401 | Key invalid, disabled or expired | **No.** Retrying makes it worse; alert instead. |
| 403 | Key lacks the required scope | No. Needs a new key. |
| 429 | Rate limit exceeded | **Yes**, after `Retry-After` seconds. Not sooner. |
| 5xx | Gateway or engine fault | Yes, with exponential backoff and a cap. |

Two rules worth encoding explicitly:

- **Never retry a 401 in a loop.** The platform's SSH access was banned for a
  day by exactly this class of mistake — repeated failed authentication against
  a host running fail2ban. The API is not fail2ban-protected in the same way,
  but the habit is the problem.
- **Honour `Retry-After` literally.** The limiter is a fixed window in Redis;
  retrying early just consumes the next window's budget.

### Idempotency

There is no server-side idempotency key. If you retry a 5xx you may send twice.
Set `reference` (and/or `foreignId`) to your own unique id on every submit, and
before retrying, check `GET /gateway/messages` for that reference.

---

## 8. Observability

```http
GET /gateway/routing-decisions?limit=50&offset=0
```

Returns, per message: `route_name`, `strategy`, `fallback_used`, `outcome`,
`reason`, the full selector `trace`, and — when a content rule blocked the
message — `content_rule_id` / `content_rule_name`. This is the endpoint that
answers "why did this message go where it did", and also "why did this message
not go at all".

---

## 9. Traps — read before coding

### 9.1 The sender ID must be `8888`

On this carrier a message with any other source address is **accepted, billed,
and never delivered**. It is not rejected. There is no error to catch; the
message simply does not arrive.

Treat `8888` as a constant in configuration, not a per-message field, and reject
any attempt to override it before the request leaves CPAAS.

### 9.2 Do not pin `smscId`

Route selection picks the bind from deployed routes and live bind health, and
records the decision. Pinning `smscId` skips all of that, so a pinned message
keeps being sent at a bind that is down.

The route serving CPAAS is a wildcard route covering all nine Ugandan mobile
prefixes (`25670*|25671*|25672*|25674*|25675*|25676*|25677*|25678*|25679*`),
scoped to sender `8888`, targeting the `kololo` carrier with **no fallback**.
No fallback is deliberate: the neighbouring route falls back to a *fake* SMSC,
where traffic is discarded while appearing to send. A CPAAS message that cannot
reach the carrier should fail visibly.

### 9.3 Do not use `POST /auth/login`

That issues a 15-minute operator JWT for the human console. It is the wrong
credential for a machine integration and will expire mid-traffic. The API key
does not expire and needs no refresh.

### 9.4 The route simulator lies about this route

`POST /routes/simulate` reports **"No eligible route"** for traffic the live
path routes correctly. It is a legacy evaluator that reads only
`destination_prefix` and `sender`, and never looks at `route_type` or
`match_prefix` — so it cannot see wildcard routes at all.

If you are verifying routing, use an actual send or
`GET /gateway/routing-decisions`. Do not conclude from the simulator that
routing is broken.

### 9.5 Quota and credit are not enforced yet

`api_keys.customer_id` is what binds a credential to a customer's quota, credit,
approved sender IDs and route bindings. No API endpoint sets it, and it has not
been set for this key — that needs one SQL statement on the host, which is
pending.

Until then the key submits **as the tenant**: the 100,000/day quota and the
sender-ID allowlist exist on the customer record but are not enforced against
CPAAS traffic. The 600/min **rate limit is** enforced (it lives on the key, not
the customer).

Practical consequence: do not rely on the gateway to stop you exceeding quota.
Count on your side if that matters.

---

## 10. Integration checklist

1. Put `JKANNEL_API_BASE`, `JKANNEL_API_KEY`, `JKANNEL_SENDER_ID` in the CPAAS
   environment. Never in source.
2. Health check against `GET /gateway/whoami` — expect 200 and
   `keyPrefix: "12a88b72"`.
3. Send path: `POST /gateway/messages`, sender forced to `8888`, `smscId`
   omitted, `reference` set to your own unique id, `dlrMask: 31`.
4. Persist `sqlId` and `reference` against your record.
5. Status: poll `GET /gateway/messages` **checking `source.status`**, or set
   `dlrUrl` for push. Treat receipt arrival as the delivery signal; ignore
   `stat`/`err`.
6. Errors: retry only 429 (after `Retry-After`) and 5xx (backoff). Alert on 401
   and on `No route is available`.
7. Rate-limit yourself below 600/min.
8. Timestamps are UTC; convert for display, never for submission.
9. **Send back to JKANNEL:** the MO webhook URL, method, and HMAC secret, so
   inbound can be switched on (§6).

---

## 11. Verified on 2026-09-03

| Check | Result |
|---|---|
| `GET /gateway/whoami` | 200, correct scopes |
| MT with `smscId` pinned | 201, `sqlId 34`, left on `kololo` |
| MT unpinned (route selection) | 201, `sqlId 35`, route `CPAAS-SMSONE Uganda mobile`, `fallbackUsed: false` |
| MT to +256782140626 | 201, `sqlId 36`, routed |
| MT to +256772833261 | 201, `sqlId 37`, routed |
| Handset receipt | Confirmed received by the account owner |
| Delivery receipts | Returned; bodies are bare `ACK/` as described in §5 |
| MO inbound | Rule created, **disabled** — awaiting webhook URL |

A fuller human-facing reference lives in
[`CPAAS-SMSONE-INTEGRATION.md`](./CPAAS-SMSONE-INTEGRATION.md).
