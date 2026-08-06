# Downstream report on the Kamex admin-panel PR review

**From:** the JKANNEL project — an external control plane for Kannel/Kamex
**Engine:** Kamex 1.8.3 (digest-pinned image, source verified from the matching `sqlbox.src.rpm`)
**Re:** the review of PR #2 (SMSC connection management in the admin panel)

---

## Why we are writing

We are not the author of that PR. JKANNEL is a separate project: a control plane that
manages Kamex from outside the engine — it generates configuration, deploys it, and
polls the admin port for status. We read the review because several findings describe
mechanisms we drive, and we wanted to check our own exposure.

Four of them applied to us. We have fixed those, and in doing so we measured some
engine behaviour that is not documented anywhere we could find and that we think is
useful upstream. That measurement is the substance of this report; the rest is
confirmation from an independent codebase.

Everything below distinguishes what we **measured** from what we **read in the source**.
Nothing here is inferred from documentation.

---

## 1. New evidence: a bad status password returns HTTP 200, not 401 or 403

**Measured** against a running 1.8.3 engine. A `/status.json` request with an incorrect
`status-password` is answered with:

```
HTTP 200
Denied
```

Not `401`, not `403`. The refusal is in the body, in prose.

This matters to anyone writing a client. A conventional HTTP client cannot tell an
authentication failure from a successful response by status code, and a JSON client
fails at the parse step with a message that looks like a malformed payload
(`Unexpected token 'D', "Denied" is not valid JSON`) rather than an auth problem. Our
own code had a synthetic `403` in its test fixtures — an assumption nobody had checked
against the engine.

It compounds finding 5 in the review: because the credential travels in the query
string, and the refusal is a 200, an unsuccessful authentication looks like an ordinary
successful request in most access logs.

**Suggestion:** return `401` with a `WWW-Authenticate` header, or at minimum a non-2xx
status. This would be a behavioural change, so a configuration flag may be the
pragmatic route.

---

## 2. New evidence: the auth-failure sleep is trippable by well-behaved clients

The review raises the brute-force delay as an unauthenticated lockout primitive. We
would add that it does not require an attacker. **A correct, polite, single client with
one wrong password does it accidentally.**

Our control plane reads the admin port from four places at different cadences —
a status poller, two console views that refresh while a tab is open, and a container
liveness probe. Combined, that is roughly twenty requests a minute in normal operation.
With a wrong `status-password` that becomes twenty failed authentications a minute
against `httpd_check_authorization`'s process-global `static double sleep`, which
increments by 1.0 per failure and never decays for the life of the process.

The consequences are worth spelling out because they are not obvious from the code:

- The degradation is **quiet**. Nothing logs "a client is failing authentication
  repeatedly". The first symptom is that the admin port becomes slow, then unusable.
- It points at the **wrong system**. The operator sees an unresponsive engine. The
  fault is a misconfigured client, and every diagnostic they run against the engine
  makes it worse.
- Once the sleep exceeds the client's request timeout, the client stops receiving
  responses at all, so it can no longer see the `Denied` body that would have explained
  the problem. The diagnosis becomes unavailable exactly when it is needed.
- It takes `/health`, `/status`, `/shutdown` and `/graceful-restart` with it, because
  they share the one admin thread. For us that means monitoring *and* the
  configuration-deploy path fail together.

**What we did**, in case it is useful as a client-side pattern: we put a circuit breaker
in front of every authenticated call. Three consecutive failures start an exponential
suppression window (5s to 5min). Measured under a deliberately wrong password against a
live engine: **twelve client calls produced three actual requests.** The other nine
never left the process.

We also found a way to classify the failure without a status code. `/health` requires no
password while `/status.json` does, so "`/health` answers and the authenticated call does
not" is a reliable differential for a credential fault. That let us replace a misleading
"engine unreachable" alert with one that names the wrong environment variable.

**Suggestions upstream, in the order we would value them:**

1. Decay the counter over time, or reset it on a successful authentication.
2. Scope it per source address rather than per process. One bad client should not be
   able to deny the admin plane to every other client.
3. Cap it. An unbounded accumulator with no upper limit is what turns a misconfiguration
   into an outage that survives until a restart.
4. Log a warning after N consecutive failures, naming the source address. This alone
   would have turned our incident into a five-minute fix.

---

## 3. New evidence: sqlbox does not reconnect after bearerbox restarts

This is the one we would most like to see addressed, because it is a silent
availability failure and we hit it for real.

We restarted bearerbox. sqlbox logged, in order:

```
ERROR: Connection closed by the bearerbox.
ERROR: Error while gw_gethostbyname occurs.
ERROR: gethostbyname failed
ERROR: error connecting to server `<bearerbox>' at port `13001'
```

— and then stopped. It did not retry. It stayed up, its own process healthy, permanently
disconnected from bearerbox.

The failure mode is bad in three ways:

- **Nothing sends.** Rows accumulate in `send_sms` and are never polled through.
- **Nothing reports it.** Both processes are individually alive. Container-level health
  checks stay green because each box is healthy in isolation; only the link between
  them is dead.
- **`sent_sms` stops being written**, so message history stops silently too. Anything
  built on that table — for us, inbound message ingest — stops with it, for the same
  invisible reason.

Recovery required restarting sqlbox by hand. The trigger appears to be that sqlbox
attempts its reconnect during the window when the peer is down and its name does not
yet resolve, and treats that as terminal rather than retryable.

**Suggestion:** a bounded retry loop around the boxc connection, the way the SMSC
drivers already reconnect. A `gethostbyname` failure in particular should be treated as
transient — in any container or DNS-based deployment it very often is.

---

## 4. Confirmed: a gateway with no `sms-service` group replies to every inbound message

We verified the chain in the source and then observed the behaviour:

- `gw/urltrans.c:236` — zero `sms-service` groups is accepted, no warning at startup.
- `gw/smsbox.c:1846` — `urltrans_find()` returns NULL, logs `No translation found`.
- `gw/smsbox.c:1909` — the reply becomes `reply_requestfailed`, default `"Request Failed"`.
- `gw/smsbox.c:318-321` — `trans == NULL` sets `max_msgs = 1`, so **the reply is sent**.

The result is a real, billable MT delivered to every subscriber who texts the gateway,
from a configuration that produces no warning and looks complete. We had this in
production without knowing.

`max-messages = 0` is the fix (`gw/smsbox.c:322`, `"No reply sent, denied."`), and we
have adopted it. We verified the corrected configuration parses by running it through
the real pinned binary before shipping it.

**Suggestion:** consider warning at startup when no `sms-service` group is configured.
The current default — answer every inbound message with a fixed string, at the
operator's expense — is a surprising thing to get by omission.

---

## 5. Confirmed: the `include` substring panic, from a config-generator's perspective

The review's finding 1 is, from where we sit, the most dangerous item in the list,
because we **generate** configuration from operator input. Any value containing the
substring — a hostname like `includes.vendor.net`, an smsc-id, a `system-type` — is
enough, and the panic recurs on every subsequent start because the file is already on
disk.

We now reject the substring, plus line breaks, quotes, backslashes and leading `#`, at
the point the operator saves the record, with a message naming the field. Before that
the only signal was a failed deployment carrying a panic backtrace and no indication of
which field caused it.

We mention it because it is a general hazard for **any** tool that writes Kamex
configuration, not only ours. We endorse the review's recommendation to parse the
directive key rather than substring-search the raw line.

---

## 6. Smaller confirmations and corrections

**Escape codes.** We checked these against `gw/urltrans.c` because we were about to rely
on them, and two pieces of widely-repeated documentation are wrong:

| Code | Actual behaviour |
|---|---|
| `%q` / `%Q` | `%p` / `%P` with a leading `00` rewritten to `%2B`. Not "the same without a `+`". |
| `%a` | Splits the body on whitespace and rejoins with `+`. **Lossy for a message body** — runs of spaces and leading/trailing spaces do not survive. `%b` is the correct code for a body. |
| `%t` | `YYYY-MM-DD+HH:MM:SS` in GMT with no zone marker, so a client parsing it in a local timezone silently misreads it. `%T` (unix seconds) is unambiguous. |

**sqlbox PostgreSQL driver drops `priority`.** `sqlbox_pgsql.h`'s SELECT omits the
column while `sqlbox_mysql.c` includes it, so SMPP `priority_flag` cannot be set through
the PostgreSQL path at all. We patch the driver in our image build to bring it to parity
and have verified end to end that priority then round-trips through bearerbox intact
(3 → 3, NULL → NULL, 0 → 0, with `foreign_id` undisturbed). Upstream parity would let us
drop the patch.

**The same driver's `CREATE TABLE` has no `IF NOT EXISTS`.** Unlike the MySQL sibling, it
fails on every start against an existing database, logging
`relation "send_sms" already exists` each time. Harmless but noisy, and it means the
`CREATE` only ever helps a fresh database — which matters if a column is ever added to
those tables, since existing deployments will not pick it up.

**Credentials in query strings — logged at ordinary verbosity, not only at debug.**
Confirmed from our side, and we cannot avoid emitting them: `/graceful-restart` and
`/status.json` accept the password only as a query parameter.

