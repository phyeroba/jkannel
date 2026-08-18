# 14. Wildcard patterns, rule overrides, drops and duplicate control

**Read this when** you want one rule to cover a whole network's prefixes, need to
swap a blocked sender ID without touching every client, want unroutable traffic
refused instead of thrown at a carrier, or are being billed twice for a client's
retries.

These capabilities come from the SMS Studio feature set that operators here
already work with. [Guide 5, Routing](05-routing.md) covers the basics; this is
the depth on top.

---

## Wildcard patterns

### The grammar

| Symbol | Matches |
|---|---|
| `*` | any run of characters, including none |
| `#` | exactly one digit |
| `$` | exactly one letter |
| `\|` | alternation — this pattern **or** that one |

So all MTN Uganda numbers, which used to be four separate prefix rules:

```
25677*|25678*|25676*|25679*
```

One rule to create, one to keep in step, one to disable.

### Where you can use it

- **Route type `wildcard`** — matched against the destination number.
- **The sender constraint on any route** — this now uses the same matcher, so
  `URA*` and `URASMS|URAOTP` work. A pattern with no special characters is an
  exact match, which is what every rule written before meant, so nothing you
  already have changes behaviour.

### Rules that will save you a support ticket

**Patterns are anchored at both ends.** `77` matches *only* the string `77`, not
every number containing it. Write `*77*` if that is what you mean. This prevents
a short pattern silently over-blocking.

**Everything except `* # $ |` is literal.** A `.` is a full stop. `(a+)+b` is
that exact string. You cannot accidentally write a regular expression, which
also means you cannot accidentally write one that hangs the send path — and
content rules are evaluated inside the transaction of *every* message.

**An invalid pattern matches nothing.** A stray `|` gives you an error when you
save it. If a broken pattern somehow reaches the matcher it blocks nothing
rather than everything: a block rule that fails open is bad, one that fails
closed is an outage.

**A pattern is only as specific as its widest branch.** `25677*|*` matches
everything, so it will not beat a genuinely narrow rule just because its first
alternative looks precise.

**Case-insensitive by default.** `jkannel` matches `JKANNEL`.

---

## Rule overrides: rewriting a message on the way through

A route rule can now change three things about a matching message before it is
spooled.

| Field | Use it for |
|---|---|
| **Override From** | Swapping a blocked or throttled sender ID |
| **Override To** | Diverting a recipient (rare) |
| **Override Text** | Replacing a body (rarest, most audited) |

### The sender-ID failover

This is the one you will actually use. A carrier blocks or throttles `URASMS`.
Instead of editing every application that submits under it:

1. Create (or edit) the rule that matches the affected traffic — say route type
   `wildcard`, pattern `25677*|25678*`, i.e. MTN.
2. Set **Override From** to the replacement, e.g. `7077`.
3. Give it a priority above the normal MTN rule so it wins.

Every matching message now goes out as `7077`. Turn it off by disabling the
rule. No client change, no redeploy.

### What is recorded

The route decision for each message stores **both values**:

```json
{ "sender": { "from": "URASMS", "to": "7077" } }
```

Six months from now, "the customer says they sent from URASMS and the subscriber
saw 7077" has a defensible answer that names the rule and shows both. You can
see it on the message trace.

For a body override, only the **length** of the original is recorded, never its
content — the decision row is not a masked read path and lands in exports, so
copying a subscriber's message into it would route around
[guide 12](12-privacy-and-reveal.md) entirely.

### Two things overrides will not do

**They never apply to a pinned send.** If a caller names the SMSC directly, no
rule was consulted, and a rule that was never selected does not get to rewrite
the message.

**They are applied before entitlements are checked.** The overridden sender is
the one your sender-ID approval is checked against. Approving `URASMS` and then
transmitting `7077` would make that approval decorative.

---

## Dropping traffic

Set a rule's **action** to `drop` and give it a **reason**. Matching messages are
refused at submission: nothing is spooled, nothing is charged, and the caller
gets an explicit error naming the rule.

The classic use is a catch-all at the top of the list:

> *Ordinal 1 — "Unknown": drop everything matching `*`, reason "Unknown network
> prefix".*

