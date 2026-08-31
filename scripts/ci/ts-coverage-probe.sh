#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The TypeScript coverage DETERMINISM PROBE — the body of the `ts-coverage-determinism` job.
#
# It answers one question: are the per-directory covered/total pairs CI produces stable
# run-to-run? Floors are only worth committing if they are. It then records the floors those
# numbers produce, which is the only sanctioned way to arm a project's ratchet — floors recorded
# on a laptop are not comparable to CI, which is the whole reason this job exists.
#
# WHY IT IS A SCRIPT AND NOT A `run:` BLOCK (#3265). Two reasons.
#
# 1. A `run:` step is `bash -e`, not the `bash` a laptop reaches for, and a step body cannot be
#    executed anywhere but inside a real CI run. That has already shipped an inert guard once: a
#    retry proved under plain `bash` was 100% dead in Actions. Here the hazard is sharper, because
#    this job is `workflow_dispatch`-only — nothing exercises it on a PR at all, so a defect in it
#    survives indefinitely. As a script it has `--self-test`, which the `guards` job runs.
#
# 2. The project list. `scripts/ts-coverage-sweep.json` is the committed record of which vitest
#    projects declare a coverage block, and `ts-coverage.mjs --self-test` already fails when a
#    recorded project has no ratchet step in ci.yml. That mirror stopped at the ratchet: the probe
#    hand-typed the same list FOUR more times — the clean-up, the print loop, the update loop and
#    the artefact `path:` — all three long against a record of six, and nothing asserted any of
#    them. `apps/marketing` and `ee`, the two the gate itself says are "awaiting numbers from CI",
#    could never get them; `packages/format` was floored outside the probe entirely. Here the list
#    is read once, from the record.
#
# WHY THE COVERAGE ASSERTION IS NOT DECORATION. `ts-coverage.mjs --print` FAILS OPEN: a project
# with no `coverage/coverage-final.json` takes F2 ("nothing measured, not a regression"), prints a
# notice and exits 0 with no rows. So a project dropping out of the measurement is, to the
# determinism comparison, indistinguishable from a project that is perfectly deterministic —
# `sort -u` over five identical empty outputs collapses exactly as it should. `assert_measured` is
# what makes an absence a RED rather than a shorter file, for the same reason
# `ts-coverage-sweep.json` records a set and not a count (#2724).
#
# Usage:
#   scripts/ci/ts-coverage-probe.sh              # the probe: N runs, compare, then record floors
#   scripts/ci/ts-coverage-probe.sh --self-test
#
# Env (all defaulted; --self-test drives them, nothing in CI sets them):
#   ALETHIA_TS_PROBE_RUNS   how many runs to compare        (default 5)
#   ALETHIA_TS_PROBE_SWEEP  the project record              (default scripts/ts-coverage-sweep.json)
#   ALETHIA_TS_PROBE_SUITE  produces every project's coverage/  (default pnpm exec turbo run test --force)
#   ALETHIA_TS_PROBE_TSCOV  the ratchet CLI                 (default node scripts/ts-coverage.mjs)
#   ALETHIA_TS_PROBE_OUT    where the floors artefact is staged  (default ts-coverage-floors)

set -euo pipefail

RUNS="${ALETHIA_TS_PROBE_RUNS:-5}"
SWEEP="${ALETHIA_TS_PROBE_SWEEP:-scripts/ts-coverage-sweep.json}"
SUITE="${ALETHIA_TS_PROBE_SUITE:-pnpm exec turbo run test --force}"
TSCOV="${ALETHIA_TS_PROBE_TSCOV:-node scripts/ts-coverage.mjs}"
OUT="${ALETHIA_TS_PROBE_OUT:-ts-coverage-floors}"

die() { echo "::error::ts-coverage-probe: $*" >&2; exit 1; }

# ── the list, read once ───────────────────────────────────────────────────────────────────────────
#
# read_projects <sweep-file>
#
# Empty is an ERROR, not an empty loop — `readSweepRecord()` in ts-coverage.mjs throws for the same
# reason. A probe that measured nothing must not read like a probe that found nothing wrong.
read_projects() {
  local sweep="$1" list
  [ -f "$sweep" ] || { echo "::error::ts-coverage-probe: no $sweep — the probe cannot know which projects to measure" >&2; return 1; }
  list="$(jq -er '.coverage_emitting_projects[]' "$sweep" 2>/dev/null)" || {
    echo "::error::ts-coverage-probe: $sweep records ZERO coverage-emitting projects, or .coverage_emitting_projects is not a list of strings — refusing to 'probe' nothing" >&2
    return 1
  }
  printf '%s\n' "$list"
}

