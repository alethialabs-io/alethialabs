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
#   scripts/claim-work.sh --issue <n>                 # claim ONE named unit through the same path
#   scripts/claim-work.sh --heartbeat <issue>         # re-stamp your lease (liveness; defeats reclaim)
#   scripts/claim-work.sh --self-test                 # run the claim-winner unit fixtures (no board)
#
# --issue exists because `needs:human` units were UNCLAIMABLE and therefore UNPROTECTED: the filter
# below skips them, so the only way to work one was a hand-claim — which bypasses the lock AND the
# verify, leaves no lease, and lets two instances start the same unit with nothing recording either.
# That is the first domino in issue #1247. A named claim still goes through the whole path; it just
# can't be picked autonomously, which is what the needs:human exclusion is actually for.
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
ONLY_ISSUE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --class) CLASS="${2:?}"; shift 2 ;;
    --class=*) CLASS="${1#*=}"; shift ;;
    --issue) ONLY_ISSUE="${2:?}"; shift 2 ;;
    --issue=*) ONLY_ISSUE="${1#*=}"; shift ;;
    --heartbeat) HEARTBEAT="${2:?}"; shift 2 ;;
    --self-test) SELFTEST=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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

# has_closing_pr / has_active_pr / active_pr_ref — the board↔PR guards. They live in
# scripts/lib/board-pr.sh because coordinate.sh needs the identical predicates, and this file used
# to carry a verbatim copy: one protocol with two call sites, where a drift is a silent false-ALLOW
# (two instances on one unit). Same reasoning as scripts/lib/wt-lease.sh; read that file for the
# fail-closed contract before changing either.
# (Sourced by path from the repo root — `cd "$(dirname "$0")/.."` above already put us there, so
# `$0`-relative would resolve against the caller's cwd instead.)
# shellcheck source=scripts/lib/board-pr.sh
. scripts/lib/board-pr.sh

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

  # board_pr_links — the keyword discrimination behind Guard 1/1b (scripts/lib/board-pr.sh). Pinned
  # offline because the regex is where this silently regresses: too narrow and a live PR stops being
  # seen (#1389 handed to a second instance); too broad and an incidental mention locks a unit
  # forever. `_l` asserts LINKS, `_n` asserts DOES NOT.
  _l() { if board_pr_links "$1" "$2" "$3"; then echo "ok   - $4"; else echo "FAIL - $4: expected a link" >&2; fails=$((fails+1)); fi; }
  _n() { if board_pr_links "$1" "$2" "$3"; then echo "FAIL - $4: expected NO link" >&2; fails=$((fails+1)); else echo "ok   - $4"; fi; }

  _l "Part of #1389. Completes the namespace tier." 1389 "$BOARD_PR_LINKING_KW" "linking: 'Part of #n' (the #1408 case that caused this)"
  _l "part of epic #1419"                           1419 "$BOARD_PR_LINKING_KW" "linking: 'part of epic #n'"
  _l "Stacked on #1405"                             1405 "$BOARD_PR_LINKING_KW" "linking: 'Stacked on #n'"
  _n "Closes #1389"                                 1389 "$BOARD_PR_LINKING_KW" "linking: 'Closes #n' is NOT a linking match (Guard 1 owns it)"
  _n "behaves similar to #1389 but unrelated"       1389 "$BOARD_PR_LINKING_KW" "linking: an incidental mention must NOT lock the unit"
  _n "Part of #13890"                               1389 "$BOARD_PR_LINKING_KW" "linking: word boundary — #13890 is not #1389"
  # All NINE GitHub closing keywords. The old `(close|fix|resolve)(s|d)?` shorthand expanded to
  # fix/fixs/fixd, so "Fixes #n" — the commonest phrasing there is — silently never matched.
  for kw in close closes closed fix fixes fixed resolve resolves resolved; do
    _l "$kw #84" 84 "$BOARD_PR_CLOSING_KW" "closing: '$kw #n'"
  done
  _n "closes #842"                                  84   "$BOARD_PR_CLOSING_KW" "closing: word boundary — #842 is not #84"
  _n "Part of #1389"                                1389 "$BOARD_PR_CLOSING_KW" "closing: 'Part of #n' is NOT a closing match (the original bug)"
  _n "fixing #84"                                   84   "$BOARD_PR_CLOSING_KW" "closing: 'fixing' is not a GitHub keyword"

  # board_pr_is_stalled — the "is the PR holding this unit actually dead?" predicate behind
  # coordinate.sh's stalled report. Pinned offline like the rest, and the two directions matter
  # differently: calling a LIVE PR dead sends a human to take over work in flight, while calling a
  # DEAD one alive is the invisibility #1426/#1461 sat in for 8h with nothing surfacing it.
  _s() { if board_pr_is_stalled "$1" "$2" "$3" "$4"; then echo "ok   - $5"; else echo "FAIL - $5: expected STALLED" >&2; fails=$((fails+1)); fi; }
  _ns() { if board_pr_is_stalled "$1" "$2" "$3" "$4"; then echo "FAIL - $5: expected ALIVE" >&2; fails=$((fails+1)); else echo "ok   - $5"; fi; }
  _now=1000000; _ttl=14400   # 4h, the default PR_IDLE_TTL (4 x LEASE_TTL)
  _s  CONFLICTING "$_now"           "$_now" "$_ttl" "stalled: conflicting counts even when just updated"
  _s  MERGEABLE   "$((_now-20000))" "$_now" "$_ttl" "stalled: mergeable but idle past the TTL"
  _ns MERGEABLE   "$((_now-100))"   "$_now" "$_ttl" "alive: mergeable and recently updated"
  _ns MERGEABLE   "$((_now-14399))" "$_now" "$_ttl" "alive: idle just under the TTL (boundary)"
  _ns UNKNOWN     ""                "$_now" "$_ttl" "alive: missing timestamp must not accuse a live PR"
  _ns MERGEABLE   "not-a-number"    "$_now" "$_ttl" "alive: garbage timestamp must not accuse a live PR"

  if [ "$fails" -eq 0 ]; then echo "self-test: all passed"; exit 0; fi
  echo "self-test: $fails check(s) FAILED" >&2; exit 1
}

