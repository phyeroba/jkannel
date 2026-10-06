# Changelog

## 2026-10-06d (the screens nothing links to from the navigation)

The sweep now walks in **two phases** and clicks **every** opener, not one.
`scripts/screen-sweep.mjs` v1 took a single button per page, which left three
classes of screen unseen: every dialog after the first, every drawer that
opens from a row click rather than a button, and **every page reached only by
a link** — the carrier, SMSC and message detail screens, none of which is in
`navigation.ts` and none of which any audit had ever visited.

99 captures. What the unvisited screens turned out to be:

| Screen | Found |
|---|---|
| `/smsc/kololo` | **7,043px tall, 917px of overflow** — the worst in the console |
| `/carriers/:id` | 4,255px, 271px overflow |
| `/smsc/local-fake`, `/smsc/local-fake-b` | 142px overflow each |
| `/smsc` → **Edit** | the dialog is **1,156px taller than the window** — Save sat below 38 fields, more than a screen past the bottom edge |

**The root cause of most of it is one rule.** `tbody td` is `white-space:
nowrap` — deliberately, so a long value cannot build a tower — and a cell that
genuinely holds prose opts in with `.cell-wrap`. Six registers never did, so a
single sentence per row set the width of the whole table.

Fixed, with the measurement each one was at:

- `/smsc/:engineId` **917** — Reason and Verification wrap; the two unbounded
  timelines are capped scroll regions with a count, which also takes the page
  down from 7,043px
- `/smpp-errors` **602** — "What it means" and "Suggested check" wrap
- `/configuration` **572 + 191** — the generic fallback columns clipped the
  checksum and the UUID. It serves every module without an explicit column
  set, so this also covers `/queues` and `/delivery-reports`
- `/logs-audit` **469** — 8 columns to 6; four opaque ids at 260px each was
  more than a thousand pixels of ellipsis before the first readable word
- `/log-explorer` **445** — the log message wraps
- `/content-rules` **410** — regex patterns and rule ids capped
- `/live-traffic` **350** — 14 columns to 7; one column per rate window, then
  peak, then MO, then three spool figures, then two totals, is four questions
  drawn as fourteen
- `/roles` **506** — permission chips laid out on one line however many there
  were
- `/carriers/:id` **271** — 10 columns to 6
- `/reports` **196** — two full ISO timestamps in two columns answering one
  question
- `/help` **66** — the guide purpose wraps

**And the Save button that was 1,156px below the fold.** The SMSC editor has
thirty-eight fields with Save under the last of them. Measured in the sheet
that is more than a window height past the bottom: an operator who changed the
first field had to scroll the whole form to commit it, and nothing on screen
said the control existed. The action row sticks to the bottom of the sheet now.

Frontend **756 tests pass**.

## 2026-10-06c (the sign-in page was inventing its figures, and five dialogs were flat)

**A screenshot sweep now exists.** `scripts/screen-sweep.mjs` walks every route
from `navigation.ts` — the same source the other two audits read — captures it,
then finds the control that OPENS something (New, Add, Create, Edit, Open),
clicks it and captures what opened. The layout and overflow audits measure two
numbers; neither can see that a dialog is a flat list of eleven fields. This is
what the redesign kept missing: a page top was rebuilt and the sheet behind its
own button was never looked at.

First run against production, 1600px, 64 captures including 16 dialogs. It also
re-measured the overflow backlog, and **`/sessions-smpp` came back at zero** —
it was +588 before yesterday's rebuild.

**The sign-in page was presenting invented figures as measurements.** It
carried "Throughput 16k +8.2%", "Delivery rate 98.7% — last hour" and
"Connected SMSCs 12", with two bar charts drawn from hardcoded arrays. This
deployment has three SMSCs and a carrier that has been refusing the connection
since 8 September. §3.3 and §17 exist precisely to stop an unmeasured value
being shown as a measured one, and the first screen anybody sees was breaking
them in 19px bold. There is also nowhere honest to source real figures there —
the page is pre-authentication. The cards now say what the platform *does*, and
the only numeral left on the page is a protocol version.

**Five create dialogs brought to the carrier dialog's shape** — a subtitle
saying what the record is for, named fieldsets, a hint under every field, a
REQUIRED marker, and a submit that names what it creates:

- **Create user** — nine role checkboxes in a flat column became a choice list
  where the picked rows are legible without reading the ticks, plus a sentence
  saying what the account will be able to do and a warning on Super
  Administrator. The grey Save now lists what is missing instead of refusing to
  say.
- **Create API client** — warns when no scope is selected, because a key with
  none authenticates and is then refused by every endpoint, which from the
  caller's side is indistinguishable from a broken credential.
- **Create backup** — the three scope radios said what was IN each choice and
  never what was missing from it. Each option now states what it leaves out,
  which is the thing that matters at restore time.
- **New backup schedule** — grouped into what it is and when it runs, with a
  sentence assembling the cadence. A schedule wrong by a factor of sixty is not
  noticed for a month.
- **Add a recipient policy entry** — labels sat *beside* their inputs, the one
  field shape the design system does not style. Regrouped, with the list type
  leading (the same destination is refused on `blacklist` and uniquely accepted
  on `whitelist`) and a sentence stating the outcome.
- **New reference record** — invalid JSON was discovered by the API refusing it.
  It is checked as it is typed now.

Frontend **756 tests pass** (750 before).

## 2026-10-06b (the lifecycle desk, in the house shape)

`/alert-lifecycle` had the right content and the wrong shape. Its columns were
grouped back in September, but the screen still opened on a seven-control
toolbar and a status dropdown with no counts, and its sheet put five badges,
nine fields and two banners above the first button an operator came to press.

**Tabs with whole-table counts.** `GET /alerts/summary` — built for `/alerts`
and already tallying through the same tenant-scoped connection as the list — now
feeds this screen too. Each tab sets the **server-side** status filter, so the
number on the tab and the rows beneath it measure the same thing. A client-side
tab over a paginated register would not. The tally is validated on arrival: a
deployment answering 200 with something that is not a tally yields `null`, not an
object whose `byStatus` is undefined and which throws mid-render.

**A verdict that leads on *unclaimed*, not *open*.** An open alert somebody has
taken is being worked; an open alert nobody has taken is the one that gets
missed. The line names the count and the age of the oldest.

**The live line** replaces `Auto refresh [On] · Every [30s] · (Refresh) · Last
updated 09:50:54` — four controls and a caption stating one idea.

