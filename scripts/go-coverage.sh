#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Per-package Go statement-coverage RATCHET. Coverage may rise, or stay flat. It may not fall.
#
# There is no absolute target. A package at 3% is fine, as long as it does not become 2%. The
# absolute-threshold gate is a different tool (apps/cli/scripts/coverage.sh); this one only ever
# asks "did you make it worse".
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY IT PARSES THE PROFILE AND NEVER `go tool cover -func`
#
# `-func` walks *ast.FuncDecl only. Every statement inside a package-level initializer — which is
# where the entire CLI lives, `var xCmd = &cobra.Command{RunE: func(…) {…}}` — belongs to no
# FuncDecl, so `-func` drops it from BOTH the numerator and the denominator. Measured on this
# repo: `-func` reports apps/cli at 64.7% where the profile says 43.8%, and reports the CLI's
# curated "logic scope" at 92.7% where the profile says 60.9%. A ratchet built on `-func` would
# be blind to exactly the code most likely to regress.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY FLOORS ARE INTEGER PAIRS AND NOT PERCENTAGES
#
# Floors store `covered` and `total` as integers and the comparison is a cross-multiplication:
#
#     PASS  <=>  covered_now * total_floor  >=  covered_floor * total_now
#
# No division, no float, no rounding ever enters the decision. This is not fastidiousness — it is
# the single likeliest way this script could wedge the repository. packages/core/git is
# 185/291 = 63.5739%, which every Go tool DISPLAYS as "63.6%". Store the displayed value and
# compare it against the measured one and the gate fails with zero code change, on every PR,
# forever. Percentages appear in messages only, formatted from the same integers.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY EVERY ERROR PATH IS FAIL-OPEN
#
# This runs inside `Go (build · vet · test · lint)`, a REQUIRED check with no path filter — it
# gates every pull request in the repository, not only Go ones. A false failure does not
# inconvenience one author; it stops the merge queue for everyone. So the rule is: the ONLY
# condition that may exit non-zero is a package that is present in both the floors and the
# profile, whose ratio genuinely fell, measured in an environment that matches the one the floors
# were recorded in. Everything else warns and exits 0. The enumerated set is in check().
#
# The subtlest of those is TOOLCHAIN DRIFT. Coverage here depends on what is on PATH, by a lot:
# packages/core/tofu moves 51.98% -> 36.72% when `tofu` is absent, packages/core/provisioner
# 50.73% -> 39.12%, apps/runner/internal/agent 49.58% -> 47.24%; and packages/core/api moves by
# two statements depending on whether an alethia credentials file exists. Those tests self-skip.
# So the floors carry a fingerprint of the environment that produced them, and if the current
# environment is missing something the recording environment had, every failure is demoted to a
# warning. Otherwise a pruned CI image reds the entire repository and the message would point at
# coverage rather than at the missing binary.
#
# THE GO COMPILER IS PART OF THAT TOOLCHAIN, and it is the one axis that moves the DENOMINATOR
# rather than skipping a test. Measured on an identical tree (#4247, determinism probe, five runs
# each): test/e2e's root package is 3406/5082 under go1.26.6 and 3686/5532 under go1.27.1, and
# cmd/t2budget — not one byte changed — counts 24 statements under 1.26 and 36 under 1.27. The
# ratio fell, so the ratchet reported "`.` fell to 66.63%" and pointed at --update, which by design
# cannot lower a floor. The only exit was --accept-regression, i.e. recording a compiler change as
# a coverage regression in a file that says "do not hand-edit".
#
# So the Go MINOR is in the fingerprint, as a string, compared like `os`: any mismatch in either
# direction demotes, because a compiler that counts MORE statements is exactly as incomparable as
# one that counts fewer. A Go bump now reds with a message that names Go and a one-command fix,
# instead of a red that names coverage. The PATCH is deliberately not fingerprinted — 1.27.0 and
# 1.27.1 do not renumber statements, and a fingerprint that churns on every point release would
# demote the gate more often than it enforced it.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# USAGE
#
#   scripts/go-coverage.sh --module apps/runner                 # CHECK. What CI runs.
#   scripts/go-coverage.sh --module apps/runner --update        # raise floors to measured (NEVER lowers)
#   scripts/go-coverage.sh --module apps/runner --accept-regression   # rewrite, INCLUDING lowering
#   scripts/go-coverage.sh --module apps/runner --print         # "<pkg> <covered> <total>", exit 0
#   scripts/go-coverage.sh --module apps/runner --profile p.out # override the profile path
#   scripts/go-coverage.sh --self-test                          # offline fixtures; no go, no network
#   scripts/go-coverage.sh --module apps/runner --require-verdict   # exit 3 if it did NOT measure
#
# EXIT CODES: 0 = measured and passed, 1 = measured and below floor, 2 = USAGE error, 3 = NO
# VERDICT (only with --require-verdict; without it a non-measuring path still exits 0). "The
# check never ran" and "the code is fine" must not be the same green in CI — and 3 is distinct
# from 2 because a bad invocation and a check that could not run are different problems.
#
# Run it from anywhere: it cd's to the repo root itself, so the fix command printed on failure is
# absolute and needs no `cd` puzzle from whoever hits it.
#
# NOT COMPATIBLE WITH TEST SHARDING. Each shard would write a partial profile, which this would
# read as a genuine collapse. If sharding is ever introduced, teach --profile to merge several
# files through the same dedupe before it is turned on.
set -euo pipefail
export LC_ALL=C

cd "$(dirname "$0")/.."
ROOT="$PWD"

# REQUIRE_VERDICT defaults OFF so a laptop run stays advisory and bootstrap stays inert.
# CI turns it on, because there a green must mean "measured and fine", never "never ran".
MODULE="" PROFILE="" MODE="check" REQUIRE_VERDICT=0

