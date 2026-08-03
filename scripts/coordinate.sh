#!/usr/bin/env bash
#
# The coordinator pass — the light shared brain of the instance fleet. Stateless over the
# board, so any instance (or the maintainer) can run it; wrap in /loop for an always-on
# backend engine. See .claude/COORDINATION.md.
#
#   reclaim  stale leases (a dead instance's claim → freed, like #534 orphan-reclaim)
#   unblock  recompute the `blocked` label from each issue's `blocked-by:` line
#   report   per-wave board status + collisions to eyeball + UI units awaiting the human +
#            possibly-shipped units (open, but a merged PR references them — de-stale the board)
#
# Usage:
#   scripts/coordinate.sh                 # reclaim + unblock + report
#   scripts/coordinate.sh --report        # report only (no mutations)
#   scripts/coordinate.sh --close-shipped # close open board units a MERGED PR CLOSES (kw + #n)
#   scripts/coordinate.sh --init-labels   # create/refresh the board's label set (once)
#
# --close-shipped is the manual BACKSTOP for the close-on-dev-merge Action: it reclaims/unblocks
# NOTHING, but for each open, still-claimable board unit that a MERGED PR CLOSES — a closing
# keyword (close|fix|resolve + tenses) directly before `#<n>`, in the PR TITLE or BODY — it closes
# the issue with a comment. Mirrors the Action's parser, so it retroactively catches the body-only
# `Closes #n` cases. A bare mention without a closing keyword is not a delivery and is left open.
#
# Env: ALETHIA_LEASE_TTL (seconds, default 3600) — a lease older than this with no heartbeat
#      is reclaimable.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v gh >/dev/null || { echo "gh (GitHub CLI) required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

LEASE_TTL="${ALETHIA_LEASE_TTL:-3600}"
MODE="full"
case "${1:-}" in
  --report) MODE="report" ;;
  --close-shipped) MODE="close-shipped" ;;
  --init-labels) MODE="init" ;;
  "" ) MODE="full" ;;
  -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# Portable ISO-8601(Z) → epoch seconds (macOS BSD date vs GNU date).
# Prints NOTHING on a parse failure — deliberately not `echo 0`, which made `now - 0` ≈ now, so an
# unparseable stamp looked infinitely old and its lease was reclaimed INSTANTLY. A timestamp we
# can't read is a reason to leave the claim alone, not to take it.
to_epoch() {
  local ts="$1"
  date -u -d "$ts" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || true
}
now="$(date -u +%s)"

# ── init-labels ──────────────────────────────────────────────────────────────
if [ "$MODE" = "init" ]; then
  # The label set is DATA — scripts/lib/board-labels.json — and decompose-validate.mjs derives the
  # proposal-authorable names from that same file. This used to be a hard-coded list here plus a
  # hand-written mirror in the validator, and the two drifted: seven program waves were live on the
  # board while the validator rejected every one of them as `unknown label`.
  labels_json="$(dirname "${BASH_SOURCE[0]}")/lib/board-labels.json"
  [ -f "$labels_json" ] || { echo "missing $labels_json" >&2; exit 1; }
  mklabel() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "  label: $1"; }
  while IFS=$'\t' read -r name color description; do
    [ -n "$name" ] || continue
    mklabel "$name" "$color" "$description"
  done < <(jq -r '.labels[] | [.name, .color, .description] | @tsv' "$labels_json")
  echo "✓ label set ready"
  exit 0
fi

# Pull the whole open board once.
board="$(gh issue list --state open --limit 300 --json number,title,labels,body,assignees)"
have() { echo "$board" | jq -e --arg n "$1" --arg l "$2" '.[]|select(.number==($n|tonumber))|.labels|map(.name)|index($l)' >/dev/null 2>&1; }

# has_closing_pr / has_active_pr — evidence that a holder is alive despite a stale lease. Both fail
# CLOSED (a gh failure reads as "yes, taken"): here a false "no" STRIPS a live instance's claim.
# Shared with claim-work.sh, which needs the identical predicates — this file used to carry a
# verbatim copy of has_closing_pr, and one protocol duplicated across call sites is how the xacct
# gate diverged three ways. See scripts/lib/board-pr.sh.
# shellcheck source=scripts/lib/board-pr.sh
. scripts/lib/board-pr.sh