**Severity is a segmented control.** Four mutually exclusive choices that fit on
one line should not cost a click to see.

**The sheet leads with the actions.** Then the record, as a 130px field grid with
relative times and the instants in `title`; then the timeline, capped so a busy
thread cannot push the comment box off the end.

Frontend **750 tests pass** (744 before; 6 new, covering the whole-table counts,
the refusal to render zeros when the tally fails, the tab→filter round trip, and
the order of the sheet).

## 2026-10-06 (the bind timeline that had no end)

`/sessions-smpp`, rebuilt to CONSOLE_DESIGN_SPEC §1 rather than patched. Peter's
report was that "the bind timeline pane is too long"; measuring found two faults
with one cause — nothing on the screen was bounded.

**The timeline grew one row per transition, forever.** Across an estate that has
been polled since August that is hundreds of rows of rail, so the panels below it
were several screens down and the page had no end. It is now a capped scroll
region of about six rows that *states what it is showing* — `40 most recent of
312` — with a Problems filter, because the question the rail exists to answer is
which binds dropped, not which ones are fine. The drawer's own Transitions list
got the same cap, for the same reason.

**Thirteen columns, 588px past the panel, now seven.** Since, Last observed and
Last transition are three readings of one question and share two cells; out rate,
ceiling and utilisation are one answer about throughput, with the ratio drawn as
a bar rather than left to be computed from two numbers in two columns. Nothing
was dropped.

**The five bands are now in order.** Before this, the first thing after the scope
note was a row of seven dropdowns, and "is anything down" could only be answered
by reading the State column of every row. Now: a verdict naming the binds that
are not bound with a way into the worst of them; four figures; tabs with counts
and a live line; the filters; the rows. The verdict is **never green on an
absence of evidence** — a page where nothing has been observed reads `Unverified`,
not `All bound`, which is the mistake the dashboard made in `612fa87`.

**It refreshes.** A register of bind state that never re-reads is a photograph;
an operator watching a carrier come back up had to reload the browser. 30s, with
Pause, matching `/alerts`.

**The house bands are now defined once.** `.screen-head`, `.status-line`, `.tab`,
`.live-line`, `.segmented` and `.table-foot` had four near-identical scoped copies
across Alerts, Routing, Notifications and the dashboard, and a fifth screen could
not adopt the shape without a fifth copy. They are in `workspace-extras.css`; the
scoped copies still win on specificity, so nothing moved on those screens, and
they come out as each one is next touched.

Frontend **744 tests pass** (736 before; 8 new, covering the cap, the filter, the
verdict's refusal to go green, and the seven columns).

## 2026-09-30 (the audit only ever looked at six screens)

`scripts/layout-audit.mjs` has had the right rules since it was written and
defaulted to the six routes from the complaint that produced it. Pointed at all
fifty — read from `navigation.ts`, as `route-smoke` already does — it found **23
findings across 15 screens** on the first run. It is now at **zero**, plus one
exemption that is printed rather than swallowed.

**Tall rows had one cause on eleven screens.** `/alerts` rendered 31 rows at an
average of 243px: 14 columns sharing 1,300px, so a 126-character condition landed
in a 93px cell and wrapped fourteen times. Fixed in the design system — cells keep
to one line, columns keep a usable minimum, and the table scrolls sideways in
`.table-wrap`, which already had `overflow: auto`. An intermediate version added
`overflow: hidden` and a max-width, fixed the towers, and failed the overflow
audit 84 times: an ellipsis on a row that does not open a detail view does not
shorten the value, it hides it. Nothing is clipped now.

**Three classes were used and never defined.** `.field-grid` is used by five views
in eleven places and existed only inside one `<style scoped>` block in a sixth,
where it could not reach them; `.split-fields` and `.button-row` were referenced
and never written at all. That accounted for five findings.

**Heights**, measured before and after:

| screen | before | after |
|---|---|---|
| `/api-reference` | 30,623px | 4,626px — groups start closed, a search opens them |
| `/messages` | 8,767px | 4,998px — page size 100 → 50 |
| `/alerts` | 8,328px | 2,983px |
| `/alert-lifecycle` | 7,464px | 2,781px, and it finally has a pager |
| `/roles` | 7,015px | under 2,500px |
| `/mo-routing` | 4,153px | 1,450px across four tabs |
| `/live-queue` | 3,202px | 1,059px across four tabs |

Nothing in the product is over five screens now; it was thirty.

Also: a shared `TablePager` supporting both paging models the backend has (offset
with a real total, cursor with none, which it refuses to invent); Live Queue's
binds became a collapsible list that distinguishes *disabled here* from *down*,
which needed a new `enabled` field on `/queue-console/live`; and the audit learned
that a container measures only the buttons it owns directly, because `.button-row`
is how a screen declares which buttons mean one thing.

## 2026-09-29b (the signature that was the secret)

The longest-standing security defect on the board, closed. Two separate problems
were hiding behind one line of code, and fixing either alone would have left the
other.

**The secret was stored and returned in plaintext.** `notification_channels.config`
and `mo_rule_destinations.config` are JSONB blobs written straight from the request
body, so `config.secret` sat in the database in the clear *and* came back out of
every list endpoint — readable by any `system.view` holder, and copied verbatim
into `audit_log` on create.

**The "signature" was the secret itself.** The sender put the shared secret into
`x-jkannel-signature` unchanged. That is a bearer token wearing a signature's
name: identical on every request, proving nothing about the body, and replayable
forever by anyone who ever received one — or read one out of the list endpoint
above.

Now, in `backend/src/security/webhook-secret.ts`:

- Secrets are **AES-256-GCM sealed** before they reach the column (reusing the
  MFA key helper), and **redacted in SQL** on every read — in SQL rather than in
  TypeScript so a reader added later inherits the redaction instead of having to
  remember it. `notification_channels` now does what `mo_rule_destinations`
  already did.
- The wire signature is an **HMAC-SHA256 over `${timestamp}.${rawBody}`**, sent as
  `x-jkannel-signature: v1=<hex>` beside `x-jkannel-timestamp`. The body is
  serialised **once** and both signed and sent, because two JSON encoders disagree
  about key order and a re-serialised digest would fail for one message in a
  thousand.
- Signing headers are applied **after** a destination's configured headers, so a
  rule cannot pin its own signature and defeat the mechanism.
- `verifySignature` is exported and enforces the replay window, because a receiver
  that skips the timestamp check buys nothing from the change.
- **Legacy plaintext rows still work** and are upgraded on next write; a value that
  cannot be decrypted sends the hook *unsigned* rather than throwing, so one bad
  row cannot stall the delivery queue forever.

The old behaviour was asserted by a *passing* test — `mo-delivery.service.spec.ts`
expected `x-jkannel-signature` to equal `'s3cret'`. That test failed the moment the
fix landed, which is the falsification, and it now asserts the opposite.

Also closed: **`requiredSecrets` is displayed** in the generated-configuration panel
(the backend always returned it and the frontend dropped it, so the most actionable
part of the response was invisible until the engine failed to start), and all four
raw `console.warn` callers now go through the shared logger, so "the rate limiter
failed open" is finally findable in the Log Explorer.

CPAAS must implement the new scheme before inbound is switched on — the worked
example and the three easy-to-get-wrong parts are in
`docs/CPAAS-HANDOFF-JKANNEL-SMS.md` §6.

## 2026-09-29 (three dialogs that laid their fields out like a filter bar)

Found by `scripts/dialog-audit.mjs` on the first full audit run since the local stack
was restored. Eleven dialogs were opened and measured; these three had **no field
grid at all**, so their labels and controls had no layout relationship to each other.

- **`/routing-advanced` → New route** (24 fields). Every field was a `filter-select`
  label in a row-wrapping flex — a *filter bar's* layout. In a filter bar that is
  correct; in a form the eye pairs a label with the control to its right and gets the
  wrong one. The field run now sits in `.dialog-grid`; the active-days fieldset and the
  weighted-targets table stay full width as siblings of it, and the wildcard field takes
  `.dialog-span` because its grammar legend and plain-English reading are prose.
- **`/roles` → New role** (25 inputs). Name and Description were loose in the dialog
  body as full-width flex rows with inline labels, so they read as one continuous band
  rather than two fields. Both now share a `.dialog-grid`. The permission checkbox
  fieldsets were never the problem and are unchanged.
- **`/api-gateway` → Create API client** (5 inputs). A bare `<label>` with a loose text
  node — the one field shape the design system does not style, and the only dialog whose
  label did not sit above its control.

All eleven dialogs now pass. 704 frontend tests and `vue-tsc` both green; all 50 routes
still render.

Also: **`scripts/layout-audit.mjs` no longer reports refresh toolbars as defects.** Its
inline-label rule grouped controls by `section, .panel`, which matched
`<section class="toolbar panel grid-toolbar">`, so three correct toolbars were flagged.
A toolbar is *supposed* to run its labels inline — its controls are independent switches
over the view, not fields of one record. Confirmed by screenshot before the tool was
changed. The exclusion is deliberately narrow (`.toolbar, .grid-toolbar, .filters,
.log-refresh`), so the Log Explorer's real search form (`.log-filters`, which wraps a
`.dialog-grid`) is still audited.

