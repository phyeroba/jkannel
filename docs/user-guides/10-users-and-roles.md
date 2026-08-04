# 10. Users, roles and permissions

How to give people access to the console — and an honest account of what you cannot do
yet, because this is the area with the largest gap between what the specification asks
for and what is built.

---

## Read this first: role administration now exists

Role and permission administration works, and eight standard roles are seeded. You can
create, rename, edit and delete roles from **Roles & Permissions**, or over the API.

This is recent — earlier documentation, and `FEATURES.md`, still describe the Roles
screen as read-only. That is out of date.

### The eight seeded roles

Seeded per tenant by migration `036_rbac`:

`Super Administrator` · `Administrator` · `Network Engineer` · `Operations Engineer` ·
`Support Engineer` · `Read Only` · `Auditor` · `API Client`

A live tenant usually shows **nine**, because the pre-existing lowercase
`administrator` role created by the development provisioning script is kept and marked
as a system role.

The permission catalogue is seeded too — 21 codes, each with a human description and one
of eight categories. API-key scopes (`sms.send`, `sms.read`, `routing.read`,
`audit.read`) are deliberately **excluded** from it: a human role cannot be granted a
machine scope.

> **Roles are seeded at migration time for tenants that existed then.** A tenant created
> later gets no default roles. Create them explicitly.

### Administering roles

From **Roles & Permissions**, use the create and edit controls to add a role, change its
description, and tick the permissions it grants. Assigning a role to a *person* is a
separate thing and is done from **Users & Roles → user → Edit → Roles**.

The same operations over the API — useful for scripting or bulk setup. All routes need
`users.manage` except the reads, which need `users.view`.

```bash
# List roles, and the permission catalogue with descriptions and categories
curl -H "Authorization: Bearer <token>" https://your-console/api/v1/users/roles
curl -H "Authorization: Bearer <token>" https://your-console/api/v1/users/permissions

# Create a role
curl -X POST https://your-console/api/v1/users/roles \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"NOC Watch","description":"Read-only incident watch",
       "permissions":["dashboard.view","messages.view","alerts.view","monitoring.view"]}'

# Change a role. NOTE: `permissions` REPLACES the whole grant set, it does not merge.
curl -X PATCH https://your-console/api/v1/users/roles/<role-uuid> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"permissions":["dashboard.view","messages.view","alerts.view","alerts.acknowledge"]}'

# Delete
curl -X DELETE https://your-console/api/v1/users/roles/<role-uuid> \
  -H "Authorization: Bearer <token>"
```

There is no separate "assign permissions" endpoint — `PATCH` with a full
`permissions` array is how you set grants.

### Five guard rails that will surprise you

1. **Editing a role's permissions logs out everyone who holds it.** Every live session
   of every holder is revoked immediately. Do it in a maintenance window.
2. **A change that would leave nobody holding `users.manage` is refused** with a 409.
   You cannot lock yourself out of user administration.
3. **A role assigned to at least one user cannot be deleted** — 409, telling you to
   reassign first.
4. **System roles cannot be renamed or deleted** — 409. Their description and permission
   set *are* still editable.
5. Permission changes take effect on the holder's **next sign-in**, since permissions
   are resolved when the token is issued.

### Machine access is a separate, enforced story

