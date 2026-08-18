# Per-deployment configuration

**Audience:** anyone running JKANNEL on a machine that is not their laptop.

**The rule:** configuration that describes a *machine* never enters the
repository. Ports, bind addresses, hostnames and test fixtures are properties of
a host, not of the product.

---

## Why this is a rule and not a preference

`docker-compose.override.yml` is **auto-loaded** by Compose. Nobody opts into
it, nobody passes a `-f` flag, and nothing in the command line hints that it
applied.

So committing one machine's copy silently imposes that machine's topology on
every developer who pulls. They would find their stack bound to different ports,
carrying a fake SMSC bind they never asked for, with no visible cause. It was
briefly committed here; this layout is the correction.

Two developers sharing one committed override would also simply fight over
ports, forever, in a file neither can change without breaking the other.

---

## Layout

```
docker-compose.override.example.yml   committed  — the documented template
deploy/                               IGNORED    — real files, one dir per host
  caps/
    docker-compose.override.yml
  <your-host>/
    docker-compose.override.yml
scripts/deploy-config.ps1             committed  — ships deploy/<host>/ to <host>
```

`deploy/` and `docker-compose.override.yml` are both in `.gitignore`. The
template is not, because a template with no secrets and no host in it is exactly
what a new developer needs.

---

## Setting up a new host

```powershell
mkdir deploy\myhost
copy docker-compose.override.example.yml deploy\myhost\docker-compose.override.yml
# edit ports to suit; delete the loopback-bind block if you have a real carrier
```

Add an SSH alias in `~/.ssh/config`, then:

```powershell
./scripts/deploy-config.ps1 -TargetHost myhost -WhatIf   # diff only
./scripts/deploy-config.ps1 -TargetHost myhost           # ship it
```

`-Name` lets the directory differ from the SSH alias — ours is
`-TargetHost cpaas-gcp -Name caps`, because the alias and the hostname are not
the same word.

### On your own laptop

You probably need none of this. The base `docker-compose.yml` works as-is. An
override is for when something *else* fronts the stack — a system nginx
terminating TLS — or when you must avoid a port another project holds.

---

## What the script does, and refuses to do

**Copies, verbatim.** No templating, no generation. The file on your disk is
byte-for-byte the file on the server, so "what is actually deployed?" is
answerable by checksum instead of inference.

**Backs up before overwriting**, timestamped in place
(`<file>.bak-YYYYmmdd-HHMMSS`), matching the convention already on the host.

**Verifies after writing.** It re-reads the server's checksum and throws on a
mismatch, so a truncated transfer fails loudly rather than leaving a half-file
that Compose will happily parse into something unintended.

**Stages through `/tmp`.** `/home/hyeroba` is not traversable by the login
account, so `scp` straight to the target path fails with *Permission denied*.

**Refuses to ship anything that looks like a secret** — a filename matching
`.env`/`.pem`/`.key`/`credentials`, or any file containing a `password`,
`secret`, `api_key` or `token` assignment. Deployment config is not a secrets
store. Secrets live in the server's own `0600` `.env`, which this script never
touches: shipping one would put it in your shell history and in any terminal
capture of the run.

That guard is tested by planting a decoy and confirming the ship aborts.

---

## The two traps this layout exists around

**`!override` is not optional.** Compose *merges* sequence fields. An override
that lists `ports:` without the tag leaves the base file's `0.0.0.0` bindings in
place *alongside* yours — the services stay publicly reachable, which is the
exact thing you were preventing, and the duplicate bind then fails with
"address already in use". The template carries this warning inline.

**A fake bind is not a carrier.** `loopback-bind` attaches Kannel's `fakesmsc`
so one SMSC shows as online and the pipeline becomes exercisable before a
carrier exists. Messages routed to it are accepted and **discarded** — a test
send reports success and delivers nothing. Delete the service and its SMSC the
moment a real carrier is configured.

---

## Related

- [Deployment runbook](REDESIGN_DEPLOYMENT_RUNBOOK.md) — migrations, env vars, rollback
- `.gitignore` — the per-deployment block, with the reasoning