Prettier normalised prose wrapping in the two touched views, which had drifted from the
project's own formatting rule.

## 2026-08-05 (close the verified gaps: RBAC, alert lifecycle, message depth, deployment hardening — `d58a3d2`)

A follow-up pass against the open and partial items in
`project/IMPLEMENTATION_VERIFICATION.md`. **Backend only** — the matching console
screens are in progress, so several of these are API-reachable but not yet clickable.

- **Role and permission administration** (migration `036_rbac`) — the verification's
  single largest open gap. `POST` / `PATCH` / `DELETE /users/roles` plus
  `GET /users/permissions`, a seeded 21-code permission catalogue with human
  descriptions and eight categories, and **eight seeded roles per tenant**: Super
  Administrator, Administrator, Network Engineer, Operations Engineer, Support Engineer,
  Read Only, Auditor, API Client. Guard rails: system roles cannot be renamed or
  deleted; a change that would leave nobody holding `users.manage` is refused with 409;
  a role held by at least one user cannot be deleted; and editing a role's grants
  revokes every holder's live session. `PATCH` **replaces** the whole grant set rather
  than merging. API-key scopes are deliberately excluded from the catalogue so a human
  role cannot be granted a machine scope. *`RolesView.vue` still shows a read-only
  banner that is now factually wrong.*
- **Full alert lifecycle** (migration `037_alert_lifecycle`) — resolve, assign,
  suppress, reopen, close and comments alongside acknowledge, with a transition table
  that returns 409 naming the current state, and `GET /alerts/:id/lifecycle`. Suppress
  requires `system.manage` and is capped at 30 days. Assignment resolves against real
  tenant users. **No ticketing** — there is no ticket field and no ticket route.
- **Notification readiness** — seeds a `Default dashboard` channel and a
  `Default escalation` policy at boot, exposes `GET /monitoring/notifications/readiness`
  and a `repair` route, and warns when a tenant has open alerts but nothing deliverable.
  Undeliverable steps now record a reason rather than being silently skipped. The
  seeded policy's email and webhook steps have empty targets, so **out of the box only
  the in-app step delivers**.
- **Message depth** (migration `038_messaging_depth2`) — server-side `from`/`to` date
  range (strict ISO 8601, inclusive), and a single shared filter parser used by the
  list, CSV and PDF routes so **export parity now holds** and an unknown status token is
  a 400 everywhere. Encoding, charset, UDH, validity, deferred, mclass, pid, binfo and
  metadata are selected and returned, with a derived segment count (GSM-7 160/153,
  UCS-2 70/67, 8-bit 140/134; a UDH-declared part count wins). Free-text search is
  **still an unindexed leading-wildcard scan**, and an export still returns at most 500
  rows per call.
- **A real SMPP bind test** — a `bind_transceiver` PDU (or transmitter/receiver per bind
  mode), reading the response and reporting `ESME_*` status. Crucially it records a
  `verified` level of `smpp_bind`, `tcp_socket` or `not_applicable`, persisted to the
  operation history, so a TCP fallback can never be read as a successful bind. It falls
  back to TCP when the API container cannot resolve the credential — the standard
  topology, since credentials live in the engine container — and says so verbatim.
- **A genuine reconnect cycle** — observes the bind, issues `stop-smsc`, waits for it to
  leave `online`, issues `start-smsc`, waits for it to return, and records `bind_cycled`
  or `command_accepted`. Gated on the `runtime.smsc.reconnect` capability. Both this and
  the bind test had been flagged in two consecutive audits without changing.