API-key scopes (`sms.send`, `sms.read`, `routing.read`, `audit.read`) are a distinct
vocabulary from console permissions, on purpose, so a machine key cannot inherit an
operator's console rights. If your problem is "this integration should only be able to
send", the answer is an API key with one scope, not a role. See
[guide 3](03-sending-messages.md#step-2--know-the-scopes).

---

## Creating a user

1. Go to **Users & Roles** (Platform group).
2. Click **Create user** (needs `users.manage`).
3. Fill in:

   | Field | Notes |
   |---|---|
   | **Username** | This is the login identity. There is no email field on the user record. |
   | **Password (min 12 characters)** | The form states *"Password must be at least 12 characters."* |
   | **Roles** | A checkbox per available role, with its name and description. |

4. Click **Create user**.

Grid columns: **User**, **Status**, **Roles**, **Created**, **Updated**. Filter by
**Status** (`pending`, `active`, `disabled`, `locked`, `expired`, `archived`,
`deleted`). Export CSV/PDF as with any grid.

## Inviting a user

1. Click **Invite user**.
2. The composer opens with one field, labelled **Email**.
3. Enter the address and click **Create**.

The invitee follows the link to the public **Accept invitation** page and sets their own
password, which provisions an active user.

> The invitation is addressed by email, but the **account** it creates is identified by
> username. The email is the delivery address for the invitation, not a login. This is
> also why the login screen's *"Email or Username"* label is misleading — see
> [guide 1](01-getting-started.md#sign-in).

## Editing, disabling and archiving

Click a user row for **User detail**: **Username**, **Status**, **Roles**,
**Permissions** (the effective set), **Created**.

- **Edit** lets you change **Status** (`active` / `disabled` / `locked` / `archived`),
  tick or untick **Roles**, and set **Reset password (optional, min 12)**.
- **Archive** asks *"Archive user {username}? This revokes their access."*

**Privilege changes take effect immediately.** Roles and permissions are re-resolved on
every token refresh, so disabling a user or removing a role does not wait for their
access token to expire — and it revokes their refresh-token family.

---

## Roles & Permissions

Go to **Roles & Permissions**. Alongside the create and edit controls, three panels:

| Panel | Shows |
|---|---|
| **Roles** | **Role**, **Description**, **Permissions** (a chip per code), **Users**, **Members**. |
| **Permission matrix** | Every permission code any role grants, against the roles that grant it, grouped by prefix. Filter with the search box. Cells read `granted` or `—`. |
| **Your effective access** | The roles and permission codes this session actually holds, as the API resolved them at sign-in. |

The footer note on the last panel is worth internalising: *"Permissions are resolved when
the access token is issued. A role change made now becomes effective on your next sign-in."*

If the matrix warns that some permissions you hold are granted by no role in the list,
they were granted outside the role catalogue or the catalogue is incomplete.

### The permission codes

| Code | Grants |
|---|---|
| `dashboard.view` | The Operations dashboard |
| `messages.view` | Messages, Queues, Delivery Reports, Live Queue, Bulk Send |
| `messages.export` | Message CSV/PDF export |
| `messages.send` | Send, bulk send, and Live Queue resend / reroute / cancel |
| `smsc.view` / `smsc.manage` | View / create, edit, enable, disable, reconnect SMSCs and control binds |
| `routes.view` / `routes.manage` | View / create and edit routes |
| `configuration.view` / `configuration.manage` / `configuration.deploy` | View / edit / deploy engine configuration |
| `monitoring.view` | Monitoring, Logs & Audit, AI Copilot |
| `alerts.view` / `alerts.acknowledge` | See alerts / acknowledge and re-notify |
| `reports.view` | Analytics & Reports |
| `users.view` / `users.manage` / `users.invite` / `users.sessions` | User administration and session administration |
| `system.view` / `system.manage` | Customers, API Gateway, Runtime Containers, Plugins, Backup, System Settings / mutate them |

Navigation items you lack the permission for are not rendered. Opening the route
directly gives **Access restricted** — *"Your current role does not permit this
workspace."*

---

## Sessions

Go to **Sessions** (needs `users.sessions`). Search, sort, filter, export, and **revoke**
an active session. Revoking a session is the fastest way to cut off a compromised
account while you decide what else to do.

---

## Sign-in security — what is enforced

These are real and tested:

- **A configurable security policy, per tenant, actually enforced.** Set these on
  **System Settings**; they are read at sign-in and refresh, with a 30-second cache:
  password minimum length and four complexity rules, password history depth, lockout
  threshold and duration, access-token lifetime, session idle timeout, session absolute
  maximum lifetime, and a concurrent-session cap.
- **Account lockout** after repeated failures — and a locked-out user **can** recover
  once the window expires. (An earlier version locked accounts permanently; that is
  fixed.)
- **Brute-force throttling** on login, MFA and password reset. It counts **failures
  only**, so legitimate traffic is never throttled. If Redis is unavailable the throttle
  fails open by design.
- **TOTP MFA with recovery codes**, enforced at login for users who have enrolled. A
  wrong TOTP code increments the lockout counter.
- **Refresh-token rotation with family and replay revocation.** A replayed refresh token
  kills the whole family.
- **Password reset with reuse prevention.**
- **Trustworthy client-IP derivation behind proxies** — a spoofed `X-Forwarded-For`
  cannot defeat an IP allowlist.
- **RBAC on every endpoint**, plus **PostgreSQL row-level security forced on every
  tenant table**, so tenant isolation is enforced in the database rather than by
  application code. The API connects as a non-owner role.
- **A tamper-evident audit log** — append-only, with a database-enforced hash chain and
  a verification endpoint.

### Policy settings are clamped toward strictness

Every knob is bounded, and a value outside the bound is silently corrected **upwards**,
never down. If you set something lax and it does not take effect, this is why:

| Setting | Bound | Note |
|---|---|---|
| Password minimum length | floor of **12** | Setting 8 silently yields 12. |
| Access-token lifetime | 300–3600 s | |
| Lockout threshold | 3–20 attempts | |
| Lockout duration | 1–1440 min | |
| Session idle timeout | 5–10080 min | `0` disables it. |
| Session absolute lifetime | 1–8760 h | `0` disables it. |
| Max concurrent sessions | 1–100 | `0` = unlimited, **and 0 is the shipped default**, so the cap is off until you set it. |

Two behaviours worth knowing: changes take up to 30 seconds to apply, and the idle and
absolute-lifetime checks fire **at token refresh**, not proactively — an idle session is
not killed until somebody tries to use it.

## What is not enforced

State these plainly to anyone doing a security review:

| Item | Reality |
|---|---|
| **Password hashing** | **scrypt**, not Argon2id. Documented, not fixed. |
| **Password expiry / ageing** | **No such setting exists.** Do not plan around it. |
| **Tenant-wide MFA forcing** | The `require_mfa` setting is **advisory only** and is marked non-editable. Enrollment is enforced at login for users who have enrolled; you cannot mandate it per role or per tenant. |
| **Permission catalogue editing** | You choose which permissions a role grants, from a fixed 21-code catalogue. You cannot invent new permission codes — those are defined in the application. |
| **HTTPS by default** | The bundled reverse proxy is HTTP-only in the default topology; an opt-in `tls` profile exists. The live deployment terminates TLS on an upstream system nginx. |
| **Notification-channel secrets** | Stored and returned as plaintext to anyone with `alerts.view`. |
| **OAuth2 / OIDC / WebAuthn / passkeys** | Absent. |
| **Service accounts and personal access tokens** | Absent. Use API keys. |
| **Intrusion detection** | Absent. |
| **Login history detail** | Present, but 5 of 11 specified fields (country, browser, OS, device, failure reason) are not captured. |

No independent penetration test has been performed. That is recorded as an outstanding
external evidence gate, not as passed.

---

## A practical access model

1. **Humans** get a console account and one of the eight seeded roles — assign it from
   **Users & Roles → user → Edit → Roles**. Reserve `Super Administrator` for the few
   people who need `system.manage`. Enable MFA on every account.
2. **Custom roles** where the eight seeded ones do not fit. Remember that changing a
   role's permissions logs out everyone holding it — do it in a maintenance window.
3. **Machines** get an API key with the minimum scopes, an IP allowlist, an expiry date,
   and a `customer_id` so entitlements apply. This is least privilege and it is
   enforced.
4. **Revoke fast.** Archive the user, revoke their sessions, and disable their API keys.
   All three take effect immediately.

---

Next: [Troubleshooting and FAQ →](11-troubleshooting.md)
