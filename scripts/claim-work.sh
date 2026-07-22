#!/usr/bin/env bash
#
# Atomically claim the next ready work unit from the GitHub Issues board — the
# instance-fleet analogue of the runner's claim_next_job. See .claude/COORDINATION.md.
#
# The pick-and-assign critical section is serialized across SAME-box instances by an atomic
# mkdir-lock (same primitive as compose-up.sh). Because instances on DIFFERENT machines can't see
# each other's lock (and all auth as the same GitHub user, so the assignee can't tell them apart),
# two extra guards give cross-box safety:
#   1. Pre-claim PR guard — skip a unit that already has an open/merged PR closing it (in flight on
#      another box, or merged-but-stale-open like an issue GitHub never auto-closed).
#   2. Claim-and-verify — after assigning, re-read the issue's lease comments and let the EARLIEST
#      lease (GitHub's server clock → skew-free) win; a later claimer cedes and re-picks. This is
#      the documented cross-box consensus. NEVER hand-claim an issue (assign/label by hand) — that
#      skips BOTH the lock and this verify; if this script offers a stale/wrong unit, fix the board
#      (close it / remove its class label) so it's skipped.
#
# Usage:
#   scripts/claim-work.sh [--class backend|ui|any]   # claim the next ready unit (default backend)
#   scripts/claim-work.sh --heartbeat <issue>         # re-stamp your lease (liveness; defeats reclaim)
#   scripts/claim-work.sh --self-test                 # run the claim-winner unit fixtures (no board)
# Env: ALETHIA_CLAIM_VERIFY_DELAY (default 5s; 0 disables the cross-box verify) ·
#      ALETHIA_CLAIM_WINDOW (default 45s — the near-simultaneous contention window).
# This script intentionally single-quotes jq programs, JSON fixtures, and the ```lease``` printf
# template, so `$`/backtick content is meant to stay literal — SC2016 is a false positive here.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/.."

CLASS="backend"
HEARTBEAT=""
SELFTEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --class) CLASS="${2:?}"; shift 2 ;;
    --class=*) CLASS="${1#*=}"; shift ;;
    --heartbeat) HEARTBEAT="${2:?}"; shift 2 ;;
    --self-test) SELFTEST=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

VERIFY_DELAY="${ALETHIA_CLAIM_VERIFY_DELAY:-5}"
WINDOW="${ALETHIA_CLAIM_WINDOW:-45}"

