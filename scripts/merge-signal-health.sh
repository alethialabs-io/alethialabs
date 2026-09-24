#!/usr/bin/env bash
#
# merge-signal-health — is a heavy CI signal reliable enough to GATE merges yet?
#
# The dev merge queue is MERGIFY (.mergify.yml). It gates on the protect-dev required checks. The
# heavy real/browser signals are OBSERVE-ONLY (not required), so a flaky real-runner/browser run
# cannot wedge the whole queue. This script turns "observe for a while, then promote" from a
# calendar reminder into a DATA verdict: it reads the conclusion of each heavy signal across the last
# N MERGE-QUEUE builds, computes its pass-rate, and says PROMOTE when a signal has earned the right to
# block merges (>= PROMOTE_RATE% over >= MIN_RUNS graded queue builds).
#
# ── THE SOURCE: Mergify's speculative builds (#2759) ─────────────────────────────────────────────
#
# A Mergify queue build is an ordinary ci.yml run with event=pull_request, on the draft PR Mergify
# opens from a `mergify/merge-queue/<hash>` branch. It is NOT `merge_group`: that event fires only
# under GitHub's native queue, which .mergify.yml replaced on 2026-07-21, and every merge_group run
# in the repo is from 2026-07-18..21 (#4173). This script graded merge_group until 2026-09-24 and,
# with a dead source, could only ever refuse.
#
# The listing is the REST endpoint, not `gh run list`: `gh run list` was observed returning stale
# data for this query. There is no server-side filter for a branch PREFIX, so it pages through
# event=pull_request runs and keeps the queue branches. GitHub caps a filtered run listing at 1000
# results, so at most MAX_PAGES (10) pages of 100 are read; the report names the window it actually
# covered rather than implying MAX_AGE_DAYS was reached.
#
# ── WHAT EACH SIGNAL IS EXPECTED TO DO ON THAT SOURCE ─────────────────────────────────────────────
#
# `queue` — scheduled on EVERY queue build (T1's job `if:` selects mergify/merge-queue/* heads).
#   Zero graded builds over a non-empty sample means its `if:` does not reach the source: UNREACHABLE.
# `paths` — path-gated (detect-changes): it runs only on a queue build whose PRs changed its surface.
#   Zero graded builds is "no evidence", not a fault — no sampled build touched those paths.
# Either class: a name that appears in NO sampled build's job list at all (renamed, removed, or the
#   whole workflow failed before creating jobs) is UNREACHABLE.
# UNREACHABLE exits 1 after the full report is published. It is a statement about the instrument,
# so it must not render as "keep observing" — that is how this report stayed green for six weeks.
#
# Usage:
#   scripts/merge-signal-health.sh              # human report to stdout
#   scripts/merge-signal-health.sh --issue <n>  # ALSO upsert the report onto tracking issue #<n>
#
# Env: RUNS (queue builds to sample, default 60), MIN_RUNS (default 20), PROMOTE_RATE (default 95),
#      MAX_AGE_DAYS (how recent a build must be to count as evidence, default 14), MAX_PAGES (REST
#      pages of 100 to read, default 10 = GitHub's 1000-result cap), PER_PAGE (default 100).
#
# Test: scripts/merge-signal-health-test.sh (offline, a fake `gh` on PATH; the exit code is the test).
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS="${RUNS:-60}"
MIN_RUNS="${MIN_RUNS:-20}"
PROMOTE_RATE="${PROMOTE_RATE:-95}"
MAX_PAGES="${MAX_PAGES:-10}"
PER_PAGE="${PER_PAGE:-100}"
QUEUE_PREFIX="mergify/merge-queue/"
# A PASS-RATE IS A CLAIM ABOUT TODAY, AND A RUN IS ONLY EVIDENCE WHILE IT IS RECENT.
#
# Measured 2026-09-03: every one of the 107 `merge_group` CI runs in the repo was dated 2026-07-18 to
# 2026-07-21. This script had no age bound then, so it graded those six-week-old runs as current and
# printed READY TO PROMOTE for "E2E (browser · Playwright hero path)" (60/60 = 100%) while that same
# check was failing on EVERY open PR. Acting on it would have made a universally-failing job required
# and wedged the repository. The bound stays under the new source for the same reason: if Mergify's
# queue stops (or its branch naming changes), the last good builds must age out into a refusal.
MAX_AGE_DAYS="${MAX_AGE_DAYS:-14}"
ISSUE=""
[ "${1:-}" = "--issue" ] && ISSUE="${2:-}"