while [ $# -gt 0 ]; do
	case "$1" in
	--module) MODULE="$2"; shift 2 ;;
	--module=*) MODULE="${1#*=}"; shift ;;
	--profile) PROFILE="$2"; shift 2 ;;
	--profile=*) PROFILE="${1#*=}"; shift ;;
	--update) MODE="update"; shift ;;
	--accept-regression) MODE="accept"; shift ;;
	--print) MODE="print"; shift ;;
	--self-test) MODE="self-test"; shift ;;
	--require-verdict) REQUIRE_VERDICT=1; shift ;;
	-h | --help) sed -n '2,89p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
	esac
done

# ── annotations ───────────────────────────────────────────────────────────────────────────────
# GitHub workflow commands must be single-line; a literal newline terminates them.
notice() { echo "::notice::$*"; }
warn() { echo "::warning::$*"; }

# ── measure ───────────────────────────────────────────────────────────────────────────────────
# Shared with apps/cli/scripts/coverage.sh (#1990) — one definition of what the number IS.
# shellcheck source=scripts/lib/go-coverage-measure.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/go-coverage-measure.sh"

# ── the ratchet comparison ────────────────────────────────────────────────────────────────────
# PASS <=> cov*ftot >= fcov*tot. Pure integers. Largest product in this repo is ~1.2e7, and a
# whole-repo variant would be ~3e8 — both exactly representable in bash arithmetic.
regressed() { # $1=cov $2=tot $3=floor_cov $4=floor_tot -> 0 if REGRESSED
	[ "$(($1 * $4))" -lt "$(($3 * $2))" ]
}

pct() { # $1=covered $2=total -> "63.57%"
	if [ "$2" -eq 0 ]; then echo "n/a"; else awk -v c="$1" -v t="$2" 'BEGIN { printf "%.2f%%", c / t * 100 }'; fi
}

# ── environment fingerprint ───────────────────────────────────────────────────────────────────
# What was present when these numbers were produced. Only binaries that measurably move coverage
# in this repo (verified by re-running the suites with each removed from PATH).
#
# `os` is in here for a measured reason. A maintainer's Mac and ubuntu-latest can carry ALL of
# these binaries — an identical boolean fingerprint — and still disagree: apps/runner/internal/agent
# measures 1669/3366 on macOS and 1671/3366 on Linux with the same commit and the same tools. So a
# matching boolean fingerprint is NOT sufficient to make two numbers comparable. Without the `os`
# key, a developer running this locally gets a failure they cannot act on. CI itself is unaffected
# (it is always ubuntu-latest, and the 5-run determinism probe pins that), but "unaffected in CI"
# is not a good enough reason to hand someone an unexplainable red.
#
# `go` is the second string key, and it is here for the reason spelled out in the header: the
# compiler renumbers statements between minors, which moves the DENOMINATOR of every package at
# once. Unlike a missing binary that only ever lowers coverage, a compiler change is incomparable
# in both directions, so it is compared like `os` — any mismatch demotes.
FINGERPRINT_KEYS="os go docker git helm kubectl tofu alethia_credentials"

# The fingerprint keys whose value is a STRING compared for equality, rather than a boolean where
# only true->false demotes. Named once, so write_floors() and the F7 loop cannot disagree about
# which is which — they did have to be edited in lockstep, and that is exactly how a key ends up
# serialised as a JSON string and then compared as a boolean.
FINGERPRINT_STRING_KEYS="os go"

is_string_key() { case " $FINGERPRINT_STRING_KEYS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

current_env() { # $1 = key -> "true"|"false", the OS name for `os`, or the Go minor for `go`
	case "$1" in
	os) uname -s ;;
	go)
		# MINOR ONLY: `go1.27.1` -> `1.27`. See the header for why the patch is excluded.
		#
		# Must always exit 0 and always print something. current_env is consumed as `v=$(...)`
		# under `set -e`, so a non-zero return here would abort the whole run — and this script's
		# every error path is fail-OPEN by contract. No go on PATH, or a GOVERSION shaped like
		# `devel go1.28-abcdef`, prints `unknown`, which the F7 loop treats the same way it treats
		# an older floors file with no `go` key: it does not demote, and it does not disarm.
		local gv="" ver rest
		gv=$(go env GOVERSION 2>/dev/null) || gv=""
		case "$gv" in
		go[0-9]*)
			ver="${gv#go}"
			rest="${ver#*.}"
			echo "${ver%%.*}.${rest%%.*}"
			;;
		*) echo unknown ;;
		esac
		;;
	alethia_credentials)
		local cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
		[ "$(uname)" = "Darwin" ] && cfg="$HOME/Library/Application Support"
		if [ -f "$cfg/alethia/credentials.json" ]; then echo true; else echo false; fi
		;;
	*)
		if command -v "$1" >/dev/null 2>&1; then echo true; else echo false; fi
		;;
	esac
}

# ── floors serialisation ──────────────────────────────────────────────────────────────────────
# Emitted by jq at 2-space indent, so every package is a 4-line record:
#     "internal/agent": {
#       "covered": 1669,
#       "total": 3366
#     },
# which guarantees at least two unchanged lines between any two packages' `covered` lines. That
# is precisely what git's 3-way merge needs to combine two PRs that each raise a DIFFERENT
# package without a conflict — two changed hunks with zero unchanged lines between them collide,
# with one or more they do not. Asserted for real with `git merge-file` in --self-test.
write_floors() { # $1 = floors path, $2 = module import path, $3 = covermode, stdin = "<pkg> <cov> <tot>"
	local pkgs env_json
	pkgs=$(awk '{ printf "%s{\"k\":\"%s\",\"c\":%d,\"t\":%d}", (NR > 1 ? "," : ""), $1, $2, $3 } END { print "" }')
	env_json="{"
	local first=1 k v
	for k in $FINGERPRINT_KEYS; do
		[ $first -eq 1 ] || env_json="$env_json,"
		v=$(current_env "$k")
		# `os` and `go` are strings; every other key is a JSON boolean. The set is named once in
		# FINGERPRINT_STRING_KEYS so this and the F7 comparison cannot drift apart.
		if is_string_key "$k"; then
			env_json="$env_json\"$k\":\"$v\""
		else
			env_json="$env_json\"$k\":$v"
		fi
		first=0
	done
	env_json="$env_json}"

	jq -n \
		--arg module "$2" \
		--arg covermode "$3" \
		--argjson env "$env_json" \
		--argjson pkgs "[$pkgs]" \
		'{
			"_": "GENERATED by scripts/go-coverage.sh --update. Do not hand-edit. Do not hand-merge a conflict here — re-run the generator instead.",
			module: $module,
			covermode: $covermode,
			env: $env,
			packages: ($pkgs | sort_by(.k) | map({(.k): {covered: .c, total: .t}}) | add // {})
		}' >"$1"
}

