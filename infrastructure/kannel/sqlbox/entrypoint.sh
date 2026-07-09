#!/bin/sh
# SQLBox (unlike Kamex bearerbox) does not expand ${ENV} placeholders in its
# configuration, so render them here before starting. Only the PostgreSQL
# credentials are substituted; the rendered copy lives on tmpfs and is not
# world-readable.
set -eu

SOURCE_CONF="${1:-/etc/kamex/sqlbox.conf}"
RENDERED_CONF="/tmp/sqlbox.rendered.conf"

sed \
  -e "s|\${POSTGRES_USER}|${POSTGRES_USER:?POSTGRES_USER is required}|g" \
  -e "s|\${POSTGRES_PASSWORD}|${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}|g" \
  -e "s|\${POSTGRES_DB}|${POSTGRES_DB:?POSTGRES_DB is required}|g" \
  "${SOURCE_CONF}" > "${RENDERED_CONF}"
chmod 600 "${RENDERED_CONF}"

exec /usr/sbin/sqlbox "${RENDERED_CONF}"
