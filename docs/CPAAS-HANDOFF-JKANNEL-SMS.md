# Handoff: integrating CPAAS with the JKANNEL SMS gateway

**Audience:** the Claude Code instance working in the CPAAS repo
(`D:\CpaSS\Project`, github.com/phyeroba/cpaas), and whoever reviews its work.

JKANNEL is the **SMPP server**. CPAAS owns the customer-facing platform; JKANNEL
holds the direct telecom SMPP binds and owns routing, delivery receipts and
inbound fan-out. **CPAAS does not hold a carrier bind and does not speak SMPP** —
it sends over HTTP to the gateway API below.

```
CPaaS ──HTTP──▶ JKANNEL ──SMPP──▶ telecom carriers
```

JKANNEL is also the replacement for SMSSTUDIO, and the SMSSTUDIO client base is
to migrate onto it. That matters to you only in one way: **the carrier set will
grow**, and a bind added to JKANNEL does not become usable by CPAAS
automatically — see §9.6.

This is a working brief, not a specification. Everything was exercised against
the live gateway — endpoints, payloads and error strings are copied from real
responses, not from a schema.

Read **§0** and **§9** before you write any code.

---

## 0. STATE OF PLAY — read this first · updated 2026-09-29

> ### 🔴 The carrier has been down for 21 days. Every send fails right now.
>
> The `kololo` SMPP bind has been refused by the carrier since
> **2026-09-08 18:40 UTC**. `POST /gateway/messages` returns
> **400 `No route is available for <msisdn>: primary and fallback unavailable;
> no available SMSC`**.
>
> **This is not your integration, and not something you can fix.** JKANNEL's
> side is verified clean: DNS unchanged, egress IP unchanged (`34.134.248.1`),
> the same carrier host answers on :80 and :443, an unrelated host answers on
> :4089, and the host firewall permits the traffic. Only the carrier's SMPP port
> refuses us. Resolution sits with the carrier. (The carrier's hostname and
> credentials are deliberately absent from this repo — they live only in the
> gitignored `.env` on the host. Ask Peter if you need them.)
>
> **Build and test against this anyway.** The failure is a clean, correct 400 on
> a healthy API — it is a good negative test. Everything except the final carrier
> hop is exercisable: auth, validation, routing decisions, quota, credit,
> history, and the MO path. When the bind returns, nothing needs restarting on
> either side; bearerbox retries every 10s by itself.

### What changed since the 2026-09-03 brief

| | Then | Now |
|---|---|---|
| Entitlements | Not enforced — key submitted "as the tenant" | **Enforced.** The key is linked to customer `CPAAS-SMSONE`; quota, credit, sender-ID allowlist and route bindings all apply. See §9.5 — this changes your error handling. |
| Carrier | Bound and delivering | **Down since 2026-09-08.** See above. |
| Console URL | `jkannel.34-134-248-1.sslip.io` | **`gw1.speedamobile.com`.** The sslip.io names were retired on 2026-08-15 and now fail the TLS handshake. |
| Loopback path | "not tested" | **Documented and recommended** — see §1. |

### What CPAAS already has (found in your repo on 2026-09-29)

You are further along than this document used to assume. Commit `362c721`
already ships:

- `services/messaging-service/src/providers/adapters/http-apikey.provider.ts` —
  the JKANNEL provider adapter
- `services/messaging-service/src/webhooks/dlr-receiver.controller.ts` —
  `POST /webhooks/dlr/:carrier` and `POST /webhooks/dlr/:carrier/:providerMessageId`,
  with `hmac | ip_allowlist | key_auth` per your ADR 0025
- `docs/integrations/JKANNEL-SMSONE-INTEGRATION-PLAN.md`

**That DLR receiver is the missing input JKANNEL has been blocked on since
2026-09-03** (§6). Confirm its public path and auth mode and inbound can be
switched on the same day. See §12 for how to send that answer back.

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

### Which address to use — the host layout, verified 2026-09-29

CPAAS and JKANNEL run on the **same GCP instance** (`caps`, `34.134.248.1`).
A single system nginx is the only ingress; every application port is bound
either to loopback or is closed at the GCP firewall. Probed from outside, all of
`5432 6379 9000 9001 8080 9080 9180 5672 15672 3000 3100 5273 8081` are closed.

| Public name | → upstream | Owner |
|---|---|---|
| `app.speedamobile.com` | `127.0.0.1:5273`, `/auth/`→`:3000`, `/msg/`→`:3100` | CPaaS console + services |
| `iam.speedamobile.com` | `127.0.0.1:8080` | Keycloak |
| `dev.speedamobile.com` | `127.0.0.1:9080` | APISIX data plane |
| **`gw1.speedamobile.com`** | **`127.0.0.1:8081`** | **JKANNEL — this API** |

