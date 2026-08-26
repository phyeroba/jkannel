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

# =============================================================================
# WHY SQLBOX IS SUPERVISED RATHER THAN EXEC'D
# =============================================================================
# Once, after a configuration deploy, 700 messages sat undelivered in `send_sms`
# while every indicator stayed green: bearerbox healthy, the deploy reporting
# success, no error anywhere. SQLBox's last log line predated the restart, and
# restarting SQLBox drained all 700 into the engine at once. So SQLBox had been
# holding a socket that no longer reached anything, and nothing in the stack
# could tell.
#
# WHAT WAS ACTUALLY MEASURED AFTERWARDS, which is narrower than first assumed
# -----------------------------------------------------------------------------
# The severance was blamed on `graceful-restart`. That attribution does not hold
# up. Tested on 2026-08-26 against this build:
#
#   * `graceful-restart` — bearerbox's own uptime SPANS it, so the process is not
#     re-exec'd at all. SQLBox reconnected within a second and both of its
#     connections were present afterwards. Not severed.
#   * bearerbox CONTAINER restart — SQLBox saw the close, shut down cleanly of
#     its own accord, and `restart: unless-stopped` had it back and reconnected
#     about twelve seconds later. Self-heals, with no help from this script.
#
# So SQLBox handles a socket that CLOSES. What it cannot handle — and what the
# 700 messages were — is a socket that stops carrying traffic without closing:
# no FIN arrives, the read never returns, and SQLBox waits forever on a
# connection the kernel still calls ESTABLISHED. That is the gap this covers.
#
# The honest limit: a peer that vanishes without a FIN leaves the entry reading
# ESTABLISHED on this side too, so this catches the cases that reach CLOSE_WAIT
# or disappear, not every possible wedge. It is one more layer, not a proof.
#
# WHY EXIT INSTEAD OF ONLY A HEALTHCHECK
# -----------------------------------------------------------------------------
# The container healthcheck used to be `kill -0 1`, which asks only whether the
# process exists — and it does exist, holding its dead socket, which is exactly
# why this was invisible. The healthcheck now reads the real link state, so the
# failure is at least VISIBLE. But Docker does not restart a container for being
# unhealthy, so visible is as far as a healthcheck goes.
#
# Exiting does restart it: `restart: unless-stopped` is already set, so the
# supervisor kills SQLBox and returns non-zero, Docker starts a fresh container,
# and SQLBox reconnects on boot. Recovery takes a few seconds and needs nobody.
#
# HOW THE CONNECTION IS CHECKED
# -----------------------------------------------------------------------------
# By reading /proc/net/tcp, because this image has no curl, nc, wget or ss. An
# ESTABLISHED (st 01) connection whose REMOTE port is the bearerbox box port is
# the thing that must exist. The port is hex in /proc, so 13001 is 32C9.
#
# The check waits for the link to come up before it starts policing it, so a
# slow first connect is not read as a failure — and it tolerates a short gap,
# because a reconnect in progress is not an outage.
# =============================================================================

BEARERBOX_PORT="${SQLBOX_BEARERBOX_PORT:-13001}"
# /proc/net/tcp renders ports as uppercase hex without a prefix.
PORT_HEX=$(printf '%04X' "${BEARERBOX_PORT}")
CHECK_INTERVAL="${SQLBOX_CHECK_INTERVAL:-10}"
# Consecutive failed checks tolerated once the link has been up. Three at ten
# seconds is half a minute — long enough to ride out a reconnect, short enough
# that a severed link is restored before a queue becomes a backlog.
FAILURES_ALLOWED="${SQLBOX_FAILURES_ALLOWED:-3}"
# Checks to wait for the FIRST connection before giving up. Generous: bearerbox
# may still be starting, and exiting during startup would be a crash loop.
STARTUP_GRACE="${SQLBOX_STARTUP_GRACE:-30}"

connected() {
  # Column 3 is rem_address as HEX_IP:HEX_PORT; column 4 is the state.
  awk -v port=":${PORT_HEX}" '
    NR > 1 && $4 == "01" && index($3, port) == length($3) - length(port) + 1 { found = 1 }
    END { exit found ? 0 : 1 }
  ' /proc/net/tcp
}

/usr/sbin/sqlbox "${RENDERED_CONF}" &
SQLBOX_PID=$!

# Forward a stop signal so `docker stop` remains clean rather than a 10s kill.
trap 'kill -TERM "${SQLBOX_PID}" 2>/dev/null || true; exit 0' TERM INT

ever_connected=0
failures=0
waited=0

while kill -0 "${SQLBOX_PID}" 2>/dev/null; do
  sleep "${CHECK_INTERVAL}"
  if connected; then
    ever_connected=1
    failures=0
    continue
  fi
  if [ "${ever_connected}" -eq 0 ]; then
    waited=$((waited + 1))
    if [ "${waited}" -ge "${STARTUP_GRACE}" ]; then
      echo "sqlbox-supervisor: no connection to bearerbox:${BEARERBOX_PORT} after startup grace; exiting to be restarted" >&2
      kill -TERM "${SQLBOX_PID}" 2>/dev/null || true
      exit 1
    fi
    continue
  fi
  failures=$((failures + 1))
  if [ "${failures}" -ge "${FAILURES_ALLOWED}" ]; then
    echo "sqlbox-supervisor: connection to bearerbox:${BEARERBOX_PORT} lost and did not return; exiting so this container restarts and reconnects. Outbound would otherwise stop silently with every indicator green." >&2
    kill -TERM "${SQLBOX_PID}" 2>/dev/null || true
    exit 1
  fi
done

# SQLBox exited on its own; surface its status so a real crash is not masked.
wait "${SQLBOX_PID}"
