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
# By reading /proc/net/tcp. An ESTABLISHED (st 01) connection whose REMOTE port
# is the bearerbox box port is the thing that must exist. The port is hex in
# /proc, so 13001 is 32C9.
#
# (An earlier version of this note said the image has no curl, nc, wget or ss.
# That was wrong — it has bash, getent, curl and timeout, and `/dev/tcp` works,
# which is what the readiness wait above now uses. /proc is still the right tool
# HERE, because this asks about an EXISTING connection rather than making one.)
#
# WHAT THIS CANNOT SEE, and it matters: both of SQLBox's connections go to the
# same remote address and port, so a socket count cannot tell which of the two
# threads is alive. One connection is enough to satisfy this check and can still
# mean outbound is dead — measured on production. `send_path_dead` below is what
# covers that case, by reading SQLBox's own log; this covers total loss of the
# link.
#
# The check waits for the link to come up before it starts policing it, so a
# slow first connect is not read as a failure — and it tolerates a short gap,
# because a reconnect in progress is not an outage.
# =============================================================================

# =============================================================================
# WAIT FOR BEARERBOX BEFORE STARTING SQLBOX AT ALL
# =============================================================================
# This is the actual fix for the failure the supervisor below was written to
# catch, and it took a production incident to find.
#
# SQLBox opens TWO connections to bearerbox. `sql_to_bearerbox` is the one that
# drains `send_sms` and pushes into the engine; `bearerbox_to_smsbox` carries
# the other direction. They are established independently.
#
# `sql_to_bearerbox` DOES NOT RETRY. If it cannot resolve or reach bearerbox the
# moment it starts, it logs and the thread TERMINATES for the life of the
# process:
#
#   Thread 2 (sqlbox.c:sql_to_bearerbox)
#   ERROR: Error while gw_gethostbyname occurs.
#   ERROR: gethostbyname failed
#   ERROR: error connecting to server `kamex-bearerbox' at port `13001'
#   Thread 2 (sqlbox.c:sql_to_bearerbox) terminates.
#
# Observed on production 2026-08-26 after a bearerbox restart: SQLBox came up
# while bearerbox's DNS name was not yet resolvable, that thread died, and the
# OTHER thread connected nine seconds later once DNS worked. The result is the
# worst possible shape — one connection attached, the container "running", the
# healthcheck satisfied, and outbound delivery completely dead. Three test
# submissions sat in `send_sms` while the engine's own counter read `sent=0`.
#
# THIS IS WHAT "SQLBOX DOES NOT RECONNECT" HAS ALWAYS MEANT. The handover has
# carried that sentence for months as an operational rule. It is not a property
# of restarting bearerbox; it is this thread, losing one race at startup.
#
# So: do not start SQLBox until bearerbox actually accepts a connection. The
# race then cannot happen, rather than being detected after it has.
#
# `/dev/tcp` because it needs no extra tooling — the image has bash, and an
# earlier comment here claiming it has no curl, nc or wget was simply wrong
# (it has bash, getent, curl and timeout). A successful TCP connect is a
# stronger check than resolving the name, and resolving is the half that failed.
# =============================================================================

BEARERBOX_HOST="${SQLBOX_BEARERBOX_HOST:-kamex-bearerbox}"
BEARERBOX_PORT="${SQLBOX_BEARERBOX_PORT:-13001}"
# Long enough to cover a bearerbox restart and its own startup, short enough
# that a genuinely absent engine is not waited on for ever. Exiting is the right
# answer at the end of it: `restart: unless-stopped` tries again.
WAIT_SECONDS="${SQLBOX_WAIT_FOR_BEARERBOX:-120}"

waited=0
while [ "${waited}" -lt "${WAIT_SECONDS}" ]; do
  if timeout 2 bash -c "exec 3<>/dev/tcp/${BEARERBOX_HOST}/${BEARERBOX_PORT}" 2>/dev/null; then
    [ "${waited}" -gt 0 ] && echo "sqlbox-entrypoint: bearerbox reachable after ${waited}s" >&2
    break
  fi
  [ "${waited}" -eq 0 ] && echo "sqlbox-entrypoint: waiting for ${BEARERBOX_HOST}:${BEARERBOX_PORT} before starting sqlbox" >&2
  sleep 2
  waited=$((waited + 2))