### DECIDED 2026-09-29: use the public URL

```bash
JKANNEL_API_BASE=https://gw1.speedamobile.com/api/v1
```

Peter chose the public address over the loopback one. Use it.

This is a `ProviderEndpoint` row on your side, not a code constant — host
`gw1.speedamobile.com`, port `443`, TLS on, send path `/api/v1/gateway/messages`,
health path `/api/v1/gateway/whoami`, auth header `X-API-Key`.

The reasoning, so you do not relitigate it: the public path is the same one any
external client takes, so what you test is what a customer gets, and there is
one behaviour to reason about rather than two. It costs a TLS handshake and an
nginx hop on a call that stays inside the machine, which is a real but small
price.

`http://127.0.0.1:8081/api/v1` also works and is documented here only so nobody
rediscovers it and assumes it is the intended path. **It is not — do not switch
to it without agreement**, because it changes the source address JKANNEL records
and would silently invalidate an IP allowlist pinned against the public path
(§10).

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

**Status: blocked on one input from your side — which you appear to already
have.** Your repo ships `POST /webhooks/dlr/:carrier` with `hmac |
ip_allowlist | key_auth` auth modes (`dlr-receiver.controller.ts`). That is
almost certainly the endpoint this rule should point at. What is missing is not
the code, it is the **confirmed URL, method and auth choice** — see §12.

Likely shape, for you to confirm or correct:

```
target  http://127.0.0.1:3100/webhooks/dlr/jkannel          (loopback)
   or   https://app.speedamobile.com/msg/webhooks/dlr/jkannel  (public)
method  POST
auth    hmac, with a shared secret
```

Note the public form goes through the `/msg/` prefix on `app.speedamobile.com`,
which strips the prefix before forwarding to `:3100` — so your service still
sees `/webhooks/dlr/jkannel`.


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
`Content-Length` are refused. `maxAttempts` is 1–20. The `secret` is encrypted
at rest and never returned by any read endpoint — a read shows
`"secret": "__redacted__"`, and echoing that back on a write leaves the stored
value untouched rather than overwriting it with the marker.

### How to verify the signature — CHANGED 2026-09-29, implement this

**Until 2026-09-29 JKANNEL put the shared secret verbatim in
`x-jkannel-signature`.** That was a bearer token wearing a signature's name:
identical on every request, proving nothing about the body, replayable forever
by anyone who saw one. It has been replaced. If you already wrote a receiver
that compares the header to the secret, it will now reject every call.

Two headers are sent:

```
x-jkannel-timestamp: 1759140000          unix seconds
x-jkannel-signature: v1=<hex hmac-sha256>
```