# ── the failure report ────────────────────────────────────────────────────────────────────────
# Two channels. (a) a single-line ::error anchored on the exact JSON line the author must change,
# so it renders inline in the file diff. (b) the full explanation to stderr and the step summary.
emit_error_annotation() { # $1=floors $2=pkg $3=cov $4=tot $5=fcov $6=ftot
	local line
	line=$(awk -v p="\"$2\":" '$1 == p { print NR + 1; exit }' "$1")
	[ -n "$line" ] || line=1
	echo "::error file=$1,line=$line::Coverage ratchet: $2 fell to $(pct "$3" "$4") ($3/$4); the floor is $(pct "$5" "$6") ($5/$6). Fix in one command from the repo root: scripts/go-coverage.sh --module $MODULE --update (or --accept-regression if the drop is intended). Full explanation in the job log."
}

emit_report() { # stdin = failing rows "<pkg> <cov> <tot> <fcov> <ftot>"
	local rows
	rows=$(cat)
	{
		echo "════════════════════════════════════════════════════════════════════════════════"
		echo "  COVERAGE RATCHET FAILED  —  $MODULE"
		echo "════════════════════════════════════════════════════════════════════════════════"
		echo
		printf "  %-34s %10s %10s   %s\n" "package" "floor" "now" "statements"
		printf "  %s\n" "---------------------------------------------------------------------------"
		while read -r p c t fc ft; do
			[ -n "$p" ] || continue
			printf "  %-34s %10s %10s   %s/%s  (floor %s/%s)\n" "$p" "$(pct "$fc" "$ft")" "$(pct "$c" "$t")" "$c" "$t" "$fc" "$ft"
		done <<<"$rows"
		cat <<EOF

  WHAT THIS CHECK IS
    A per-package RATCHET. Each package's coverage may go UP or stay flat. It may
    not go DOWN. There is no absolute target — 3% is fine, as long as it does not
    become 2%.

  WHY IT IS BLOCKING **YOU**
    This job runs on every PR in the repository, not only on Go PRs. If your change
    added code to $MODULE without tests, this fires even if that package is not
    "yours". That is intended. You are not expected to raise anyone's coverage —
    only to not lower it, or to record that you lowered it.

  FIX IT — PICK ONE, THEN COMMIT $MODULE/coverage-floors.json
  ---------------------------------------------------------------------------
    1. You want to cover the new code (best). Write the tests, then from the repo root:

         scripts/go-coverage.sh --module $MODULE --update

       Re-runs the suite if the profile is stale and RAISES the floors. It will
       never lower one, so it is always safe to run.

    2. You deliberately added uncovered code, or deleted covered code:

         scripts/go-coverage.sh --module $MODULE --accept-regression

       This LOWERS the floor to what you measured. It is an allowed, normal action.
       The lowered number shows up in the diff — that is the review signal, and it
       is the whole reason the floors are a checked-in file.

    3. You did not touch $MODULE and believe this is spurious: re-run the job once.
       If it reproduces, the environment has drifted — this suite's coverage depends
       on git, helm, kubectl and tofu being on PATH, AND on the Go minor (see the
       "env" block in the floors file; packages/core/tofu alone moves 15 points, and
       a Go minor bump renumbers statements in every package at once). A drifted
       environment normally DEMOTES this report to a warning; if you are reading it,
       the fingerprint matched. Run
       scripts/go-coverage.sh --self-test and open an issue with its output.
       DO NOT hand-edit the JSON, and DO NOT hand-resolve a merge conflict in it —
       re-run --update instead.

  This is NOT the apps/cli ≥90% gate (apps/cli/scripts/coverage.sh). That is a
  separate step and it measures a different thing.
════════════════════════════════════════════════════════════════════════════════
EOF
	} | tee ${GITHUB_STEP_SUMMARY:+-a "$GITHUB_STEP_SUMMARY"} >&2
}