# ── one run ───────────────────────────────────────────────────────────────────────────────────────
#
# probe_run <out-file> <project...>
#
# The clean-up is per-project and derived from the same list. It used to name three projects while
# the suite produced six, so three `coverage/` directories survived every `--force` iteration.
# Measuring a directory it did not clean is the one thing a determinism probe must not do.
probe_run() {
  local out="$1"; shift
  local p
  for p in "$@"; do rm -rf "${p:?}/coverage"; done
  # shellcheck disable=SC2086  # SUITE and TSCOV are command lines, deliberately word-split
  $SUITE
  : >"$out"
  for p in "$@"; do
    # shellcheck disable=SC2086
    $TSCOV --project "$p" --print | sed "s|^|$p |" >>"$out"
  done
}

# ── did the probe actually measure every project it claims to? ────────────────────────────────────
#
# assert_measured <rows-file> <project...>
#
# Field-exact, not a prefix match: `packages/plan-catalog` must not be satisfied by a row for
# `packages/plan-catalog-extra`. A substring hit dismissing a whole finding is a defect this
# repository has already paid for once.
#
# And SHAPE-exact, not merely field-exact. `$1 == p` alone asked "is there a line here whose first
# field is the project?", which is not the question — `probe_run` prefixes EVERY line of the child's
# stdout with the project name, so any line at all satisfied it. `ts-coverage.mjs` used to write its
# `::warning::` annotations to stdout, and `packages/foo ::warning::…` passed this assertion: the
# probe reported "every recorded project produced measured rows" over a run that measured nothing.
#
# So mirror the EMITTER. `runPrint` writes `<dir> <covered> <total>`, prefixed here to
# `<project> <dir> <covered> <total>` — four fields, the last two integers. Annotations now go to
# stderr (the real fix), and this is the independent second lock: either one alone closes the hole,
# which is the point of having both.
assert_measured() {
  local out="$1"; shift
  local p missing=""
  for p in "$@"; do
    awk -v p="$p" '$1 == p && NF == 4 && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { found = 1 } END { exit !found }' "$out" || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    echo "::error::ts-coverage-probe: recorded project(s) produced NO measured rows:$missing"
    echo "  --print fails OPEN (F2: no coverage/coverage-final.json), so this is silence, not a zero."
    echo "  TWO causes reach this line, and they send you to different places:"
    echo "  1. The project measured nothing. Either it stopped emitting coverage — fix its vitest"
    echo "     config, or remove it from the sweep record in the same PR — or the suite command did"
    echo "     not build it."
    echo "  2. It measured, but every row was the wrong SHAPE. A row is '<project> <dir> <covered>"
    echo "     <total>' — four fields, the last two integers. Anything the child wrote to STDOUT"
    echo "     that is not a measurement lands here looking like a row and is rejected. Check the"
    echo "     raw rows before assuming the vitest config: 'ts-coverage.mjs --project P --print'."
    echo "  Naming only cause 1 sent an operator to the vitest config once when the real cause was"
    echo "  commentary in the data channel, which is expensive in a workflow_dispatch-only job."
    return 1
  fi
  echo "✓ every recorded project produced measured rows ($# project(s))"
}