# ── the merged-PR corpus, passed on DISK and never through argv ───────────────
# Both consumers below (the close-shipped closer and the possibly-shipped advisory) need the
# recent merged PRs. Both used to receive it as `jq --argjson merged "$merged"` — roughly 1 MB of
# JSON as a single command-line ARGUMENT.
#
# That quietly crossed ARG_MAX as the merged history grew (measured 2026-07-28: 1,059,524 bytes
# against a 1,048,576 limit — over by ~11 KB). The kernel then refuses the exec: jq never runs,
# the shell reports "Argument list too long" (exit 126), and BOTH call sites discarded it with
# `2>/dev/null || true`. An unset result then read as "found nothing" — so the closer reported
# "Nothing to close" and the advisory printed no section, on every run, for as long as the corpus
# has been over the line. Neither had a failure mode that said anything.
#
# A file has no size ceiling, and `--slurpfile` reads it directly. Keep it that way.
MERGED_PRS=""
fetch_merged_prs() {
  MERGED_PRS="$(mktemp -t alethia-merged-prs)"
  trap 'rm -f "$MERGED_PRS"' EXIT
  gh pr list --state merged --limit 300 --json number,title,body >"$MERGED_PRS" 2>/dev/null \
    || echo '[]' >"$MERGED_PRS"
}