We had assumed this was contained, on the grounds that we run `log-level = 1` rather
than debug and bind the admin port to loopback. **We measured it, and the assumption was
wrong.** A live engine at `log-level = 1` carried **945 occurrences of `password=`** in
24 hours of captured process output.

Loopback binding protects the *port*. It does nothing for the *logs*, which in any
container deployment are captured by the runtime and routinely shipped to an aggregator
that is not loopback-scoped. So the real exposure is not "an operator who turned debug
on": a default deployment writes its admin and status passwords into its log stream
continuously, in cleartext. Anyone who can read logs — a shipper, an on-call engineer, a
support bundle, a filesystem backup — has the credentials.

A `POST` body or header alternative for these endpoints would let downstream tools stop
emitting them. Failing that, redacting a query parameter named `password` before the
request line is written would fix it for every existing client at once, without any
client change, and looks inexpensive.

---

## 7. On the PR itself

We have no standing in the review, but for whatever a downstream integrator's opinion is
worth: the recommendation to split it is the right call, and the build fix in particular
should not be held hostage to the rest.

We would also gently observe that runtime SMSC management, a message archive, a report
API and an operator web panel are a control plane, and that putting one inside the
process that carries live traffic is what produces most of the findings in the review —
a text field that halts the gateway, a database outage that wedges the SMS hot path, a
reload that races a signal handler. Keeping that surface outside the engine is the whole
premise of our project, and the review reads to us as a fairly strong argument for the
boundary.

---

## 8. Disposition of every finding, from our side

Set out in full — including what we already had — because "we were not exposed to that
one" is only credible if we say *why*, and because several of our pre-existing defences
are the same shapes the review recommends to the PR. Where we are still exposed, we say
so rather than leaving it off the list.

### 8a. Already in place before the review — no change needed