# ── self-test ─────────────────────────────────────────────────────────────────────────────────
self_test() {
	local fails=0 tmp
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' RETURN

	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: want '$1' got '$2'" >&2; fails=$((fails + 1)); fi; }
	_pass() { if regressed "$1" "$2" "$3" "$4"; then echo "FAIL - $5: expected PASS, got REGRESSED" >&2; fails=$((fails + 1)); else echo "ok   - $5"; fi; }
	_fail() { if regressed "$1" "$2" "$3" "$4"; then echo "ok   - $5"; else echo "FAIL - $5: expected REGRESSED, got PASS" >&2; fails=$((fails + 1)); fi; }

	local M="github.com/x/y"

	# ── A. measure(): profile parsing ─────────────────────────────────────────────────────────
	printf 'mode: set\n%s/a/f.go:1.1,2.2 3 1\n%s/a/f.go:3.1,4.2 2 0\n' "$M" "$M" >"$tmp/p1"
	_a "a 3 5" "$(measure "$tmp/p1" "$M")" "measure: covered+uncovered blocks in one package"

	printf 'mode: set\n%s/main.go:1.1,2.2 4 1\n' "$M" >"$tmp/p2"
	_a ". 4 4" "$(measure "$tmp/p2" "$M")" "measure: root package key is '.'"

	printf 'mode: set\n%s/cloud/f.go:1.1,2.2 1 1\n%s/cloud/aws/g.go:1.1,2.2 1 0\n' "$M" "$M" >"$tmp/p3"
	_a "cloud 1 1
cloud/aws 0 1" "$(measure "$tmp/p3" "$M")" "measure: nested package is distinct from its parent"

	printf 'mode: count\n%s/a/f.go:1.1,2.2 3 7\n%s/a/f.go:3.1,4.2 2 0\n' "$M" "$M" >"$tmp/p4"
	_a "a 3 5" "$(measure "$tmp/p4" "$M")" "measure: mode=count treats any count>0 as covered (not ==1)"

	printf 'mode: atomic\n%s/a/f.go:1.1,2.2 3 9\n' "$M" >"$tmp/p5"
	_a "a 3 3" "$(measure "$tmp/p5" "$M")" "measure: mode=atomic parses"

	printf 'mode: banana\n%s/a/f.go:1.1,2.2 3 1\n' "$M" >"$tmp/p6"
	if measure "$tmp/p6" "$M" >/dev/null 2>&1; then
		echo "FAIL - measure: unknown covermode must exit non-zero so the caller fails OPEN" >&2
		fails=$((fails + 1))
	else
		echo "ok   - measure: unknown covermode exits non-zero (caller fails OPEN)"
	fi

	: >"$tmp/p7"
	_a "" "$(measure "$tmp/p7" "$M" 2>/dev/null || true)" "measure: empty file yields nothing"

	printf 'mode: set\n' >"$tmp/p8"
	_a "" "$(measure "$tmp/p8" "$M")" "measure: header-only profile yields nothing"

	printf 'mode: set\n%s/a/f.go:1.1,2.2 3 1\n\n' "$M" >"$tmp/p9"
	_a "a 3 3" "$(measure "$tmp/p9" "$M")" "measure: trailing blank line is ignored"

	printf 'mode: set\n%s/a/f.go:1.1,2.2 3 1\n%s/a/f.go:1.1,2.2 3 0\n' "$M" "$M" >"$tmp/p10"
	_a "a 3 3" "$(measure "$tmp/p10" "$M")" "measure: duplicate block counted ONCE (3/3, not 3/6)"

	printf 'mode: set\n%s/a/f.go:1.1,2.2 3 0\n%s/a/f.go:1.1,2.2 3 1\n' "$M" "$M" >"$tmp/p11"
	_a "a 3 3" "$(measure "$tmp/p11" "$M")" "measure: duplicate-block OR is order-independent"

	printf 'mode: set\n%s/b/f.go:1.1,2.2 1 1\n%s/a/f.go:1.1,2.2 1 1\n' "$M" "$M" >"$tmp/p12"
	_a "a 1 1
b 1 1" "$(measure "$tmp/p12" "$M")" "measure: output is sorted regardless of block order in the profile"

	printf 'mode: set\n%s/a/f.go:1.1,2.2 2 0\n' "$M" >"$tmp/p13"
	_a "a 0 2" "$(measure "$tmp/p13" "$M")" "measure: a package with zero covered statements is PRESENT at 0"

	# ── B. the ratchet arithmetic ─────────────────────────────────────────────────────────────
	_pass 370 582 185 291 "ratchet: identical ratio at double the size passes (exact, no float)"
	_pass 185 291 185 291 "ratchet: THE ROUNDING TRAP — 185/291 is 63.5739% and displays as 63.6%; it must pass its own floor"
	_fail 185 292 185 291 "ratchet: one statement added, uncovered -> REGRESSED"
	_pass 186 292 185 291 "ratchet: one statement added, covered -> passes"
	_fail 3 4 3 3 "ratchet: 100% -> 75% on a tiny package -> REGRESSED"
	_pass 4 4 3 3 "ratchet: tiny package grows fully covered -> passes"
	_pass 0 2 0 1 "ratchet: 0% cannot fall"
	_pass 3366 3366 3366 3366 "ratchet: largest real package, no overflow"
	_pass 1 1 0 0 "ratchet: a zero-total floor never divides"

	# ── C. floors serialisation + the merge property ──────────────────────────────────────────
	if ! command -v jq >/dev/null 2>&1; then
		echo "ok   - (skipped serialisation cases: jq unavailable)"
	else
		printf 'a/one 1 2\na/two 3 4\na/three 5 6\n' | write_floors "$tmp/f.json" "$M" set
		_a "0" "$(jq -e . "$tmp/f.json" >/dev/null 2>&1 && echo 0 || echo 1)" "floors: emitted JSON is valid"
		_a "a/one
a/three
a/two" "$(jq -r '.packages | keys[]' "$tmp/f.json")" "floors: package keys are sorted"
		_a "3" "$(jq -r '.packages["a/two"].covered' "$tmp/f.json")" "floors: covered round-trips as an integer"

		# The fingerprint's TYPES. `os` and `go` are strings; everything else is a JSON boolean.
		# Serialising a string key as a bare word produces invalid JSON, which F3 would then
		# fail-open on — the gate disarmed by a typo nothing else would catch.
		_a "string" "$(jq -r '.env.os | type' "$tmp/f.json")" "floors: env.os is a JSON string"
		_a "string" "$(jq -r '.env.go | type' "$tmp/f.json")" "floors: env.go is a JSON string"
		_a "boolean" "$(jq -r '.env.tofu | type' "$tmp/f.json")" "floors: a tool key is a JSON boolean"
		# MINOR ONLY. `1.27.1` here would demote the gate on every patch release.
		# (An rc toolchain reports `go1.28rc1`, which is a genuinely different compiler and is
		# allowed to appear as `1.28rc1`. A second dot is what must never appear.)
		_a "ok" "$(jq -r '.env.go | if test("^([0-9]+\\.[0-9]+[A-Za-z0-9]*|unknown)$") then "ok" else . end' "$tmp/f.json")" "floors: env.go is the Go MINOR (1.NN), never the patch"

		# Every record must span exactly 4 lines, so two adjacent records always have >= 2
		# unchanged lines between their `covered` lines.
		_a "4" "$(awk '/"a\/three": \{/{n=NR} /"a\/two": \{/{print $0 ? NR-n : ""}' "$tmp/f.json")" "floors: each package record spans exactly 4 lines"

		# THE property the whole file format exists for: two PRs each raising a DIFFERENT,
		# ADJACENT package must merge without a conflict. Assert it, do not assume it.
		printf 'a/one 1 2\na/two 3 4\na/three 5 6\n' | write_floors "$tmp/base.json" "$M" set
		printf 'a/one 2 2\na/two 3 4\na/three 5 6\n' | write_floors "$tmp/ours.json" "$M" set
		printf 'a/one 1 2\na/two 4 4\na/three 5 6\n' | write_floors "$tmp/theirs.json" "$M" set
		cp "$tmp/ours.json" "$tmp/merged.json"
		if git merge-file "$tmp/merged.json" "$tmp/base.json" "$tmp/theirs.json" >/dev/null 2>&1; then
			if grep -q '<<<<<<<' "$tmp/merged.json"; then
				echo "FAIL - floors: adjacent-package merge left conflict markers" >&2
				fails=$((fails + 1))
			else
				_a "2" "$(jq -r '.packages["a/one"].covered' "$tmp/merged.json")" "floors: 3-way merge of two adjacent raises keeps OURS"
				_a "4" "$(jq -r '.packages["a/two"].covered' "$tmp/merged.json")" "floors: 3-way merge of two adjacent raises keeps THEIRS"
			fi
		else
			echo "FAIL - floors: git merge-file reported a CONFLICT on two adjacent package raises" >&2
			fails=$((fails + 1))
		fi
	fi

	# ── D. the ::error annotation ─────────────────────────────────────────────────────────────
	if command -v jq >/dev/null 2>&1; then
		local ann
		MODULE="apps/runner" ann=$(emit_error_annotation "$tmp/f.json" "a/two" 3 5 3 4)
		_a "1" "$(printf '%s' "$ann" | wc -l | tr -d ' ' | awk '{print ($1==0)?1:0}')" "annotation: is a single line (a newline would truncate it)"
		_a "$(awk '/"a\/two": \{/{print NR+1}' "$tmp/f.json")" "$(printf '%s' "$ann" | sed -n 's/.*,line=\([0-9]*\)::.*/\1/p')" "annotation: line= points at the package's \"covered\" line"
	fi

	# ── E. exit codes: a skip must not look like a pass (#2852) ───────────────────────────────
	# These run the script as a SUBPROCESS, because the thing under test is its exit code and
	# nothing else can observe that. Both directions for each path: without the flag the skip
	# still exits 0 (a laptop run stays advisory, bootstrap stays inert), with it the same skip
	# exits 2. `|| rc=$?` is required — `set -e` would otherwise abort the self-test on the
	# non-zero we are deliberately provoking.
	local rc

	# F1 needs a module that EXISTS and is unarmed — a bootstrapping module. It has to live under
	# $ROOT because --module is repo-relative, so the fixture is created and removed here. Note
	# the module must be real: a path with no go.mod exits 2 (usage), not 3, which is the
	# distinction this block is testing and is why the two codes are different.
	local boot="$ROOT/.go-coverage-selftest-$$"
	mkdir -p "$boot" && printf 'module example.com/selftest\n\ngo 1.24\n' >"$boot/go.mod"
	rc=0; bash "$0" --module "$(basename "$boot")" >/dev/null 2>&1 || rc=$?
	_a "0" "$rc" "exit: an unarmed module exits 0 by default (bootstrap stays inert)"
	rc=0; bash "$0" --module "$(basename "$boot")" --require-verdict >/dev/null 2>&1 || rc=$?
	_a "3" "$rc" "exit: an unarmed module exits 3 under --require-verdict"
	rm -rf "$boot"

	# A path that is not a Go module at all is a USAGE error (2), not a no-verdict (3), with or
	# without the flag. Two problems, two codes — collapsing them is the defect being fixed.
	rc=0; bash "$0" --module scripts/lib --require-verdict >/dev/null 2>&1 || rc=$?
	_a "2" "$rc" "exit: a non-module path is a usage error (2), never a no-verdict (3)"

	# F4, via a real armed module pointed at a profile that does not exist. This is the path a
	# test step writing its profile elsewhere takes, and the one that made "the tests never ran"
	# and "coverage is fine" the same green in CI.
	rc=0; bash "$0" --module packages/core --profile "$tmp/__absent__.out" >/dev/null 2>&1 || rc=$?
	_a "0" "$rc" "exit: a missing coverprofile exits 0 by default"
	rc=0; bash "$0" --module packages/core --profile "$tmp/__absent__.out" --require-verdict >/dev/null 2>&1 || rc=$?
	_a "3" "$rc" "exit: a missing coverprofile exits 3 under --require-verdict"

	# And the message has to name the reason, or a 2 in a job log is a riddle.
	local msg
	msg=$(bash "$0" --module packages/core --profile "$tmp/__absent__.out" --require-verdict 2>&1 || true)
	case "$msg" in
	*"NO VERDICT"*"coverprofile"*) echo "ok   - exit: the no-verdict error names the cause" ;;
	*) echo "FAIL - exit: the no-verdict error does not name the cause: $msg" >&2; fails=$((fails + 1)) ;;
	esac

	# ── F. F7 toolchain drift on the GO key, BOTH DIRECTIONS (#4247) ──────────────────────────
	# A Go minor bump renumbers statements, so the ratchet used to report a compiler change as a
	# coverage regression and point at --update, which cannot lower a floor. The `go` key routes
	# it through F7 instead.
	#
	# THE CONTROL IS THE POINT. Asserting only "it demoted" cannot tell a demote caused by `go`
	# from one caused by any other axis — every local run already demotes on `os`. So the fixture
	# pins every other axis to a non-demoting value and runs the SAME regression twice: once with
	# a mismatched Go minor (must demote and NAME go) and once with this environment's own
	# (must fail for real, exit 1). Only the pair proves the key is what moved.
	if ! command -v jq >/dev/null 2>&1 || [ "$(current_env go)" = "unknown" ]; then
		echo 'ok   - (skipped the go-fingerprint cases: jq or a release go toolchain is unavailable)'
	else
		local fp="$ROOT/.go-coverage-selftest-fp-$$" here
		here=$(current_env go)
		mkdir -p "$fp"
		printf 'module example.com/fpselftest\n\ngo 1.24\n' >"$fp/go.mod"
		printf 'mode: set\nexample.com/fpselftest/a/f.go:1.1,2.2 2 0\n' >"$fp/cover.out"

		# Every axis but `go` pinned so it cannot demote: this OS, and every tool recorded false
		# (only a true->false transition demotes a boolean key).
		_fp_floors() { # $1 = the go minor to record
			jq -n --arg os "$(uname -s)" --arg go "$1" \
				'{module:"example.com/fpselftest",covermode:"set",
				  env:{os:$os,go:$go,docker:false,git:false,helm:false,kubectl:false,tofu:false,alethia_credentials:false},
				  packages:{a:{covered:2,total:2}}}' >"$fp/coverage-floors.json"
		}

		_fp_floors "0.0" # a minor no toolchain reports — guaranteed to differ from `here`
		rc=0; msg=$(bash "$0" --module "$(basename "$fp")" --profile "$fp/cover.out" --require-verdict 2>&1) || rc=$?
		_a "3" "$rc" "fingerprint: a Go minor that differs demotes (exit 3, not a coverage failure)"
		case "$msg" in
		*"drift:"*"go(0.0!=$here)"*) echo "ok   - fingerprint: the demote NAMES go and both minors" ;;
		*) echo "FAIL - fingerprint: the demote does not name go: $msg" >&2; fails=$((fails + 1)) ;;
		esac

		_fp_floors "$here" # THE CONTROL: same regression, matching fingerprint -> a real failure
		rc=0; bash "$0" --module "$(basename "$fp")" --profile "$fp/cover.out" --require-verdict >/dev/null 2>&1 || rc=$?
		_a "1" "$rc" "fingerprint: CONTROL — a matching Go minor still fails on a real regression"

		rm -rf "$fp"
	fi

	echo
	if [ "$fails" -eq 0 ]; then
		echo "self-test: all passed"
		return 0
	fi
	echo "self-test: $fails check(s) FAILED" >&2
	return 1
}