with your real routes above it in specificity. Without it, traffic to a network
you have no route for falls through to whatever the last rule is and gets thrown
at a carrier that will reject it — paid for, and counted against that carrier's
delivery rate.

**A drop must state why.** Enforced by the database and again by the API.
"Traffic vanished" with no explanation is the worst thing this feature could
produce, so it is not a possible state.

**A dropping rule cannot also carry overrides.** Nothing is sent, so there is
nothing to rewrite, and a rule whose author believed it did both must not
silently do one.

Every drop is recorded as a **decision** with outcome `dropped` and the rule's
name — not merely as a rejection. You can find every message a rule dropped, and
say why.

---

## Duplicate control

### What it does

A client that retries a submission — usually because our response was slow and
its HTTP library gave up — used to send the subscriber two messages and be
billed for two. Now the second one is refused.

A duplicate is **the same content, to the same recipient, from the same sender,
within a short window**. Not unconditional: `Your OTP is 448120` to the same
number an hour later is a different message and must go.

### Configuring the window

Per tenant, on `tenants.mt_dedupe_window_seconds`:

- **60 seconds** by default — longer than any sane client timeout, far shorter
  than any legitimate repeat.
- **0** disables it, which is the right setting for a tenant whose traffic is
  legitimately repetitive.
- **3600** is the maximum. Longer starts suppressing real traffic, and a
  subscriber who never received their second OTP is the worse failure.

### Controlling it from the client side

Supply a **`foreignId`** and it becomes the key instead of the content hash.

- Two different references = two different messages, even if identical. A client
  that distinguishes them knows better than a content hash does.
- One reference reused = a retry, even if the body changed. A retry with a
  corrected body is still one message; sending both is the bug.

### What a suppressed caller sees

An HTTP 409 that tells them how to send it anyway:

> *An identical message to this recipient was submitted within the last 60s and
> was treated as a retry. The first one is message 4231. Supply a distinct
> foreignId if this really is a second message, or ask an administrator to
> shorten the duplicate window for this tenant.*

Deliberately specific. A refusal that reads as a generic error just trains
clients to retry harder.

### What is stored

A SHA-256 hash and an expiry. Never the number, never the body — that table
would otherwise be a second, unmasked copy of every message sitting outside
every masked read path.

Keys are released automatically if the send is then refused for another reason
(no route, no credit, blocked recipient), so your corrected retry seconds later
is not rejected as a duplicate of a message that never went.

---

## Reprioritizing spooled messages

**Live Queue → select rows → Reprioritize.** Raises or lowers the send priority
of messages still in the spool, in place.

This is the least destructive of the three intercept actions — cancel throws the
message away, reroute moves it to another carrier, this just lets it go sooner.
During a backlog it is what you actually want for OTP traffic stuck behind a
marketing campaign, and before it existed the only option was cancelling and
resubmitting, which loses the original id and its correlation.

Priorities are `0` (bulk) to `3` (highest). Only meaningful while a backlog
exists: with an idle bind the spool drains in under a second and nothing is
queued long enough to reorder. Messages the engine picked up mid-request are
reported as skipped rather than silently counted.

---

## Re-dispatching an inbound message

**MO Routing → Messages → open one → Re-dispatch.**

The commonest inbound support case is a message sitting in `no_match` because
the rule that should have caught it did not exist yet, was disabled, or had a
typo. Fix the rule, then re-dispatch — it runs the same matching and fan-out as
the original ingest.

It refuses if the message still has pending or running deliveries. Re-dispatching
those would deliver twice, and "the customer got the same MO twice" is worse than
waiting for the first attempt to settle.

If it still matches nothing, it says so and tells you what to check, rather than
reporting "0 deliveries" as though something failed.

---

## Related

- [05. Routing](05-routing.md) — route types, priority, failover, the simulator
- [03. Sending messages](03-sending-messages.md) — `foreignId` on submission
- [04. Live Queue and recovery](04-live-queue-and-recovery.md) — cancel and reroute
- [12. Privacy and reveal](12-privacy-and-reveal.md) — why overrides record lengths, not bodies