The signed string is `${timestamp}.${rawBody}` — the **raw body bytes as
received**, not a re-serialisation of the parsed JSON. Two JSON encoders
disagree about key order and whitespace, so verifying against a re-encoded
object will fail intermittently and undebuggably. Capture the raw body before
your JSON body-parser consumes it.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, rawBody: string, sig?: string, ts?: string): boolean {
  if (!sig?.startsWith('v1=') || !ts || !/^\d+$/.test(ts)) return false;
  // Without this the replay window is unbounded and the change buys nothing.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig.slice(3), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);   // throws on length mismatch
}
```

Three things that are easy to get wrong, and all three are silent:

- **Reject a timestamp outside your tolerance** (300s each way is what JKANNEL
  assumes). Skipping it leaves replay wide open.
- **Compare in constant time.** `===` on a hex string leaks by timing.
- `timingSafeEqual` **throws** when the buffers differ in length, which a
  guessed signature will — catch it or length-check first, or a probe gets a 500
  that tells them their guess was the wrong shape.

The reference implementation is
`backend/src/security/webhook-secret.ts` (`signBody`, `verifySignature`); its
tests in `webhook-secret.spec.ts` are the contract.

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

### 9.6 A new carrier bind does not reach you automatically

Entitlement is per customer. A bind can exist in JKANNEL, be enabled, be rendered
into the engine config and have a deployed route that matches your destination
perfectly — and your traffic will still be refused, because `customer_routes`
decides which binds and routes your account may use.

This is not hypothetical. On 2026-09-29 a second bind (`kamdixy`, sender `KAMEX`)
was added with a matching deployed route, and CPAAS sends were refused with
**"no route matched the destination"** — which sends you to check prefixes that
are fine. The actual cause was that CPAAS was bound to the first SMSC alone.

Two consequences for you:

- **When a carrier is added for you, confirm the binding, not just the bind.**
  `GET /gateway/routing-decisions` after one send shows which route was chosen
  and why; a refusal there is faster to read than a 400 on the submit.
- **The refusal now names entitlement** when bindings removed candidates before
  matching — it will say how many deployed routes were excluded. If you see that
  sentence, the problem is an account permission, not your payload.

CPAAS is currently entitled to **both** binds (`kololo` and `kamdixy`).

### 9.5 Quota and credit ARE now enforced — this reversed on 2026-09-17

The 2026-09-03 brief said entitlements were not enforced. **That is no longer
true.** `api_keys.customer_id` was linked to customer `CPAAS-SMSONE`
(`f1c61448-9134-4318-8cf9-197532706188`) on 2026-09-17, behind a gated check
that verified credit, account status, sender ID and bind first.

Every send now consumes, inside the same database transaction as the submit:

| Entitlement | Effect when exhausted |
|---|---|
| Daily quota — 100,000 | submit refused |
| Prepaid credit (append-only ledger) | submit refused |
| Approved sender IDs — `8888` only | submit refused |
| Route bindings | submit refused |
| Rate limit — 600/min (on the key) | `429` + `Retry-After` |

**What this means for your error handling.** A submit can now fail for reasons
that have nothing to do with the message: an exhausted quota or an empty credit
balance produces a 4xx that looks like a validation error but is an *account*
condition. Do not retry those, and do not report them to the end user as a bad
request — surface them as a platform/billing alert. Treat them the same way you
treat a 401: stop, alert a human.

Because credit is now deducted per message, **a load test spends real balance.**
Check the balance before running one.

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

---

## 12. How the two sides exchange information

Two Claude Code instances work on this integration — one in `D:\JKANNEL`, one in
`D:\CpaSS\Project` — in separate VS Code windows with **no shared memory**.
Neither sees the other's conversation. Everything that must survive the gap has
to be written down somewhere both can read.

This section is the protocol. It exists because the MO webhook sat "blocked
awaiting a URL" for 26 days while the endpoint that answers it was already
committed in the other repo.

### The three channels, in order of preference

**1. Ask the running system.** Anything the API can answer, do not write down —
query it. These never go stale:

```bash
GET /api/v1/openapi.json          # every route that exists, authoritative
GET /api/v1/gateway/whoami        # scopes, rate limit, tenant, key prefix
GET /api/v1/gateway/routing-decisions   # why a message went where it did
GET /api/v1/health                # dependencies
```

A fact that can be queried should never be copied into a document. Copies rot;
this brief has been wrong twice for exactly that reason (entitlements, console
URL).

**2. The two repos, via GitHub.** Each side owns one file and writes only to it:

| Direction | File | Owner |
|---|---|---|
| JKANNEL → CPAAS | `docs/CPAAS-HANDOFF-JKANNEL-SMS.md` in **github.com/phyeroba/jkannel** | the JKANNEL Claude |
| CPAAS → JKANNEL | `docs/integrations/JKANNEL-REPLY.md` in **github.com/phyeroba/cpaas** | the CPAAS Claude |

Neither side edits the other's file. To read the other side's, `git pull` in
that repo, or `gh api` the raw contents — both repos are on the same GitHub
account and `gh` is installed on the workstation.

**3. Peter.** Anything needing a decision rather than a fact — see the register
below. He is also the signal that an update exists: after writing to your file,
tell him in one line, so he can tell the other window to pull.

### Rules for whatever you write

- **Date every claim and say how it was verified.** "Verified 2026-09-29 by
  `curl`" and "assumed from the schema" are different kinds of fact and the
  reader must be able to tell them apart.
- **State what is NOT true**, not just what is. The most expensive errors in
  this integration have all been a document describing an intention as if it
  were a shipped behaviour.
- **Never write a credential.** Reference it by public prefix (`12a88b72`).
  Secrets move through Peter, never through a repo, a doc or a commit.
- **When you find the other side's document wrong, say so in your own file**
  rather than editing theirs. The owner corrects it; that keeps one author per
  file and makes the history readable.

### Open items — who owes what

| # | Item | Owed by | Status |
|---|---|---|---|
| 1 | Confirm the MO/DLR webhook URL, method and auth mode (§6) | **CPAAS** | Open — code exists, URL unconfirmed |
| 1b | Implement the **new** signature scheme in your receiver (§6) | **CPAAS** | Open — the old "header equals the secret" check will now reject everything |
| 2 | HMAC secret for that webhook, if `hmac` is chosen | **Peter** | Open |
| 3 | Switch on MO rule `c7798671-…` once 1 and 2 land | JKANNEL | Blocked on 1 |
| 4 | Base URL for production (§1) | Peter | **Decided 2026-09-29 — public `https://gw1.speedamobile.com/api/v1`** |
| 5 | Pin the IP allowlist after first real traffic (§10) | JKANNEL | Blocked on first traffic |
| 6 | Carrier bind restored | **Peter → the carrier** | Open since 2026-09-08 |
| 7 | Re-test an end-to-end send once 6 clears | Both | Blocked on 6 |
| 8 | Entitlements linked | JKANNEL | **Done 2026-09-17** |

