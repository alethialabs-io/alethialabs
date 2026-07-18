#!/usr/bin/env bash
#
# The coordinator pass — the light shared brain of the instance fleet. Stateless over the
# board, so any instance (or the maintainer) can run it; wrap in /loop for an always-on
# backend engine. See .claude/COORDINATION.md.
#
#   reclaim  stale leases (a dead instance's claim → freed, like #534 orphan-reclaim)
#   unblock  recompute the `blocked` label from each issue's `blocked-by:` line
#   report   per-wave board status + collisions to eyeball + UI units awaiting the human
#
# Usage:
#   scripts/coordinate.sh                 # reclaim + unblock + report
#   scripts/coordinate.sh --report        # report only (no mutations)
#   scripts/coordinate.sh --init-labels   # create/refresh the board's label set (once)
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
  --init-labels) MODE="init" ;;
  "" ) MODE="full" ;;
  -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# Portable ISO-8601(Z) → epoch seconds (macOS BSD date vs GNU date).
to_epoch() {
  local ts="$1"
  date -u -d "$ts" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || echo 0
}
now="$(date -u +%s)"

# ── init-labels ──────────────────────────────────────────────────────────────
if [ "$MODE" = "init" ]; then
  mklabel() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "  label: $1"; }
  for w in 1 2 3 4 5 6 7; do mklabel "wave:W$w" "1d76db" "north-star wave $w"; done
  mklabel "wave:hygiene" "0e8a16" "launch-hygiene track (parallel)"
  for l in schema server runner core canvas tests docs; do mklabel "lane:$l" "5319e7" "file-ownership lane: $l"; done
  mklabel "class:backend" "0e8a16" "autonomous: claim→PR→enqueue on green (merge queue)"
  mklabel "class:ui"      "d93f0b" "human-in-loop: design-spec → Claude Design → gated merge"
  mklabel "claimed"       "fbca04" "held by an instance (carries a lease comment)"
  mklabel "blocked"       "b60205" "a blocked-by dependency is still open (coordinate-maintained)"
  mklabel "mutex:migration" "e99695" "generates a drizzle migration — serialized, one at a time"
  mklabel "needs:design"  "d4c5f9" "UI unit awaiting the Claude-Design build"
  mklabel "needs:human"   "d4c5f9" "awaiting a human decision/gate"
  echo "✓ label set ready"
  exit 0
fi

# Pull the whole open board once.
board="$(gh issue list --state open --limit 300 --json number,title,labels,body,assignees)"
have() { echo "$board" | jq -e --arg n "$1" --arg l "$2" '.[]|select(.number==($n|tonumber))|.labels|map(.name)|index($l)' >/dev/null 2>&1; }

# ── reclaim stale leases ─────────────────────────────────────────────────────
reclaimed=0
if [ "$MODE" = "full" ]; then
  for n in $(echo "$board" | jq -r '.[]|select(.labels|map(.name)|index("claimed"))|.number'); do
    stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' \
      | sed -n 's/^stamped_at: //p' | tail -1)"
    [ -z "$stamp" ] && stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' | sed -n 's/^claimed_at: //p' | tail -1)"
    if [ -z "$stamp" ]; then continue; fi
    age=$(( now - $(to_epoch "$stamp") ))
    if [ "$age" -gt "$LEASE_TTL" ]; then
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
    (if (.labels|map(.name)|index("claimed")) then "CLAIMED"
     elif (.labels|map(.name)|index("blocked")) then "blocked"
     else "READY" end);
  sort_by(waveof, .number)[]
  | "  \(waveof|ltrimstr("wave:")|(.+"      ")[0:8]) #\(.number|tostring|(.+"    ")[0:5]) \(st|(.+"       ")[0:8]) \(.title[0:56]) \(if .assignees|length>0 then "→ "+.assignees[0].login else "" end)"
'
echo "  ─────"
echo "$board" | jq -r '
  "  ready:   \(map(select((.labels|map(.name)|index("claimed")|not) and (.labels|map(.name)|index("blocked")|not)))|length)"
  + "   claimed: \(map(select(.labels|map(.name)|index("claimed")))|length)"
  + "   blocked: \(map(select(.labels|map(.name)|index("blocked")))|length)"
'

# Collisions to eyeball: >1 claimed mutex:migration.
migc="$(echo "$board" | jq '[.[]|select((.labels|map(.name)|index("claimed")) and (.labels|map(.name)|index("mutex:migration")))]|length')"
[ "$migc" -gt 1 ] && echo "  ⚠ COLLISION: $migc claimed migration units at once — only one may generate migrations."

# UI awaiting the human.
uis="$(echo "$board" | jq -r '[.[]|select(.labels|map(.name)|index("class:ui"))|select(.labels|map(.name)|index("needs:design") or (.labels|map(.name)|index("needs:human")))|"#\(.number) \(.title)"][]' 2>/dev/null || true)"
if [ -n "$uis" ]; then echo "  ── UI awaiting you ──"; echo "$uis" | sed 's/^/  /'; fi

[ "$MODE" = "full" ] && echo "  (reclaimed $reclaimed stale lease(s))"
