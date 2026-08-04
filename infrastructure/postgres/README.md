# PostgreSQL

PostgreSQL is JKANNEL's system of record. Canonical ordered migrations and their validation contract live in `database/`; this infrastructure folder contains deployment notes only. Application identities must not own schema objects, and credentials come from the untracked `.env` file.

---

# Point-in-time recovery (PITR)

## What the application does and does not give you

`backup-dr` produces **encrypted `pg_dump` artifacts** on a schedule, verifies
them, and replicates them to an offsite destination (`BACKUP_DESTINATION`; see
`backend/src/backup-dr/`). That is a *snapshot* strategy:

|                         | pg_dump artifacts (the app)    | PITR (this document)                 |
| ----------------------- | ------------------------------ | ------------------------------------ |
| Restore granularity     | whole database, as of the dump | any instant since the base backup    |
| Typical RPO             | the backup interval (hours)    | seconds to `archive_timeout`         |
| Recovers a bad `DELETE` | only to the last dump          | to the moment before the statement   |
| Needs                   | nothing extra                  | continuous WAL archive + base backup |

**The application cannot perform PITR and does not claim to.** `pg_dump` has no
incremental mode, which is why migration 035 removed the `incremental` backup
kind rather than keep faking it. PITR is a server-side capability: it needs
PostgreSQL to archive its write-ahead log continuously. What follows is the
procedure an operator runs. Before this document there was no path at all.

## 1. Turn on WAL archiving

Archiving is wired into the HA overlay's `postgres-primary`
(`docker-compose.ha.yml`) and is **off by default**, so nothing changes until
you opt in. In `.env`:

```bash
POSTGRES_ARCHIVE_MODE=on
POSTGRES_ARCHIVE_COMMAND=test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f
POSTGRES_ARCHIVE_TIMEOUT=300     # force a segment switch every 5 min => RPO <= 5 min
```

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml \
  --profile ha up -d postgres-primary        # archive_mode requires a restart
```

Verify:

```bash
docker compose exec postgres-primary psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT archived_count, failed_count, last_archived_wal, last_failed_wal
        FROM pg_stat_archiver;"
docker compose exec postgres-primary ls -1 /var/lib/postgresql/wal-archive | head
```

> ### The failure mode that takes the server down
>
> If `archive_command` returns non-zero, PostgreSQL **keeps every WAL segment**
> until it succeeds. A silently broken archive (full disk, unreachable mount,
> wrong credentials) therefore ends as a full `pg_wal` and a server that stops
> accepting writes. Two rules:
>
> 1. The command must be reliable and must **never overwrite** an existing file
>    — hence the `test ! -f … &&` guard. Overwriting a segment corrupts the
>    archive silently, which is worse than failing.
> 2. Alert on `pg_stat_archiver.failed_count` increasing and on
>    `last_failed_wal` being non-null. Prometheus already scrapes this stack;
>    add the rule before you rely on PITR.

### The archive must leave the host

`postgres-wal-archive` is a Docker volume on the same machine as the database.
That is enough to recover from a bad statement, and **not** enough to recover
from losing the host. Choose one:

- write directly to object storage from `archive_command`, e.g. with
  `wal-g wal-push %p` or `pgbackrest --stanza=jkannel archive-push %p`;
- or point the volume at an off-host mount (NFS/CIFS) via a bind mount;
- or replicate the archive directory on a timer with `rclone`/`rsync`.

The same reasoning applies as to `BACKUP_DESTINATION=local`: a copy on the host
you are protecting is not an offsite copy.

## 2. Take a base backup

A WAL archive is only usable from a base backup taken **after** archiving was
turned on. Take one immediately, and thereafter on a schedule (weekly is
typical — the older the base, the more WAL must be replayed to reach "now").

```bash
docker compose exec postgres-primary \
  pg_basebackup -U "$REPLICATION_USER" -h 127.0.0.1 \
    -D /var/lib/postgresql/wal-archive/base-$(date +%Y%m%dT%H%M%S) \
    -Fp -Xstream -P -c fast
```

Store the base backup wherever the WAL archive goes. Retention rule: keep the
newest base backup that is **older** than your recovery window, plus every WAL
segment from that base onward. Deleting WAL newer than your oldest retained
base breaks recovery — prune with `pg_archivecleanup`, never by hand:

```bash
docker compose exec postgres-primary \
  pg_archivecleanup /var/lib/postgresql/wal-archive <OLDEST_WAL_NEEDED_BY_BASE>
```

## 3. Restore to a point in time

Restore into a **new** container and data directory. Never recover on top of a
running production data directory: if the target time is wrong you have then
destroyed the only copy of the present.

```bash
# 1. Stop writes to the damaged instance (or leave it running and recover beside it).
# 2. Materialise the base backup into an empty data directory.
rm -rf /srv/jkannel-recovery && mkdir -p /srv/jkannel-recovery
cp -a /var/lib/docker/volumes/jkannel_postgres-wal-archive/_data/base-20260731T020000/. \
      /srv/jkannel-recovery/
chmod 700 /srv/jkannel-recovery

# 3. Tell PostgreSQL where the WAL is and when to stop.
cat >> /srv/jkannel-recovery/postgresql.auto.conf <<'CONF'
restore_command = 'cp /var/lib/postgresql/wal-archive/%f %p'
recovery_target_time = '2026-07-31 14:31:59+00'
recovery_target_action = 'pause'
CONF
touch /srv/jkannel-recovery/recovery.signal
```

`recovery_target_action = 'pause'` is the important one: the server reaches the
target and **waits**, so you can connect read-only and confirm you picked the
right instant before committing to it.

```bash
docker run --rm -it \
  -v /srv/jkannel-recovery:/var/lib/postgresql/data \
  -v jkannel_postgres-wal-archive:/var/lib/postgresql/wal-archive:ro \
  -p 55432:5432 postgres:17-alpine
```

Then, in another shell:

```bash
psql -h 127.0.0.1 -p 55432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM messages WHERE created_at > '2026-07-31 14:00';"
```

- **Wrong instant?** Stop the container, adjust `recovery_target_time`, restore
  the base backup again, retry.
- **Right instant?** Promote and it becomes a normal read/write server:

  ```sql
  SELECT pg_wal_replay_resume();   -- finish replay up to the target
  SELECT pg_promote();             -- end recovery, open for writes
  ```

  Then repoint `DATABASE_URL` / `DATABASE_APP_URL` / `AUTH_DATABASE_URL` at the
  recovered instance and restart the backend. **Take a fresh base backup
  immediately** — a promoted server starts a new timeline, and the old archive
  no longer describes it.

Targets other than `recovery_target_time` are available and are often more
precise: `recovery_target_xid`, `recovery_target_lsn`, and
`recovery_target_name` — set the last one beforehand with
`SELECT pg_create_restore_point('pre-migration')`, which is worth doing before
every risky migration.

## 4. Drill it

An untested recovery procedure is a hypothesis. Run steps 2–3 against the HA
overlay on a non-production host, record the wall-clock time to reach a
promoted server, and publish that number as the RTO. Recovery time scales with
the amount of WAL replayed since the base backup, which is precisely what the
base-backup schedule controls.

## Scope note

The archiving configuration above is applied to `docker-compose.ha.yml`'s
`postgres-primary`, not to the single-node `postgres` service, whose command
line is left untouched so the live deployment is unaffected. To run PITR on the
single-node stack, add the same three `-c` flags to that service's `command:`
and give it the same archive volume — and re-read the failure-mode warning
first.
