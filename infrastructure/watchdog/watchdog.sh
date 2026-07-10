#!/bin/sh
# JKANNEL watchdog — lightweight automatic recovery.
#
# Polls the Docker healthcheck status of containers in THIS compose project and
# restarts any that report "unhealthy". Emits structured JSON to stdout so the
# lines are picked up by Promtail/Loki like any other container log.
#
# Scope is intentionally narrow: it never touches containers outside the
# jkannel project. It complements (does not replace) Docker restart policies —
# restart policies handle crashes/exits, the watchdog handles the "running but
# failing its healthcheck" case that Docker itself will not auto-remediate.
set -eu

PROJECT="${WATCHDOG_PROJECT:-jkannel}"
INTERVAL="${WATCHDOG_INTERVAL:-30}"

log() {
  # $1=level $2=message $3=container(optional) $4=extra(optional)
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","component":"watchdog","level":"%s","message":"%s","container":"%s","detail":"%s"}\n' \
    "$ts" "$1" "$2" "${3:-}" "${4:-}"
}

log info "watchdog started" "" "project=${PROJECT} interval=${INTERVAL}s"

while true; do
  # List running containers in this project.
  for cid in $(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.ID}}'); do
    name="$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')" || continue
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)" || continue

    if [ "$status" = "unhealthy" ]; then
      log warn "container unhealthy, restarting" "$name" "status=${status}"
      if docker restart "$cid" >/dev/null 2>&1; then
        log info "restart issued" "$name" ""
      else
        log error "restart failed" "$name" ""
      fi
    fi
  done
  sleep "$INTERVAL"
done