if [ "$MODE" = "self-test" ]; then
	self_test
	exit $?
fi

# ── everything below needs a module ───────────────────────────────────────────────────────────
[ -n "$MODULE" ] || { echo "--module <path> is required (try --help)" >&2; exit 2; }
[ -f "$ROOT/$MODULE/go.mod" ] || { echo "no go.mod at $MODULE — not a Go module" >&2; exit 2; }

# Read the module path from go.mod directly. NEVER `go list -m`: inside go.work it prints all four.
MODPATH=$(awk '$1 == "module" { print $2; exit }' "$ROOT/$MODULE/go.mod")
FLOORS="$MODULE/coverage-floors.json"
[ -n "$PROFILE" ] || PROFILE="$MODULE/cover.out"
# --profile may be given as an absolute path (comparing against a profile downloaded from a CI
# artifact is the motivating case). Resolve once, here, rather than prefixing $ROOT at each use —
# doing that turns an absolute path into "$ROOT//abs/path" and the script reports "no profile"
# for a file that plainly exists.
case "$PROFILE" in
/*) PROFILE_ABS="$PROFILE" ;;
*) PROFILE_ABS="$ROOT/$PROFILE" ;;
esac

# ── regenerate the profile when it is missing or stale (write paths only) ──────────────────────
ensure_profile() {
	local stale=0
	if [ ! -s "$PROFILE_ABS" ]; then
		stale=1
	elif [ -n "$(find "$ROOT/$MODULE" -name '*.go' -newer "$PROFILE_ABS" -print -quit 2>/dev/null)" ]; then
		echo "  $PROFILE is older than the sources — re-running the suite..."
		stale=1
	fi
	if [ "$stale" -eq 1 ]; then
		(cd "$ROOT/$MODULE" && go test ./... -coverprofile="$PROFILE_ABS" -covermode=set >/dev/null)
	fi
}

case "$MODE" in
print)
	[ -s "$PROFILE_ABS" ] || { echo "no profile at $PROFILE" >&2; exit 2; }
	measure "$PROFILE_ABS" "$MODPATH"
	exit 0
	;;

update | accept)
	command -v jq >/dev/null 2>&1 || { echo "jq is required to write floors" >&2; exit 2; }
	ensure_profile
	NOW=$(measure "$PROFILE_ABS" "$MODPATH") || { echo "unreadable profile at $PROFILE" >&2; exit 2; }
	COVERMODE=$(head -1 "$PROFILE_ABS" | sed 's/^mode: //')

	MERGED=""
	RAISED=0 KEPT=0 LOWERED=0 ADDED=0
	while read -r pkg c t; do
		[ -n "$pkg" ] || continue
		if [ -f "$ROOT/$FLOORS" ] && jq -e --arg p "$pkg" '.packages[$p]' "$ROOT/$FLOORS" >/dev/null 2>&1; then
			fc=$(jq -r --arg p "$pkg" '.packages[$p].covered' "$ROOT/$FLOORS")
			ft=$(jq -r --arg p "$pkg" '.packages[$p].total' "$ROOT/$FLOORS")
			if regressed "$c" "$t" "$fc" "$ft"; then
				if [ "$MODE" = "accept" ]; then
					echo "  LOWERED   $pkg   $(pct "$fc" "$ft") -> $(pct "$c" "$t")   ($fc/$ft -> $c/$t)"
					MERGED="$MERGED$pkg $c $t
"
					LOWERED=$((LOWERED + 1))
				else
					# --update NEVER lowers. That is what makes it safe to hand to a stranger.
					echo "  NOT LOWERED  $pkg   would drop $(pct "$fc" "$ft") -> $(pct "$c" "$t")   (use --accept-regression if intended)"
					MERGED="$MERGED$pkg $fc $ft
"
					KEPT=$((KEPT + 1))
				fi
			elif [ "$c" != "$fc" ] || [ "$t" != "$ft" ]; then
				echo "  raised    $pkg   $(pct "$fc" "$ft") -> $(pct "$c" "$t")   ($fc/$ft -> $c/$t)"
				MERGED="$MERGED$pkg $c $t
"
				RAISED=$((RAISED + 1))
			else
				MERGED="$MERGED$pkg $c $t
"
				KEPT=$((KEPT + 1))
			fi
		else
			echo "  added     $pkg   $(pct "$c" "$t")   ($c/$t)"
			MERGED="$MERGED$pkg $c $t
"
			ADDED=$((ADDED + 1))
		fi
	done <<<"$NOW"

	printf '%s' "$MERGED" | write_floors "$ROOT/$FLOORS" "$MODPATH" "$COVERMODE"
	echo "  wrote $FLOORS  ($RAISED raised, $ADDED added, $LOWERED lowered, $KEPT unchanged) — commit it."
	exit 0
	;;
esac

# ── CHECK (what CI runs) ──────────────────────────────────────────────────────────────────────
# Every branch before the comparison is fail-OPEN. See the header for why.
#
# EXIT CODES. Every skip below is individually correct and stays. What changed (#2852) is that
# they are no longer indistinguishable from a pass:
#
#   0  measured, and nothing regressed          — a VERDICT
#   1  measured, and something is below floor   — a VERDICT
#   2  usage error (already taken: no --module, not a Go module, jq missing for --update)
#   3  did NOT measure (any F-path, or a demote) — NO verdict, only under --require-verdict
#
# Without --require-verdict a non-measuring path still exits 0, so a laptop run stays advisory
# and bootstrap stays inert. CI passes the flag, because there the number is supposed to be
# authoritative and "the tests never ran" must not read the same as "coverage is fine".
#
# The two that can genuinely fire in CI are the reason this exists: F2 (a runner image without
# jq silently disarms the ratchet) and F4 (a test step that wrote its profile somewhere else).
# Both printed `::warning::`, which nothing surfaces on a PR page.
no_verdict() {
	if [ "$REQUIRE_VERDICT" = "1" ]; then
		echo "::error::$MODULE: coverage ratchet produced NO VERDICT — $1"
		echo "  --require-verdict was passed, so this is a failure rather than a silent pass." >&2
		exit 3
	fi
	exit 0
}

# F1 — no floors file yet. The ratchet is not armed for this module. Bootstrap must be inert.
[ -f "$ROOT/$FLOORS" ] || { notice "no $FLOORS — coverage ratchet not armed for $MODULE"; no_verdict "no $FLOORS, so the ratchet is not armed for this module"; }

# F2 — jq unavailable. A required check must not depend on a tool being installed.
command -v jq >/dev/null 2>&1 || { warn "jq unavailable — coverage ratchet SKIPPED for $MODULE"; no_verdict "jq is unavailable on this runner"; }

# F3 — floors unparseable. The likeliest cause is a hand-resolved merge conflict leaving
# `<<<<<<< HEAD` in the file. That must never red every PR in the repo.
jq -e '.packages' "$ROOT/$FLOORS" >/dev/null 2>&1 || {
	warn "$FLOORS is not valid JSON or has no .packages (a hand-resolved merge conflict?) — ratchet SKIPPED. Re-run: scripts/go-coverage.sh --module $MODULE --update"
	no_verdict "$FLOORS is not valid JSON or has no .packages"
}

# F4 — no profile. The only way to reach this is that the `go test` step already failed and
# failed the job. Failing twice adds noise and misattributes the cause.
[ -s "$PROFILE_ABS" ] || { warn "no coverprofile at $PROFILE — ratchet SKIPPED for $MODULE"; no_verdict "there is no coverprofile at $PROFILE"; }

# F5 — unrecognised mode line (a future Go release, or -race forcing atomic).
NOW=$(measure "$PROFILE_ABS" "$MODPATH") || { warn "$PROFILE has an unrecognised 'mode:' line — ratchet SKIPPED"; no_verdict "$PROFILE has an unrecognised 'mode:' line"; }

# F6 — the profile parsed to nothing (truncated, interrupted, disk full). Left alone this would
# read as "every package collapsed to 0%" and red them all at once.
[ -n "$NOW" ] || { warn "$PROFILE parsed to zero packages (truncated?) — ratchet SKIPPED"; no_verdict "$PROFILE parsed to zero packages"; }

# F7 — TOOLCHAIN DRIFT. If the recording environment had something this one lacks, coverage is
# not comparable and every failure is demoted. Measured: tofu is worth 15 points on
# packages/core/tofu, 11 on provisioner; helm+tofu 2.3 on runner/internal/agent; and a Go MINOR
# bump renumbers statements across every package at once (#4247 — test/e2e's root package went
# 3406/5082 -> 3686/5532 on an identical tree).
DEMOTE="" DRIFT=""
for k in $FINGERPRINT_KEYS; do
	rec=$(jq -r --arg k "$k" '.env[$k] // "unknown"' "$ROOT/$FLOORS")
	cur=$(current_env "$k")
	if is_string_key "$k"; then
		# A different OS, or a different Go minor, makes the two numbers incomparable in BOTH
		# directions — measured: apps/runner/internal/agent is 1669/3366 on Darwin and 1671/3366
		# on Linux with an otherwise identical fingerprint, and cmd/t2budget counts 24 statements
		# under go1.26 and 36 under go1.27 without changing a byte. Any mismatch demotes.
		#
		# `unknown` on EITHER side does not demote: on the recorded side it is a floors file
		# written before this key existed, and on the current side it is a runner with no `go` on
		# PATH — which cannot have produced a profile in the first place, so F4 already fired.
		if [ "$rec" != "unknown" ] && [ "$cur" != "unknown" ] && [ "$rec" != "$cur" ]; then
			DEMOTE=1
			DRIFT="$DRIFT $k($rec!=$cur)"
		fi
	# Only a true->false transition can lower coverage. More tools than before cannot hurt, and
	# an older floors file with no `env` block ("unknown") must NOT silently disarm the gate.
	elif [ "$rec" = "true" ] && [ "$cur" != "true" ]; then
		DEMOTE=1
		DRIFT="$DRIFT $k(absent)"
	fi
done

# F8 — PROFILE PLAUSIBILITY, checked BEFORE any comparison.
#
# This is the guard that a naive implementation gets wrong, and it is worth being explicit about
# because it bit this script during development. A truncated profile — an interrupted run, a full
# disk, a killed `go test` — does NOT parse to nothing (F6 already covers that). It parses to a
# PARTIAL profile: some packages missing entirely, and the last one cut mid-stream so its
# statement TOTAL collapses. Compared naively that reads as a catastrophic, genuine coverage
# collapse and reds every PR in the repository, with a message about coverage rather than about
# the real cause.
#
# The discriminator is the DENOMINATOR. A package's `total` is its statement count: it can only
# change when code changes. So a floored package vanishing, or its total falling by more than
# half, is far more likely a bad profile than two unrelated real events landing together. When
# either shows up, the whole module's failures are demoted to warnings — the same mechanism as
# toolchain drift, and for the same reason: fail OPEN, loudly, and name the real cause.
#
# This self-heals rather than disarming permanently: `--update` prunes the stale key and the next
# run re-arms the gate. Verified safe because a package leaves the profile only by losing ALL its
# statements, never by losing its tests — apps/cli and packages/core/assets have no test files at
# all and are still in the profile, at 0%. "Delete the tests to escape the gate" does not work.
SUSPECT="" SUSPECT_WHY=""
while read -r pkg; do
	[ -n "$pkg" ] || continue
	grep -q "^$pkg " <<<"$NOW" && continue
	warn "$MODULE: floor recorded for $pkg but it is absent from the profile (deleted, now statement-free, or the profile is partial) — run --update to prune it"
	SUSPECT=1
	SUSPECT_WHY="$SUSPECT_WHY $pkg(absent)"
done < <(jq -r '.packages | keys[]' "$ROOT/$FLOORS")

FAILROWS="" fails=0
while read -r pkg c t; do
	[ -n "$pkg" ] || continue
	if ! jq -e --arg p "$pkg" '.packages[$p]' "$ROOT/$FLOORS" >/dev/null 2>&1; then
		# F9 — a new package with no floor. A PR must never be blocked by a file it had no way
		# to know it must edit. Pressure to arm it comes from --update, not from this gate.
		notice "$MODULE: new package $pkg at $(pct "$c" "$t") — no floor yet; run --module $MODULE --update to arm it"
		continue
	fi
	fc=$(jq -r --arg p "$pkg" '.packages[$p].covered' "$ROOT/$FLOORS")
	ft=$(jq -r --arg p "$pkg" '.packages[$p].total' "$ROOT/$FLOORS")
	# The denominator collapsed — see F8. Deleting more than half a package's statements in one
	# PR is possible but rare; a truncated profile produces it every time.
	if [ "$((t * 2))" -lt "$ft" ]; then
		warn "$MODULE: $pkg has $t statements but its floor recorded $ft — the profile looks partial, not the code"
		SUSPECT=1
		SUSPECT_WHY="$SUSPECT_WHY $pkg($t/$ft stmts)"
	fi
	if regressed "$c" "$t" "$fc" "$ft"; then
		FAILROWS="$FAILROWS$pkg $c $t $fc $ft
"
		fails=$((fails + 1))
	fi
done <<<"$NOW"

if [ "$fails" -eq 0 ]; then
	echo "✓ coverage ratchet: $MODULE — no package regressed ($(wc -l <<<"$NOW" | tr -d ' ') packages checked)"
	exit 0
fi

if [ -n "$DEMOTE" ] || [ -n "$SUSPECT" ]; then
	if [ -n "$DEMOTE" ]; then
		# The drift list names the AXIS, not just "something is missing": a Go minor bump reads as
		# `go(1.26!=1.27)` rather than as a coverage collapse, which is the whole point of #4247.
		warn "$MODULE: $fails package(s) are below their floor, but the toolchain differs from the one the floors were recorded in (drift:$DRIFT). NOT failing the build — the numbers are not comparable, so this run cannot blame the code. Fix the environment to match, or re-record the floors in an environment that matches the enforcing job (dispatch .github/workflows/go-floors-rerecord.yml)."
	fi
	if [ -n "$SUSPECT" ]; then
		warn "$MODULE: $fails package(s) are below their floor, but the coverprofile looks PARTIAL rather than the code having changed ($SUSPECT_WHY). NOT failing the build — a truncated profile must never be reported as a coverage collapse. Re-run the job; if it reproduces, run --update to prune stale keys."
	fi
	printf '%s' "$FAILROWS" | while read -r p c t fc ft; do
		[ -n "$p" ] || continue
		echo "  (demoted) $p  floor $(pct "$fc" "$ft")  now $(pct "$c" "$t")"
	done
	# A demote is the subtlest no-verdict of the seven: packages ARE below their floors, and the
	# script is saying it does not trust its own numbers enough to blame the code. That is right —
	# a truncated profile must never be reported as a coverage collapse — but it is not a pass.
	# On a Mac `os(Linux!=Darwin)` demotes unconditionally, so every local run lands here and was
	# reporting 0; #2845 sat 0.03 below its floor and the author caught it only by reading the
	# number.
	no_verdict "$fails package(s) are below their floor but the result was demoted (toolchain drift or a partial profile), so this run cannot say whether the code regressed"
fi

printf '%s' "$FAILROWS" | while read -r p c t fc ft; do
	[ -n "$p" ] || continue
	emit_error_annotation "$FLOORS" "$p" "$c" "$t" "$fc" "$ft"
done
printf '%s' "$FAILROWS" | emit_report
exit 1