- **An enforced security policy** — password minimum length and four complexity rules,
  history depth, lockout threshold and duration, access-token TTL, session idle timeout,
  absolute session lifetime and a concurrent-session cap, resolved per tenant with a
  30-second cache. These were previously decorative settings read by no code. Values are
  clamped one-sidedly toward strictness, and the session cap ships **off** by default.
  Hashing remains **scrypt, not Argon2id**, and **no password-expiry setting exists**.
- **Customer `rate_limit_per_min` enforced** on the send path — 429 with `limit`,
  `windowSeconds` and `retryAfterSeconds`. It fails open on Redis loss, counts attempts
  rather than successes, and uses a fixed 60-second window.
- **An S3-compatible offsite backup destination** (AWS, MinIO, Ceph) with SSE and
  path-style options, alongside the existing filesystem driver.
- **Container resource limits** — `mem_limit`, `cpus`, `pids_limit` and `ulimits` across
  the compose services, closing a gap where only `restart:` was set.
- **An opt-in `tls` profile.** The default topology is unchanged and **the live
  deployment still terminates TLS on an upstream system nginx**.
- **Correlation IDs in log lines** via `AsyncLocalStorage` — correlation ID, request ID,
  user, tenant, method, route and client IP — plus an `x-correlation-id` response header
  and `GET /observability/logs`. **That endpoint reads a process-local, non-durable
  in-memory ring buffer** (1000 lines by default, 20 000 maximum, no retention window,
  lost on restart, one replica's view only); every response says `durable: false`. It is
  triage convenience, not a log store.

Not changed by this commit, and still true: **a generated configuration has never bound
to a real carrier**; notification-channel secrets are stored and returned in plaintext;
there is no real-time push; plugins do not execute.

`FEATURES.md` and `project/IMPLEMENTATION_VERIFICATION.md` are anchored to `eefa320` and
now **understate** the product. Re-running the verification is tracked in
`progress/next-actions.md`.

## 2026-08-04 (documentation: honest README, operator manuals, ledger refresh)

- **Rewrote `README.md`.** It now states the control-plane boundary
  ([ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md)) in one paragraph, links
  the capability summary to `FEATURES.md` rather than restating it, gives an
  architecture diagram, a Compose quick start with profiles, the configuration
  essentials, how to run every test layer, and a documentation map. It is explicit that
  the frontend is a **Vite dev server** and that **TLS is terminated upstream by
  default**.
- **Added task-oriented operator manuals** under
  [`docs/user-guides/`](../docs/user-guides/README.md): getting started and console
  tour, connecting an SMSC, sending messages, **Live Queue and recovering a bad bind**,
  routing, monitoring and alerts, reports and exports, customers and quotas, backup and
  restore, users and roles, and troubleshooting. Every screen name, button label and
  field was verified against `frontend/src/views/` and `frontend/src/navigation.ts`.
- Verifying those labels surfaced three gaps now stated plainly in the guides rather
  than omitted: the configuration UI **drops the `requiredSecrets` array** the backend
  returns; the SMSC create/edit forms expose **no field for `credentialSecretRef`,
  `systemId` or bind mode** (API only); and **`POST /auth/api-keys` — the only
  credential that authenticates the gateway — has no console UI**, while the API Gateway
  screen manages a registry that authenticates nothing.
- **Retired `project/SUPERVISOR_HANDOVER_SUMMARY.md`.** It was a point-in-time status
  memo from 2026-07-09, superseded by `FEATURES.md` and
  `project/IMPLEMENTATION_VERIFICATION.md`. The single inbound link (from `README.md`)
  was repointed.
- Brought `progress/completed.md`, `pending.md`, `next-actions.md`, `blockers.md` and
  `session-log.md`, plus `project/PROJECT_STATE.md`, `TASKS.md`,
  `SPEC_CONFORMANCE_PLAN.md`, `ROADMAP.md` and the documentation catalog, into line with
  the audited state. The honesty discipline from the traceability correction notice —
  *code merged is not capability delivered* — is applied throughout, including to the
  waves' own summaries.

## 2026-08-04 (verified feature list + collapsible navigation, `4ed4bda`)

- Added **`FEATURES.md`**: a capability list where every entry was verified by tracing
  that a **non-test caller reaches it on a real request path**. Code that exists but
  nothing invokes is not listed. Its "Not yet implemented" section is deliberately long
  and specific.
- Added **`project/IMPLEMENTATION_VERIFICATION.md`**: an independent, read-only,
  file-by-file verification of the six remediation waves. Method: call-site tracing of
  every previously-callerless symbol, route-table extraction of all non-test controllers
  paired with their guards and permissions, and direct inspection of every migration,
  compose file and CI workflow. **Result: 10 of 20 gaps closed, 7 partial, 3 open.**
- It also retracts the ledger's "36/36 Playwright e2e acceptance" claim. Of 40 runtime
  cases, **26 are one navigation loop and 5 are genuinely mutating workflows**.
- Frontend: collapsible navigation groups in the console shell.

## 2026-08-04 (deployable behind a reverse proxy, `eefa320`)

- The frontend container runs the Vite dev server, whose host check returned **403**
  behind a reverse proxy because it receives the *public* hostname in `Host`. Added
  **`VITE_ALLOWED_HOSTS`** (comma-separated; a leading dot allows a whole suffix).
- Deployed to a **shared VPS running an unrelated stack alongside it**. JKANNEL's
  published ports were remapped to **loopback only** so nothing is exposed publicly and
  nothing collides: backend 3200, frontend 5173, JKANNEL proxy 8081, Kamex admin 13000,
  Kamex sendsms 13013. A **system nginx terminates TLS** and proxies to
  `127.0.0.1:8081`.
- The shipped `reverse-proxy` service stays **HTTP-only by design** — the "TLS
  terminated upstream" topology. A profile-gated `reverse-proxy-tls` service exists for
  deployments that want JKANNEL to hold the certificate, with a deliberately separate
  port list so enabling it cannot republish a port publicly.
- Console live at `https://jkannel.34-134-248-1.sslip.io` (tenant `default`, username
  `operator`).

## 2026-08-04 (six remediation waves, `9ba2bae`)

Executed against the build order recommended by `project/SPEC_GAP_ANALYSIS.md`.

- **Wave A — stop the bleeding.** Fixed **permanent account lockout** (an
  unauthenticated DoS against any account). Fixed **stale privileges on refresh** —
  `refresh()` re-resolves status, roles and permissions and revokes the token family on
  a non-usable account. Closed the **`X-Forwarded-For` allowlist bypass** with
  `trust proxy` plus a platform-derived `request.clientIp`. Added **MFA and `/auth/*`
  throttling**; a wrong TOTP now increments the lockout counter. Replaced the
  **hardcoded `/health`** with a real PostgreSQL + Redis probe under bounded timeouts
  that redacts driver detail and returns 503. **Decoded `dlr_mask`**, so the shipped
  success-rate reports stopped being wrong — `successRate = delivered / (delivered +
  failed + rejected)`, with the old figure surviving under the honest label "DLR
  coverage". **Added CI**: five GitHub Actions jobs (backend, frontend, compose,
  migrations, security) with coverage gated at the current floor and ESLint at zero
  errors.
