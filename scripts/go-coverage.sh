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
# ─────────────────────────────────────────────────────────────────────────────────────────────
# USAGE
#
#   scripts/go-coverage.sh --module apps/runner                 # CHECK. What CI runs.
#   scripts/go-coverage.sh --module apps/runner --update        # raise floors to measured (NEVER lowers)
#   scripts/go-coverage.sh --module apps/runner --accept-regression   # rewrite, INCLUDING lowering
#   scripts/go-coverage.sh --module apps/runner --print         # "<pkg> <covered> <total>", exit 0
#   scripts/go-coverage.sh --module apps/runner --profile p.out # override the profile path
#   scripts/go-coverage.sh --self-test                          # offline fixtures; no go, no network
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

MODULE="" PROFILE="" MODE="check"

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
	-h | --help) sed -n '2,80p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
	esac
done

# ── annotations ───────────────────────────────────────────────────────────────────────────────
# GitHub workflow commands must be single-line; a literal newline terminates them.
notice() { echo "::notice::$*"; }
warn() { echo "::warning::$*"; }

# ── measure: coverprofile -> "<module-relative package> <covered> <total>", sorted ─────────────
# Integers only. Exits 9 on an unrecognised mode line so the caller can fail OPEN.
measure() { # $1 = profile path, $2 = module import path
	awk -v modpath="$2" '
		NR == 1 {
			if ($0 !~ /^mode: (set|count|atomic)$/) { exit 9 }
			next
		}
		NF < 3 { next }   # tolerate a blank or truncated trailing line
		{
			blk = $1                       # "<importpath>/<file>.go:sL.sC,eL.eC" — the dedupe key
			n = $(NF - 1) + 0
			c = $NF + 0
			key = blk
			sub(/:[0-9]+\.[0-9]+,[0-9]+\.[0-9]+$/, "", key)   # -> "<importpath>/<file>.go"
			sub(/\/[^\/]+$/, "", key)                          # -> "<importpath>"
			# A block can legitimately repeat if -coverpkg is ever added. Count its statements
			# ONCE, and treat it as covered if ANY occurrence ran. `c > 0` (never `c == 1`) is
			# what makes this correct for set, count and atomic alike.
			if (!(blk in seen)) { seen[blk] = 1; tot[key] += n }
			if (c > 0 && !(blk in hit)) { hit[blk] = 1; cov[key] += n }
		}
		END {
			for (k in tot) {
				# Exact prefix strip — NOT a regex, because an import path is full of dots that
				# a regex would treat as wildcards.
				if (substr(k, 1, length(modpath)) == modpath) {
					rel = substr(k, length(modpath) + 1)
					sub(/^\//, "", rel)
					if (rel == "") rel = "."
				} else {
					rel = k
				}
				printf "%s %d %d\n", rel, cov[k] + 0, tot[k]
			}
		}
	' "$1" | sort
}

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
FINGERPRINT_KEYS="docker git helm kubectl tofu alethia_credentials"

current_env() { # $1 = key -> "true"|"false"
	case "$1" in
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
	local first=1 k
	for k in $FINGERPRINT_KEYS; do
		[ $first -eq 1 ] || env_json="$env_json,"
		env_json="$env_json\"$k\":$(current_env "$k")"
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
       on git, helm, kubectl and tofu being on PATH (see the "env" block in the
       floors file; packages/core/tofu alone moves 15 points). Run
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

# F1 — no floors file yet. The ratchet is not armed for this module. Bootstrap must be inert.
[ -f "$ROOT/$FLOORS" ] || { notice "no $FLOORS — coverage ratchet not armed for $MODULE"; exit 0; }

# F2 — jq unavailable. A required check must not depend on a tool being installed.
command -v jq >/dev/null 2>&1 || { warn "jq unavailable — coverage ratchet SKIPPED for $MODULE"; exit 0; }

# F3 — floors unparseable. The likeliest cause is a hand-resolved merge conflict leaving
# `<<<<<<< HEAD` in the file. That must never red every PR in the repo.
jq -e '.packages' "$ROOT/$FLOORS" >/dev/null 2>&1 || {
	warn "$FLOORS is not valid JSON or has no .packages (a hand-resolved merge conflict?) — ratchet SKIPPED. Re-run: scripts/go-coverage.sh --module $MODULE --update"
	exit 0
}

# F4 — no profile. The only way to reach this is that the `go test` step already failed and
# failed the job. Failing twice adds noise and misattributes the cause.
[ -s "$PROFILE_ABS" ] || { warn "no coverprofile at $PROFILE — ratchet SKIPPED for $MODULE"; exit 0; }

# F5 — unrecognised mode line (a future Go release, or -race forcing atomic).
NOW=$(measure "$PROFILE_ABS" "$MODPATH") || { warn "$PROFILE has an unrecognised 'mode:' line — ratchet SKIPPED"; exit 0; }

# F6 — the profile parsed to nothing (truncated, interrupted, disk full). Left alone this would
# read as "every package collapsed to 0%" and red them all at once.
[ -n "$NOW" ] || { warn "$PROFILE parsed to zero packages (truncated?) — ratchet SKIPPED"; exit 0; }

# F7 — TOOLCHAIN DRIFT. If the recording environment had something this one lacks, coverage is
# not comparable and every failure is demoted. Measured: tofu is worth 15 points on
# packages/core/tofu, 11 on provisioner; helm+tofu 2.3 on runner/internal/agent.
DEMOTE="" MISSING=""
for k in $FINGERPRINT_KEYS; do
	rec=$(jq -r --arg k "$k" '.env[$k] // "unknown"' "$ROOT/$FLOORS")
	# Only a true->false transition can lower coverage. More tools than before cannot hurt, and
	# an older floors file with no `env` block ("unknown") must NOT silently disarm the gate.
	if [ "$rec" = "true" ] && [ "$(current_env "$k")" != "true" ]; then
		DEMOTE=1
		MISSING="$MISSING $k"
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
		warn "$MODULE: $fails package(s) are below their floor, but the toolchain differs from the one the floors were recorded in (missing:$MISSING). NOT failing the build — fix the environment, or re-record the floors in this one."
	fi
	if [ -n "$SUSPECT" ]; then
		warn "$MODULE: $fails package(s) are below their floor, but the coverprofile looks PARTIAL rather than the code having changed ($SUSPECT_WHY). NOT failing the build — a truncated profile must never be reported as a coverage collapse. Re-run the job; if it reproduces, run --update to prune stale keys."
	fi
	printf '%s' "$FAILROWS" | while read -r p c t fc ft; do
		[ -n "$p" ] || continue
		echo "  (demoted) $p  floor $(pct "$fc" "$ft")  now $(pct "$c" "$t")"
	done
	exit 0
fi

printf '%s' "$FAILROWS" | while read -r p c t fc ft; do
	[ -n "$p" ] || continue
	emit_error_annotation "$FLOORS" "$p" "$c" "$t" "$fc" "$ft"
done
printf '%s' "$FAILROWS" | emit_report
exit 1