# ── close-shipped: the manual backstop for the close-on-dev-merge Action ──────
# Mutates NOTHING on leases/blocks. For each open, still-claimable board unit that a MERGED PR
# CLOSES — a closing keyword (`close|fix|resolve` + tenses) directly before `#<n>`, in the PR
# TITLE or BODY — close the issue. This mirrors the `close-on-dev-merge` Action's parser exactly,
# so it's the retroactive backstop for units the Action didn't fire on (PRs merged before it
# existed, incl. the body-only `Closes #n` a title-only heuristic used to miss). A bare mention
# without a closing keyword is NOT a delivery and is never auto-closed. Idempotent (only OPEN
# units are in `board`). See .claude/COORDINATION.md.
if [ "$MODE" = "close-shipped" ]; then
  fetch_merged_prs
  # Emit "<issue> <pr-list>" pairs for every claimable unit a merged PR CLOSES (keyword + #n in
  # title or body — the same signal GitHub honours and the Action parses).
  #
  # NO `2>/dev/null || true` on this one: this path MUTATES the board. A tool failure must abort
  # loudly, never degrade into "nothing to close" — that silent-empty is precisely what let the
  # ARG_MAX break above run undetected.
  if ! strong="$(jq -r --slurpfile _m "$MERGED_PRS" '
    ($_m[0] // []) as $merged
    | .[]
    | select(.labels|map(.name)|any(startswith("class:")))                                 # board units only
    | select(.labels|map(.name)|any(. == "claimed" or . == "blocked" or . == "needs:human" or . == "needs:design")|not)
    | .number as $n
    | ($merged | map(select(                                                                # CLOSING keyword + #n, title OR body
        (((.title // "") + " " + (.body // ""))
         | test("(?i)\\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#\($n)\\b"))))) as $refs
    | select($refs|length > 0)
    | "\($n) \($refs|map("#\(.number)")|join(","))"
  ' <<<"$board")"; then
    echo "✗ close-shipped: could not evaluate the board (jq failed). Closing NOTHING." >&2
    exit 1
  fi
  if [ -z "$strong" ]; then
    echo "close-shipped: no open board unit is closed by a merged PR (keyword + #n in title/body). Nothing to close."
    exit 0
  fi
  closed=0
  while read -r n prs; do
    [ -z "$n" ] && continue
    gh issue close "$n" --comment "Closed by merged PR(s) ${prs} (coordinate --close-shipped backstop)." >/dev/null \
      && { echo "✓ closed #$n (shipped in ${prs})"; closed=$((closed+1)); } \
      || echo "  (could not close #$n — skipped)"
  done <<< "$strong"
  echo "close-shipped: closed $closed shipped board unit(s)."
  exit 0
fi

# ── reclaim stale leases ─────────────────────────────────────────────────────
# STALLED units: the lease is long dead AND the only reason we are not reclaiming is a PR that is
# itself stuck (conflicting, or untouched for PR_IDLE_TTL). Found via #1426/#1461: the lease was 8h
# past TTL, the worktree lease was free, the branch was 17 commits behind — and nothing surfaced it,
# because an open "Closes #1426" PR is, correctly, treated as evidence someone is on it.
#
# We deliberately do NOT reclaim these. Two reasons, and the second is the load-bearing one:
#   1. The guards in scripts/lib/board-pr.sh are FAIL-CLOSED by contract; weakening them to unstick a
#      board is how two instances end up building one unit (#1247).
#   2. It would not even work. claim-work.sh Guard 1 skips any unit with an open closing PR, so
#      stripping the label would only make the unit LOOK ready while the loop kept skipping it —
#      strictly worse than the honest "claimed" it shows today.
# So: name it loudly and let a human decide. `claim-work.sh --issue <n>` is the documented override.
PR_IDLE_TTL="${ALETHIA_PR_IDLE_TTL:-$(( LEASE_TTL * 4 ))}"
stalled_units=""
note_if_stalled() { # <n> <lease-age-seconds>
  local n="$1" age="$2" ref
  ref="$(stalled_pr_ref "$n" "$PR_IDLE_TTL")"
  [ -z "$ref" ] && return 0
  stalled_units="$stalled_units  #$n — lease dead ${age}s, blocked behind stalled PR $ref"$'\n'
}
reclaimed=0
# Runs in `full` AND `report`: the scan itself is read-only (lease comments + PR queries), and the
# stalled diagnostic below is worthless if you can only get it by running the mutating mode. The
# three writes are gated separately, further down.
if [ "$MODE" = "full" ] || [ "$MODE" = "report" ]; then
  for n in $(echo "$board" | jq -r '.[]|select(.labels|map(.name)|index("claimed"))|.number'); do
    stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' \
      | sed -n 's/^stamped_at: //p' | tail -1)"
    [ -z "$stamp" ] && stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' | sed -n 's/^claimed_at: //p' | tail -1)"
    if [ -z "$stamp" ]; then continue; fi
    stamp_epoch="$(to_epoch "$stamp")"
    # Unparseable stamp → leave it alone (see to_epoch).
    if [ -z "$stamp_epoch" ]; then
      echo "· #$n has an unreadable lease timestamp ('$stamp') — leaving the claim in place." >&2
      continue
    fi
    age=$(( now - stamp_epoch ))
    if [ "$age" -gt "$LEASE_TTL" ]; then
      # The docs promised this checked "PR/branch activity" and it never did — it reclaimed purely
      # on elapsed time, so a unit being actively built for over an hour without a heartbeat was
      # handed to a second instance. An open PR closing the issue is proof of a live holder.
      if has_closing_pr "$n"; then
        echo "· #$n lease is stale (${age}s) but a PR already closes it — not reclaiming." >&2
        note_if_stalled "$n" "$age"
        continue
      fi
      # Same evidence, the other phrasing: a PR delivering one tier of a multi-tier unit says
      # "Part of #n", never "Closes #n". Reclaiming on a stale lease alone would hand a unit that
      # someone is demonstrably still building to a second instance.
      if has_active_pr "$n"; then
        echo "· #$n lease is stale (${age}s) but open PR $(active_pr_ref "$n") is building it — not reclaiming." >&2
        note_if_stalled "$n" "$age"
        continue
      fi
      # `--report` reaches here too, so that the read-only mode can SEE what full mode would do.
      # Everything above this line is read-only; only the three writes below are gated on `full`.
      if [ "$MODE" != "full" ]; then
        echo "· #$n lease is stale (${age}s) and nothing is building it — reclaimable (report mode: not touching)." >&2
        continue
      fi
      who="$(echo "$board" | jq -r --arg n "$n" '.[]|select(.number==($n|tonumber))|.assignees[0].login // ""')"
      [ -n "$who" ] && gh issue edit "$n" --remove-assignee "$who" >/dev/null 2>&1 || true
      gh issue edit "$n" --remove-label claimed >/dev/null 2>&1 || true
      gh issue comment "$n" --body "reclaimed: lease stale (${age}s > ${LEASE_TTL}s, no heartbeat)" >/dev/null
      echo "↻ reclaimed #$n (stale ${age}s)"; reclaimed=$((reclaimed+1))
    fi
  done
fi

# ── unblock: recompute the `blocked` label from `blocked-by:` ───────────────
if [ "$MODE" = "full" ]; then
  for n in $(echo "$board" | jq -r '.[].number'); do
    body="$(echo "$board" | jq -r --arg n "$n" '.[]|select(.number==($n|tonumber))|.body // ""')"
    # `|| true`: grep exits 1 when an issue has no blocked-by; under `set -e` + pipefail that
    # non-zero command substitution would abort the whole pass on the first unblocked issue.
    deps="$(printf '%s' "$body" | sed -n 's/.*[Bb]locked-by:\([^\n]*\).*/\1/p' | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)"
    [ -z "$deps" ] && { have "$n" blocked && gh issue edit "$n" --remove-label blocked >/dev/null 2>&1 || true; continue; }
    open_dep=0
    for d in $deps; do
      st="$(gh issue view "$d" --json state --jq .state 2>/dev/null || echo OPEN)"
      [ "$st" = "OPEN" ] && open_dep=1
    done
    if [ "$open_dep" = "1" ]; then
      have "$n" blocked || gh issue edit "$n" --add-label blocked >/dev/null 2>&1 || true
    else
      have "$n" blocked && gh issue edit "$n" --remove-label blocked >/dev/null 2>&1 || true
    fi
  done
fi

# Refresh the board after mutations for an accurate report.
[ "$MODE" = "full" ] && board="$(gh issue list --state open --limit 300 --json number,title,labels,assignees)"

# ── report ───────────────────────────────────────────────────────────────────
echo
echo "──────── BOARD ($(date -u +%H:%MZ)) ────────"
echo "$board" | jq -r '
  def waveof: (.labels|map(.name)|map(select(startswith("wave:")))|(.[0]//"wave:—"));
  def st:
    (if (.labels|map(.name)|index("epic")) then "EPIC"
     elif (.labels|map(.name)|index("claimed")) then "CLAIMED"
     elif (.labels|map(.name)|index("blocked")) then "blocked"
     else "READY" end);
  sort_by(waveof, .number)[]
  | "  \(waveof|ltrimstr("wave:")|(.+"      ")[0:8]) #\(.number|tostring|(.+"    ")[0:5]) \(st|(.+"       ")[0:8]) \(.title[0:56]) \(if .assignees|length>0 then "→ "+.assignees[0].login else "" end)"
'
echo "  ─────"
# READY excludes epics: an umbrella/tracking issue is never claimable (it decomposes into sub-issues).
echo "$board" | jq -r '
  "  ready:   \(map(select((.labels|map(.name)|index("claimed")|not) and (.labels|map(.name)|index("blocked")|not) and (.labels|map(.name)|index("epic")|not)))|length)"
  + "   claimed: \(map(select(.labels|map(.name)|index("claimed")))|length)"
  + "   blocked: \(map(select(.labels|map(.name)|index("blocked")))|length)"
  + "   epics: \(map(select(.labels|map(.name)|index("epic")))|length)"
'

# Collisions to eyeball: >1 claimed mutex:migration.
migc="$(echo "$board" | jq '[.[]|select((.labels|map(.name)|index("claimed")) and (.labels|map(.name)|index("mutex:migration")))]|length')"
[ "$migc" -gt 1 ] && echo "  ⚠ COLLISION: $migc claimed migration units at once — only one may generate migrations."

# UI awaiting the human.
uis="$(echo "$board" | jq -r '[.[]|select(.labels|map(.name)|index("class:ui"))|select(.labels|map(.name)|index("needs:design") or (.labels|map(.name)|index("needs:human")))|"#\(.number) \(.title)"][]' 2>/dev/null || true)"
if [ -n "$uis" ]; then echo "  ── UI awaiting you ──"; echo "$uis" | sed 's/^/  /'; fi

# ── possibly-shipped: open board units a MERGED PR references but that never closed ──
# The stale-open failure mode: a multi-issue PR closes several units in one merge but omits
# the per-issue `Closes #n`, so GitHub creates no closing linkage and the issue never
# auto-closes — a future instance then re-claims finished work. Surface them to eyeball
# (heuristic — a reference is not a delivery; verify vs origin/dev before closing). Advisory
# only, never mutates, like the COLLISION flag above. See .claude/COORDINATION.md.
fetch_merged_prs
# Advisory, so a failure warns and continues rather than aborting the report — but it must SAY so.
# The previous `2>/dev/null || true` turned a jq that could not even be exec'd into a silent
# "no hits", which is why this section never printed once (see fetch_merged_prs).
if ! ship="$(jq -r --slurpfile _m "$MERGED_PRS" '
  ($_m[0] // []) as $merged
  | [ .[]
    # EXACTLY the READY predicate used by the counts below — not a stricter one. The hazard is a
    # unit that still LOOKS claimable, so the set to police is by definition the set READY
    # publishes. This additionally required a `class:` label and excluded needs:human/needs:design,
    # neither of which READY does — so a unit with no class label (#1207, #1046, #1050, #1058) or a
    # needs:human one (#1268, #1065) was counted claimable on the dashboard and invisible here.
    # Worst case was #1207: two merged PRs named it in their TITLES — the strongest signal this
    # heuristic has — suppressed because the issue happened to carry only `wave:connectors-v2`.
    | select(.labels|map(.name)|any(. == "claimed" or . == "blocked" or . == "epic")|not)
    | .number as $n
    | ($merged | map(select((.title|test("#\($n)\\b")) or (.body|test("#\($n)\\b"))))) as $refs
    | select($refs|length > 0)
    | { n: $n, title: .title[0:46],
        strong: ($refs|map(select(.title|test("#\($n)\\b")))|length > 0),          # named in a PR title = likely closed
        prs: ($refs|map("#\(.number)")|join(",")) } ]
  | sort_by(.n)[]
  | "  #\(.n)  \(if .strong then "LIKELY" else "verify" end)  (merged \(.prs))  \(.title)"
' <<<"$board")"; then
  echo "  ⚠ possibly-shipped: could not evaluate (jq failed) — advisory SKIPPED, the board may be stale." >&2
  ship=""
fi
if [ -n "$ship" ]; then
  echo "  ── ⚠ possibly-shipped (open, but a MERGED PR references it — verify vs origin/dev, close if delivered) ──"
  echo "$ship"
fi

# ── stalled: claimed, lease long dead, and the PR holding it is stuck too ────
# Not reclaimed on purpose (see the reclaim block). These are the units that would otherwise sit
# invisible forever: the board says someone owns them, and nothing says the owner left.
if [ -n "$stalled_units" ]; then
  echo "  ── ⚠ stalled (claimed, lease dead, and the PR holding it is stuck — needs a human) ──"
  printf '%s' "$stalled_units"
  echo "     take one over with:  scripts/claim-work.sh --issue <n>   (then rebase or close its PR)"
fi

# `if`, not `[ … ] && echo` — as the script's LAST command, a short-circuited `&&` becomes the exit
# status, so every read-only `--report` (and therefore `engine.sh status`, which execs it) exited 1
# on success. A reporter that reports failure when it worked is the same class of lie as the
# swallowed jq error above.
if [ "$MODE" = "full" ]; then
  echo "  (reclaimed $reclaimed stale lease(s))"
fi
