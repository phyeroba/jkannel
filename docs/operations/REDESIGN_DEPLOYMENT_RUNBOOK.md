# Deployment runbook — redesign phases 6–7 and SMS Studio parity

**Audience:** whoever deploys and operates JKANNEL.
**Covers:** migrations 051–053, three new environment variables, two new
console screens, and the behaviour changes an operator will notice.

Everything here has been proved against a PostgreSQL built by applying the whole
migration chain in order, not against a hand-patched development database. The
proof scripts and their output are described per migration below.

---

## 1. What changed, in one table

| Change | Migration | Env | Operator-visible |
|---|---|---|---|
| Subscriber masking by default | — | — | Yes — every message screen |
| Time-limited audited reveal | 051 | — | Yes — a new permission |
| Services board | — | 2 optional | Yes — new screen |
| Nodes / resource pressure | — | — | Yes — new screen |
| Wildcard route matching | 052 | — | Yes — new route type |
| Route drop + overrides | 052 | — | Yes — new rule fields |
| Outbound duplicate control | 053 | — | **Yes — can refuse sends** |
| Spool reprioritize | — | — | Yes — new action |
| MO re-dispatch | — | — | Yes — new action |

---

## 2. Migrations

Apply in order: **051, 052, 053**. All three are idempotent — re-running an
`up` is a no-op — and all three have a tested `down`.

### 051 — `pii_reveal_grants`

Creates the reveal-grant table and seeds the `messages.reveal` permission,
granting it to Super Administrator, Administrator, Operations Engineer and
Support Engineer.

**Verified:** RLS enabled + forced with a `tenant_isolation` policy; a second
tenant sees zero rows while the row exists; the app role's `DELETE` is refused
at runtime (grants are evidence — revocation sets a timestamp, the row stays);
the active-grant lookup is index-backed; reason-length, expiry-window and
null-expiry constraints all fire; down leaves nothing behind.

> **Note on the `REVOKE`.** Migration 011 set `ALTER DEFAULT PRIVILEGES` to
> grant `SELECT, INSERT, UPDATE, DELETE` on every table created afterwards, so
> a bare three-privilege `GRANT` leaves `DELETE` in place. 051 revokes it
> explicitly. If you add tables that must not be deleted from, do the same.

### 052 — route actions and overrides

Adds `action`, `override_sender`, `override_recipient`, `override_text`,
`drop_reason` to `routing_rules`; `applied_overrides` and `dropped_by_rule` to
`message_route_decisions`; and extends the `route_type` CHECK constraint to
accept `wildcard`.

**Existing rules are unaffected** — `action` defaults to `route`, which is
current behaviour, and this is asserted by the proof.

> **The `down` deliberately refuses** while any rule has `route_type =
> 'wildcard'`. Narrowing the constraint back would leave those rules matching
> nothing and their traffic silently falling through to whatever rule is next.
> Convert them first:
>
> ```sql
> SELECT name, match_prefix FROM routing_rules
>  WHERE route_type = 'wildcard' AND deleted_at IS NULL;
> ```
>
> A failed revert leaves the schema intact — also asserted.

Before reverting, also check for rules that are *dropping* traffic. Losing
`action` turns them back into routing rules, which will start submitting traffic
they were built to refuse:

```sql
SELECT name, drop_reason FROM routing_rules
 WHERE action = 'drop' AND deleted_at IS NULL;
```

### 053 — outbound duplicate control

Creates `mt_dedupe_keys` (RLS, TTL cache, `DELETE` granted because the expiry
sweep runs as the app role) and adds `tenants.mt_dedupe_window_seconds`,
defaulting to **60**.

**This is the one change that can refuse a send.** Read §4 before deploying it
to a tenant with unusual traffic.

**Verified:** the window bounded at 0 and 3600; first claim wins and the second
is refused; the key is re-claimable the instant it lapses with no sweep having
run; the sweep takes only lapsed keys; cross-tenant reads blocked; and — the
case the whole feature exists for — **two concurrent retries, one holding its
transaction open, with exactly one winning.**

---

## 3. Environment variables

All three are **optional**. Absent means the corresponding component reports
`not observed` on the Services board — visibly distinct from healthy, never
mistaken for it.

| Variable | Example | Effect |
|---|---|---|
| `KAMEX_SENDSMS_URL` | `http://kamex-smsbox:13013` | Probes smsbox on the Services board |
| `PROMETHEUS_BASE_URL` | `http://prometheus:9090` | Probes the metrics collector |
| `SMSBOX_BASE_URL` | — | Accepted as an alias for `KAMEX_SENDSMS_URL` |

Both targets are already reachable from the backend container on the existing
Compose networks (`appnet` and `obsnet`) — no topology change is needed. Set
`PROMETHEUS_BASE_URL` only if you actually run the optional `monitoring` profile;
pointing it at nothing turns a blind spot into a false alarm.

