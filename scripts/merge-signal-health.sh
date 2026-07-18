#!/usr/bin/env bash
#
# merge-signal-health — is a heavy CI signal reliable enough to GATE merges yet?
#
# The merge queue (protect-dev ruleset, infra/github/main.tf) gates on the 7 fast required checks.
# The heavy real/browser signals run on every `merge_group` build but are OBSERVE-ONLY (not required)
# so a flaky real-cloud/browser run can't wedge the whole queue. This script turns "observe for a
# while, then promote" from a calendar reminder into a DATA verdict: it reads the conclusion of each
# heavy signal across the last N merge_group CI runs, computes its pass-rate, and says PROMOTE when a
# signal has earned the right to block merges (>= PROMOTE_RATE% over >= MIN_RUNS merge_group runs).
#
# Promotion itself is then a one-line change: add the signal's check name to
# `var.required_status_checks` (infra/github/variables.tf) and re-apply infra/github — the report
# prints the exact name to add.
#
# Usage:
#   scripts/merge-signal-health.sh              # human report to stdout
#   scripts/merge-signal-health.sh --issue <n>  # ALSO upsert the report onto tracking issue #<n>
#
# Env: RUNS (merge_group runs to sample, default 60), MIN_RUNS (default 20), PROMOTE_RATE (default 95).
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS="${RUNS:-60}"
MIN_RUNS="${MIN_RUNS:-20}"
PROMOTE_RATE="${PROMOTE_RATE:-95}"
ISSUE=""
[ "${1:-}" = "--issue" ] && ISSUE="${2:-}"

# The observe-only heavy signals we're deciding whether to promote. These are the exact GitHub check
# names (job `name:` in ci.yml) — they must match `var.required_status_checks` entries verbatim to gate.
SIGNALS=(
  "Provisioning E2E (T1 · real runner → kind)"
  "E2E (browser · Playwright hero path)"
  "E2E (browser · Elench AI journeys · scripted model)"
)

echo "→ sampling the last $RUNS merge_group CI runs…" >&2
# The queued-merge builds are CI runs with event=merge_group. Grab their ids (most recent first).
run_ids=$(gh run list --workflow ci.yml --event merge_group -L "$RUNS" --json databaseId --jq '.[].databaseId')

if [ -z "$run_ids" ]; then
  echo "No merge_group CI runs yet — the queue hasn't built anything. Nothing to evaluate."
  exit 0
fi

# Pull every job (name, conclusion) from every sampled run in one pass, so each signal is tallied
# across the same set of runs. Only success/failure count as a "graded" run; skipped/cancelled/null
# (e.g. a run that errored before the job, or the job was not reached) are ignored, not counted as fail.
jobs_json="$(for id in $run_ids; do
  gh api "repos/{owner}/{repo}/actions/runs/$id/jobs" --jq '.jobs[] | {name, conclusion}'
done)"

report=""
promote_lines=""
for sig in "${SIGNALS[@]}"; do
  # Count graded runs (success|failure) and successes for this signal.
  total=$(printf '%s\n' "$jobs_json" | jq -rs --arg n "$sig" \
    '[.[] | select(.name==$n and (.conclusion=="success" or .conclusion=="failure"))] | length')
  passed=$(printf '%s\n' "$jobs_json" | jq -rs --arg n "$sig" \
    '[.[] | select(.name==$n and .conclusion=="success")] | length')
  total=${total:-0}; passed=${passed:-0}

  if [ "$total" -eq 0 ]; then
    line=$(printf "  %-52s  no graded runs yet" "$sig")
    verdict="OBSERVE"
  else
    rate=$(( passed * 100 / total ))
    if [ "$total" -ge "$MIN_RUNS" ] && [ "$rate" -ge "$PROMOTE_RATE" ]; then
      verdict="PROMOTE"
      promote_lines+=$'\n'"  • \"$sig\"  ($passed/$total = ${rate}%)"
    else
      verdict="OBSERVE"
    fi
    line=$(printf "  %-52s  %3d%%  (%d/%d graded)  → %s" "$sig" "$rate" "$passed" "$total" "$verdict")
  fi
  report+="$line"$'\n'
done

summary="Merge-signal health — last $RUNS merge_group runs (promote at ≥${PROMOTE_RATE}% over ≥${MIN_RUNS} graded)

$report"
if [ -n "$promote_lines" ]; then
  summary+="
READY TO PROMOTE — add each to var.required_status_checks (infra/github/variables.tf) and re-apply infra/github:$promote_lines"
else
  summary+="
No signal has met the bar yet — keep observing."
fi

echo "$summary"

# Optional: upsert the report as a marked comment on a pinned tracking issue (idempotent-ish: a fresh
# comment each run keeps the history; the marker lets a human/scout find the series).
if [ -n "$ISSUE" ]; then
  gh issue comment "$ISSUE" --body "<!-- merge-signal-health -->
\`\`\`
$summary
\`\`\`" >&2 && echo "→ posted to issue #$ISSUE" >&2
fi