# Set by `gate_section` before the queue-source guards run, and appended by every publish.
#
# WHY IT IS A GLOBAL AND NOT INLINE: the release-gate verdict used to be computed at the BOTTOM of
# this script, below `exit 1` guards that fired on every run while the source was dead. The two
# sources are independent: one being dead must not silence the other.
GATE_SECTION=""

# Prints a report for the workflow summary and, when configured, records the same verdict on the
# tracking issue so a failing run cannot leave an older green recommendation as the latest evidence.
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

# The observe-only heavy signals we're deciding whether to promote, as `<class>|<check name>`. The
# names are the exact GitHub check names (job `name:` in ci.yml) — they must match the required-check
# lists verbatim to gate. The class is what the job's `if:` makes it do on a queue build (see header).
SIGNALS=(
  "queue|Provisioning E2E (T1 · real runner → kind)"
  "paths|E2E (browser · Playwright hero path)"
  "paths|E2E (browser · Elench AI journeys · scripted model)"
)

cutoff=$(date -u -d "${MAX_AGE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-"${MAX_AGE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)

# ── THE RELEASE GATE — a second signal source, graded the same way ─────────────────────────────
# release-gate.yml runs on every non-draft PR into main or staging (and on a labelled dev PR). Its
# legs are REQUIRED on main by infra/github, and observed on staging. This grades the same
# `Release gate (<leg>)` contexts over the last $RUNS of those runs so the staging→main promotion
# decision (delete the staging exclusions in infra/github/main.tf) is a data verdict, not a feeling.
#
# "No runs yet" is printed as exactly that. A zero sample is NOT evidence, and no PROMOTE line is
# ever produced from it.
#
# COMPUTED HERE, ABOVE THE queue-source guards, and published by `publish_report` on every exit path.
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
  # DERIVED from the leg table, not retyped. This loop was the THIRD hand-written copy of the leg
  # list (after infra/github's required checks and the workflow's own table); #4266 added a seventh
  # leg and this one kept measuring six — so the instrument built to notice a leg that never runs
  # would itself have gone quiet about exactly that leg. Caught in review on #4435.
  #
  # The pattern accepts `project: "x"` and `"project": "x"` because the table is a JS array today
  # and becomes JSON under #4440; matching both means that change does not silently empty this list.
  gate_legs="$(grep -oE '"?project"?: *"[a-z][a-z-]*"' "$(dirname "$0")/../.github/workflows/release-gate.yml" 2>/dev/null \
    | sed -E 's/.*"([a-z][a-z-]*)"$/\1/' | sort -u)"
  # A scan that finds nothing is broken, not a gate with no legs. Refuse rather than report 0%.
  if [ "$(printf '%s\n' "$gate_legs" | grep -c .)" -lt 2 ]; then
    printf '%s\n' "Release gate: could not read the leg table out of .github/workflows/release-gate.yml — refusing to report a health signal over an unknown set of legs."
    return 1
  fi
  for leg in $gate_legs; do
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

# ── LIST THE QUEUE BUILDS ──────────────────────────────────────────────────────────────────────────
# Pages newest-first until it has RUNS completed in-window queue builds, reaches a run older than the
# cutoff, runs out of pages, or hits MAX_PAGES. A page whose body is not a run listing is a REFUSAL:
# parsing an error body as "zero runs" is how an instrument reports a dead source as an empty one.
echo "→ listing ci.yml pull_request runs on ${QUEUE_PREFIX}* (up to $MAX_PAGES pages of $PER_PAGE)…" >&2
queue_runs='[]'
pages_read=0
listing_oldest=""
page=1
while [ "$page" -le "$MAX_PAGES" ]; do
  page_json=$(gh api "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=pull_request&per_page=${PER_PAGE}&page=${page}") \
    || { publish_report "✗ Could not list ci.yml pull_request runs (page $page) — refusing to grade an unreadable source."; exit 1; }
  if ! printf '%s' "$page_json" | jq -e '.workflow_runs | type == "array"' >/dev/null 2>&1; then
    publish_report "✗ The ci.yml run listing (page $page) did not return a workflow_runs array — refusing to grade an unreadable source."
    exit 1
  fi
  pages_read=$page
  queue_runs=$(printf '%s' "$page_json" | jq -c --argjson acc "$queue_runs" --arg p "$QUEUE_PREFIX" \
    '$acc + [.workflow_runs[] | select((.head_branch // "") | startswith($p))
             | {id, created_at, status}]')
  n=$(printf '%s' "$page_json" | jq '.workflow_runs | length')
  page_oldest=$(printf '%s' "$page_json" | jq -r '[.workflow_runs[].created_at] | min // ""')
  [ -n "$page_oldest" ] && listing_oldest="$page_oldest"
  have=$(printf '%s' "$queue_runs" | jq --arg c "$cutoff" '[.[] | select(.created_at >= $c and .status == "completed")] | length')
  [ "$n" -lt "$PER_PAGE" ] && break
  [ -n "$page_oldest" ] && [[ "$page_oldest" < "$cutoff" ]] && break
  [ "$have" -ge "$RUNS" ] && break
  page=$((page + 1))
done

newest=$(printf '%s' "$queue_runs" | jq -r '[.[].created_at] | max // ""')
# In-progress builds are left out: their heavy jobs have no conclusion yet, and counting the build
# while dropping the job would shrink every signal's denominator unevenly.
sample_json=$(printf '%s' "$queue_runs" | jq -c --arg c "$cutoff" --argjson n "$RUNS" \
  '[.[] | select(.created_at >= $c and .status == "completed")] | sort_by(.created_at) | reverse | .[:$n]')
run_ids=$(printf '%s' "$sample_json" | jq -r '.[].id')
oldest_sampled=$(printf '%s' "$sample_json" | jq -r '[.[].created_at] | min // ""')

if [ -z "$newest" ]; then
  # THIS USED TO `exit 0`, AND THAT IS WHY NOBODY NOTICED. A guard whose "nothing found" branch is
  # indistinguishable from "nothing wrong" reported green every Monday for six weeks while the
  # promote-on-data mechanism had no data at all. It fails loudly instead.
  publish_report "✗ No ci.yml pull_request runs on ${QUEUE_PREFIX}* in the $pages_read page(s) read (back to ${listing_oldest:-nothing}).

  The heavy signals are graded over Mergify's queue builds, and there is no sample. Either the
  queue has not run in that window, or Mergify's branch naming changed and QUEUE_PREFIX no longer
  matches. Nothing can be promoted from here until it reads builds that exist. See #2759."
  exit 1
fi

if [ -z "$run_ids" ]; then
  publish_report "✗ No COMPLETED queue build is newer than ${MAX_AGE_DAYS} days (newest seen: $newest).

  The builds exist, so this is not 'no data yet' — the source is stale or still running. Grading
  old builds would report a pass-rate about a tree that is no longer dev, and PROMOTE on it would
  add a check to the required lists that may now fail on every PR. See #2759."
  exit 1
fi

# Pull every job (run, name, conclusion) from every sampled build in one pass, so each signal is
# tallied across the same set of builds. Only success/failure count as "graded"; skipped, cancelled
# and null are not counted as failures. `cancelled` is expected: once Mergify merges a batch it closes
# the draft PR, and a still-running heavy job on it can be cut off.
jobs_json="$(for id in $run_ids; do
  body=$(gh api "repos/{owner}/{repo}/actions/runs/$id/jobs?per_page=100")
  printf '%s' "$body" | jq -e '.jobs | type == "array"' >/dev/null 2>&1 \
    || { echo "✗ run $id: job listing is not a jobs array" >&2; exit 1; }
  printf '%s' "$body" | jq -c --arg id "$id" '.jobs[] | {run: $id, name, conclusion}'
done)" || { publish_report "✗ Could not read the job list of every sampled queue build — refusing to grade a partial sample."; exit 1; }

