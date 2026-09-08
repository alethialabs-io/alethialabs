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
# Env: RUNS (merge_group runs to sample, default 60), MIN_RUNS (default 20), PROMOTE_RATE (default
#      95), MAX_AGE_DAYS (how recent a run must be to count as evidence, default 14).
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS="${RUNS:-60}"
MIN_RUNS="${MIN_RUNS:-20}"
PROMOTE_RATE="${PROMOTE_RATE:-95}"
# A PASS-RATE IS A CLAIM ABOUT TODAY, AND A RUN IS ONLY EVIDENCE WHILE IT IS RECENT.
#
# Measured 2026-09-03: every one of the 107 `merge_group` CI runs in the repo is dated 2026-07-18 to
# 2026-07-21 — `.mergify.yml` replaced GitHub's native queue on the 21st and the event has not fired
# since. This script had no age bound, so it graded those six-week-old runs as current and printed
#
#     READY TO PROMOTE — "E2E (browser · Playwright hero path)"  (60/60 = 100%)
#
# while that same check was failing on EVERY open PR. Promotion adds a check to
# var.required_status_checks; acting on that recommendation would have made a universally-failing
# job required and wedged the entire repository.
#
# That is worse than the silent-green it looks like: the script was not saying nothing, it was
# confidently recommending a repo-wide outage from data that had stopped being true.
MAX_AGE_DAYS="${MAX_AGE_DAYS:-14}"
ISSUE=""
[ "${1:-}" = "--issue" ] && ISSUE="${2:-}"

# Prints a report for the workflow summary and, when configured, records the same verdict on the
# tracking issue so a failing run cannot leave an older green recommendation as the latest evidence.
# Set by `gate_section` before the merge_group guards run, and appended by every publish.
#
# WHY IT IS A GLOBAL AND NOT INLINE: the release-gate verdict used to be computed at the BOTTOM of
# this script, below two `exit 1` guards that fire whenever `run_ids` is empty — which this file's
# own comments establish is permanent, because `merge_group` has not fired since .mergify.yml
# replaced the native queue on 2026-07-21. So the block could never execute, and the staging→main
# promotion decision it exists to inform was never printed. The two sources are independent: one
# being dead must not silence the other.
GATE_SECTION=""

