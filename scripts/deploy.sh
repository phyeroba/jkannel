#!/usr/bin/env bash
#
# Deploy JKANNEL to a host that already has the stack running.
#
#   ssh <host> 'bash -s' < scripts/deploy.sh            # backend + frontend
#   ssh <host> 'bash -s' < scripts/deploy.sh frontend   # frontend only
#
# WHAT THIS WILL NOT DO
# -----------------------------------------------------------------------------
# It never touches the engine. bearerbox, smsbox and sqlbox are left running and
# the script ABORTS if the bearerbox container id changes across the run —
# sqlbox does not reconnect when bearerbox restarts, so a recreate wedges
# sending silently with every metric still green.
#
# It also never touches anything outside this compose project. On the shared
# host that means the cpaas-* containers and the PM2 processes beside them.
#
# THE FAILURE THIS SCRIPT EXISTS TO PREVENT
# -----------------------------------------------------------------------------
# A `sudo git` or `sudo docker compose` run leaves files in the working tree
# owned by root. `git merge` then fails PART WAY THROUGH the checkout: some
# files carry the new content, HEAD still points at the old commit, and the next
# deploy reports "Your local changes would be overwritten" for files nobody
# edited. It presents as a deploy that silently did nothing, and it cost a
# debugging session to recognise.
#
# So ownership is repaired BEFORE the pull, every time, and the pull is verified
# to have actually moved HEAD.
set -euo pipefail

APP_DIR=${APP_DIR:-/home/hyeroba/jkannel}
PROJECT=${PROJECT:-jkannel}
ENGINE=${ENGINE:-jkannel-kamex-bearerbox-1}
SERVICES=${1:-backend frontend}

cd "$APP_DIR"
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "OWNERSHIP"
# Scoped to the repo. `-print -quit` so a clean tree costs one stat, not a walk.
if [ -n "$(find . -path ./node_modules -prune -o ! -user "$(id -un)" -print -quit 2>/dev/null)" ]; then
  echo "   root-owned files present — repairing before pull"
  sudo chown -R "$(id -un):$(id -gn)" .
else
  echo "   OK  clean"
fi

say "DEPLOYMENT CONFIG"
# docker-compose.override.yml is gitignored and exists only on this host. If a
# pull ever removed it the stack would come back with the wrong topology, so its
# checksum is recorded and re-checked after the merge.
test -f docker-compose.override.yml || { echo "   !! override missing BEFORE pull"; exit 1; }
OVERRIDE_BEFORE=$(sha256sum docker-compose.override.yml | cut -d' ' -f1)
echo "   sha256 ${OVERRIDE_BEFORE:0:16}"

# The engine's own configuration is gitignored AND bind-mounted into bearerbox.
# That pairing is a trap. On 2026-08-26 a history rewrite plus `git reset --hard`
# deleted it, because it had been TRACKED in this checkout from before it was
# ignored. bearerbox kept running on the open inode and nothing looked wrong —
# until the next restart, when Docker could not find the mount source,
# auto-created a DIRECTORY in its place, and the container died with exit 127
# and "not a directory".
#
# Checked before AND after the pull, like the override above, and as a FILE
# rather than merely present: the directory Docker leaves behind would pass a
# bare existence test.
test -f runtime/kamex/kamex.conf || {
  echo "   !! runtime/kamex/kamex.conf is missing or is not a file — bearerbox cannot start"
  echo "      restore: cp infrastructure/kannel/kamex.conf runtime/kamex/kamex.conf && chmod 644 runtime/kamex/kamex.conf"
  exit 1
}
CONF_BEFORE=$(sha256sum runtime/kamex/kamex.conf | cut -d' ' -f1)
echo "   engine conf ${CONF_BEFORE:0:16}"

say "PULL"
BEFORE=$(git rev-parse --short HEAD)
ENGINE_BEFORE=$(docker inspect "$ENGINE" --format '{{.Id}}')
git fetch --quiet origin
git merge --ff-only origin/main
AFTER=$(git rev-parse --short HEAD)
echo "   $BEFORE -> $AFTER"
# A merge that leaves the tree dirty is the half-applied case above.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "   !! working tree still dirty after merge — half-applied, refusing to build"
  git status --short --untracked-files=no
  exit 1
fi
[ "$OVERRIDE_BEFORE" = "$(sha256sum docker-compose.override.yml | cut -d' ' -f1)" ] \
  || { echo "   !! override changed during pull"; exit 1; }
test -f runtime/kamex/kamex.conf \
  || { echo "   !! the pull REMOVED runtime/kamex/kamex.conf — bearerbox would die on its next restart"; exit 1; }
[ "$CONF_BEFORE" = "$(sha256sum runtime/kamex/kamex.conf | cut -d' ' -f1)" ] \
  || echo "   note: the engine configuration changed during the pull"

say "BUILD $SERVICES"
# shellcheck disable=SC2086
docker compose -p "$PROJECT" build $SERVICES >/dev/null 2>&1
echo "   built"

say "RECREATE $SERVICES (never the engine)"
# shellcheck disable=SC2086
docker compose -p "$PROJECT" up -d --no-deps $SERVICES 2>&1 | tail -4
sleep 25

say "ENGINE UNTOUCHED?"
ENGINE_AFTER=$(docker inspect "$ENGINE" --format '{{.Id}}')
if [ "$ENGINE_BEFORE" = "$ENGINE_AFTER" ]; then
  echo "   OK  ${ENGINE_AFTER:0:12}"
else
  echo "   !! ENGINE RECREATED — sqlbox will not have reconnected"; exit 1
fi

say "VERIFY"
BASE=${BASE:-https://gw1.speedamobile.com}
for path in / /api/v1/health /api/v1/openapi.json; do
  printf '   %-24s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")"
done

say "NEIGHBOURS UNTOUCHED"
docker ps --filter name=cpaas --format '   {{.Names}} {{.Status}}' | head -8
pm2 list 2>/dev/null | grep -E 'auth-service|messaging-service|console-web' || true

say "STATE"
docker ps --filter name="$PROJECT" --format '   {{.Names}} {{.Status}}'
echo "   commit: $(git rev-parse --short HEAD)"
