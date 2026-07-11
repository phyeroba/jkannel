#!/bin/sh
# ---------------------------------------------------------------------------
# PostgreSQL PRIMARY init hook (HA profile).
#
# Placed in /docker-entrypoint-initdb.d, so the official postgres:17-alpine
# entrypoint runs it EXACTLY ONCE, during first initialization of an empty data
# directory, as the bootstrap superuser. The entrypoint reloads/restarts the
# server after init hooks complete, so the pg_hba change below takes effect.
#
# It creates a dedicated physical-replication role and authorizes replication
# connections for that role from within the private Docker network (datanet).
# No secrets are baked in — REPLICATION_USER / REPLICATION_PASSWORD come from
# the environment (see .env / .env.example).
# ---------------------------------------------------------------------------
set -e

: "${REPLICATION_USER:?REPLICATION_USER must be set for the HA primary}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD must be set for the HA primary}"

echo "[primary-init] creating replication role '${REPLICATION_USER}'"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${REPLICATION_USER}') THEN
    CREATE ROLE "${REPLICATION_USER}" WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
  END IF;
END
\$\$;
SQL

# Authorize replication connections for the replication role. Scoped by ROLE and
# authenticated with scram-sha-256; the network is a private compose bridge, so
# the source range is the whole (non-routable) datanet rather than a public CIDR.
echo "[primary-init] authorizing replication in pg_hba.conf"
cat >> "$PGDATA/pg_hba.conf" <<HBA
# --- HA streaming replication (added by primary-init.sh) ---
host    replication    ${REPLICATION_USER}    all    scram-sha-256
HBA

echo "[primary-init] done"
