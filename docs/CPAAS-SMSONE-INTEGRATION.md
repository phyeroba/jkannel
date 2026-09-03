# CPAAS-SMSONE — JKANNEL API integration

The CPAAS platform's account on JKANNEL, and how to drive it. Every contract
below was exercised against production on 2026-09-03; where something is *not*
yet working, it says so rather than describing the intent.

**No credentials in this file.** The API key is shown once, at creation, and was
delivered separately. This file names it only by its public prefix, `12a88b72`.

---

## 1. What exists

| Resource | Identifier |
|---|---|
| Customer | `CPAAS-SMSONE` — `f1c61448-9134-4318-8cf9-197532706188` |
| API key | prefix `12a88b72` — id `e726afc2-a45c-4249-a553-164d3b9fa0ea` |
| Approved sender ID | `8888` |
| Route | `CPAAS-SMSONE Uganda mobile` — `e575e305-a0d3-4917-8a52-aa185cd3a398`, deployed |
| Carrier bind | `kololo` (SMPP), bound |
| MO rule | `CPAAS-SMSONE inbound` — `c7798671-097a-4e5e-9b49-66d19fd158dd`, **disabled** |
| Daily quota | 100,000 |
| Rate limit | 600 requests/minute |

Base URL: `https://gw1.speedamobile.com/api/v1`

---

## 2. Authentication

One header. No login call, no token refresh.

```
X-API-Key: jk_<prefix>.<secret>
```

The key is a single opaque string; `jk_12a88b72.` is the prefix part and the
rest is the secret. Send it whole.

**Do not use `POST /auth/login` for CPAAS.** That issues a 15-minute operator
JWT for the console and is the wrong credential for a machine integration.

Verify the credential before anything else:

```bash
curl -s https://gw1.speedamobile.com/api/v1/gateway/whoami \
     -H "X-API-Key: $JKANNEL_API_KEY"
```

```json
{ "apiKeyId": "e726afc2-…", "keyPrefix": "12a88b72", "tenantId": "1",
  "scopes": ["sms.send","sms.read","routing.read","audit.read"], "rateLimit": 600 }
```

Reaching this handler means the key passed authentication, expiry, the IP
allowlist and the rate limiter. It is the right health check for the
integration.

### Scopes on this key

| Scope | What it unlocks |
|---|---|
| `sms.send` | `POST /gateway/messages` |
| `sms.read` | `GET /gateway/messages` |
| `routing.read` | `GET /gateway/routing-decisions` |
| `audit.read` | **Nothing today.** The scope is defined but no endpoint requires it. It is on the key so that it does not need reissuing when one exists. |

---

## 3. Sending a message (MT)

```
POST /gateway/messages
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

| Field | Required | Notes |
|---|---|---|
| `sender` | yes | **Must be `8888`.** See §7. |
| `receiver` | yes | E.164 with or without `+`; both normalise to the same number. |
| `text` | yes | Up to **1530** characters. Longer is a 400. |
| `smscId` | no | Pins the bind, bypassing route selection. Normally omit — see §4. |
| `dlrUrl` | no | Per-message delivery-receipt callback. |
| `dlrMask` | no | 0–31, which receipt events to request. 31 = all. |
| `foreignId` | no | Your identifier, carried into the engine row. |
| `reference` | no | Free-text tag, returned in history and routing decisions. |
| `operator` | no | Hint for operator-typed routes. |
| `priority` | no | 0 (bulk) – 3 (highest). Orders the per-bind queue, so it is only observable under backlog; an idle bind drains in arrival order regardless. **Omitting it is not the same as 0.** |

`customerId` is deliberately **not** accepted from the body — a client cannot
submit as another customer.

### Response — 201

```json
{ "success": true, "data": {
    "sqlId": "35", "status": "queued", "source": "kamex-sqlbox",
    "smscId": "kololo", "destination": "256782479192",
    "routeId": "e575e305-…", "routeName": "CPAAS-SMSONE Uganda mobile",
    "strategy": "priority", "fallbackUsed": false,
    "outcome": "routed", "reason": "primary target" } }
```

`sqlId` is the engine's own row id and the handle for everything afterwards.
`status: "queued"` means accepted by the engine — **not** delivered.

### Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | `No route is available for …` | The destination matches no deployed route for this sender. See §4. |
| 400 | `text must be at most 1530 characters` | Split the message. |
| 401 | Invalid, disabled or expired key | Do not retry; the key needs attention. |
| 403 | Key lacks the scope | Reissue with the scope. |
| 429 | Rate limit exceeded | Honour the `Retry-After` header (seconds). Do not retry sooner. |

---

## 4. Routing — why you should not pin `smscId`

Route selection picks the bind from the deployed routes and live bind health,
and records the decision. Pinning `smscId` skips that, so a pinned message keeps
going at a bind that is down.

The route serving CPAAS is a **wildcard** route:

```
sender        8888
matchPrefix   25670*|25671*|25672*|25674*|25675*|25676*|25677*|25678*|25679*
target        kololo
fallback      (none)
priority      200
```

The grammar is `*` (any run), `#` (a digit), `$` (end), and `|` between
alternatives — so all nine Ugandan mobile prefixes are one rule rather than nine.
It is scoped to sender `8888` on purpose: an unscoped route could outrank the
existing `MTN`/`MSC` route on specificity and silently re-point traffic that has
nothing to do with CPAAS.

There is deliberately **no fallback bind**. The pre-existing `MTN` route falls
back to `Local Fake B`, which is a *fake* SMSC — traffic failing over there is
discarded while appearing to send. A CPAAS send that cannot reach the carrier
should fail visibly instead.

To see why a message went where it did:

```
GET /gateway/routing-decisions?limit=50&offset=0
```

