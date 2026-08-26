# The four Kamex engine defects — status

**Short answer: all four are closed, and were closed on 2026-08-06 in commit
`625a065`.** The plan that described them as pending, and the note carrying them
forward "to the week of 2026-08-24", were both stale by three weeks. This
document exists so nobody has to work that out again.

## Where these came from

The Kamex maintainer reviewed a third-party PR adding SMSC management to the
engine's own admin panel. That PR is not ours and none of the reviewed code is
ours — but four of the findings describe behaviour in the **engine we depend
on**, and JKANNEL drives exactly those mechanisms. Most of the maintainer's list
does not apply to us, because the control-plane boundary already avoids it: we
validate configuration in an isolated container before writing, we set
`status-password`, Vue escapes our output, and SQLBox owns message history.

Four applied. Each is below with what it was, what was done, and how the claim
is checked — because "the file exists" and "the defect is closed" are different
statements, and this repository has been bitten by the difference.

---

## 1. A wrong password progressively bricks the engine's admin port

**The defect.** `httpd_check_authorization` keeps a *process-global* sleep
counter: +1 second per failed authentication, slept on the single thread that
serves `/health`, `/status`, `/shutdown` and `/graceful-restart`. It never
resets while the process lives.

**Why it applied to us.** JKANNEL drives that port continuously, and nothing
backed off:

| Source | Rate | Password |
|---|---|---|
| bearerbox container healthcheck | 6/min, forever | status |
| `smsc-status.poller.ts` | 2/min | status |
| Live Queue tab (5s poll) | 12/min **per open tab** | status |
| Operations Overview tab (30s) | 2/min per tab | status |

With a wrong password that is 20+ failed authentications a minute. Within about
an hour the admin port stops answering — which takes out health monitoring *and*
the configuration deploy path. It presents as "the engine went unresponsive",
never as "the password is wrong", and `restart: unless-stopped` does not act on
unhealthy, so it does not self-heal.

**Closed by** `backend/src/engine/kamex-request-gate.ts`, consulted by the
adapter on every authenticated call — `coreDiagnostics()`, `queueSnapshot()` and
`adminCommand()`. The gate is in the adapter and not in the poller deliberately:
the poller is 2 of the ~20 requests a minute, and one open Live Queue tab is six
times worse. One gate covers every caller.

Consecutive failures widen a suppression window; success resets it. It gates on
failures of *any* kind, so it also protects an engine that is merely down.

**The credential case is distinguished**, which the original analysis thought
impossible. Status codes cannot tell them apart, and after three failures the
engine's own sleep exceeds the 3s client timeout so no response arrives at all.
But `/health` takes **no password** while `/status.json` does — `/health` OK
with `/status.json` failing is a differential diagnosis for a bad credential.
On that signal the gate classifies the outage as `credentials` rather than
`unreachable`, so the operator is told which one it is.

**Verified.** `kamex-request-gate.spec.ts`, passing.

---

## 2 & 3. Operator input reaching the engine config unescaped

**The defect.** Two emitters. `quoted` escaped `"` but not `\`, so a value
ending in a backslash escapes its own closing quote. `push` — used for `host`,
`smsc-username`, `system-type`, `address-range`, `alt-charset`,
`bearerbox-host` and more — quoted and escaped *nothing*, so a newline in any of
them injects arbitrary directives.

Separately, Kannel detects `include` by substring-searching the raw line and
`panic()`s if the right-hand side does not `lstat()`. So any value merely
*containing* the word — `includes.vendor.net` — makes bearerbox refuse to start
until somebody edits the file by hand.

**Closed by** `backend/src/configuration/config-value-safety.ts`, applied at
both layers: write time (`smsc.service.ts`, `carrier.service.ts`, the settings
handler in `console.controllers.ts`) and generate time (the generator's
`validate()`), so `POST /configurations/generate?source=body` is covered too.

Rejecting beats escaping here: it covers `push`, which cannot escape anything,
and `quoted` together; it changes generated output for no value that is
currently valid; and it reports the problem when the operator types it rather
than as an opaque deploy failure long afterwards.

**Verified against the running API on 2026-08-27**, not by reading:

```
REJECTED  newline in host (directive injection)        400
REJECTED  backslash (escapes its own closing quote)    400
REJECTED  double quote (breaks out of the value)       400
REJECTED  leading # (comment injection)                400
REJECTED  contains "include" (cfg.c panics)            400
REJECTED  over-length (>512)                           400
ACCEPTED  a normal host (the control)                  201
```

The control matters: without it, "everything was rejected" would read as a pass.
Each refusal names the character and why it is dangerous.

---

## 4. No fsync before rename

**The defect.** `rename` is atomic against a concurrent *reader*, but it is not
a barrier against power loss: the rename can reach the disk while the file's
contents have not, leaving a correctly-named, truncated configuration. The
engine's parser panics on a malformed file and keeps panicking on every restart,
so the cost of that window is a gateway that will not boot until somebody edits
the file by hand.

**Closed by** `writeDurable()` in `configuration-deployment.service.ts`: open →
write → `handle.sync()` → close → `rename` → fsync the directory. The directory
sync is separate and necessary — the file's own fsync makes its *contents*
durable, but the directory entry `rename` creates is separate metadata.

Directory fsync is best-effort and documented as such: it fails with
EISDIR/EPERM on some platforms (notably Windows, where developers run this), and
failing the whole deployment over the weaker of the two barriers would trade a
real outage for a theoretical one.

**Verified.** `configuration-deployment.service.spec.ts` asserts the ordering —
file synced before rename, directory after.

---

## 5. The authenticated container healthcheck (added to the list)

Not one of the four, but the same mechanism: the bearerbox healthcheck used to
probe `/status.json?password=`, spending a failed authentication attempt every
ten seconds against defect 1's global counter.

It now probes unauthenticated `/health` and accepts **200 or 503**, because
Kamex answers 503 whenever no SMSC is bound — a statement about the carriers,
not about the engine. Conflating "no carrier bound" with "process dead" is not
something a container healthcheck should restart on.

---

## What is genuinely still open on the engine

Neither of these is a defect we can close in this repository:

- **The admin password travels in the `/graceful-restart` query string.** Kannel
  offers no other interface. Contained by binding the admin port to loopback.
- **`POST /mo/inbound` is not wired to Kannel push.** MO already works through
  the engine sweep now that the polling bug is fixed, so push is a latency
  optimisation that needs a security-sensitive auth change and deserves its own
  decision rather than being folded into this.