- **Wave B — make configuration real.** Migration 029 adds the 20-column SMSC attribute
  set. `SecretResolver` renders every credential as a `${ENV}` placeholder — never a
  literal — and reports `requiredSecrets`. The renderer emits the full SMPP bind
  parameter set plus the `smsbox`, `sendsms-user`, `sms-service`, `pgsql-connection` and
  `dlr-db` groups. **`ConfigurationModelBuilder` composes the model from
  `smsc_definitions`**, closing the void between the SMSC Manager and the generator, and
  `POST /configurations/generate` defaults to `source='database'`. Deploy rollback fires
  on a 503 health check. Verified live that Kamex expands `${VAR}` from its own
  environment.
- **Wave C — close the observability loop.** `SmscStatusPoller` (migration 031) observes
  every bind and writes state, transitions and metric samples. Live-verified: a bind
  drop detected (`connecting → disconnected`), transition audited, alert raised, no
  flapping. Real SMS metrics exported (`jkannel_smsc_bind_up`, queue depth, failures,
  throughput, DLR queued); the dead bearerbox scrape job deleted; an SMS-focused Grafana
  dashboard added. **`AlertRuleEvaluatorScheduler` now drives the previously callerless
  `AlertEvaluatorService`.** `deliverSms` submits through SQLBox instead of returning
  `skipped`; escalation honours `step.target`.
- **Wave D — routing and customers on the send path.** A single **`MessageSendService`**
  funnels the console, API-gateway, bulk and replay send paths. `smscId` is optional;
  when omitted the router selects and the send **fails closed**. Decisions persist to
  `message_route_decisions` for successes *and* refusals. Candidates come from live
  `smsc_bind_state`; `deployment_state='deployed'` is respected; the two divergent
  routing engines were converged onto one `selectRoute()`. **Customer entitlements are
  consumed inside the same transaction as the engine submit.** `POST /gateway/messages`
  and its read endpoints sit behind `ApiKeyAuthGuard` with enforced
  `sms.send`/`sms.read`/`routing.read` scopes, and customer identity comes from
  `api_keys.customer_id`, never from the body. Blocklist/allowlist/DND evaluate before
  selection via a shared E.164 normaliser.
- **Wave E — operator surfaces.** `useLiveResource` (overlap guard, `document.hidden`
  guard, caller pause predicate, deterministic cleanup) on the Operations dashboard,
  Live Queue and three workspace modules. Real dense column sets on 13 modules. Alert
  row actions. New UI for escalation policies, maintenance windows, backup schedules and
  routing depth.
- **Wave F — durability and platform depth.** `BACKUP_ENCRYPTION_KEY` made **mandatory**
  with placeholder rejection; the JWT-key fallback chain removed. Backup and
  verification failures open real alert instances. Config and certificate capture added.
  **The false `incremental` label was retired rather than faked** — a requested
  incremental is recorded as `full` with an explanatory note. A **real job queue**
  (migration 034): `FOR UPDATE SKIP LOCKED` claiming, exponential backoff,
  dead-lettering, stale-claim reaping, and `POST /jobs` returning 202 + `Location`.
  `PluginManifestValidator` — previously zero callers — is now called on install.
- Verification: backend 100 suites / 836 tests, frontend 18 files / 112 tests, `tsc`
  clean, ESLint 0 errors, schema at migration 035, all 9 Compose services healthy.
  Live-verified: Live Queue reroute/resend, a bind drop detected and alerted, `/health`
  failing and recovering, an async job executing to `succeeded`.

## 2026-08-04 (Live Queue console + spec-gap audit, `e7d9df9`)

- **Live Queue console** (`backend/src/queue-console/` + `LiveQueueView.vue`, 7 routes,
  5-second polling): per-bind status, queue depth, failures and throughput with an
  honest `source` when the engine is unreachable; a pending-spool grid with
  **`POST /spool/reroute`** (true zero-restart retarget, tenant predicate in the SQL) and
  `/spool/cancel`; **`POST /resend`** (bulk resend of failed traffic to any bind, by id
  or status filter); and **`POST /binds/:engineId/control`** to start, stop or reconnect
  **one** bind — verified live that the engine and every other bind keep running.
- DLR-derived delivery status with `resendable` and `in-flight` presets, shared by the
  Live Queue and the Messages explorer.
- **Accepted [ADR-0008](../docs/adr/ADR-0008-control-plane-boundary.md).** Building this
  surfaced a hard boundary: bearerbox's internal per-SMSC queue is exposed only as an
  aggregate counter and cannot be listed, moved or cancelled per message. Owning the
  outbound queue in JKANNEL was **considered and rejected** — it duplicates two decades
  of hardened retry, throttling, windowing, store-and-forward, DLR correlation and SMPP
  flow control, and would turn a control-plane bug into a message-loss bug. Forking the
  engine was also rejected. The boundary is stated in the UI and the supported
  workaround (disable the bind, then resend) is built.
- **`project/SPEC_GAP_ANALYSIS.md`**: a systematic specification-vs-implementation audit
  applying one decisive test — *does a non-test caller reach this on a real request
  path?* It found 20 gaps, three of them **integration voids**: the configuration
  generator never read `smsc_definitions`, the routing engine was not on the send path,
  and alert rules were never evaluated. Measured adoption of components the ledger had
  cited as evidence: `AlertEvaluatorService` **0 callers**, `requireCapability()` **0
  callers**, `PluginManifestValidator` **0 callers**, `SmscService` **0 injections**,
  `selectRoute()` **0 send paths**, customer quota/credit **0 send paths**.
- A correction notice was added to the head of
  `progress/requirements-traceability.md`: the ledger had been booking **capability
  shipped** as **capability delivered**. Eight rows previously marked Complete were
  downgraded. That discipline is now permanent across every project document.