sample_count=$(printf '%s\n' "$run_ids" | grep -c .)
report=""
promote_lines=""
unreachable=0
for entry in "${SIGNALS[@]}"; do
  class="${entry%%|*}"
  sig="${entry#*|}"
  counts=$(printf '%s\n' "$jobs_json" | jq -rs --arg n "$sig" '
    [.[] | select(.name == $n)] as $j
    | [ ($j | map(select(.conclusion == "success" or .conclusion == "failure")) | length),
        ($j | map(select(.conclusion == "success")) | length),
        ($j | map(select(.conclusion == "skipped")) | length),
        ($j | map(.run) | unique | length) ] | @tsv')
  read -r total passed skipped present <<<"$counts"

  if [ "$present" -eq 0 ]; then
    verdict="UNREACHABLE"
    line=$(printf "  %-52s  in none of %d queue builds' job lists — renamed, removed, or never created  → %s" "$sig" "$sample_count" "$verdict")
    unreachable=1
  elif [ "$total" -eq 0 ] && [ "$class" = "queue" ]; then
    verdict="UNREACHABLE"
    line=$(printf "  %-52s  skipped on all %d queue builds — its if: does not select ${QUEUE_PREFIX}*  → %s" "$sig" "$present" "$verdict")
    unreachable=1
  elif [ "$total" -eq 0 ]; then
    verdict="OBSERVE"
    line=$(printf "  %-52s  no graded runs — path-gated, and none of %d queue builds changed its paths" "$sig" "$present")
  else
    rate=$(( passed * 100 / total ))
    if [ "$total" -ge "$MIN_RUNS" ] && [ "$rate" -ge "$PROMOTE_RATE" ]; then
      verdict="PROMOTE"
      promote_lines+=$'\n'"  • \"$sig\"  ($passed/$total = ${rate}%)"
    else
      verdict="OBSERVE"
    fi
    line=$(printf "  %-52s  %3d%%  (%d/%d graded, %d skipped)  → %s" "$sig" "$rate" "$passed" "$total" "$skipped" "$verdict")
  fi
  report+="$line"$'\n'
done

summary="Merge-signal health — last $sample_count Mergify queue builds (${QUEUE_PREFIX}*, $oldest_sampled .. $newest; requested $RUNS within ${MAX_AGE_DAYS}d; promote at ≥${PROMOTE_RATE}% over ≥${MIN_RUNS} graded)

$report"
if [ -n "$promote_lines" ]; then
  # THE ADVICE NAMES EVERY PLACE, because promoting into one of them is a wedge, not a half-step.
  # A context the ruleset requires and Mergify does not wait for queues, looks mergeable, and is
  # refused at merge time; scripts/ci/check-required-checks.mjs fails a PR that does that, and fails
  # one whose two .mergify.yml lists differ. The always-report rule is the part no list can check.
  summary+="
READY TO PROMOTE:$promote_lines

  A check gates only once it is named, verbatim, in ALL THREE places — one PR, so
  scripts/ci/check-required-checks.mjs sees them agree:
    1. var.required_status_checks            infra/github/variables.tf (the maintainer applies infra/github)
    2. queue_rules[dev].merge_conditions     .mergify.yml
    3. merge_protections[\"dev required CI\"]  .mergify.yml success_conditions
  .mergify.yml takes effect only once it reaches main (Mergify reads the default branch).

  ALWAYS-REPORT RULE — check this BEFORE the lists. A required check must report on every PR into
  dev and on every queue build. A job-level \`if:\` that skips it (T1 is queue-only; the browser E2Es
  are path-gated) leaves the context \`skipped\`, which Mergify's \`check-success=\` does not accept:
  merge_protections are evaluated on the PR itself, so the PR is never auto-queued. Move the gate
  from the job to its STEPS (as validate-console.yml does) so the job always runs and passes fast
  when it has nothing to do — then promote."
else
  summary+="
No signal has met the bar yet — keep observing."
fi

publish_report "$summary"
if [ "$unreachable" -ne 0 ]; then
  echo "✗ at least one signal is UNREACHABLE on the queue source — the instrument cannot grade it (exit 1)." >&2
  exit 1
fi