if [ -n "$SELFTEST" ]; then run_self_test; fi

# --- heartbeat: re-stamp the lease on an issue this instance holds, then exit ---
# Ownership is CHECKED, not assumed: an unchecked heartbeat lets any instance keep any issue's
# lease warm, which defeats coordinate.sh's reclaim of work its actual holder has abandoned.
# `assignees` is the check available — every instance authenticates as the same GitHub user, so
# this catches the honest mistake (heartbeating the wrong number) rather than an impostor.
if [ -n "$HEARTBEAT" ]; then
  hb_claimed="$(gh issue view "$HEARTBEAT" --json labels --jq '[.labels[].name]|index("claimed")//empty' 2>/dev/null || echo "")"
  if [ -z "$hb_claimed" ]; then
    echo "✗ #$HEARTBEAT is not claimed — nothing to heartbeat." >&2
    echo "  Claim it first: scripts/claim-work.sh --issue $HEARTBEAT" >&2
    exit 1
  fi
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

# Ready = open, in class, not claimed, not blocked, not needs:human, not epic; ordered by wave
# then issue number. needs:human marks a unit awaiting a MAINTAINER decision (e.g. a product
# A/B/C call) — autonomous instances repeatedly mis-claimed those (#648, twice in one
# night) because only claimed/blocked were filtered. `epic` marks an umbrella/tracking issue that
# is decomposed into sub-issues and NEVER directly built — excluding it keeps `--class any` (and a
# mislabeled epic that also carries a class) from ever being handed to a builder.
#
# `--class any` passes NO label filter, so it must require a `class:` label in the jq instead —
# otherwise it returns every open issue in the repo and can hand a builder something that was
# never a board unit at all (coordinate.sh already gates on this; this didn't).
ready="$(gh issue list --state open "${class_filter[@]}" --limit 200 --json number,title,labels --jq '
  def waveord:
    (.labels | map(.name) | map(select(startswith("wave:"))) | (.[0] // "wave:z"))
    | ltrimstr("wave:")
    | (if . == "hygiene" then 50 else (ltrimstr("W") | tonumber? // 99) end);
  map(select(
    (.labels|map(.name)|any(startswith("class:")))
    and (.labels|map(.name)|index("claimed")|not)
    and (.labels|map(.name)|index("blocked")|not)
    and (.labels|map(.name)|index("needs:human")|not)
    and (.labels|map(.name)|index("epic")|not)
  ))
  | map(. + {ord: waveord})
  | sort_by(.ord, .number)
')"

# --issue <n>: claim exactly this unit, through the same lock + lease + verify. The autonomous
# exclusions (needs:human, class) don't apply — a human named it — but the guards that prevent a
# DOUBLE claim very much do: it must still be open, unclaimed, and free of a closing PR.
if [ -n "$ONLY_ISSUE" ]; then
  meta="$(gh issue view "$ONLY_ISSUE" --json number,title,state,labels 2>/dev/null)" || {
    echo "✗ #$ONLY_ISSUE not found." >&2; exit 1; }
  [ "$(echo "$meta" | jq -r .state)" = "OPEN" ] || { echo "✗ #$ONLY_ISSUE is not open." >&2; exit 1; }
  if [ "$(echo "$meta" | jq -r '[.labels[].name]|index("claimed")//empty')" != "" ]; then
    echo "✗ #$ONLY_ISSUE is already claimed. See who holds it:  gh issue view $ONLY_ISSUE --comments" >&2
    exit 1
  fi
  if has_closing_pr "$ONLY_ISSUE"; then
    echo "✗ #$ONLY_ISSUE already has an open/merged PR closing it — someone is on it." >&2
    exit 1
  fi
  # An open "Part of #n" PR WARNS here rather than blocking: a human naming a unit may deliberately
  # be taking over an abandoned draft, and that override is the whole point of --issue. The
  # autonomous loop treats the same signal as a hard skip (Guard 1b).
  if has_active_pr "$ONLY_ISSUE"; then
    echo "⚠ #$ONLY_ISSUE has an open PR $(active_pr_ref "$ONLY_ISSUE") already building it — claiming anyway (--issue is an explicit override)." >&2
    echo "  If that PR is alive, you are about to duplicate it. Check first:  gh pr view $(active_pr_ref "$ONLY_ISSUE" | tr -d '#' | cut -d' ' -f1)" >&2
  fi
  ready="$(echo "$meta" | jq -c '[{number, title, labels}]')"
fi

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

  # Guard 1b — skip a unit an OPEN PR is BUILDING without claiming to close it. A PR that delivers
  # one tier of a multi-tier unit says "Part of #n" (correctly — it does not close it), which
  # Guard 1 cannot see. On 2026-07-27 that handed #1389 to a second instance while #1408 was
  # actively building its last tier.
  # `-z "$ONLY_ISSUE"`: this guard is for the AUTONOMOUS pick only. --issue already warned above and
  # is an explicit human override, so re-blocking it here would make that override a no-op (it did,
  # until this line existed). A CLOSING PR still hard-blocks both paths — that one exits before the
  # loop.
  if [ -z "$ONLY_ISSUE" ] && has_active_pr "$cand"; then
    echo "↷ skip #$cand — open PR $(active_pr_ref "$cand") is already building this (\"Part of #$cand\")." >&2
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
