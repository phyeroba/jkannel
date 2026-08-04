# 9. Backup and restore

Protecting the control plane's data, and — the part people skip — proving that a backup
is actually usable before you need it.

---

## What is and is not backed up

| Included | Not included |
|---|---|
| The PostgreSQL database: messages metadata, SMSC definitions, routes, configuration versions, customers, audit log | **Application code** — it lives in version control |
| Rendered engine **configuration** versions | The engine's own spool on disk |
| **Certificates** | Anything outside the containers |

The help panel on the screen says the same thing, including the objectives:
**RTO under 1 hour, RPO under 15 minutes**.

## Before your first backup

> **`BACKUP_ENCRYPTION_KEY` is mandatory.** A backup will not run without a real key,
> and placeholder values are rejected. There is no weak fallback and no unencrypted
> mode. Set it in `.env` before you do anything else.

---

## Create a backup

1. Go to **Backup & Restore** (Platform group).
2. Click **Create backup**. A dialog opens.
3. Fill in:

   | Field | Options |
   |---|---|
   | **Backup name (label)** | e.g. `pre-upgrade snapshot`. |
   | **Kind** | `full` (default) · `schema` · `incremental` |
   | **Retention class** | `hourly` · `daily` · `weekly` · `monthly` · `yearly` · `manual` (default) |
   | **Scope** | **Full (database + configurations)** · **Database only** · **Configurations only** |

4. Click **Create backup**. You get *"Backup requested."*

The hint under Retention class is worth reading: *"The retention class decides how long
the backup survives the retention sweep; manual is never expired automatically."*

> **`incremental` is not really incremental.** Asking for one records a **full** backup
> with an explanatory note. The label was retired rather than faked. Plan around full
> backups.

The grid shows: **Label**, **Scope**, **Kind**, **Status**, **Retention**,
**Verified** (reads `never` until you verify), **Size**, **Offsite** (reads *"not synced
offsite"* until it is), **Checksum**, **Started**, **Completed**, **Warning**,
**Actions**.

## Schedule backups

Manual backups are not a strategy. The **Schedules & retention** panel is blunt about
it: *"No backup schedules are defined — backups only happen when somebody clicks Create
backup."*

1. Click **New schedule** (needs `system.manage`).
2. Fill in:

   | Field | Options |
   |---|---|
   | **Name** | e.g. `Nightly full`. |
   | **Trigger** | **Every N minutes** or **Cron expression**. |
   | **Interval (minutes)** or **Cron** | e.g. `0 2 * * *`. |
   | **Kind** | full / schema / incremental. |
   | **Retention class** | hourly … yearly / manual. |
   | **Enabled** | Yes / No. |

3. Click **Create schedule**.

The schedule grid shows **Schedule**, **Trigger**, **Kind**, **Retention**, **Enabled**,
**Last run**, **Next run**.

A reasonable starting pair: a nightly `full`/`daily` at 02:00, and a weekly
`full`/`weekly` on Sunday.

**A failed backup raises an alert** rather than passing silently — provided you have
somewhere for alerts to go ([guide 6](06-monitoring-and-alerts.md)).

## Apply retention

**Apply retention now** runs the sweep immediately. The confirmation is explicit:

> *Apply retention now?*
>
> *Every backup older than its retention class window is expired and its artifact
> removed. This cannot be undone.*

Retention windows are fixed per class in the backup service. **Manual backups are never
expired automatically.**

---

## Verify a backup — do this regularly

An unverified backup is a hope, not a plan.

1. Find the backup in the grid.
2. Click **Verify** on its row. There is no confirmation dialog.
3. You get *"Verification for {name}: {status}."*, and the **Verified** column gets a
   timestamp.

Verification re-checks the artifact's integrity (`pg_restore --list`) and its checksum.
A verification failure opens an alert.

## Restore

> **Restore never touches the live system.** The backup is restored into an **isolated
> verification database**. This is deliberate: there is no one-click production restore
> and there will not be one. Restoring to production is a runbook operation performed
> deliberately outside the console.

1. Click **Restore** on the backup's row.
2. The panel **Restore from {name}** opens. Its hint: *"The backup is restored into an
   isolated verify database, not the live system. Provide a reason for the audit
   trail."*
3. Enter a **Reason**.
4. Click **Request restore**.
5. Confirm the browser dialog: *"Authorize restore from {name}? The backup is restored
   into an isolated verify database, not the live system."*

Use this as a **restore drill**: pick a recent backup, restore it into the verification
database, connect to that database and check that your SMSC definitions, routes and
audit rows are all there. Do it on a schedule. A backup you have never restored is
untested.

### Restoring to production for real

Outside the console:

1. Stop the backend (and the workers, if you run the `workers` profile) so nothing
   writes.
2. Decrypt the artifact with `BACKUP_ENCRYPTION_KEY`.
3. `pg_restore` into the target database.
4. Restore the captured configuration and certificates.
5. Start the backend. Migrations run on boot and will reconcile the schema version.
6. Verify: sign in, check **SMSC Connections**, check **Logs & Audit**, and run a
   **Configuration → Check now** drift check before you redeploy anything.

---

## Offsite copies

Two destination drivers ship. Choose with `BACKUP_DESTINATION`.

### `local` — a filesystem copy

Set `BACKUP_OFFSITE_DIR`. Genuinely off-host only if you point it at a **mounted network
volume** (NFS, SMB, or a FUSE mount). If the mount silently disappears, the copy lands
on local disk again — monitor the mount separately.

### `s3` — object storage

Works with AWS S3 and with S3-compatible stores such as MinIO and Ceph.

| Variable | Notes |
|---|---|
| `BACKUP_S3_BUCKET` | Required. |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | Credentials. |
| `BACKUP_S3_REGION` | e.g. `us-east-1`. |
| `BACKUP_S3_ENDPOINT` | Leave unset for AWS; set it for MinIO/Ceph. |
| `BACKUP_S3_FORCE_PATH_STYLE` | Usually `true` for MinIO/Ceph, `false` for AWS. |
| `BACKUP_S3_PREFIX` | Key prefix, e.g. `prod`. |
| `BACKUP_S3_SSE`, `BACKUP_S3_SSE_KMS_KEY_ID` | Server-side encryption, on top of JKANNEL's own encryption. |
| `BACKUP_S3_SESSION_TOKEN` | For temporary credentials. |
| `BACKUP_S3_MAX_OBJECT_BYTES`, `BACKUP_S3_TIMEOUT_MS` | Guard rails. |

Confirm it is working by checking that the **Offsite** column stops reading *"not synced
offsite"*. Do not assume — a misconfigured destination is exactly the failure you will
not notice until you need the backup.

---

## What is not available

- **No point-in-time recovery.** There is no WAL archiving and no `archive_command`
  anywhere. Your recovery granularity is the interval between backups.
- **No one-click production restore** — by design.
- **No true incremental backups.**
- **No Azure Blob or SFTP destination.** Local filesystem and S3-compatible only.

## Recovery-objective reality check

The screen states RTO under 1 hour and RPO under 15 minutes. Those are the *design*
objectives. With hourly full backups and no PITR your real RPO is up to one hour, and
your real RTO is however long a `pg_restore` of your database size takes plus your
manual steps. **Measure both in a drill** and set your schedule from the measurement,
not from the stated objective.

Note also that a multi-node HA failover drill with measured RPO/RTO has **not** been
performed. The HA overlay (`docker-compose.ha.yml`) is config-validated but has never
been exercised on real hosts, and that is recorded as outstanding evidence rather than
claimed as done.

---

Next: [Users, roles and permissions →](10-users-and-roles.md)
