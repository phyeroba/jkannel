#!/bin/sh
# ---------------------------------------------------------------------------
# Redis Sentinel entrypoint (HA profile).
#
# Sentinel rewrites its configuration file at runtime to persist the discovered
# master and replicas, so it cannot run against a read-only mounted file. We
# copy the read-only template to a writable path (a per-container tmpfs at
# /data) and launch Sentinel against the copy.
# ---------------------------------------------------------------------------
set -e

CONF_SRC="${SENTINEL_CONF_SRC:-/etc/redis/sentinel.conf}"
CONF_DST="${SENTINEL_CONF_DST:-/data/sentinel.conf}"

cp "$CONF_SRC" "$CONF_DST"
exec redis-sentinel "$CONF_DST"