## 2026-07-10 (Claude cycle 4: user-reported fixes + Customers domain)

- Fixed the **AI Copilot "Failed to fetch"** — the `x-jkannel-ai-opt-in` consent header was missing from the CORS allowlist, so the browser preflight blocked the request (curl worked). Added it.
- **Messages** rows are now clickable and open a message trace/detail drawer.
- **SMSC Connections**: click-to-edit plus a Delete/Archive action (`DELETE /smscs/:id`, 409 when referenced by routes); connection status dots retained.
- **Routing**: Target SMSC and Fallback SMSC are now dropdowns populated from the SMSC list instead of free-text ids.
- **Configuration**: a "Load baseline" starter configuration (`GET /configurations/baseline`) and an Edit action that loads a version's content into the form to save as a new immutable version.
- **Volume report snapshots** are clickable to a detail view showing the full period breakdown (total + per-SMSC + per-route) via `GET /reports/volume/:id`.
- **Customers domain** implemented (migration 020): a `customers` table (name, code, status, contact, daily quota, per-minute rate limit, allowed sender IDs, notes) with tenant-scoped CRUD, a create form, detail/edit/archive, and a help panel explaining the concept.
- **API Gateway**: an API-documentation/how-to panel (client creation, one-time secret, bearer auth, scopes, rate limits, OpenAPI reference).
- **Plugins**: a downloadable sample plugin manifest (`GET /plugins/sample-manifest`) and a developer-portal panel (manifest fields, lifecycle, permission/event model, packaging).
- **Backup & Restore**: create now opens a modal to name the backup and choose scope (Full / Database / Configurations); a Restore action (confirm + reason, restores into an isolated verify database); Verify action; pointed at the real `/backup-dr` endpoints. Configurations-scope backups dump only the config tables.
- **Users & Roles**: role assignment is now a labelled checkbox list (name + description) in both create and edit, with roles shown as chips in the detail drawer.
- Verification: backend 45 suites / 189 tests, frontend 12 files / 67 tests, both typecheck + build clean; migration 020 applied on the live stack; new endpoints and the Customers UI smoke-tested live.


## 2026-07-10 (Claude cycle 3: platform modules, analytics, and console completeness)

- Built the previously-missing Platform modules end to end (migration 016): **API Gateway** clients (create with one-time secret, rotate, revoke, export), **Plugins** (seeded examples with enable/disable and manifest install), **Backups** (logical-checkpoint catalog with create/verify/restore-request and export), **Runtime Containers** (declared Compose services with live-probed health for PostgreSQL/engine/SQLBox and honest "unknown" for the rest), and a **Customers** honest-unavailable placeholder — every one previously returned "Workspace API not available yet".
- **System Settings** now seeds 23 documented defaults across 8 groups (Platform, API, Security, Retention, Backup & DR, Notifications, Runtime, AI Operations) with per-setting description, type and editable/read-only flags, and inline editing.
- **Users & Roles**: full user lifecycle beyond invite — create user with roles, detail with effective permissions, edit (status/roles/password reset), archive (with session revocation), and a roles listing.
- **Sessions**: added search, whitelisted sort, and CSV/PDF export.
- **Queues** and **Delivery Reports**: real paginated, searchable, filterable grids with CSV export (previously summary-only).
- **SMSC**: detail endpoint (recent health samples + operations) and richer test results; **Logs & Audit**: per-event detail endpoint exposing old/new values.
- **Analytics & Reports**: overview KPI cards, daily traffic-trend series, per-SMSC and per-route breakdowns, delivery breakdown, and a seven-category report catalog (Reporting spec §3–10), plus SVG charts and a report-catalog view in the console.
- Frontend: analytics dashboard with a dependency-free MiniChart, grouped settings editor, user CRUD/detail drawers, SMSC detail/edit and connection status dots, configuration help panel, audit-event detail, queue/DLR pagination and export, and plugin/backup/API-gateway/runtime-container management surfaces.
- Fixed the "Failed to fetch" login issue by defaulting the API base to 127.0.0.1 (IPv4) — see the run note in the README.
- Verification: backend 32 suites / 105 tests, typecheck, Prettier clean; migration 016 applied on a fresh database; all new endpoints smoke-tested 200 against the live stack with real data.

## 2026-07-09 (Claude cycle 2: carrier SMPP, notifications, metrics, AI Copilot, anomaly detection, identity)

- Configured a live carrier SMPP bind (authorized test) as a managed SMSC; bearerbox correctly attempts the bind and the platform's own test-connection honestly reports `ECONNREFUSED`. The bind is blocked only by carrier-side IP allowlisting (the deployment egress IP must be authorized) and will establish automatically once allowed — proving the SMSC lifecycle and honest connection-state reporting end to end. The carrier endpoint and credentials are kept in the gitignored `.env` and are not committed.
- Repaired the SQLBox runtime so the message pipeline works: rebuilt sqlbox from the official checksum-pinned source RPM with only the PostgreSQL backend (the official binary panics on non-MSSQL configs) and added credential rendering; proved API→send_sms→bearerbox→sent_sms→grid live.
- Added real notification channel delivery: SMTP email (via `SMTP_URL`, honest "unavailable" when unset) and webhooks with optional signature header, unified behind a transport-neutral payload so scheduled reports and alerts both deliver; report deliveries are recorded (migration 013 relaxes notification_deliveries for non-alert categories).
- Added backend Prometheus metrics: HTTP request counters by method/status class, a latency histogram, and named event counters, exposed at `/metrics` for the Grafana profile, recorded by a global metrics interceptor.
- Added the AI Ops Copilot: a read-only, RBAC-scoped, opt-in, audit-logged assistant with six privacy-safe tools (traffic volume, queue depth, SMSC health, open alerts, engine capabilities, recent audit). Answers locally by default and via the Claude Messages API when `AI_PROVIDER=anthropic` is configured; never returns recipient numbers or message bodies; cannot execute changes.
- Added traffic anomaly detection: statistical per-SMSC volume-drop/spike and DLR-failure detection over daily report snapshots, opening deduplicated alert instances into the existing pipeline (migration 014 adds alert severity/source/dedup and fixes the alerts grid, which referenced a non-existent severity column).
- Added identity workflows (migration 015): password reset (request/confirm with session revocation), invitation acceptance (provisions an active user with the invited role), and session administration (list/revoke, new `users.sessions` permission). All proven live: invite→accept→login and reset→login with the new password.
- Verification: backend 30 suites / 102 tests, typecheck, Prettier clean; all 15 migrations apply cleanly to a fresh database on boot; new features smoke-tested against the running stack.

