#!/bin/sh
# ---------------------------------------------------------------------------
# PostgreSQL HOT STANDBY entrypoint (HA profile).
#
# Wraps the official postgres:17-alpine entrypoint. On first boot (empty data
# dir) it takes a base backup from the primary with pg_basebackup, which:
#   -R   writes standby.signal + primary_conninfo (so the node comes up as a
#        streaming hot standby),
#   -Xs  streams WAL during the backup (no gap),
#   -C -S creates and uses a named physical replication slot on the primary so
#        the primary retains WAL the standby still needs.
# On subsequent boots the data dir already exists, so it just starts Postgres
# and resumes streaming from where it left off.
#
# Runs as root (the base image entrypoint expects that) and drops to the
# 'postgres' user via gosu for the backup so file ownership is correct.
# ---------------------------------------------------------------------------
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${PRIMARY_HOST:-postgres-primary}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPLICATION_SLOT="${REPLICATION_SLOT:-standby_slot}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  : "${REPLICATION_USER:?REPLICATION_USER must be set for the HA standby}"
  : "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD must be set for the HA standby}"

  echo "[standby] no local data — bootstrapping from ${PRIMARY_HOST}:${PRIMARY_PORT}"

  # Wait until the primary accepts connections before cloning.
  until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPLICATION_USER" >/dev/null 2>&1; do
    echo "[standby] waiting for primary ${PRIMARY_HOST}:${PRIMARY_PORT} ..."
    sleep 2
  done

  # Ensure the (possibly root-owned, fresh) volume dir is owned by postgres and
  # empty before the base backup writes into it.
  mkdir -p "$PGDATA"
  rm -rf "${PGDATA:?}/"* 2>/dev/null || true
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"

  export PGPASSWORD="$REPLICATION_PASSWORD"
  gosu postgres pg_basebackup \
    --host="$PRIMARY_HOST" --port="$PRIMARY_PORT" --username="$REPLICATION_USER" \
    --pgdata="$PGDATA" --format=plain --wal-method=stream --progress \
    --write-recovery-conf --create-slot --slot="$REPLICATION_SLOT"
  unset PGPASSWORD

  echo "[standby] base backup complete — starting hot standby"
fi

exec docker-entrypoint.sh postgres