| Finding | What we already had |
|---|---|
| Validate before touching any file in the include path (the review's recommended shape) | Every generated configuration is POSTed to an isolated container running the real digest-pinned `bearerbox --test` and is refused unless it parses. Nothing is written to disk first. This is the "parse a candidate into a throwaway Cfg" pattern, done out of process. |
| SMSC credentials written world-readable (`0666 & ~umask`) | Configuration is written `0600` via temp file plus atomic rename. |
| `smsc-password` readable through the config-read endpoint | Credentials never appear as literals in our generated configuration at all — only as `${ENV}` placeholders the engine resolves at parse time. There is no read path that could return one. |
| `/messages.json` open when `status-password` is unset | We always set `status-password`, so the `ha_status_pw == NULL ⇒ allow` branch is unreachable in our deployments. |
| Stored XSS via `smsc-id` into `innerHTML` | Our console is Vue with template interpolation, which escapes by default. The single `v-html` in the codebase renders a static internal icon, never operator data. |
| Hand-built SQL escaping only `'` | All our queries are parameterised (`$1` placeholders); we build no SQL by concatenation. |
| No retention policy or size cap on the message archive | Message history is sqlbox's `sent_sms`, with our own retention policies and scheduled pruning. |
| `(ts DESC)` and `(type)` as separate indexes | We had already hit and fixed the equivalent — composite indexes matching the actual query shape, applied at boot. |
| `instances` read with no upper bound, and `smscconn_create` failure panics | Our parallel-connection count is bounded 1–64 in three places: API validation, the generator's own validation, and a database `CHECK` constraint. It also refuses values above 1 for non-SMPP link types, since the fake and http adapters bind a listening socket and a second instance would collide. |
| Credentials reachable over the admin port from anywhere | Every engine port is bound to loopback only; nothing is published on a routable interface. |
| Delete/change without an audit trail | All mutations are RBAC-gated, tenant-isolated and audited. |

### 8b. Added because of the review

| Finding | What we added |
|---|---|
| Unauthenticated admin-port lockout via the brute-force delay | A shared circuit breaker in front of every authenticated call: three consecutive failures start an exponential suppression window (5s–5min). Measured: twelve client calls became three requests. Plus `/health`-differential classification, so a credential fault is reported as one instead of as "engine unreachable". |
| The same, from our container liveness probe | Liveness moved to the unauthenticated `/health`, accepting `200` or `503`. This removed a standing six-authentications-per-minute load. `503` means "running, no bind" — a carrier problem, not grounds to restart the container and drop the remaining binds. |
| Any value containing `include` panics the parser | Rejected at input — along with line breaks, quotes, backslashes and a leading `#` — with the offending field named. Enforced both at write time and again at generation, because our generate endpoint can accept a whole model from the caller and would otherwise bypass the write path. |
| (No prior finding — our own gap, surfaced while reading the review) | The generator's quoted emitter escaped `"` but not `\`, so a value ending in a backslash escaped its own closing quote. Fixed, though the input rejection above now means nothing should reach it. |
| No `fsync` before rename | `fsync` on the file before rename and on the directory after. Ordering is pinned by a test, since an `fsync` placed after the rename would look correct and do nothing. |
| Pre-existing bad data | Input validation does nothing about rows saved before it existed, so we added a read-only endpoint that reports stored values which would now be rejected — rather than letting them surface as a failed deployment at the worst moment. |
| A gateway with no `sms-service` group replies to every inbound message | `max-messages = 0` on the default inbound service. |

### 8c. Applies to us, deliberately NOT fixed — and why

| Finding | Why not |
|---|---|
| Credentials travel in query strings | We cannot fix this from outside. `/graceful-restart` accepts the admin password only as a query parameter, so our deployments necessarily put it in a URL that `gwlib/http.c` logs in full at debug level. Contained by loopback-only binding. **A `POST` body or header alternative upstream would let us stop.** |
| Editing an SMSC bounces the connection and can duplicate in-flight messages | Real for us: our deploy path issues `graceful-restart`, so a configuration change carries this risk. The fix the review proposes — construct the candidate `SMSCConn` before touching the live one — has to happen inside bearerbox. Our validator proves the config *parses*, which is not the same as proving the connection will come up. **Accepted, documented risk.** |
| Save/delete overlapping `SIGHUP`; no reload mutex | Partially avoided rather than fixed: our target is a single file, not a directory in the include path, so the temp-file-parsed-mid-write variant does not reach us. A logrotate `SIGHUP` racing our deploy remains possible, and the interlock has to be inside bearerbox. |
| The admin thread serves requests inline, and `/health` rides on it | Engine-side thread model. We have cut our own contribution to the load substantially, but a slow admin request still blocks our liveness probe and we cannot change that from here. |
| sqlbox does not reconnect after bearerbox restarts (section 3) | Engine-side. We can and will add detection — a spool that stops draining while both processes report healthy is observable from our side — but the reconnect itself belongs in sqlbox. |
| `host` plus `smsc-username`/`smsc-password` is a credential-exfiltration primitive | Applies to us in principle: an operator with `configuration.manage` can point a bind at a listener they control. We treat this as an authorisation question rather than a validation one — it is a privileged role, the action is audited, and the alternative (blocking hostname changes) would break legitimate carrier migrations. Flagging it as a deliberate acceptance rather than an oversight. |

### 8d. Not applicable to us

Included for completeness, since "not applicable" should be checkable rather than
asserted. These findings concern code the PR adds to the engine, or engine internals we
do not touch:

- **PostgreSQL message archival wedging the SMS hot path** (`bb_alog.c`,
  `dbpool_conn_consume` on the delivery path). We have no equivalent: message history is
  sqlbox's, and our own writes run on a job queue off the send path.
- **Stored XSS in `contrib/admin-panel.html`**, the `onclick` escaping, the missing fetch
  timeout, `s.status.includes` throwing, and delete-failure string-sniffing — we do not
  ship that panel.
- **`/messages.json`, `httpd_send_sms`, `get-smsc-config`** — endpoints the PR introduces.
- **The admin password forwarded to a box-chosen host** (`boxc_sendsms_url`) — we do not
  use that path.
- **`bb_graceful_restart` leaking the parsed `Cfg`**, the destroy-retry loop,
  `smsc2_smsc_exists` matching too broadly, deleting an SMSC discarding its backlog,
  `boxc_sendsms_url` scheme inference — engine internals.
- **Report rows not reflecting what happened**, and `octstr_convert_printable` reducing
  UTF-8 bodies to dots — that archive is the PR's.
- **`smsc-config-dir` undocumented, `admin_panel.h` as a committed build artifact,
  `smsc_config_dir` never freed** — PR and repository hygiene.

One caveat on this list: several of these are "not applicable *today*". If we ever adopt
`smsc-config-dir`, the temp-file-in-a-scanned-directory and `*.conf` filtering findings
become ours immediately, which is why we have noted the constraint in our own code
rather than only here.

---

## Offer

If any of the measurements above would be more useful as a reproduction case, we are
happy to write one up — particularly the sqlbox reconnect failure, which we can
reproduce reliably, and the HTTP 200 `Denied` response, which is a two-line curl.

Thank you for the review. It was specific enough to be actionable in a codebase it was
not written about, which is not a common property of code reviews, and it found a live
billing defect in our deployment that we would not have gone looking for.