## 2026-07-09 (maintainer transition: Claude)

- Project maintenance moved from the ChatGPT/Codex workflow to Claude; takeover review findings, applied fixes and forward proposals are recorded in `SYSTEM_IMPROVEMENT_PROPOSALS.md`.
- Reformatted the entire backend and frontend source with Prettier (config at `.prettierrc.json`, enforced via `npm run format:check`) to eliminate the minified single-line style; all suites remained green after the reformat.
- Fixed the authentication signing-key mismatch: token issue/verify now use validated `AUTH_ACCESS_TOKEN_KEY`/`AUTH_REFRESH_TOKEN_KEY` (separate keys per token type) with `AUTH_SIGNING_KEY` accepted as a deprecated fallback; environment validation, Compose and `.env.example` updated.
- Enforced tenant isolation for real: migration 011 adds `FORCE ROW LEVEL SECURITY` to every RLS table, an `audit_log` tenant policy (previously the audit trail had no row security), a non-owner `jkannel_app` application role, and a least-privilege `jkannel_auth` BYPASSRLS role for pre-authentication identity lookups; the API now connects via `DATABASE_APP_URL`/`AUTH_DATABASE_URL`.
- Added a deterministic migration runner (`npm run migrate`, `MIGRATIONS_ON_BOOT`) with checksum drift detection, advisory locking, `--down` rollback, automatic FORCE-RLS enforcement, and role login provisioning; Compose now applies migrations on backend boot.
- Closed the SQLBox cross-tenant leak: message list/trace/export/queue/DLR reads and outbound submission are scoped to the tenant's own SMSC engine identifiers, with honest empty states for tenants without SMSCs.
- Added a global audit-trail interceptor: every authenticated mutating request and sensitive read (exports, traces, audit queries) is recorded in `audit_log` with actor, tenant, redacted parameters, outcome, correlation id and source IP; audit events are queryable and exportable through the console.
- Added uniform grid capabilities (whitelisted `search`, `sort`, `filter.<field>`, `limit`/`offset` with totals) across SMSC, route, alert, alert-rule, user, invitation, configuration, audit-event, notification and report endpoints, plus CSV and PDF export endpoints for each grid (server-side pdfkit rendering with tenant/requester/filter metadata).
- Added scheduled volume reporting (migration 012): idempotent per-tenant daily and weekly message/DLR snapshots — total, per SMSC, and per route (attributed via target SMSC) — generated by an in-process scheduler with unique period claims, plus in-app notifications to `reports.view`/`system.manage` holders and a notification centre API (list, unread count, mark read).
- Added a cross-tenant RLS integration proof (`backend/tests/rls.integration-spec.ts`) that runs against a live database when `RLS_TEST_*` URLs are provided and skips honestly otherwise.
- Live-stack validation: proved migrations 001-012 apply cleanly to a fresh database (fixing 001 bootstrap overlap and the missing routing_rules UNIQUE constraint 007 always required), added `--baseline` for brownfield databases, and verified RLS isolation, grids, exports, reports, notifications and the audit trail against the running stack.
- Repaired the SQLBox runtime, which had never worked: the official kamex-sqlbox 1.8.3 RPM panics on any non-MSSQL configuration (upstream dispatcher bug), so the sqlbox image now rebuilds it from the official checksum-pinned source RPM with only the PostgreSQL backend enabled and renders `${POSTGRES_*}` credentials in an entrypoint. First live end-to-end message proof: API submission → send_sms → bearerbox → fake SMSC → sent_sms → tenant-scoped grid.
- Fixed the pdfkit CommonJS import so PDF exports produce real PDFs (verified live).

- Added API platform primitives from the REST standard: migration 009 for tenant-scoped idempotency records and jobs, a global authenticated `Idempotency-Key` interceptor, `/api/v1/jobs` job create/list/get/cancel APIs, and raw `/api/v1/openapi.json` OpenAPI 3.1 output.
- Documented the API platform primitive behavior and remaining gaps in `docs/specifications/api/API_PLATFORM_PRIMITIVES.md`.
- Added configuration approval workflow support: migration 010 approval/deployment metadata, persisted native validation state, approve endpoints, deploy-before-approval protection, auditable rollback-to-new-approved-version behavior, and configuration workspace Validate/Approve/Deploy/Rollback plus version diff controls.
- Validation: backend Jest passed 23 suites/53 tests, backend TypeScript passed via `tsc --noEmit --incremental false` after the normal npm script hit the known sandbox write restriction creating `backend/dist/tsconfig.tsbuildinfo`, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.
- Follow-up validation after configuration workflow work: backend Jest passed 23 suites/56 tests, backend TypeScript passed, frontend Vue typecheck passed with the non-incremental command, frontend Vitest passed 6 suites/17 tests, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.
- Added audited SMSC runtime operations through the Engine Adapter boundary: test connection, enable, disable, reconnect, idempotency records, lifecycle state, and deployment history.
- Added route operation persistence with migration 007, route validation dry-runs, conflict checks, simulation endpoints, deploy/rollback/history records, and routing workspace UI actions.
- Extended the Vue module workspace with SMSC protocol-aware creation, route prefix/sender/fallback fields, a route simulator, route deployment controls, configuration deploy/rollback actions, and restored accessible table headers.
- Expanded Kamex SQLBox reads into normalized paginated message records, server-side filtering, message trace lookup, CSV export, and DLR reporting while preserving SQLBox as an engine-owned external data source.
- Added SQLBox retention governance: bounded dry-run/apply cleanup for native `sent_sms`, operator-created read indexes, authenticated CSV downloads with export row caps, status filtering, `messages.export` permission enforcement, and Messages workspace export/retention controls.
- Added a Prometheus/Grafana monitoring profile with backend Prometheus text metrics, Prometheus scrape configuration, Grafana datasource/dashboard provisioning, and environment placeholders.
- Added notification delivery foundations: migration 008, dashboard/webhook/email/SMS channel definitions, auditable notification delivery records, safe dashboard delivery, guarded webhook delivery, honest skipped status for unsupported transports, and alert notification APIs.
- Repaired the local backend dependency tree after partial `node_modules` installs (`bs-logger`, `exit`, `source-map`, `iterare`) and restored the full backend Jest suite.
- Validation: backend TypeScript passed, backend Jest passed 20 suites/46 tests, frontend Vue typecheck passed, frontend Vitest passed 6 suites/17 tests, frontend production build passed after elevated `.cache` write access, and Docker Compose/monitoring-profile config passed with expected missing-env warnings.

