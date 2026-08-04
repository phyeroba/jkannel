# 2. Connecting an SMSC

This guide takes you from nothing to a gateway connection the engine is actually
running: **create → generate config → validate → approve → deploy → verify the bind**.

It also tells you the two things that most often stop a carrier bind from coming up,
neither of which is a software fault.

---

## The two rules before you start

**1. Your carrier must allow-list your egress IP.**
An SMPP server accepts connections only from source IPs the carrier has pre-authorised.
If your egress IP is not on that list, the bind attempt is refused at the TCP level
(`ECONNREFUSED` / errno 111) and nothing in JKANNEL can change that. Send the carrier
the **public egress IP of the host running the engine container** and ask for SMPP
access. If you later move the platform to a different host, the new host's egress IP
must be allow-listed instead.

**2. Every `requiredSecrets` variable must exist in the engine container's environment.**
JKANNEL never writes a password into a configuration file. It renders `${VARNAME}`
placeholders and tells you which variables it expects. Kamex expands those from **its
own** environment when it parses the config. If a variable is missing, the engine starts
with an unresolved placeholder and the bind fails with a credential error. Details in
[step 3](#step-3--read-requiredsecrets-and-put-them-in-the-engine-environment).

---

## Step 1 — Create the connection

1. Go to **SMSC Connections** (Messaging group).
2. Click **Add SMSC**. The composer opens with the heading **Create SMSC**.
3. Fill in:

   | Field | Notes |
   |---|---|
   | **Name** | Required. The engine id is derived from it automatically (lower-cased, non-alphanumerics replaced with `-`). |
   | **Protocol** | **Fake SMSC** (default), **SMPP client**, **HTTP SMS**, or **AT modem**. Choose **SMPP client** for a carrier. |
   | **Host** | Shown only when the protocol is not Fake. Required for a carrier. |
   | **Port** | Shown only when the protocol is not Fake. Defaults to 2775. |
   | **TPS limit** | Defaults to 10. |

4. Note the helper text: *"Credentials use secret references; plaintext passwords are
   never stored here."*
5. Click **Create**.

> **The create form does not cover the whole SMPP attribute set.** It sets name,
> protocol, host, port and TPS. The credential secret reference, system ID, system
> type, bind mode, interface version, TON/NPI, window size, keepalive, reconnect delay,
> address range and TLS flag are stored on the SMSC record and rendered into the
> configuration, but there is **no console field for them yet**. Set them with the API
> until there is — see [Setting the attributes the form does not
> expose](#setting-the-attributes-the-form-does-not-expose) below. For a carrier bind
> you will need at least `credentialSecretRef` and usually `systemId`.

The new row appears in the grid with these columns: **SMSC**, **Type**, **Host:port**,
**System ID**, **TPS**, **Priority**, **Lifecycle**, **Enabled**, **Health**, **Tags**,
**Last error**, **Updated**, **Actions**.

### Setting the attributes the form does not expose

`PATCH /smscs/{id}` accepts them. The credential reference must be a `secret://` URI —
the API rejects a plaintext password outright, which is the point.

```bash
curl -X PATCH https://your-console/api/v1/smscs/<smsc-uuid> \
  -H "Authorization: Bearer <your access token>" \
  -H "Content-Type: application/json" \
  -d '{
        "credentialSecretRef": "secret://smsc/acme-carrier-password",
        "systemId": "acmeco",
        "systemType": "SMPP",
        "bindMode": "transceiver",
        "interfaceVersion": 52,
        "sourceAddrTon": 5,
        "sourceAddrNpi": 0,
        "destAddrTon": 1,
        "destAddrNpi": 1,
        "windowSize": 10,
        "keepaliveSeconds": 30,
        "reconnectDelaySeconds": 30,
        "useTls": false
      }'
```

The full machine-readable schema is at `/api/v1/openapi.json`.

## Step 2 — Generate the configuration

The configuration generator builds a complete, working gateway config **from the SMSC
records in the database**. What you created in step 1 is what gets rendered.

1. Go to **Configuration**.
2. Click **Create configuration**.
3. Set **Scope**. The help panel on the page explains the two forms:
   - `gateway` — the whole engine (bearerbox + smsbox); use this for global settings.
   - `smsc:<engine-id>` — an override scoped to a single SMSC connection.
4. Leave **Admin port** (default 13000) and **Bearerbox/SMSBox port** (default 13001)
   alone unless your deployment remaps them.
5. Leave **Enable PostgreSQL SQLBox integration** ticked. SQLBox is how messages and
   delivery reports reach the console.
6. Click **Create**. The console generates the config from the database, validates it,
   and saves it as a new immutable version.

You can also click **Load baseline** first to start from a known-good starting point,
or use a template — see [Templates](#templates) below.

## Step 3 — Read `requiredSecrets` and put them in the engine environment

The generate response includes `requiredSecrets`: a sorted, de-duplicated list of the
environment variable names the rendered file expects, derived from every `secret://`
reference in the model. For example, `secret://smsc/acme-carrier-password` becomes an
environment variable name the engine must supply.

> **The console does not currently display this list.** The frontend drops the field.
> Until it is surfaced, read it from the API:
>
> ```bash
> curl -X POST https://your-console/api/v1/configurations/generate \
>   -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}' \
>   | jq '.data.requiredSecrets'
> ```

Then make each of those variables available to the **engine** container — in your
`.env`, in the Compose service environment, or from your secret store. Restart or
recreate the engine container so it picks them up.

A missing variable is not silently tolerated: `JKANNEL_SECRETS_STRICT=true` turns a
missing secret into a hard failure at render time instead of shipping a broken file.

## Step 4 — Validate, approve and deploy

Configuration versions are immutable and move through a workflow. In the grid, each row
has these actions:

1. **Validate** — runs the engine's **own native validator** (`bearerbox --test`)
   against the rendered file. A version that does not validate cannot be deployed.
2. **Approve** — marks the immutable version approved. Deploying an unapproved version
   is rejected.
3. **Deploy** — writes the config atomically and reloads the engine. **If the
   post-deploy health check fails, the deploy rolls back automatically.**
4. **Rollback** — creates a *new* approved rollback version derived from the previous
   target and deploys that. History is never rewritten in place.

The in-page note states the order plainly: *"Validate generated output, approve the
immutable version, then deploy. Rollback creates a new approved rollback version before
deployment."*

### Comparing versions

In the **Configuration workflow** panel, paste two version UUIDs into **Compare from
version ID** and **Compare to version ID** and click **Compare versions**. You get the
changed-line count and the diff.

The diff is rendered as a plain text block, not a side-by-side editor.

### Drift detection

The **Configuration drift** panel compares the deployed configuration against what is
actually live on the engine.

1. Click **Check now**.
2. Read the status strip: **In sync** or **Drift detected**, plus **Deployed
   checksum**, **Live checksum** and **Config path**.

Drift means somebody changed the file on the engine host outside JKANNEL. Redeploy from
the console to bring them back into agreement.

### Templates

The **Configuration templates** panel lists reusable starting points. Built-in
templates are read-only. Per row:

- **View** shows the content.
- **Instantiate** creates a working copy. Then click **Use in create form** to load it
  into the create composer and save it as a version.

## Step 5 — Bring the connection up and verify it

Back on **SMSC Connections**, each row has three actions:

| Action | What it actually does |
|---|---|
| **Test** | Attempts a **real SMPP bind** — a `bind_transceiver` PDU (or transmitter/receiver, per the bind mode), reads the response, reports the `ESME_*` status, then politely unbinds. |
| **Reconnect** | A **genuine stop-then-start cycle**: observes the bind, issues `stop-smsc`, waits for it to leave `online`, issues `start-smsc`, waits for it to come back. |
| **Disable** / **Enable** | Stops or starts that one SMSC in the engine. Other binds keep running. |

Both actions now report **how far they actually got**, and you should read that field
rather than just the green tick.

**Test connection** returns a verification level:

| Level | Meaning |
|---|---|
| `smpp_bind` | A real SMPP bind succeeded. This is the one that proves credentials. |
| `tcp_socket` | Only a socket was opened. The detail says verbatim *"This is NOT an SMPP bind — …"* with the reason. |
| `not_applicable` | Nothing was checked. |

> **The common reason you get `tcp_socket` instead of `smpp_bind`** is that the standard
> deployment keeps SMSC credentials in the **engine** container, not the API container.
> If the API cannot resolve `credential_secret_ref` or `system_id`, it falls back to a
> TCP connect and says so. To get a true bind test from the console, the credential
> must also be resolvable where the API runs.

Per SMSC type: a `fake` SMSC returns `not_applicable` and passes without checking
anything; `http`, `at` and any non-SMPP type get a TCP connect only, with a detail
explaining there is no SMPP bind to verify.

Note also that a TLS bind probe does **not** validate the certificate chain.

**Reconnect** records `bind_cycled` when the drop was actually observed, or
`command_accepted` when the commands fired but bearerbox's status could not be read, or
the carrier was slower than the bounded wait (5 s to stop, 10 s to start). Reconnect is
gated on the engine advertising the `runtime.smsc.reconnect` capability; if it does not,
the call is refused rather than silently doing nothing.

Enable, disable and reconnect all go through bearerbox's admin interface for every SMSC
type, so they need `KAMEX_BASE_URL` and `KAMEX_ADMIN_PASSWORD` configured or they fail
with "Kamex administrative endpoint is not configured".

To see the real state, use these instead:

- Click the row to open **SMSC detail**. It shows **Recent health** (state, detail,
  latency, timestamp) and **Recent operations** (operation, status, detail, timestamp).
- Go to **Live Queue**. The **Binds** section shows what the engine itself reports:
  status, queue depth, **Failed**, **Sent**, **Received**, **Outbound rate**. This is
  the honest answer to "is it bound?".

A bind polls continuously in the background. Every state transition is recorded and
audited, and a degradation raises a deduplicated alert with anti-flap confirmation.

## Troubleshooting a bind that will not come up

| Symptom | Almost always means |
|---|---|
| Test returns `tcp_socket`, not `smpp_bind` | The API container cannot resolve the credential. The socket opened, but nothing about your credentials was proven. |
| Test returns an `ESME_*` error status | A real bind was attempted and the carrier rejected it. The status code tells you why — `ESME_RINVSYSID`, `ESME_RINVPASWD`, `ESME_RBINDFAIL` and so on. Check `credentialSecretRef`, `systemId`, `systemType`, `bindMode`. |
| Test fails with connection refused | The carrier has not allow-listed your egress IP, or the host/port is wrong. This is rule 1. |
| Engine log shows a literal `${SOMETHING}` | The variable is missing from the *engine container's* environment. This is rule 2. |
| Bind flaps up and down | Window size or keepalive too aggressive for the carrier, or the carrier is throttling. Lower `windowSize`, raise `keepaliveSeconds`. |
| `Last error` column populated | Read it. It is the engine's own message, not a JKANNEL interpretation. |

## Honest limits of this workflow

- **A generated configuration has still never been bound to a real carrier.** The render
  is complete and correct as far as the native validator is concerned, and the engine
  expands its `${VAR}` placeholders correctly — but the create → deploy → **bind**
  chain has not been proven against a live SMSC, because that needs carrier IP
  allow-listing. It is tracked as an outstanding external evidence gate, not as done.
- **One config file per engine.** Multiple tenants deploying configuration to the same
  engine would overwrite each other.
- **SMSC types are 4 of 7**: `smpp`, `http`, `fake`, `at`. There is no SMPP-server,
  CIMD2 or EMI/UCP type.
- **Upstream-Kannel rendering is not implemented** — the Kannel arm of the generator
  throws. Kamex is the supported engine.
- **No SMSC groups, clone, bulk edit or import.**

## Archiving a connection

Open the row, click **Delete / Archive**, and confirm. The dialog reads *"Archive SMSC
{name}? Routes referencing it must be repointed first."* If a route still points at it
you get a 409 and the message *"This SMSC is still referenced by one or more routes and
cannot be archived."* Repoint the route first — see [guide 5](05-routing.md).

---

Next: [Sending messages →](03-sending-messages.md)
