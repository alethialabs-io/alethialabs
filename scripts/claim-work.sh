#!/usr/bin/env bash
#
# Atomically claim the next ready work unit from the GitHub Issues board — the
# instance-fleet analogue of the runner's claim_next_job. See .claude/COORDINATION.md.
#
# The pick-and-assign critical section is serialized across all same-box instances by an
# atomic mkdir-lock (same primitive as compose-up.sh), so two instances can never claim the
# same unit. A crashed lock-holder is reclaimed by pid liveness.
#
# Usage:
#   scripts/claim-work.sh [--class backend|ui|any]   # claim the next ready unit (default backend)
#   scripts/claim-work.sh --heartbeat <issue>         # re-stamp your lease (liveness; defeats reclaim)
set -euo pipefail
cd "$(dirname "$0")/.."

CLASS="backend"
HEARTBEAT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --class) CLASS="${2:?}"; shift 2 ;;
    --class=*) CLASS="${1#*=}"; shift ;;
    --heartbeat) HEARTBEAT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh (GitHub CLI) required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

INSTANCE="${ALETHIA_INSTANCE_ID:-$(hostname -s 2>/dev/null || hostname)-$$}"

lease_body() { # <branch>
  printf '```lease\ninstance: %s\npid: %s\nbranch: %s\nstamped_at: %s\n```' \
    "$INSTANCE" "$$" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# --- heartbeat: re-stamp the lease on an issue this instance holds, then exit ---
if [ -n "$HEARTBEAT" ]; then
  gh issue comment "$HEARTBEAT" --body "$(lease_body "heartbeat")" >/dev/null
  echo "♥ heartbeat on #$HEARTBEAT ($INSTANCE)"
  exit 0
fi

LOCK=/tmp/alethia-claim.lock
acquire_lock() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    holder="$(cat "$LOCK/pid" 2>/dev/null || echo "")"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "⏳ Another instance is claiming (pid $holder). Retrying in 3s…" >&2
      sleep 3; acquire_lock; return
    fi
    echo "↻ Reclaiming stale claim-lock (holder '${holder:-?}' gone)." >&2
    rm -rf "$LOCK"; mkdir "$LOCK"
  fi
  echo $$ > "$LOCK/pid"
}
acquire_lock
trap 'rm -rf "$LOCK"' EXIT

class_filter=()
case "$CLASS" in
  backend) class_filter=(--label "class:backend") ;;
  ui)      class_filter=(--label "class:ui") ;;
  any)     class_filter=() ;;
  *) echo "unknown --class $CLASS (backend|ui|any)" >&2; exit 2 ;;
esac

# Is a migration-mutex unit already held? (never two db:generate at once)
mig_held="$(gh issue list --state open --label claimed --label "mutex:migration" --json number --jq 'length')"

# Ready = open, in class, not claimed, not blocked; ordered by wave then issue number.
ready="$(gh issue list --state open "${class_filter[@]}" --limit 200 --json number,title,labels --jq '
  def waveord:
    (.labels | map(.name) | map(select(startswith("wave:"))) | (.[0] // "wave:z"))
    | ltrimstr("wave:")
    | (if . == "hygiene" then 50 else (ltrimstr("W") | tonumber? // 99) end);
  map(select((.labels|map(.name)|index("claimed")|not) and (.labels|map(.name)|index("blocked")|not)))
  | map(. + {ord: waveord})
  | sort_by(.ord, .number)
')"

pick=""; count="$(echo "$ready" | jq 'length')"; i=0
while [ "$i" -lt "$count" ]; do
  has_mig="$(echo "$ready" | jq -r ".[$i].labels|map(.name)|if index(\"mutex:migration\") then 1 else 0 end")"
  if [ "$has_mig" = "1" ] && [ "$mig_held" != "0" ]; then i=$((i+1)); continue; fi
  pick="$(echo "$ready" | jq -r ".[$i].number")"; break
done

if [ -z "$pick" ]; then
  echo "No ready $CLASS unit to claim (all done / claimed / blocked, or migration mutex held)." >&2
  exit 3
fi

title="$(gh issue view "$pick" --json title --jq .title)"
slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)"
branch="feat/$slug"

gh issue edit "$pick" --add-assignee @me --add-label claimed >/dev/null
gh issue comment "$pick" --body "$(lease_body "$branch")" >/dev/null

echo "✓ Claimed #$pick — $title"
echo "  instance: $INSTANCE   branch: $branch"
echo
echo "Next:"
echo "  pnpm wt $slug && cd ../wt-$slug"
echo "  # build ONLY within the issue's scope: globs; never git add -A"
echo "  # open a PR into dev with 'Closes #$pick'"
echo "  # backend → self-merge on green | ui → author a data-model-grounded design spec, human gates"
echo "  scripts/claim-work.sh --heartbeat $pick   # periodically, to keep your lease alive"
echo "  scripts/complete-work.sh $pick            # when merged"