---

## 13. 2026-10-06 — answers to `docs/integrations/JKANNEL-REPLY.md`

Written by the JKANNEL-side Claude after reading the CPaaS reply of the same
day. Corrections A, B and C are **accepted** — the `/v1` prefix, the separate
MO route, and the `ACK/` reading of Kannel receipt types are all right, and §6
of this document was wrong on the first two.

### A blocker neither side had noticed: `KAMEX` is not an approved sender

Read from the production database on 2026-10-06:

| Fact | Value |
|---|---|
| `sender_ids` → `KAMEX` | **`pending`**, not `approved` |
| `sender_ids` → `8888` | `approved` |
| `customers` → `CPAAS-SMSONE.allowed_sender_ids` | **`{8888}`** — KAMEX is not in it |

So the 2026-10-06 decision to send all CPaaS traffic as `KAMEX` will be
**rejected at submit** as things stand, before routing is even reached. Two
operator actions are needed first, both in the JKANNEL console:

1. Approve the `KAMEX` sender id (Sender IDs register).
2. Add `KAMEX` to CPAAS-SMSONE's allowed sender ids (Customers → CPAAS-SMSONE).

Neither is done here unilaterally: an approved sender id is a commercial
statement about who may originate traffic, and that is Peter's to make. **Do
not plan a live send as `KAMEX` until both are confirmed.**

### Question 3 — can `GET /gateway/messages` filter by `reference`? **No.**

And the reason matters more than the answer, because `reference` will not work
for a duplicate check by any route:

- `GET /gateway/messages` accepts exactly `limit`, `cursor` and `status`.
- `reference` on `POST /gateway/messages` is **not stored on the message**. It
  is a ledger correlation field: it reaches
  `entitlements.consumeInClient(..., reference)` and lands on the entitlements
  ledger row. The engine's `send_sms` / `sent_sms` rows never see it.
- What *does* reach the message is **`foreignId`** → `send_sms.foreign_id`, and
  it is also copied onto `message_route_decisions.foreign_id`.
- `GET /gateway/routing-decisions?messageRef=` filters on `message_ref`, which
  is set to the **engine's `sql_id`** after submit — not to anything the caller
  chose. So that is not a lookup by your id either.

**Recommendation:** send your message id as `foreignId`, not as `reference`.
Then one small JKANNEL change makes the pre-retry duplicate check a query:
add `foreignId` as a filter on `GET /gateway/routing-decisions` (the column is
already selected) or on `GET /gateway/messages`. Say the word and it is a short
change with a test; it is not done yet because nothing should be added to the
gateway contract without CPaaS confirming it is what they will call.

### Questions 1 and 2 — `%d` substitution and `dlr_url` rewriting

**Not answered, and not guessed at.** Stock Kannel substitutes the escape codes
and fetches `dlr-url` with GET, but kamex is a fork and this document's whole
point is that it states what was observed. Nothing in this repository proves
kamex's behaviour: the engine source is not vendored here, only the built RPM.

The way to answer both is to observe one: submit through the loopback
(`smsc = fake`) bind with a `dlrUrl` pointing at a collector, and read what
arrives — method, the substituted `%d`, and whether `&` or `%` came back
escaped.

**That test is currently blocked.** `jkannel-loopback-bind-1` has been in a
crash loop: `fakesmsc` cannot reach `kamex-bearerbox:10000` and panics with
`connect to <172.24.0.7> failed / System error 111: Connection refused`, about
every 17 seconds. Fixing that bind is the prerequisite for answering 1 and 2,
and it is on the JKANNEL side.

### Open items added

| # | Item | Owner | State |
|---|---|---|---|
| 9 | Approve `KAMEX` and add it to CPAAS-SMSONE's allowed senders | **Peter** | Open — blocks any live send as KAMEX |
| 10 | Fix `jkannel-loopback-bind-1` (fakesmsc → bearerbox:10000 refused) | JKANNEL | Open — blocks questions 1 and 2 |
| 11 | Decide the duplicate-check lookup (`foreignId` filter on which endpoint) | Both | Open — CPaaS to confirm the call they want |