publish_report() {
  local summary="$1${GATE_SECTION}"
  printf '%s\n' "$summary"
  if [ -n "$ISSUE" ]; then
    gh issue comment "$ISSUE" --body "<!-- merge-signal-health -->
\`\`\`
$summary
\`\`\`" >&2
    echo "→ posted to issue #$ISSUE" >&2
  fi
}

# The observe-only heavy signals we're deciding whether to promote. These are the exact GitHub check
# names (job `name:` in ci.yml) — they must match `var.required_status_checks` entries verbatim to gate.
SIGNALS=(
  "Provisioning E2E (T1 · real runner → kind)"
  "E2E (browser · Playwright hero path)"
  "E2E (browser · Elench AI journeys · scripted model)"
)

echo "→ sampling the last $RUNS merge_group CI runs…" >&2
# The queued-merge builds are CI runs with event=merge_group. Grab their ids (most recent first).
runs_json=$(gh run list --workflow ci.yml --event merge_group -L "$RUNS" --json databaseId,createdAt)
cutoff=$(date -u -d "${MAX_AGE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-"${MAX_AGE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)
newest=$(printf '%s' "$runs_json" | jq -r '[.[].createdAt] | max // ""')
run_ids=$(printf '%s' "$runs_json" | jq -r --arg c "$cutoff" '.[] | select(.createdAt >= $c) | .databaseId')

# ── THE RELEASE GATE — a second signal source, graded the same way ─────────────────────────────
# release-gate.yml runs on every non-draft PR into main or staging (and on a labelled dev PR). Its
# legs are REQUIRED on main by infra/github, and observed on staging. This grades the same
# `Release gate (<leg>)` contexts over the last $RUNS of those runs so the staging→main promotion
# decision (delete the staging exclusions in infra/github/main.tf) is a data verdict, not a feeling.
#
# "No runs yet" is printed as exactly that. Unlike the merge_group source, this workflow is NEW and
# a zero sample is not a dead event source — but it is also NOT evidence, and no PROMOTE line is
# ever produced from it.
#
# COMPUTED HERE, ABOVE THE merge_group GUARDS, and published by `publish_report` on every exit
# path. Below them it was unreachable: both guards `exit 1` whenever `run_ids` is empty, which is
# every invocation since the native merge queue was retired.
gate_section() {
  local gate_runs_json gate_ids gate_jobs gate_report gate_count sig total passed rate leg
  gate_runs_json=$(gh run list --workflow release-gate.yml --event pull_request -L "$RUNS" --json databaseId,createdAt 2>/dev/null || echo '[]')
  gate_ids=$(printf '%s' "$gate_runs_json" | jq -r --arg c "$cutoff" '.[] | select(.createdAt >= $c) | .databaseId')
  if [ -z "$gate_ids" ]; then
    printf '%s' "

Release gate (release-gate.yml, pull_request into main/staging): no runs in the last ${MAX_AGE_DAYS} days — no sample, so no verdict. Not evidence either way."
    return 0
  fi
  gate_jobs="$(for id in $gate_ids; do
    gh api "repos/{owner}/{repo}/actions/runs/$id/jobs" --jq '.jobs[] | {name, conclusion}'
  done)"
  gate_report=""
  for leg in hero elench-ai console canvas qa audit; do
    sig="Release gate ($leg)"
    total=$(printf '%s\n' "$gate_jobs" | jq -rs --arg n "$sig" '[.[] | select(.name==$n and (.conclusion=="success" or .conclusion=="failure"))] | length')
    passed=$(printf '%s\n' "$gate_jobs" | jq -rs --arg n "$sig" '[.[] | select(.name==$n and .conclusion=="success")] | length')
    total=${total:-0}; passed=${passed:-0}
    if [ "$total" -eq 0 ]; then
      gate_report+=$(printf "  %-52s  no graded runs yet" "$sig")$'\n'
    else
      rate=$(( passed * 100 / total ))
      gate_report+=$(printf "  %-52s  %3d%%  (%d/%d graded)" "$sig" "$rate" "$passed" "$total")$'\n'
    fi
  done
  gate_count=$(printf '%s' "$gate_ids" | grep -c . || true)
  printf '%s' "

Release gate (release-gate.yml) — last $gate_count pull_request runs into main/staging:

$gate_report
The gate is REQUIRED on main and observed on staging. Requiring it on staging too is deleting the
staging exclusions in infra/github/main.tf, once every leg is green at the bar above."
}

GATE_SECTION="$(gate_section)"

if [ -n "$newest" ] && [ -z "$run_ids" ]; then
  summary="✗ Every merge_group CI run is older than ${MAX_AGE_DAYS} days (newest: $newest).

  The runs exist, so this is NOT 'no data yet' — the EVENT SOURCE HAS STOPPED.
  \`merge_group\` fires only under GitHub's native merge queue, which .mergify.yml
  replaced on 2026-07-21. Grading those runs would report a pass-rate from a mechanism
  that no longer exists, and PROMOTE on it — which adds a check to
  var.required_status_checks and would wedge every PR if that check now fails.

  Point SOURCE at an event that actually fires, or retire the promotion path. See #4173."
  publish_report "$summary"
  exit 1
fi

if [ -z "$run_ids" ]; then
  # THIS USED TO `exit 0`, AND THAT IS WHY NOBODY NOTICED.
  #
  # `merge_group` fires only under GitHub's NATIVE merge queue. `.mergify.yml` replaced that queue
  # on 2026-07-21 (the native queue's merge_group-only T1 job failed on missing auth env and wedged
  # every queued PR), so the event has not fired since — measured 2026-09-03: the last twelve
  # merge_group CI runs are all dated 2026-07-21 and all twelve FAILED.
  #
  # So for six weeks this script has printed "nothing to evaluate", exited 0, and reported green
  # every Monday, while the promote-on-data mechanism it exists to drive had no data source at all.
  # A guard whose "nothing found" branch is indistinguishable from "nothing wrong" is the failure
  # this repo names most often; here it was reporting on its own liveness.
  #
  # Fails loudly instead. If the event source is deliberately gone, the fix is to change SOURCE
  # below — not to make this quiet again.
  summary="✗ No CI runs found for event=merge_group.

  This script grades the observe-only heavy signals over merge-queue builds, and it has no
  sample. That is not 'no data yet' — it means the EVENT SOURCE IS DEAD. \`merge_group\`
  fires only under GitHub's native merge queue, which .mergify.yml replaced on 2026-07-21.

  Nothing can ever be promoted from here until this reads an event that actually fires.
  See #4173."
  publish_report "$summary"
  exit 1
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

sample_count=$(printf '%s' "$runs_json" | jq 'length')
summary="Merge-signal health — last $sample_count merge_group runs (requested $RUNS; promote at ≥${PROMOTE_RATE}% over ≥${MIN_RUNS} graded)

$report"
if [ -n "$promote_lines" ]; then
  summary+="
READY TO PROMOTE — add each to var.required_status_checks (infra/github/variables.tf) and re-apply infra/github:$promote_lines"
else
  summary+="
No signal has met the bar yet — keep observing."
fi

publish_report "$summary"
