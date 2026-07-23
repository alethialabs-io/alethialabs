#!/usr/bin/env bash
#
# engine.sh — the autonomous build-loop DRIVER a running Claude instance invokes to self-sustain the
# coordination board WITHOUT a per-unit human prompt. See .claude/COORDINATION.md and the `foundry`
# skill (.claude/skills/foundry/SKILL.md), which is what an agent uses to drive this in a loop.
#
# This is a THIN, DRY dispatcher over the three existing board scripts — it re-implements NONE of the
# claim / lease / reclaim logic (those already atomic-lock themselves); it only orchestrates one
# iteration of the loop so the agent can re-invoke it and pace itself:
#
#   engine.sh claim            → claim-work.sh --class backend   (claim the next ready backend unit)
#   engine.sh heartbeat <n>    → claim-work.sh --heartbeat <n>   (re-stamp the lease mid-build so it
#                                                                  never goes stale under LEASE_TTL)
#   engine.sh complete <n>     → complete-work.sh <n> && coordinate.sh   (release + unblock downstream)
#   engine.sh coordinate       → coordinate.sh [--close-shipped]  (reclaim/unblock/report; flag if avail)
#   engine.sh status           → coordinate.sh --report           (read-only board report; no mutations)
#
# SAFETY: this is a SCAFFOLD an agent drives, never a destructive autonomous process. It NEVER merges
# to a protected branch, never runs `gh pr merge`, never runs tofu/terraform apply. Backend PRs land
# via the Mergify queue on green (see CLAUDE.md); UI units stay human-gated (the `foundry` skill only
# claims --class backend). Exit codes pass through from the underlying scripts — notably `claim`
# exits 3 when there is NO ready unit, which the loop skill reads as "STOP".
#
# Usage:
#   scripts/engine.sh claim
#   scripts/engine.sh heartbeat <issue>
#   scripts/engine.sh complete <issue>
#   scripts/engine.sh coordinate
#   scripts/engine.sh status
#   scripts/engine.sh -h | --help
set -euo pipefail
cd "$(dirname "$0")/.."

CLAIM="scripts/claim-work.sh"
COORDINATE="scripts/coordinate.sh"
COMPLETE="scripts/complete-work.sh"

usage() { sed -n '2,31p' "$0"; }

cmd="${1:-}"
case "$cmd" in
  claim)
    # Claim the next ready backend unit. Prints the claimed issue, its scope: globs, and the
    # `pnpm wt <slug>` line the agent builds in. Exits 3 when nothing is ready (loop → STOP).
    shift || true
    exec "$CLAIM" --class backend "$@"
    ;;

  heartbeat)
    # Re-stamp the lease on an issue this instance holds, so a long build never lets the lease go
    # stale (defeats coordinate.sh's reclaim). The agent calls this at each build checkpoint.
    issue="${2:?usage: engine.sh heartbeat <issue>}"
    exec "$CLAIM" --heartbeat "$issue"
    ;;

  complete)
    # Release a merged unit, THEN run a coordinate pass so downstream `blocked-by:` units unblock.
    issue="${2:?usage: engine.sh complete <issue>}"
    "$COMPLETE" "$issue"
    echo
    echo "→ engine: running a coordinate pass to unblock downstream…"
    exec "$COORDINATE"
    ;;

  coordinate)
    # Full reclaim + unblock + report. Feature-detect the optional --close-shipped flag (some
    # coordinate.sh versions can auto-close units a merged PR already shipped) and pass it if present.
    if grep -q close-shipped "$COORDINATE"; then
      exec "$COORDINATE" --close-shipped
    fi
    exec "$COORDINATE"
    ;;

  status)
    # Read-only board report — no mutations. Safe to run anytime (this is what -h demos as harmless).
    exec "$COORDINATE" --report
    ;;

  -h|--help|help|"")
    usage
    [ -z "$cmd" ] && exit 2
    exit 0
    ;;

  *)
    echo "unknown command: $cmd" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