command -v gh >/dev/null || { echo "gh (GitHub CLI) required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

INSTANCE="${ALETHIA_INSTANCE_ID:-$(hostname -s 2>/dev/null || hostname)-$$}"

lease_body() { # <branch>
  printf '```lease\ninstance: %s\npid: %s\nbranch: %s\nstamped_at: %s\n```' \
    "$INSTANCE" "$$" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# has_closing_pr <issue-number>: true (exit 0) if an OPEN or MERGED PR closes this issue — the
# pre-claim guard that skips work already in flight on another box, or an issue whose PR merged but
# GitHub never auto-closed (a "Closes #n" that didn't link). Requires the closing keyword + the
# exact number (\b so #84 doesn't match #842).
has_closing_pr() { # <n>
  local n="$1" cnt
  cnt="$(gh pr list --state all --limit 20 --search "#$n in:body" --json number,state,body \
    --jq "[.[] | select(.state==\"OPEN\" or .state==\"MERGED\")
               | select(.body | test(\"(?i)(close|fix|resolve)(s|d)? +#$n\\\\b\"))] | length" \
    2>/dev/null || echo 0)"
  [ "${cnt:-0}" -gt 0 ]
}

# claim_winner <window_start_epoch>: read a `gh issue view --json comments` payload on STDIN and
# print the instance whose lease comment has the EARLIEST server createdAt within the window
# (tiebreak: lexicographically-smallest instance). Empty when no in-window lease exists. Using
# GitHub's server timestamps (not the client-stamped `stamped_at`) makes the winner skew-free, so
# every contender computes the SAME winner: the true first claimer always sees itself earliest and
# keeps; every later claimer sees someone earlier and cedes — no double-keep.
claim_winner() { # <window_start_epoch>  (comments JSON on stdin)
  jq -r --argjson ws "$1" '
    [ .comments[]?
      | select(.body | startswith("```lease"))
      | { c: (.createdAt | fromdateiso8601),
          i: ((.body | capture("instance: (?<x>[^\r\n]+)").x) // "") }
      | select(.c >= $ws and .i != "") ]
    | sort_by(.c, .i) | (.[0].i // "")'
}

# run_self_test: exercise claim_winner against fixtures (no board / no gh). Server timestamps are
# the trust anchor, so these lock the winner-selection contract.
run_self_test() {
  local fails=0 ws
  _a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: want '$1' got '$2'" >&2; fails=$((fails+1)); fi; }
  # window start = 2026-07-20T09:59:30Z (portable macOS/BSD -j -f, else GNU -d)
  ws="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' '2026-07-20T09:59:30Z' +%s 2>/dev/null \
        || date -u -d '2026-07-20T09:59:30Z' +%s)"
  _a "box-A" "$(printf '%s' '{"comments":[{"createdAt":"2026-07-20T10:00:00Z","body":"```lease\ninstance: box-A\npid: 1\n```"}]}' | claim_winner "$ws")" "sole claimant wins"
  _a "box-A" "$(printf '%s' '{"comments":[{"createdAt":"2026-07-20T10:00:05Z","body":"```lease\ninstance: box-B\n```"},{"createdAt":"2026-07-20T10:00:02Z","body":"```lease\ninstance: box-A\n```"}]}' | claim_winner "$ws")" "earliest of two wins (order-independent)"
  _a "box-A" "$(printf '%s' '{"comments":[{"createdAt":"2026-07-20T10:00:02Z","body":"```lease\ninstance: box-B\n```"},{"createdAt":"2026-07-20T10:00:02Z","body":"```lease\ninstance: box-A\n```"}]}' | claim_winner "$ws")" "same-second tie -> lowest instance"
  _a "box-A" "$(printf '%s' '{"comments":[{"createdAt":"2026-01-01T00:00:00Z","body":"```lease\ninstance: box-OLD\n```"},{"createdAt":"2026-07-20T10:00:03Z","body":"```lease\ninstance: box-A\n```"}]}' | claim_winner "$ws")" "out-of-window (stale) lease ignored"
  _a "" "$(printf '%s' '{"comments":[{"createdAt":"2026-07-20T10:00:00Z","body":"just a normal comment"}]}' | claim_winner "$ws")" "no lease -> empty"
  if [ "$fails" -eq 0 ]; then echo "self-test: all passed"; exit 0; fi
  echo "self-test: $fails check(s) FAILED" >&2; exit 1
}

if [ -n "$SELFTEST" ]; then run_self_test; fi

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

# Ready = open, in class, not claimed, not blocked, not needs:human; ordered by wave then
# issue number. needs:human marks a unit awaiting a MAINTAINER decision (e.g. a product
# A/B/C call) — autonomous instances repeatedly mis-claimed those (#648, twice in one
# night) because only claimed/blocked were filtered.
ready="$(gh issue list --state open "${class_filter[@]}" --limit 200 --json number,title,labels --jq '
  def waveord:
    (.labels | map(.name) | map(select(startswith("wave:"))) | (.[0] // "wave:z"))
    | ltrimstr("wave:")
    | (if . == "hygiene" then 50 else (ltrimstr("W") | tonumber? // 99) end);
  map(select(
    (.labels|map(.name)|index("claimed")|not)
    and (.labels|map(.name)|index("blocked")|not)
    and (.labels|map(.name)|index("needs:human")|not)
  ))
  | map(. + {ord: waveord})
  | sort_by(.ord, .number)
')"

# Pick + claim + verify, folded into ONE loop so a unit skipped by a guard (mutex / existing PR) or
# CEDED by the cross-box verify falls through to the next ready unit instead of exiting.
pick=""; title=""; slug=""; branch=""
count="$(echo "$ready" | jq 'length')"; i=0
while [ "$i" -lt "$count" ]; do
  cand="$(echo "$ready" | jq -r ".[$i].number")"
  has_mig="$(echo "$ready" | jq -r ".[$i].labels|map(.name)|if index(\"mutex:migration\") then 1 else 0 end")"
  i=$((i+1))   # advance BEFORE any `continue` so we always move on to the next candidate

  if [ "$has_mig" = "1" ] && [ "$mig_held" != "0" ]; then continue; fi

  # Guard 1 — skip a unit that already has an open/merged PR closing it.
  if has_closing_pr "$cand"; then
    echo "↷ skip #$cand — a PR already closes it (in flight or merged-but-stale-open)." >&2
    continue
  fi

  title="$(gh issue view "$cand" --json title --jq .title)"
  slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)"
  branch="feat/$slug"

  start_epoch="$(date +%s)"
  gh issue edit "$cand" --add-assignee @me --add-label claimed >/dev/null
  gh issue comment "$cand" --body "$(lease_body "$branch")" >/dev/null

  # Guard 2 — cross-box claim-and-verify: after a brief settle, the EARLIEST lease wins. If someone
  # claimed before me, CEDE. Note: the `claimed` label + assignee are SHARED (all instances are the
  # same GitHub user), so a ceder must NOT remove them — that would un-claim the winner. Just record
  # the cede and re-pick; the leftover lease is harmless (never the earliest, so never wins a round).
  if [ "${VERIFY_DELAY}" -gt 0 ]; then
    sleep "$VERIFY_DELAY"
    winner="$(gh issue view "$cand" --json comments | claim_winner "$((start_epoch - WINDOW))")"
    if [ -n "$winner" ] && [ "$winner" != "$INSTANCE" ]; then
      gh issue comment "$cand" --body "ceded: $INSTANCE yields #$cand to $winner (concurrent cross-box claim; earliest lease wins). Left the shared claimed label/assignee in place — the winner holds them." >/dev/null 2>&1 || true
      echo "⚠ #$cand was concurrently claimed by $winner — ceding, re-picking…" >&2
      continue
    fi
  fi

  pick="$cand"; break
done

if [ -z "$pick" ]; then
  echo "No ready $CLASS unit to claim (all done / claimed / blocked / already-PR'd, or migration mutex held)." >&2
  exit 3
fi

echo "✓ Claimed #$pick — $title"
echo "  instance: $INSTANCE   branch: $branch"
echo
echo "Next:"
echo "  pnpm wt $slug && cd ../wt-$slug"
echo "  # build ONLY within the issue's scope: globs; never git add -A"
echo "  # open a PR into dev with 'Closes #$pick'"
echo "  # backend → open a NON-DRAFT PR into dev (Closes #$pick); Mergify auto-queues + squash-merges on green — do NOT run gh pr merge | ui → data-model-grounded design spec, human gates"
echo "  scripts/claim-work.sh --heartbeat $pick   # periodically, to keep your lease alive"
echo "  scripts/complete-work.sh $pick            # when merged"
