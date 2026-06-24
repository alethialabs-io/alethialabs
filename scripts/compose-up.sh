#!/usr/bin/env bash
#
# Lock-guarded bring-up for the shared `alethia` compose stack.
#
# The compose project name is hardcoded (`name: alethia`), so every terminal /
# worktree targets the SAME stack. The only hazard from running Claude in
# several windows is two `docker compose up --build` racing the same builder and
# container set at once. This wrapper serializes that: a second concurrent call
# no-ops (prints status) instead of kicking off a duplicate build.
#
# macOS has no native flock, so we use an atomic `mkdir` lock (portable).
#
# Usage:
#   bash scripts/compose-up.sh                       # lite: caddy app docs blog
#   bash scripts/compose-up.sh caddy app docs blog runner   # full (heavy runner)
set -euo pipefail

cd "$(dirname "$0")/.."

LOCK=/tmp/alethia-compose.lock

if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || echo "")"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "⏳ A compose bring-up is already running (pid $holder). Not racing it."
    echo "   Current stack:"
    docker compose ps
    exit 0
  fi
  echo "↻ Reclaiming stale lock (holder pid '${holder:-?}' is gone)."
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# Lite default; pass an explicit service list to override (e.g. add `runner`).
if [ "$#" -eq 0 ]; then
  set -- caddy app docs blog
fi

echo "▶ docker compose up -d --build $*"
docker compose up -d --build "$@"

echo "✓ Bring-up complete. Stack:"
docker compose ps
