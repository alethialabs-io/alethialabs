#!/usr/bin/env bash
# shellcheck shell=bash
#
# Offline test for scripts/merge-signal-health.sh (#2759). The EXIT CODE is the test; the text is a
# report.
#
# A fake `gh` on PATH serves fixture JSON for the three calls the script makes: the REST run listing
# of ci.yml pull_request runs (paged), each run's job list, and `gh run list` for the release gate
# (always empty here — that section is not under test). No network, no token.
#
# It then MUTATES the script six times — each mutation undoes one property the scenarios claim to
# pin — and requires the suite to FAIL on every mutant. A mutation whose anchor no longer matches is
# itself a failure: a mutant identical to the original would "survive" for the wrong reason.
#
#   bash scripts/merge-signal-health-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SUBJECT="$ROOT/scripts/merge-signal-health.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── the fake gh ──────────────────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  run) echo '[]' ;;
  issue) exit 0 ;;
  api)
    url="$2"
    case "$url" in
      *actions/workflows/ci.yml/runs*)
        page="${url##*page=}"
        if [ -f "$FIXTURE/listing-error" ]; then cat "$FIXTURE/listing-error"; exit 0; fi
        if [ -f "$FIXTURE/page-$page.json" ]; then cat "$FIXTURE/page-$page.json"; else echo '{"total_count":0,"workflow_runs":[]}'; fi ;;
      *actions/runs/*/jobs*)
        id="${url#*actions/runs/}"; id="${id%%/*}"
        if [ -f "$FIXTURE/jobs-$id.json" ]; then cat "$FIXTURE/jobs-$id.json"; else echo '{"message":"Not Found"}'; exit 1; fi ;;
      *) echo "fake gh: unexpected api $url" >&2; exit 2 ;;
    esac ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$TMP/bin/gh"

T1="Provisioning E2E (T1 · real runner → kind)"
HERO="E2E (browser · Playwright hero path)"
ELENCH="E2E (browser · Elench AI journeys · scripted model)"

# ISO-8601 UTC timestamp `$1` hours ago (BSD and GNU date).
ago_h() { date -u -v-"$1"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "$1 hours ago" +%Y-%m-%dT%H:%M:%SZ; }

REPO="alethialabs-io/alethialabs"

# Appends one run to the fixture's run table: id, hours-ago, head branch, status, and optionally the
# head repository (default: this repo; `null` = a deleted fork, which the API reports as null).
add_run() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$(ago_h "$2")" "$3" "$4" "${5:-$REPO}" >>"$FIXTURE/runs.tsv"; }

# Writes a run's job list. Each of T1/HERO/ELENCH gets a conclusion, or `absent` to omit the job.
add_jobs() {
  local id="$1" t1="$2" hero="$3" elench="$4"
  jq -n --arg t1n "$T1" --arg t1 "$t1" --arg hn "$HERO" --arg h "$hero" --arg en "$ELENCH" --arg e "$elench" '
    {total_count: 0, jobs: ([{name: "Detect PR surface changes", conclusion: "success"}]
      + ([[$t1n, $t1], [$hn, $h], [$en, $e]] | map(select(.[1] != "absent") | {name: .[0], conclusion: .[1]})))}' \
    >"$FIXTURE/jobs-$id.json"
}

# Splits runs.tsv (newest first) into REST pages of $PER_PAGE, the shape the script pages through.
paginate() {
  local per="$1"
  jq -R -s --argjson per "$per" --arg repo "$REPO" '
    split("\n") | map(select(length > 0) | split("\t")
      | {id: (.[0] | tonumber), created_at: .[1], head_branch: .[2], status: .[3], event: "pull_request",
         head_repository: (if .[4] == "null" then null else {full_name: .[4]} end),
         repository: {full_name: $repo}})
    | sort_by(.created_at) | reverse
    | [range(0; length; $per) as $i | .[$i:$i + $per]]' "$FIXTURE/runs.tsv" |
    jq -c '.[]' | {
      p=1
      while IFS= read -r chunk; do
        printf '{"total_count":0,"workflow_runs":%s}' "$chunk" >"$FIXTURE/page-$p.json"
        p=$((p + 1))
      done
    }
}

# Runs the subject copy at $1 against the current fixture. Sets OUT and CODE.
invoke() {
  local subject="$1"; shift
  : >"$FAKE_LOG"
  OUT="$(env "$@" PATH="$TMP/bin:$PATH" FIXTURE="$FIXTURE" FAKE_LOG="$FAKE_LOG" bash "$subject" 2>&1)"
  CODE=$?
}

# Starts an empty fixture directory for one scenario.
fresh() { FIXTURE="$TMP/fx-$1"; rm -rf "$FIXTURE"; mkdir -p "$FIXTURE"; : >"$FIXTURE/runs.tsv"; FAKE_LOG="$FIXTURE/gh.log"; }

# Runs every scenario against the script at $1. Prints ok/FAIL lines; returns the failure count.
suite() {
  local subject="$1" fails=0 i
  ok() { [ -n "${QUIET:-}" ] || echo "ok   - $1"; }
  bad() { [ -n "${QUIET:-}" ] || echo "FAIL - $1" >&2; fails=$((fails + 1)); }
  has() { printf '%s' "$OUT" | grep -qF -- "$1"; }

  # A — healthy queue source, paged over 4 pages of 10, with feature-PR runs and in-progress queue
  # builds mixed in that would each pull T1 below the bar if they were counted.
  fresh healthy
  for i in $(seq 1 25); do
    add_run "$((1000 + i))" "$i" "mergify/merge-queue/q$i" completed
    if [ "$i" -le 20 ]; then add_jobs "$((1000 + i))" success success skipped; else add_jobs "$((1000 + i))" success skipped skipped; fi
  done
  for i in $(seq 1 10); do add_run "$((2000 + i))" "$i" "feat/thing-$i" completed; add_jobs "$((2000 + i))" failure failure failure; done
  for i in 1 2; do add_run "$((3000 + i))" 0 "mergify/merge-queue/live$i" in_progress; add_jobs "$((3000 + i))" failure failure skipped; done
  paginate 10
  invoke "$subject" PER_PAGE=10
  [ "$CODE" -eq 0 ] && ok "A: healthy source exits 0" || bad "A: healthy source exited $CODE"
  has "$T1" && has "100%  (25/25 graded, 0 skipped)  → PROMOTE" && ok "A: T1 graded over exactly the 25 completed queue builds" \
    || bad "A: T1 was not graded 25/25 — feature-PR or in-progress runs leaked into the sample"
  has "100%  (20/20 graded, 5 skipped)  → PROMOTE" && ok "A: path-gated hero graded only where it ran" || bad "A: hero tally wrong"
  has "no graded runs — path-gated" && ok "A: a never-run path-gated signal is OBSERVE, not an error" || bad "A: path-gated elench not reported as path-gated"
  if has "var.required_status_checks" && has "merge_conditions" && has "merge_protections" && has "ALWAYS-REPORT RULE"; then
    ok "A: promotion advice names all three places and the always-report rule"
  else bad "A: promotion advice is missing a place or the always-report rule"; fi
  grep -q 'actions/runs/20' "$FAKE_LOG" && bad "A: fetched jobs of a feature-PR run" || ok "A: never fetched a feature-PR run's jobs"
  [ "$(grep -c 'workflows/ci.yml/runs' "$FAKE_LOG")" -eq 4 ] && ok "A: paged the listing (4 pages)" || bad "A: did not page through all 4 listing pages"

  # B — T1 is scheduled on none of the queue builds: UNREACHABLE, exit 1.
  fresh t1-dead
  for i in $(seq 1 25); do add_run "$((1000 + i))" "$i" "mergify/merge-queue/q$i" completed; add_jobs "$((1000 + i))" skipped success skipped; done
  paginate 100
  invoke "$subject"
  [ "$CODE" -eq 1 ] && ok "B: a queue-class signal skipped everywhere exits 1" || bad "B: exited $CODE, want 1"
  has "skipped on all 25 queue builds" && has "UNREACHABLE" && ok "B: the T1 line says UNREACHABLE" || bad "B: no UNREACHABLE verdict for T1"

  # C — a signal that appears in no build's job list (renamed/removed): UNREACHABLE, exit 1.
  fresh absent
  for i in $(seq 1 25); do add_run "$((1000 + i))" "$i" "mergify/merge-queue/q$i" completed; add_jobs "$((1000 + i))" success success absent; done
  paginate 100
  invoke "$subject"
  [ "$CODE" -eq 1 ] && ok "C: a signal absent from every job list exits 1" || bad "C: exited $CODE, want 1"
  has "in none of 25 queue builds' job lists" && ok "C: the absent signal is named UNREACHABLE" || bad "C: absent signal not reported"

  # D — the queue builds exist but are all older than MAX_AGE_DAYS: refuse, exit 1.
  fresh stale
  for i in $(seq 1 25); do add_run "$((1000 + i))" "$((480 + i))" "mergify/merge-queue/q$i" completed; add_jobs "$((1000 + i))" success success success; done
  paginate 100
  invoke "$subject" MAX_AGE_DAYS=14
  [ "$CODE" -eq 1 ] && ok "D: a stale source exits 1" || bad "D: stale source exited $CODE"
  has "No COMPLETED queue build is newer than 14 days" && ok "D: the refusal names staleness" || bad "D: stale refusal text missing"
  has "PROMOTE:" && bad "D: printed a PROMOTE from stale builds" || ok "D: no PROMOTE from stale builds"

  # E — no queue builds at all, only feature-PR runs: refuse, exit 1.
  fresh empty
  for i in $(seq 1 25); do add_run "$((2000 + i))" "$i" "feat/x$i" completed; add_jobs "$((2000 + i))" success success success; done
  paginate 100
  invoke "$subject"
  [ "$CODE" -eq 1 ] && ok "E: an empty queue source exits 1" || bad "E: empty source exited $CODE"
  has "No ci.yml pull_request runs on mergify/merge-queue/*" && ok "E: the refusal names the missing source" || bad "E: empty refusal text missing"

  # F — a real pass-rate below the bar: OBSERVE, and nothing to promote.
  fresh below-bar
  for i in $(seq 1 20); do
    add_run "$((1000 + i))" "$i" "mergify/merge-queue/q$i" completed
    if [ "$i" -le 2 ]; then add_jobs "$((1000 + i))" failure skipped skipped; else add_jobs "$((1000 + i))" success skipped skipped; fi
  done
  paginate 100
  invoke "$subject"
  [ "$CODE" -eq 0 ] && ok "F: below the bar exits 0" || bad "F: exited $CODE"
  has "90%  (18/20 graded, 0 skipped)  → OBSERVE" && ok "F: 18/20 grades OBSERVE" || bad "F: 18/20 not graded OBSERVE"
  has "No signal has met the bar yet" && ok "F: says nothing met the bar" || bad "F: printed a promotion"

  # G — the listing returns an error body, not a run listing: refuse rather than read it as zero.
  fresh unreadable
  echo '{"message":"Bad credentials"}' >"$FIXTURE/listing-error"
  invoke "$subject"
  [ "$CODE" -eq 1 ] && has "did not return a workflow_runs array" && ok "G: an error body is a refusal" || bad "G: error body not refused (exit $CODE)"

  # H — one sampled build's job list cannot be read: refuse a partial sample.
  fresh partial
  for i in $(seq 1 25); do add_run "$((1000 + i))" "$i" "mergify/merge-queue/q$i" completed; add_jobs "$((1000 + i))" success success success; done
  rm "$FIXTURE/jobs-1007.json"
  paginate 100
  invoke "$subject"
  [ "$CODE" -eq 1 ] && has "refusing to grade a partial sample" && ok "H: an unreadable job list is a refusal" || bad "H: partial sample not refused (exit $CODE)"

  # I — fork PRs named like queue branches (#5029 review): a fork chooses its branch name and its own
  # ci.yml, so its all-green T1 must not be counted. 20 real queue builds grade 18/20; the 10 fork
  # runs (and one whose fork was deleted, head_repository null) would lift that to a PROMOTE.
  fresh fork
  for i in $(seq 1 20); do
    add_run "$((1000 + i))" "$((i + 2))" "mergify/merge-queue/q$i" completed
    if [ "$i" -le 2 ]; then add_jobs "$((1000 + i))" failure skipped skipped; else add_jobs "$((1000 + i))" success skipped skipped; fi
  done
  for i in $(seq 1 10); do add_run "$((4000 + i))" 1 "mergify/merge-queue/f$i" completed "mallory/alethialabs"; add_jobs "$((4000 + i))" success skipped skipped; done
  add_run 4099 1 "mergify/merge-queue/gone" completed null; add_jobs 4099 success skipped skipped
  paginate 100
  invoke "$subject"
  has "90%  (18/20 graded, 0 skipped)  → OBSERVE" && ok "I: fork runs on a queue-named branch are not graded" \
    || bad "I: T1 not graded 18/20 — a fork run was counted as a queue build"
  grep -q 'actions/runs/40' "$FAKE_LOG" && bad "I: fetched a fork run's jobs" || ok "I: never fetched a fork run's jobs"

  return "$fails"
}

# Copies the subject into a scratch repo layout (it cd's to its parent and reads release-gate.yml).
stage() {
  local dir="$TMP/stage-$1"
  mkdir -p "$dir/scripts" "$dir/.github/workflows"
  cp "$SUBJECT" "$dir/scripts/merge-signal-health.sh"
  cp "$ROOT/.github/workflows/release-gate.yml" "$dir/.github/workflows/release-gate.yml"
  printf '%s' "$dir/scripts/merge-signal-health.sh"
}

total_fails=0
echo "── the real script"
real="$(stage real)"
suite "$real"
total_fails=$?

# ── mutations: each must make the suite fail ──────────────────────────────────────────────────────
MUTANTS=(
  'drops the queue-branch filter|startswith($p)|true'
  'drops the age bound on the sample|select(.created_at >= $c and .status == "completed")] | sort_by|select(.status == "completed")] | sort_by'
  'counts in-progress builds|select(.created_at >= $c and .status == "completed")] | sort_by|select(.created_at >= $c)] | sort_by'
  'drops the queue-class UNREACHABLE|elif [ "$total" -eq 0 ] && [ "$class" = "queue" ]; then|elif false; then'
  'makes UNREACHABLE exit 0|if [ "$unreachable" -ne 0 ]; then|if false; then'
  'drops the head-repository check|and (.head_repository.full_name // "") == (.repository.full_name // "-")|and true'
)
echo "── mutations (each must be KILLED)"
n=0
for m in "${MUTANTS[@]}"; do
  n=$((n + 1))
  label="${m%%|*}"; rest="${m#*|}"; from="${rest%%|*}"; to="${rest#*|}"
  mutant="$(stage "m$n")"
  FROM="$from" TO="$to" python3 - "$mutant" <<'PY'
import os, sys
p = sys.argv[1]
s = open(p).read()
f, t = os.environ["FROM"], os.environ["TO"]
if f not in s:
    sys.exit(3)
open(p, "w").write(s.replace(f, t))
PY
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL - mutant $n ($label): anchor not found in the script — the mutation did not apply" >&2
    total_fails=$((total_fails + 1)); continue
  fi
  if ! QUIET=1 suite "$mutant"; then echo "ok   - mutant $n killed: $label"; else
    echo "FAIL - mutant $n SURVIVED: $label" >&2; total_fails=$((total_fails + 1)); fi
done

if [ "$total_fails" -ne 0 ]; then
  echo "merge-signal-health-test: $total_fails failure(s)" >&2
  exit 1
fi
echo "merge-signal-health-test: all scenarios pass, all ${#MUTANTS[@]} mutants killed"