done

if [ "${waited}" -ge "${WAIT_SECONDS}" ]; then
  echo "sqlbox-entrypoint: ${BEARERBOX_HOST}:${BEARERBOX_PORT} unreachable after ${WAIT_SECONDS}s; exiting to be restarted rather than starting sqlbox into a half-connected state" >&2
  exit 1
fi

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

# SQLBox's own output goes to a file that is tailed to stdout, so `docker logs`
# is unchanged AND the supervisor can read what SQLBox said. It has to: the
# degraded state is not visible in /proc — both connections are to the same
# remote address and port, so a socket count cannot tell which of the two
# threads survived. The log can, exactly.
SQLBOX_LOG=/tmp/sqlbox.out
: > "${SQLBOX_LOG}"
/usr/sbin/sqlbox "${RENDERED_CONF}" >> "${SQLBOX_LOG}" 2>&1 &
SQLBOX_PID=$!
tail -n +1 -f "${SQLBOX_LOG}" &
TAIL_PID=$!

# Forward a stop signal so `docker stop` remains clean rather than a 10s kill.
trap 'kill -TERM "${SQLBOX_PID}" "${TAIL_PID}" 2>/dev/null || true; exit 0' TERM INT

# ---------------------------------------------------------------------------
# DID THE SEND-PATH THREAD SURVIVE ITS FIRST SECONDS?
#
# `sql_to_bearerbox` is the thread that drains `send_sms`. If it cannot reach
# bearerbox when it starts it terminates permanently, and the process carries on
# with only the other direction connected — running, healthy by any socket
# check, and delivering nothing.
#
# The wait above should make this impossible. This checks anyway, because the
# cost of being wrong is silent data loss and the check is one grep.
# ---------------------------------------------------------------------------
# Checked in the loop below rather than once, because the thread can die at any
# time — not only during startup. Measured locally: it terminated 72 seconds in,
# when a bearerbox restart severed it, which a one-shot check at 8 seconds would
# have walked straight past.
send_path_dead() {
  grep -q 'sql_to_bearerbox) terminates' "${SQLBOX_LOG}" 2>/dev/null
}

ever_connected=0
failures=0
waited=0

while kill -0 "${SQLBOX_PID}" 2>/dev/null; do
  sleep "${CHECK_INTERVAL}"
  # The send path first: a socket count cannot see this, because both of
  # SQLBox's connections go to the same address and port. One surviving
  # connection satisfies `connected` below and can still mean nothing is
  # draining `send_sms`. That is the production failure, exactly.
  if send_path_dead; then
    echo "sqlbox-supervisor: the sql_to_bearerbox thread has terminated — nothing is draining send_sms, and every other indicator would stay green. Exiting to be restarted." >&2
    kill -TERM "${SQLBOX_PID}" "${TAIL_PID}" 2>/dev/null || true
    exit 1
  fi
  if connected; then
    ever_connected=1
    failures=0
    continue
  fi
  if [ "${ever_connected}" -eq 0 ]; then
    waited=$((waited + 1))
    if [ "${waited}" -ge "${STARTUP_GRACE}" ]; then
      echo "sqlbox-supervisor: no connection to bearerbox:${BEARERBOX_PORT} after startup grace; exiting to be restarted" >&2
      kill -TERM "${SQLBOX_PID}" "${TAIL_PID}" 2>/dev/null || true
      exit 1
    fi
    continue
  fi
  failures=$((failures + 1))
  if [ "${failures}" -ge "${FAILURES_ALLOWED}" ]; then
    echo "sqlbox-supervisor: connection to bearerbox:${BEARERBOX_PORT} lost and did not return; exiting so this container restarts and reconnects. Outbound would otherwise stop silently with every indicator green." >&2
    kill -TERM "${SQLBOX_PID}" "${TAIL_PID}" 2>/dev/null || true
    exit 1
  fi
done

# SQLBox exited on its own; surface its status so a real crash is not masked.
# The tail is stopped first, or `wait` would block on a process that never ends.
kill -TERM "${TAIL_PID}" 2>/dev/null || true
wait "${SQLBOX_PID}"