# ── are the numbers the same in every run? ────────────────────────────────────────────────────────
#
# assert_deterministic <expected-run-count> <rows-file...>
assert_deterministic() {
  local n="$1"; shift
  local expected actual
  expected="$(wc -l <"$1")"
  actual="$(cat "$@" | sort -u | wc -l)"
  if [ "$actual" -eq "$expected" ]; then
    echo "✓ TypeScript coverage is run-to-run deterministic across $n run(s)"
    return 0
  fi
  echo "::error::NONDETERMINISTIC — do NOT floor this. Rows that did not appear $n times:"
  cat "$@" | sort | uniq -c | awk -v n="$n" '$1 != n'
  return 1
}

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# WHAT IT HAS TO PROVE, and why each case is here rather than obvious:
#
#   (a) A recorded project that produces no rows FAILS, and the failure NAMES it. That is the case
#       this whole change exists for, and the one that fails open upstream.
#   (b) Every project is driven through (a) — not just the one the assertion was written around.
#       The last guard shipped from this repo derived its inputs correctly and still missed an
#       entire emission shape, because it was only ever mutated in the one place it was designed
#       for. So: mutate each, and tabulate.
#   (c) A row that differs between runs still FAILS. The determinism half must keep biting.
#   (d) The clean pass passes. A guard whose only exercised branch is its failure branch has never
#       been shown to pass for the right reason.
#   (e) A missing or EMPTY record is an error, not a silent success.
#   (f) The run loop drives the real commands, counted in a FILE — `n=$((n+1))` inside `$( )` is a
#       subshell and rewinds, which has already made one of my self-tests pass for the wrong reason.
if [ "${1:-}" = "--self-test" ]; then
  pass=0; fail=0
  ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
  bad() { fail=$((fail + 1)); echo "  ✗ $1"; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "ts-coverage-probe --self-test"
  echo
  echo " the record"

  if read_projects "$tmp/missing.json" >/dev/null 2>&1; then
    bad "a missing record should fail"
  else ok "a missing record fails"; fi

  echo '{"coverage_emitting_projects":[]}' >"$tmp/empty.json"
  if read_projects "$tmp/empty.json" >/dev/null 2>&1; then
    bad "an EMPTY record should fail — probing nothing is not a pass"
  else ok "an empty record fails"; fi

  echo '{"coverage_emitting_projects":["a","b","c"]}' >"$tmp/three.json"
  got="$(read_projects "$tmp/three.json" | tr '\n' ' ')"
  if [ "$got" = "a b c " ]; then ok "a good record reads back verbatim"
  else bad "read_projects returned '$got'"; fi

  echo
  echo " coverage of the measurement"
  set -- apps/console apps/marketing ee packages/format packages/plan-catalog packages/ui
  full="$tmp/full.txt"; : >"$full"
  for p in "$@"; do echo "$p src 10 20" >>"$full"; done
  if assert_measured "$full" "$@" >/dev/null 2>&1; then ok "all six present passes"
  else bad "all six present should pass"; fi

  for drop in "$@"; do
    part="$tmp/drop.txt"; : >"$part"
    for p in "$@"; do [ "$p" = "$drop" ] || echo "$p src 10 20" >>"$part"; done
    if msg="$(assert_measured "$part" "$@" 2>&1)"; then
      bad "dropping $drop should FAIL"
    elif ! printf '%s' "$msg" | grep -qF -- "$drop"; then
      bad "dropping $drop failed but did not NAME it"
    else
      ok "dropping $drop fails, and names it"
    fi
  done

  pre="$tmp/prefix.txt"
  echo "packages/plan-catalog-extra src 10 20" >"$pre"
  if assert_measured "$pre" packages/plan-catalog >/dev/null 2>&1; then
    bad "a row for a LONGER project name should not satisfy a shorter one"
  else ok "a row for a different project sharing its prefix does not satisfy it"; fi

  # THE #3342 REGRESSION. `probe_run` prefixes every line of the child's stdout, so anything the
  # child says on stdout arrives looking like a row for that project. ts-coverage.mjs wrote its
  # annotations there, and F2 (`no coverage-final.json — nothing measured`) is exactly the case
  # where there are no real rows to drown it out: the probe passed on a project it had not measured.
  ann="$tmp/annotation.txt"
  echo "packages/plan-catalog ::warning::ts-coverage F2: packages/plan-catalog: no coverage/coverage-final.json" >"$ann"
  if assert_measured "$ann" packages/plan-catalog >/dev/null 2>&1; then
    bad "an ANNOTATION line must not count as a measured row — that is #3342's silent pass"
  else ok "an annotation line does not satisfy the measurement assertion"; fi

  # ...and the non-vacuous half: the fixture differs from a real row ONLY in shape, so this proves
  # the check reads the shape rather than rejecting the fixture for some incidental reason.
  real="$tmp/real.txt"
  echo "packages/plan-catalog lib 10 20" >"$real"
  if assert_measured "$real" packages/plan-catalog >/dev/null 2>&1; then
    ok "...while a well-shaped row for the same project still does"
  else bad "a valid 4-field row must still satisfy the assertion"; fi

  for junk in "packages/plan-catalog lib 10" "packages/plan-catalog lib ten 20" "packages/plan-catalog lib 10 20 30"; do
    j="$tmp/junk.txt"; echo "$junk" >"$j"
    if assert_measured "$j" packages/plan-catalog >/dev/null 2>&1; then
      bad "a malformed row should not satisfy the assertion: '$junk'"
    else ok "malformed row rejected: '$junk'"; fi
  done

  echo
  echo " determinism"
  r1="$tmp/r1.txt"; r2="$tmp/r2.txt"; r3="$tmp/r3.txt"
  printf 'a src 1 2\nb src 3 4\n' >"$r1"; cp "$r1" "$r2"; cp "$r1" "$r3"
  if assert_deterministic 3 "$r1" "$r2" "$r3" >/dev/null 2>&1; then ok "identical runs pass"
  else bad "identical runs should pass"; fi
  printf 'a src 1 2\nb src 3 5\n' >"$r3"
  if assert_deterministic 3 "$r1" "$r2" "$r3" >/dev/null 2>&1; then
    bad "a row that differs between runs should FAIL"
  else ok "a row that differs between runs fails"; fi

  echo
  echo " the run loop"
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/suite" <<'STUB'
#!/usr/bin/env bash
echo run >>"$PROBE_SELFTEST_COUNTER"
STUB
  cat >"$tmp/bin/tscov" <<'STUB'
#!/usr/bin/env bash
echo "src 1 2"
STUB
  chmod +x "$tmp/bin/suite" "$tmp/bin/tscov"
  (
    cd "$tmp"
    mkdir -p wt/x/coverage wt/y/coverage
    cd wt
    export PROBE_SELFTEST_COUNTER="$tmp/count.txt"; : >"$PROBE_SELFTEST_COUNTER"
    # Overriding these INSIDE the subshell is the point — the stubs must not leak into the cases
    # after this one. shellcheck flags the scoping it is relying on.
    # shellcheck disable=SC2030
    SUITE="$tmp/bin/suite"
    # shellcheck disable=SC2030
    TSCOV="$tmp/bin/tscov"
    probe_run "$tmp/out.txt" x y
  )
  if [ "$(wc -l <"$tmp/count.txt")" -eq 1 ]; then ok "the suite is invoked once per run"
  else bad "the suite ran $(wc -l <"$tmp/count.txt") time(s), expected 1"; fi
  if [ "$(cat "$tmp/out.txt")" = "x src 1 2
y src 1 2" ]; then ok "each project's rows are prefixed with its own path"
  else bad "rows were: $(cat "$tmp/out.txt")"; fi
  if [ -d "$tmp/wt/x/coverage" ] || [ -d "$tmp/wt/y/coverage" ]; then
    bad "every project's coverage/ should be removed before the suite runs"
  else ok "every project's coverage/ is removed before the suite runs"; fi

  echo
  if [ "$fail" -eq 0 ]; then echo "ts-coverage-probe self-test: all $pass passed"; exit 0; fi
  echo "ts-coverage-probe self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

# ── the probe ─────────────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null || die "jq is required to read $SWEEP"

PROJECTS=()
while IFS= read -r line; do PROJECTS+=("$line"); done < <(read_projects "$SWEEP")
[ "${#PROJECTS[@]}" -gt 0 ] || die "no projects to probe"

echo "── probing ${#PROJECTS[@]} project(s) from $SWEEP, $RUNS run(s) ──"
printf '   %s\n' "${PROJECTS[@]}"

RUN_FILES=()
for i in $(seq 1 "$RUNS"); do
  echo "── run $i of $RUNS ──"
  probe_run "run.$i.txt" "${PROJECTS[@]}"
  RUN_FILES+=("run.$i.txt")
done

echo "── per-directory covered/total, run 1 ──"
cat run.1.txt

assert_measured "run.1.txt" "${PROJECTS[@]}"
assert_deterministic "$RUNS" "${RUN_FILES[@]}"

# ee/dist is RECORDED, not asserted. What makes probe-recorded floors reachable is that this job
# and the required `typescript` job run the IDENTICAL suite command — a property of the commands,
# not something a filesystem probe can assert here. The assertion that does bite is F7 inside the
# ratchet, which demotes when the recorded environment and the measuring one disagree.
if [ -f ee/dist/index.js ]; then
  echo "ee/dist PRESENT — floors will record ee_dist: true (enterprise scope)"
else
  echo "ee/dist ABSENT — floors will record ee_dist: false (community scope)"
fi

echo "── the floors these numbers produce (commit these VERBATIM) ──"
rm -rf "$OUT"
for p in "${PROJECTS[@]}"; do
  # shellcheck disable=SC2086,SC2031
  $TSCOV --project "$p" --update
  echo "── $p/coverage-floors.json ──"
  cat "$p/coverage-floors.json"
  # Staged into ONE directory because `upload-artifact`'s `path:` is static YAML and cannot take a
  # shell variable. That list was the fourth hand-typed copy, and the one that would have kept
  # marketing's and ee's floors on the runner even after the loops were fixed.
  mkdir -p "$OUT/$p"
  cp "$p/coverage-floors.json" "$OUT/$p/coverage-floors.json"
done
echo "✓ staged ${#PROJECTS[@]} floors file(s) under $OUT/"