---

## 4. The one behaviour change to plan for

**Duplicate control can refuse a send.** After 053, a client that submits the
same content to the same recipient twice inside 60 seconds gets an HTTP 409 on
the second.

For most tenants this is exactly right and needs no thought. Two cases need it:

**A tenant with legitimately repetitive traffic.** Set the window to 0:

```sql
UPDATE tenants SET mt_dedupe_window_seconds = 0 WHERE id = <tenant>;
```

**A client that will now start seeing 409s.** The correct client-side fix is to
send a distinct `foreignId` per message, which overrides content hashing
entirely. Tell integrators before you deploy, not after.

To roll the behaviour back without reverting the migration, set the window to 0
for every tenant. That is instant and needs no restart.

Everything else in this release is additive: masking changes what a screen
*shows* but not what it *does*, and the new route capabilities do nothing until
somebody creates a rule that uses them.

---

## 5. Deployment order

1. **Apply 051, 052, 053.** All are additive to existing behaviour except as
   noted in §4.
2. **Set the two probe variables** if you want smsbox and Prometheus watched.
3. **Deploy the backend.** The privacy, platform-health and dedupe services all
   fail *closed* on a missing dependency — masked, `not observed`, and
   suppression off respectively — so a backend running against a database that
   has not been migrated degrades safely rather than erroring.
4. **Deploy the frontend.**
5. **Verify** with §6.

Backend and frontend can be deployed independently. An old frontend against a
new backend simply does not render the `privacy` block — the data is still
masked, because the server masked it.

---

## 6. Post-deploy verification

```sh
# 1. Masking is on. Expect privacy.masked = true and no real numbers.
curl -s -H "authorization: Bearer $TOKEN" \
  "$BASE/api/v1/messages?limit=1" | jq '.data.privacy, .data.items[0].receiver'

# 2. The reveal permission exists and is granted.
psql -c "SELECT r.name FROM role_permissions rp
           JOIN roles r ON r.id=rp.role_id
           JOIN permissions p ON p.id=rp.permission_id
          WHERE p.code='messages.reveal';"

# 3. The services board answers, and says what it cannot see.
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/v1/services" \
  | jq '.data.summary, [.data.services[] | select(.observation=="unobserved") | .name]'

# 4. Nodes reports the container, and admits the inventory is partial.
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/v1/nodes" \
  | jq '.data.inventoryComplete, .data.items[0].pressure'

# 5. Existing routes are untouched by 052.
psql -c "SELECT action, count(*) FROM routing_rules GROUP BY action;"
#   expect every row 'route'

# 6. Duplicate control is armed.
psql -c "SELECT id, mt_dedupe_window_seconds FROM tenants;"
```

**Expected on a healthy stack**: `privacy.masked = true`; `messages.reveal`
granted to four roles; the services summary naming any unobserved components;
`inventoryComplete = false`; every route `action = 'route'`.

---

## 7. Rollback

| Symptom | Action |
|---|---|
| Clients hitting 409s | `UPDATE tenants SET mt_dedupe_window_seconds = 0;` — instant, no restart |
| A drop rule refusing too much | Disable the rule in the console |
| An override sending the wrong sender | Disable the rule; the decision rows keep the record |
| Something worse | Revert the backend image; the migrations are additive and safe to leave |

Reverting a migration is the **last** resort and 052's `down` will refuse if it
would silently change routing behaviour. Read the header comment of each `.down.sql`
before running it — each one states what it turns back on.

---

## 8. Operational notes

**`mt_dedupe_keys` grows and is swept.** Rows expire by timestamp and the sweep
deletes lapsed ones. Nothing schedules it yet, and nothing needs to: expired
keys are also deleted lazily whenever the same key is claimed again. If a tenant
has very high cardinality traffic, add a periodic
`DELETE FROM mt_dedupe_keys WHERE expires_at <= now();`.

**Reveal grants accumulate.** They are evidence and are never deleted by the
application. If you retire the feature, export
`SELECT user_id, reason, granted_at, expires_at, reveal_count FROM pii_reveal_grants WHERE reveal_count > 0`
before dropping the table.

**The services board makes eight probes per request.** They run concurrently
with 3-second timeouts, so a fully broken stack answers in about three seconds
rather than twenty-four. It is not polled by default — the screen fetches on
load and on demand.

**Nodes polls every 10 seconds** while open, because CPU is a rate and the
backend needs two samples before it can report one at all.

---

## Related

- [Guide 12 — Privacy and reveal](../user-guides/12-privacy-and-reveal.md)
- [Guide 13 — Services and Nodes](../user-guides/13-services-and-nodes.md)
- [Guide 14 — Wildcard routing and duplicate control](../user-guides/14-advanced-routing-and-duplicate-control.md)
- [docs/redesign/PLAN.md](../redesign/PLAN.md) — the phase plan and its progress log
