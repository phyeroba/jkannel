# 12. Subscriber privacy: masking and audited reveal

**Read this when** you look at a message and see `+2567••••••18` instead of a phone
number, or when you need the real number to answer a support ticket.

---

## The short version

Subscriber numbers and message bodies are **masked by default** on every screen
that shows them. To see the real values you need the `messages.reveal`
permission *and* an open reveal window — a short, reasoned, audited period you
request when you need it. Windows last 15 minutes by default and every row you
read under one is recorded.

---

## What a masked value looks like

| Field | Real value | On screen |
|---|---|---|
| Recipient | `+256772000118` | `+2567••••••18` |
| Sender (subscriber) | `256700123456` | `2567••••••56` |
| Sender (service) | `JKANNEL`, `8000` | `JKANNEL`, `8000` — unchanged |
| Message body | `Your OTP is 448120` | `[18 characters hidden]` |

Three things to notice.

**The country prefix and last two digits survive.** That is deliberate. Support
work needs you to *recognise* a number — "is this the same subscriber who called
yesterday?", "is this even a Ugandan number?" — not read it. Hiding the field
entirely would make the console useless for triage and push people to query the
database directly, which nothing audits.

**Short codes and alphanumeric sender IDs are never masked.** `JKANNEL` and
`8000` identify a *service*, not a person. Masking them would hide the one thing
you are usually looking at.

**The body's length survives.** `[480 characters hidden]` tells you it is a
four-part message, which is a billing fact, without telling you what it said.

> **A masked value is not a real one.** Do not paste `+2567••••••18` into a
> carrier ticket. Every masked screen carries a notice saying exactly this,
> and it cannot be dismissed.

---

## Where masking applies

Everywhere subscriber data appears:

- **Messages** grid and CSV/PDF exports
- **Message Trace** — both the timeline and the raw engine rows
- **Queues** — the spool
- **Delivery Reports** and their export
- **MO messages** — inbound, both the grid and a single message

Exports mask on the same terms as the screen they were raised from. A CSV
carries an `x-jkannel-masked` header and a PDF says so in its caption, so a file
full of `+2567••••••18` is never a mystery to whoever opens it.

---

## Revealing real values

### 1. Check you have the permission

`messages.reveal` is **separate from** `messages.view`, deliberately. Nearly
every operator holds `messages.view` because it is also what lets you see that a
message exists at all; if it carried the subscriber's number too, masking would
protect nobody.

It is granted by default to **Super Administrator, Administrator, Operations
Engineer and Support Engineer**. Not to Read Only, not to Auditor (an auditor
reads the trail, not the traffic), not to API Client, not to Network Engineer.

If you do not have it, the masked panel says so and names the permission to ask
your administrator for.

### 2. Open a window

On any masked screen, click **Reveal real values…**. You are asked for:

- **A reason.** At least three characters, and it is recorded against every row
  you then read. Write what you would want to read six months from now:
  `ticket 4412 — customer reports the OTP never arrived` beats `checking`.
- **A window**, in minutes. 15 by default, 60 maximum.

The screen re-fetches and shows real values, with a countdown.

### 3. Close it when you are done

Click **Close the window now**. You do not have to — it expires on its own, and
when it does the screen re-fetches and re-masks itself automatically.

### Scoped windows

Message Trace and a single MO message request a window **scoped to that one
message**. A grant taken out to investigate one complaint unmasks that
complaint, and nothing else. This is the narrowest thing that answers the
question, and it is the right habit.

---

## What gets recorded

Two separate facts, because they are different questions.

**That you were authorised.** Requesting a window writes a
`pii.reveal.granted` audit entry with your reason and the window length.

**That you actually looked.** Every read under an open window writes a
`pii.revealed` entry carrying **how many rows** were disclosed and which screen
it was. An operator who requested a window and never looked is not the same as
one who exported four thousand numbers, and after a privacy question that is
exactly the distinction being investigated.

Revoking writes `pii.reveal.revoked`. Grants are never deleted — revoking sets a
timestamp and the row stays, so the record of who could see what cannot be
erased by the person who did the looking. The application role has no `DELETE`
right on that table at all.

Find all of it under **Logs & Audit**, filtering on the `pii.` action prefix.

---

## Frequently asked

**Why did my window disappear?**
It expired. They are short on purpose: long enough to work one investigation,
short enough that forgetting to close one does not leave you holding the whole
estate for a shift.

**I have a window open but this screen is still masked.**
The window may be scoped to a different message. Scoped windows only unmask what
they name.

**Can I turn masking off?**
No, and that is the point. Masking is the default state, not a setting.

**Does the API mask too?**
Yes. Every read endpoint returns a `privacy` block saying whether what it sent
was masked, and reveal works the same way — `?reveal=true` on the request, with
a live grant. See `POST /api/v1/privacy/reveal` in the API Reference.

**Does this slow anything down?**
No. Masking is applied in memory to the rows already fetched. Without a reveal
request, the reveal service is not consulted at all.

---

## Related

- [10. Users, roles and permissions](10-users-and-roles.md) — granting `messages.reveal`
- [11. Troubleshooting and FAQ](11-troubleshooting.md)
