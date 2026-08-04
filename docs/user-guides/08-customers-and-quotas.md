# 8. Customers, quotas, credit and sender IDs

A **customer** is an organisation or account that consumes messaging on your platform.
Customers exist so you can control what each account may send, how much, from which
sender IDs, and over which routes.

**These controls are real.** They are enforced on the send path, atomically, inside the
same database transaction as the engine submit. Exceed a quota, run out of credit, or
use an unapproved sender ID and the send is refused — nothing is sent and nothing is
charged.

---

## The console screen, and what it does not cover

Go to **Customers** (Insights group).

The screen handles the customer record: create, view, edit, archive. The **quota**,
**credit** and **sender ID** *workflows* live behind a separate API
(`/customer-accounts/{id}/…`) that has **no console UI yet**. Both are covered below.

### Create a customer

1. Click **Add customer**.
2. Fill in:

   | Field | Notes |
   |---|---|
   | **Name** | The organisation. |
   | **Code** | A short unique identifier used in routing and billing. |
   | **Contact email** | |
   | **Daily quota** | Maximum messages per day. |
   | **Rate limit / min** | Per-minute submission ceiling. |
   | **Allowed sender IDs (comma-separated)** | e.g. `JKANNEL, INFO`. |
   | **Notes** | |
   | **Status** | `active` · `suspended` · `archived` |

3. Click **Create customer**.

Grid columns: **Customer**, **Code**, **Contact**, **Daily quota**, **Rate/min**,
**Status**. Click a row for **Customer detail**, with **Edit** and **Archive** actions.
Archiving asks *"Archive customer {name}? This suspends their traffic."*

**`Rate limit / min` is now enforced** on the send path, before blocklist and routing,
returning **429** with `limit`, `windowSeconds` and `retryAfterSeconds`. Leave it blank
or at zero for unlimited. Four things to understand about it:

- **It only applies when the send carries a customer.** No `customer_id` on the API key,
  no limit.
- **It fails open.** If Redis is unreachable the send is allowed and flagged degraded
  rather than blocked.
- **It counts attempts, not successes.** A send later refused by the blocklist, quota or
  credit has still burned a slot.
- **The window is a fixed 60 seconds, not sliding.** A caller can push roughly twice the
  limit across a window boundary.

For a hard ceiling on a machine client, the **API gateway's per-key rate limit** is the
stronger control — it is atomic in Redis and independent of customer identity. See
[guide 3](03-sending-messages.md#what-the-gateway-enforces-on-every-request).

---

## Quotas

A quota is a cap plus a rolling counter that resets when the period elapses. Periods are
`daily` and `monthly`.

```bash
# See the customer's quotas and current usage
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/customer-accounts/<customer-uuid>/quota

# Set or update a cap (upsert; existing usage is preserved)
curl -X PUT https://your-console/api/v1/customer-accounts/<customer-uuid>/quota \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"period":"daily","limit":50000}'

# Remove a cap
curl -X DELETE https://your-console/api/v1/customer-accounts/<customer-uuid>/quota/daily \
  -H "Authorization: Bearer <token>"
```

Reads need `system.view`; writes need `system.manage`.

**How it is enforced.** The send path consumes quota inside the send transaction, with
the quota row correctly locked. Concurrent sends cannot race past the cap, and a send
that is refused for any later reason does not leave quota consumed.

---

## Prepaid credit

Each customer has a balance and an **append-only ledger**. The ledger is never edited;
you post a new transaction to change the balance.

```bash
# Current balance
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/customer-accounts/<customer-uuid>/credit

# The ledger
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/customer-accounts/<customer-uuid>/credit/transactions

# Top up
curl -X POST https://your-console/api/v1/customer-accounts/<customer-uuid>/credit/transactions \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"direction":"credit","amount":250000,"reason":"October prepayment","reference":"INV-4471"}'
```

`direction` is `credit` or `debit`; `amount` must be positive. Sends debit the balance
in the same transaction as the submit, so a send that fails leaves no phantom debit.

> **Pricing is flat.** There is no per-customer tariff, no destination-based rating, and
> **a multi-part message counts as one**. If you need real rating you will have to build
> it — there is no billing or invoicing module, by design (it is Future Scope in the
> product scope document).

---

## Sender IDs

Two places control sender IDs, and they are different things:

- **Allowed sender IDs** on the customer record — a simple comma-separated list.
- **The sender-ID approval workflow** at `/customer-accounts/{id}/sender-ids` — request,
  review, approve or reject, with status tracking. **This is what the send path
  enforces.**

```bash
# List (optionally filter by status: pending | approved | rejected)
curl -H "Authorization: Bearer <token>" \
  "https://your-console/api/v1/customer-accounts/<customer-uuid>/sender-ids?status=pending"

# Register a request
curl -X POST https://your-console/api/v1/customer-accounts/<customer-uuid>/sender-ids \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"senderId":"ACMEBANK"}'

# Approve or reject it
curl -X PATCH https://your-console/api/v1/customer-accounts/<customer-uuid>/sender-ids/<sender-id-uuid> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"status":"approved","reason":"Brand ownership verified"}'
```

A send using a sender ID that is not `approved` for that customer is **refused**.

---

## Per-customer route bindings

Restrict a customer to specific routes or SMSCs. When bindings exist, route selection
only considers the bound candidates for that customer.

```bash
# List bindings
curl -H "Authorization: Bearer <token>" \
  https://your-console/api/v1/customer-accounts/<customer-uuid>/routes

# Bind to a route (or an SMSC), with an optional priority
curl -X POST https://your-console/api/v1/customer-accounts/<customer-uuid>/routes \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"routeId":"<route-uuid>","priority":10}'

# Enable/disable or reprioritise
curl -X PATCH https://your-console/api/v1/customer-accounts/<customer-uuid>/routes/<binding-uuid> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"enabled":false}'

# Remove
curl -X DELETE https://your-console/api/v1/customer-accounts/<customer-uuid>/routes/<binding-uuid> \
  -H "Authorization: Bearer <token>"
```

---

## Tying a customer to traffic

Entitlements are only enforced when JKANNEL knows **whose** message it is. That comes
from one place: **`api_keys.customer_id`**. The customer is taken from the API key, never
from the request body, so a client cannot submit as somebody else.

Set it when you issue the key (see
[guide 3](03-sending-messages.md#step-1--get-a-real-api-key)). A key with no customer
submits as the tenant and consumes no entitlements.

Bulk send jobs carry a `customer_id` too, so a campaign consumes the right account's
quota and credit.

Two paths deliberately **do not** consume entitlements:

- **Operator resend from the Live Queue.** See
  [guide 4](04-live-queue-and-recovery.md#operator-resend-bypasses-routing-and-entitlements--by-design).
- **SMS notification channels**, which send alerts rather than customer traffic.

---

## Checking that enforcement actually fired

1. Set a small daily quota — say 5.
2. Send 6 messages with that customer's API key.
3. The sixth is refused; the response says why.
4. `GET /customer-accounts/{id}/quota` shows `used_count` at 5, not 6.
5. `GET /customer-accounts/{id}/credit/transactions` shows exactly 5 debits.

If the sixth message went out, the key has no `customer_id` set.

---

## Not available

- **No customer portal.** Customers have no self-service login.
- **No invoicing or billing.**
- **No per-customer tariff or destination rating.** Segment counts are now recorded on
  messages, but **billing still counts a multi-part message as one**.
- **No console UI** for quota, credit, sender-ID approval or route bindings. The API is
  the way, and it is fully documented at `/api/v1/openapi.json`.

---

Next: [Backup and restore →](09-backup-and-restore.md)