## 2026-07-07

- Integrated the official Kamex 1.8.3 SQLBox extension as a checksum-verified derivative of the pinned Kamex image and placed it correctly between bearerbox and smsbox.
- Made native `send_sms` and `sent_sms` tables the adapter boundary for outbound enqueue, message history, delivery reports, queue depth, and database-backed capability discovery.
- Extended deterministic configuration generation with environment-only PostgreSQL credentials and implemented version retrieval, atomic runtime writing, deployed/superseded transitions, audit, and authenticated Kamex graceful reload.
- Preserved honest degradation: APIs and capability manifests report SQLBox unavailable until the native tables can be probed.
- Added an internal, token-authenticated, resource-bounded Kamex validator that executes the vendor-native `bearerbox --test` command without Docker socket access; deployment now requires native acceptance and rolls back on failed reload/health verification.
- Implemented documented configuration history, diff, validate, deploy and rollback API surfaces, plus live engine monitoring/capability and audit-event read models.
- Added canonical requirements traceability and corrected project tracking so bounded foundations are no longer conflated with complete operational modules.

## 2026-07-06

- Organized the documentation-first repository into its production monorepo boundaries.
- Preserved visual assets under `design/design_spec/` and archived superseded planning material.
- Corrected API Gateway and Docker Deployment specification filename typos.
- Established the documentation catalog, project memory, state tracking, roadmap, ADRs, and progress logs.
- Added the Phase 1 Docker, NestJS health-check, and Vue application-shell scaffold.
- Reworked ADR-0007 and the Engine Capability Registry to assess Kamex independently from upstream Kannel.
- Added typed capability provenance/freshness, optional adapter providers, runtime-management safety metadata, and database-backed engine observability entities.
- Added deterministic npm lockfiles, corrected frontend TypeScript build configuration, and pinned Multer 2.2.0 to resolve runtime audit findings.
- Verified clean image builds, backend tests/typecheck, frontend production build, Compose configuration, and healthy four-service startup.
- Restored newly supplied master specifications and completed the missing Plugin SDK and telecommunications domain model.
- Initialized Git on `main`.
- Completed Phase 2 backend foundation: validated environment, JSON logging, API v1, correlation IDs, standard response/error handling, and integration harness.
- Reconciled the restored Plugin Development SDK into the canonical signed, scoped, testable SDK contract.
- Added and validated Phase 3 database migrations, SQL acceptance tests, and rollback paths.
- Added Phase 4 scrypt password hashing and signed typed-token primitives with tests.
- Added the Phase 5 permission-aware Vue operations shell and verified its production build.
- Added Phase 6 generic Engine Adapter core with deliberately distinct upstream Kannel and Kamex capability fixtures.
- Added PostgreSQL-backed authentication, refresh rotation, lockout, audit, bearer validation and RBAC guards; fixed deterministic refresh-token rotation with unique token IDs.
- Added tested Phase 8 deterministic configuration generation, Phase 9 SMSC validation, and Phase 10 priority/fallback routing foundations.
- Adopted Kamex as the first containerized runtime in ADR-0008; pinned official image 1.8.3 by OCI digest and validated bearerbox, smsbox, JSON status, and Prometheus metrics.
- Added tested Phase 11 message exploration, Phase 12 sustained alert evaluation, and Phase 13 delivery reporting foundations.
- Added migration 004 with tenant-RLS persistence for SMSCs, routes, alert rules/instances/acknowledgements, settings, invitations, and configuration-version isolation.
- Added guarded console APIs with same-transaction audit writes and explicit unavailable-source contracts for message and delivery-report ingestion.
- Replaced the mock frontend session with real login, refresh rotation, logout, `/auth/me`, permission guards, API retry handling, and CORS allowlisting.
- Completed the responsive console shell, global search, all planned module routes, honest loading/error/empty states, not-found handling, and contract-aligned create forms.
- Added Vitest component/API/router coverage; current validation passes 13 backend suites (26 tests) and 6 frontend suites (15 tests).
- Validated migration 004 up/down/up and SQL tenant-isolation behavior in a disposable database, then exercised authenticated SMSC, route, configuration, and setting workflows against the live stack.
- Revalidated zero known production dependency vulnerabilities, Compose configuration, frontend production build, and healthy Postgres, Redis, backend, frontend, Kamex bearerbox, and Kamex smsbox services.
- Added Phase 14 strict plugin manifest validation, signature/checksum policy, declared permissions/events, redacting host APIs, circuit breaking, and an explicit worker-process executor boundary without in-process isolation claims.
- Added Phase 15 deployment- and request-opt-in AI Operations using deterministic local rules, evidence redaction, tenant-RLS migration 005, audited assistance records, and human approval/rejection decisions without action execution.
- Added Phase 16 defensive API headers and PowerShell 5.1-compatible security, bounded concurrent readiness-load, and PostgreSQL dump/checksum/disposable-restore smoke checks.
- Final backend validation passes 17 suites and 40 tests; the readiness smoke completed 50 requests at concurrency 10 with zero failures and 205.62 ms p95, and backup restoration was verified before its temporary artifact was removed.
- Corrected Kamex bearerbox health-probe shell quoting so the status password environment variable is expanded rather than sent literally; bearerbox and smsbox revalidated healthy.
- Realigned the Vue console with `design/design_spec/` as visual authority: Public Sans typography, canonical violet/navy tokens, soft-shadow cards, floating topbar, grouped navigation, reusable stroked SVG icons, split-screen login, and JKANNEL/Kamex product language replaced the improvised blue admin theme and two-letter menu markers.
- Rebuilt login from the prototype's exact layout recipe: default-light 1.15/1 split, top-left mark, 460px circular three-card illustration, 340px form, Admin Console badge, username/password reveal, Remember Me, and violet submit treatment. Removed the invented orbit composition and visible tenant field.
- Changed the sidebar to match the prototype: the logo and Kamex footer stay fixed while only the padded navigation region scrolls with the canonical narrow violet scrollbar.
- Added a repository-owned Playwright/installed-Chrome acceptance harness for desktop and mobile visual checks when the VS Code Codex surface does not expose Browser Use's Node REPL tool.