Returns `route_name`, `strategy`, `fallback_used`, `outcome`, `reason`, the full
selector `trace`, and — when a content rule blocked the message —
`content_rule_name`.

> **Caveat.** `POST /routes/simulate` in the console reports "No eligible route"
> for these messages. That endpoint is a legacy evaluator that reads only
> `destination_prefix` and `sender`; it never looks at `route_type` or
> `match_prefix`, so it is blind to wildcard routes. The live send path is a
> different implementation and routes them correctly. Trust an actual send, or
> `/gateway/routing-decisions`, over the simulator.

---

## 5. Delivery status and receipts

```
GET /gateway/messages?limit=50&offset=0
GET /gateway/messages?status=delivery_report
```

Scoped to this tenant's binds. When the engine's message store is unreachable
the call still returns 200 with `source.status: "unavailable"` and an empty
list — check `source`, because an empty list is otherwise indistinguishable from
"no traffic".

### What this carrier actually reports

A standard SMPP receipt carries `id: sub: dlvrd: submit date: done date: stat:
err:`. **This carrier sends none of it** — the receipt body is the bare string
`ACK/`. Verified across 33 receipts: `dlr_time` was null on every one, and the
only usable signal was the event mask (delivered / accepted).

So: treat the arrival of a receipt as the delivery signal. Do not build logic on
`stat` or `err` for this bind — they are absent at source, not lost in transit.

For a per-message push instead of polling, set `dlrUrl` on the submit.

---

## 6. Receiving messages (MO) — **not yet active**

The rule exists and is **disabled**:

```
CPAAS-SMSONE inbound   c7798671-097a-4e5e-9b49-66d19fd158dd
  match destination = 8888 (exact),  customer = CPAAS-SMSONE,  enabled = false
```

It is disabled because it has no destination yet, and a rule with no destination
matches inbound traffic and delivers it nowhere — enabling it early would take
messages away from the catch-all recorder and drop them.

To activate, supply the CPAAS webhook URL and it becomes:

```
POST /mo/rules/c7798671-…/destinations
{ "kind": "webhook", "target": "https://<cpaas-host>/…", "maxAttempts": 5,
  "config": { "method": "POST", "secret": "<hmac secret>",
              "headers": { "X-Source": "jkannel" } } }

PATCH /mo/rules/c7798671-…   { "enabled": true }
```

`config.secret` signs the payload; `config.headers` may not set `Host` or
`Content-Length`. Unknown config keys are dropped rather than stored, so a
header that looks configured but is not cannot happen silently.

Inbound is visible regardless via `GET /mo/messages`, and delivery attempts via
`GET /mo/deliveries` (with `POST /mo/deliveries/{id}/retry`). A catch-all rule
already records every inbound message, so nothing is being lost while this is
off.

---

## 7. Sender ID — why it must be `8888`

On this carrier a message with any other source address is **accepted, billed
and never delivered**. It is not rejected, so there is no error to catch: it
simply does not arrive. `8888` is the approved sender ID on the account and the
only value the route matches.

---

## 8. One thing not yet wired

`api_keys.customer_id` is what binds a credential to a customer's quota, credit,
approved sender IDs and route bindings — the send path enforces all four inside
the same transaction as the send.

**No API endpoint sets it.** `POST /auth/api-keys` does not accept it and
`PATCH /gateway/keys/{id}` handles only rate limit, IP allowlist, expiry and
enabled. It can currently only be set with SQL:

```sql
UPDATE api_keys
   SET customer_id = 'f1c61448-9134-4318-8cf9-197532706188'
 WHERE id = 'e726afc2-a45c-4249-a553-164d3b9fa0ea';
```

Until then the key submits **as the tenant**, and the customer's quota, credit
and sender-ID allowlist are recorded but not enforced against CPAAS traffic.
Sending, routing, delivery reports and MO are unaffected — this governs
entitlement accounting only.

That statement needs host access, which is blocked while the office IP is
banned from port 22 (see `scripts/prod-ssh.ps1`). It is the first thing to run
once that clears.

---

## 9. Worked example

```bash
export JKANNEL_API_KEY='jk_12a88b72.…'
export JKANNEL_API='https://gw1.speedamobile.com/api/v1'

# 1. is the credential healthy?
curl -s "$JKANNEL_API/gateway/whoami" -H "X-API-Key: $JKANNEL_API_KEY"

# 2. send
curl -s -X POST "$JKANNEL_API/gateway/messages" \
  -H "X-API-Key: $JKANNEL_API_KEY" -H 'content-type: application/json' \
  -d '{"sender":"8888","receiver":"+256782479192",
       "text":"Hello from CPAAS","dlrMask":31,"reference":"demo-1"}'

# 3. what happened to it
curl -s "$JKANNEL_API/gateway/messages?limit=5" -H "X-API-Key: $JKANNEL_API_KEY"
curl -s "$JKANNEL_API/gateway/routing-decisions?limit=5" -H "X-API-Key: $JKANNEL_API_KEY"
```

---

## 10. Operational notes

- **Rate limit 600/min per key**, enforced in Redis. A 429 carries `Retry-After`
  in seconds; honour it rather than backing off blindly.
- **No IP allowlist is set.** CPAAS reaches the API from the same host, and the
  source address the gateway records depends on whether the call arrives over
  the docker bridge or the loopback proxy. Once the first real requests appear
  in `GET /gateway/request-log`, pin the allowlist to the address actually
  observed — guessing it would lock the integration out on its first call.
- **The key is not rotatable in place.** Rotation means issuing a new key and
  disabling the old one (`DELETE /auth/api-keys/{id}`), so allow the CPAAS
  config to hold two keys during a changeover.
- **Server time is UTC**; every timestamp in these responses is UTC. Uganda is
  UTC+3, so convert for display.
