#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# resolve-dimension.sh — resolve which DIMENSION one E2E-nightly run is proving. PURE: no network,
# no gh, no token. Trigger in, ONE of the six dimension tokens out:
#
#   floor  maxconfig  addons  byo  day2  full
#
# It also owns two things DERIVED from that token, because both used to be retyped by a caller
# and both were wrong: the run's FIDELITY (--fidelity) and whether it needs the provider's heavy
# node profile (--heavy).
#
# E2E Nightly runs two dimensions:
#   `17 3 * * *`  the cheap green-floor smoke   → floor  (the only SCHEDULED dimension)
#   `17 5 * * 0`  the full bar                  → full   (ALETHIA_E2E_MAX_CONFIG + _ALL_ADDONS)
# plus a manual `workflow_dispatch` whose `full_bar` input picks either.
#
# ⚠️ `17 5 * * 0` IS NOT CURRENTLY SCHEDULED. The weekly full-bar cron was removed from
# e2e-nightly.yml because it fired the whole matrix while the pre-apply cost ceiling is wired for
# aws only, and because it bought a standing monthly alibaba CR EE subscription every week. A
# dispatch with `full_bar=true` is the only live path to `full` today.
#
# The mapping below is kept anyway, and that is deliberate rather than dead code: re-adding the cron
# is a per-cloud decision we expect to make, and a re-added cron whose dimension resolved to `floor`
# would run the cheap shape while the ledger and the issue titles recorded a full bar — the exact
# class of silent mislabelling this file was written to end. `check-e2e-spend-guard.mjs` reads
# FULL_BAR_CRON from here so the workflow and this script cannot disagree about which cron is which.
#
# WHY THIS EXISTS (#1755). That resolution used to be written out THREE times: inline in the
# provision job, inline in the rollup job's ledger step, and not at all in the issue filer — which
# is how both dimensions collapsed into one issue titled `e2e nightly: aws RED`. On 2026-08-02 both
# crons fired 90 minutes apart; the floor red became #1734 and the full-bar red — five template and
# fixture defects, failing every Sunday — was deduped away against it and had to be filed by hand.
# `$GITHUB_ENV` is per-JOB, so the provision job's resolved value is not visible to the rollup job;
# reusing it means reusing THIS, not re-deriving. One deriver, every consumer (the same shape #1613
# imposed on the rollup itself).
#
# Usage:
#   resolve-dimension.sh                    # print the dimension for this trigger
#   resolve-dimension.sh --fidelity [dim]   # the NAME=value lines that turn its assertions on
#   resolve-dimension.sh --heavy [dim]      # `true` when it needs the heavy node shape
#   resolve-dimension.sh --label            # the words that go in an issue title
#   resolve-dimension.sh --dimensions       # the whole vocabulary
#   resolve-dimension.sh --self-test        # run the offline cases
#
# Env:
#   EVENT               github.event_name       (`schedule` | `workflow_dispatch` | …)
#   DISPATCH_DIMENSION  github.event.inputs.dimension  (names one of the six; wins over DISPATCH_FULL)
#   DISPATCH_FULL       github.event.inputs.full_bar   (`true` picks the full bar on a dispatch)
#   SCHEDULE            github.event.schedule   (the cron string that fired this run)
#   E2E_SOAK            optional soak window, honoured only by the soak-defined dimensions
set -uo pipefail

# The one cron that means "full bar". Kept here, not in the workflow, so the provision job, the
# rollup filer and the parity ledger cannot disagree about which Sunday run is which.
FULL_BAR_CRON="17 5 * * 0"

# resolve prints the dimension token consumed everywhere downstream: `full` and `floor` are two of
# provisioning-e2e.sh's dimension names, so a row it appends and a title the filer renders always
# name the same thing.
resolve() {
	# An EXPLICIT dispatch dimension wins, and it is the only way to reach the four dimensions a
	# boolean cannot express. `full_bar` could only ever say floor-or-full, so `maxconfig`, `addons`,
	# `byo` and `day2` were drivable from a laptop and from nowhere else — which is how a cell whose
	# cause had been FIXED (hetzner/addons, #2490) could sit stale with no way to re-drive it from CI
	# at all. The dimension vocabulary already existed in DIMENSIONS below; only the door was missing.
	#
	# Validated against that same list rather than trusted: a typo'd dispatch input must not silently
	# resolve to `floor` and record a cheap run under an expensive name.
	if [ "${EVENT:-}" = "workflow_dispatch" ] && [ -n "${DISPATCH_DIMENSION:-}" ]; then
		case " $DIMENSIONS " in
		*" $DISPATCH_DIMENSION "*)
			echo "$DISPATCH_DIMENSION"
			return 0
			;;
		*)
			echo "resolve: unknown dispatch dimension '${DISPATCH_DIMENSION}' (want one of: $DIMENSIONS)" >&2
			return 2
			;;
		esac
	fi
	# `full_bar` stays honoured for back-compat: it is the input every existing runbook, issue and
	# muscle-memory dispatch still uses, and removing it would break them for no gain.
	if [ "${EVENT:-}" = "workflow_dispatch" ] && [ "${DISPATCH_FULL:-}" = "true" ]; then
		echo "full"
		return 0
	fi
	if [ "${EVENT:-}" = "schedule" ] && [ "${SCHEDULE:-}" = "$FULL_BAR_CRON" ]; then
		echo "full"
		return 0
	fi
	echo "floor"
}

# ── The dimension → FIDELITY mapping. One table, every consumer. ───────────────────────────────
#
# WHY THIS MOVED HERE (#2356). The mapping was written out twice — inline in
# provisioning-e2e.sh's `case`, and inline in the workflow's step-level `env:` — and the two did not
# agree. The workflow turned the A0.3 day-2 soak ON FOR EVERY RUN (`vars.E2E_SOAK || '10m'`), while
# `floor` is documented, in three places, as "provision + cluster_ready + ArgoCD converge". The soak
# hard-fails on its drift posture, so a cloud could satisfy the entire floor definition and still be
# recorded a floor FAIL.
#
# That is not hypothetical. Run 31486339552 (azure) applied cleanly, reached Ready nodes, verified a
# signed receipt sealed to the plan hash, converged every expected Application and tore down — and
# was filed a floor FAIL solely on `A0.3 drift: ... in_sync=false drifted=9`. The first azure run
# ever to clear the reachability gate is recorded as a floor failure, and the auto-filed issue sends
# the reader to the provisioning spine, which was fine.
#
# So the dimension DECIDES its assertions, and there is no per-run override: an override is exactly
# how the divergence returns. A heavier claim gets a heavier dimension — that ladder already exists.
DIMENSIONS="floor maxconfig addons byo day2 full"

# soak_window prints a POSITIVE soak window for the two dimensions whose assertion IS the soak. A
# caller may widen or narrow it; they may not EMPTY it, because a day-2 dimension with no soak
# asserts nothing and would report PASS having proven nothing — the vacuous proof the bar forbids.
#
# The refused values are exactly the sentinels parseSoakDuration honours (test/e2e/t2_soak.go: "off",
# "none", "0", plus empty), so this cannot drift from what the harness actually treats as disabled.
# The override is announced on stderr: silently ignoring an operator's `off` is its own surprise.
soak_window() {
	case "${E2E_SOAK:-}" in
	"" | off | none | 0)
		if [ -n "${E2E_SOAK:-}" ]; then
			echo "resolve-dimension: E2E_SOAK='${E2E_SOAK}' would empty a soak-defined dimension; using 10m instead (pick the 'floor' dimension to run without a soak)" >&2
		fi
		echo "10m"
		;;
	*) echo "$E2E_SOAK" ;;
	esac
}

# fidelity_env prints the `NAME=value` lines that turn one dimension's assertions on — one per line,
# suitable for `>> "$GITHUB_ENV"` or for building an `env` array.
#
# `floor` is the load-bearing entry. It prints ALETHIA_E2E_SOAK=off EXPLICITLY rather than leaving it
# unset, because "unset" is what the workflow was overriding; a positive assertion of `off` is a
# statement the self-test below can hold it to.
fidelity_env() { # <dimension>
	case "${1:-}" in
	floor)
		echo "ALETHIA_E2E_SOAK=off"
		;;
	maxconfig)
		echo "ALETHIA_E2E_SOAK=off"
		echo "ALETHIA_E2E_MAX_CONFIG=1"
		;;
	addons)
		echo "ALETHIA_E2E_SOAK=off"
		echo "ALETHIA_E2E_ALL_ADDONS=1"
		;;
	byo)
		# The A0.6 bring-your-own Helm/apps-repo proof activates from the caller's ALETHIA_E2E_ARGO_*
		# inputs — so asking for this dimension and NOT having them wired used to green-skip the only
		# assertion it has (t2_argo_repos.go logs "A0.6 ... SKIPPED") and record `<cloud> byo PASS`
		# having proven nothing but the floor.
		#
		# REQUIRE is what makes the difference between a proof and a claim, and it is the same
		# reasoning soak_window applies to day2 twenty lines up: a dimension whose vehicle is off
		# asserts nothing. With this set the leg REDS when the apps-repo env is missing instead of
		# passing, which is the direction the bar demands.
		echo "ALETHIA_E2E_SOAK=off"
		echo "ALETHIA_E2E_ARGO_REPOS_REQUIRE=1"
		;;
	day2)
		# The soak IS this dimension's vehicle. ${E2E_SOAK} lets a caller widen or narrow the window;
		# it cannot turn it off, because a day-2 dimension with no soak asserts nothing.
		echo "ALETHIA_E2E_SOAK=$(soak_window)"
		;;
	full)
		echo "ALETHIA_E2E_SOAK=$(soak_window)"
		echo "ALETHIA_E2E_MAX_CONFIG=1"
		echo "ALETHIA_E2E_ALL_ADDONS=1"
		;;
	*)
		echo "fidelity_env: unknown dimension '${1:-}' (want one of: $DIMENSIONS)" >&2
		return 2
		;;
	esac
}

# heavy_shape prints `true` when a dimension's assertions need the provider's HEAVY node profile,
# and `false` when the cheapest floor pool will do.
#
# WHY THIS EXISTS. The workflow keyed that decision on E2E_FULL_BAR, which the resolve step sets
# from `[ "$dim" = "full" ]` — so it was true for exactly ONE of the six dimensions. `maxconfig` and
# `addons` therefore provisioned the cheapest floor shape and then asserted a surface that cannot fit
# on it: on hetzner, 18 add-ons onto the template default cpx22 x1 (2 vCPU / 4 GB) against a heavy
# fixture calling for 6x cx33 (24 vCPU / 48 GB). The add-ons sit Pending, the ArgoCD gate burns the
# 165-minute cap, and it files as `<cloud> RED (addons)` for a node-size reason. The FT-5 guard did
# not catch it either, because it returns early unless BOTH flags are on.
#
# DERIVED FROM fidelity_env, never a second list. A dimension needs the heavy shape exactly when it
# turns on a heavier SURFACE — that is what MAX_CONFIG (11 kinds) and ALL_ADDONS (18 charts) mean.
# Writing the set out again here is how the two would disagree the next time a dimension is added,
# which is the whole failure this file was created to end (#1755).
heavy_shape() { # <dimension>
	local fidelity
	fidelity="$(fidelity_env "${1:-}")" || return 2
	if printf '%s\n' "$fidelity" | grep -qE '^ALETHIA_E2E_(MAX_CONFIG|ALL_ADDONS)=1$'; then
		echo "true"
	else
		echo "false"
	fi
}

# dimension_label turns the token into the words that go in an issue TITLE. The title is the dedup
# key, so this mapping is load-bearing: change it and every open nightly issue is orphaned and
# re-filed under the new name.
# The `floor` fallback is for the UNSET/unknown token only. Every real dimension names itself, because
# a run that proved add-ons and filed an issue titled "floor" is the exact mislabelling this function
# was written to end — and with a dispatchable dimension there are now four more tokens that could
# hit it. `full` keeps its "full-bar" wording: the title is the dedup key, so changing THAT one would
# orphan every open nightly issue and re-file it under a new name.
dimension_label() { # <token>
	case "${1:-}" in
	full) echo "full-bar" ;;
	maxconfig | addons | byo | day2) echo "$1" ;;
	*) echo "floor" ;;
	esac
}

run_self_test() {
	local fails=0
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }

	# DISPATCH_DIMENSION is cleared like the rest. Without it an ambient value in the operator's
	# shell leaks into every case below and reports FAILs that are not defects — the self-test has to
	# describe the script, not the terminal it was run from. (_rd already does this for DISPATCH_FULL.)
	_r() { # <event> <dispatch_full> <schedule>
		(EVENT="$1" DISPATCH_FULL="$2" SCHEDULE="$3" DISPATCH_DIMENSION="" resolve)
	}

	# The two crons — the whole point. They fired 90 minutes apart on 2026-08-02 and read as one
	# dimension re-running.
	_a "floor" "$(_r schedule '' '17 3 * * *')" "the nightly floor cron resolves floor"
	_a "full" "$(_r schedule '' '17 5 * * 0')" "the Sunday full-bar cron resolves full"

	# A dispatch picks its own dimension; the cron string is absent on that event.
	_a "full" "$(_r workflow_dispatch true '')" "dispatch with full_bar=true resolves full"
	_a "floor" "$(_r workflow_dispatch false '')" "dispatch with full_bar=false resolves floor"
	_a "floor" "$(_r workflow_dispatch '' '')" "dispatch with no full_bar input resolves floor"

	# Fail SAFE, both ways. An unknown trigger must not claim to have proven the expensive bar, and
	# `full_bar` is only honoured on a dispatch — a schedule that somehow carries the input is still
	# resolved by its cron.
	_a "floor" "$(_r push '' '')" "an unrecognised event resolves floor, never a claimed full bar"
	_a "floor" "$(_r schedule true '17 3 * * *')" "full_bar is ignored on a schedule — the cron decides"
	_a "floor" "$(_r '' '' '')" "an empty environment resolves floor"

	# A near-miss cron is NOT the full bar. Retyping this string in a second place is exactly the
	# drift this file exists to prevent.
	_a "floor" "$(_r schedule '' '17 5 * * 1')" "a Monday 05:17 cron is not the full bar"

	# ── The dispatchable dimension (the four a boolean could not reach). ──
	_rd() { # <event> <dimension>
		(EVENT="$1" DISPATCH_DIMENSION="$2" DISPATCH_FULL="" SCHEDULE="" resolve)
	}
	_a "addons" "$(_rd workflow_dispatch addons)" "a dispatch naming addons resolves addons"
	_a "maxconfig" "$(_rd workflow_dispatch maxconfig)" "a dispatch naming maxconfig resolves maxconfig"
	_a "day2" "$(_rd workflow_dispatch day2)" "a dispatch naming day2 resolves day2"
	_a "byo" "$(_rd workflow_dispatch byo)" "a dispatch naming byo resolves byo"
	_a "floor" "$(_rd workflow_dispatch floor)" "a dispatch naming floor still resolves floor"
	_a "full" "$(_rd workflow_dispatch full)" "a dispatch naming full resolves full"

	# A typo must be REFUSED, never silently downgraded — resolving `addonz` to `floor` would record
	# a cheap run under whatever name the operator thought they asked for.
	_a "2" "$(_rd workflow_dispatch addonz >/dev/null 2>&1; echo $?)" "an unknown dispatch dimension exits non-zero"
	_a "" "$(_rd workflow_dispatch addonz 2>/dev/null)" "...and prints no dimension at all"

	# The dimension input is dispatch-only: a SCHEDULE carrying one must still be decided by its cron,
	# so a stray repository variable can never widen what a timer spends.
	_a "floor" "$(EVENT=schedule DISPATCH_DIMENSION=full SCHEDULE='17 3 * * *' resolve)" "a schedule ignores DISPATCH_DIMENSION — the cron decides"

	# Back-compat: the boolean every existing runbook uses still works, and the explicit dimension
	# wins when both are present.
	_a "full" "$(EVENT=workflow_dispatch DISPATCH_FULL=true DISPATCH_DIMENSION='' SCHEDULE='' resolve)" "full_bar=true still resolves full"
	_a "addons" "$(EVENT=workflow_dispatch DISPATCH_FULL=true DISPATCH_DIMENSION=addons SCHEDULE='' resolve)" "an explicit dimension beats full_bar"

	# Every real dimension names ITSELF in an issue title. A run that proved add-ons and filed an
	# issue titled "floor" is the mislabelling dimension_label exists to prevent.
	_a "addons" "$(dimension_label addons)" "addons labels as addons, not floor"
	_a "maxconfig" "$(dimension_label maxconfig)" "maxconfig labels as maxconfig, not floor"
	_a "day2" "$(dimension_label day2)" "day2 labels as day2, not floor"
	_a "byo" "$(dimension_label byo)" "byo labels as byo, not floor"

	_a "full-bar" "$(dimension_label full)" "the full token labels as full-bar in an issue title"
	_a "floor" "$(dimension_label floor)" "the floor token labels as floor in an issue title"

	# ── The fidelity table (#2356). These are the assertions that were missing, and their absence is
	# why a documented definition and an asserted one could diverge for weeks. ──

	_f() { (E2E_SOAK="${2:-}" fidelity_env "$1"); }

	# THE REGRESSION. The floor must not run the day-2 soak, whose drift check is fatal. Asserted as
	# an explicit `off` rather than "no SOAK line", because unset is what the workflow overrode.
	_a "ALETHIA_E2E_SOAK=off" "$(_f floor | grep '^ALETHIA_E2E_SOAK=')" "the floor turns the day-2 soak OFF (#2356)"
	# And a caller's E2E_SOAK must NOT be able to switch it back on — an override is how this returns.
	_a "ALETHIA_E2E_SOAK=off" "$(_f floor 30m | grep '^ALETHIA_E2E_SOAK=')" "E2E_SOAK cannot re-enable the soak on the floor"

	# The floor is the CHEAPEST rung: nothing but the soak switch.
	_a "1" "$(_f floor | wc -l | tr -d ' ')" "the floor enables no fidelity beyond the soak switch"
	_a "" "$(_f floor | grep -E 'MAX_CONFIG|ALL_ADDONS' || true)" "the floor enables neither max-config nor all-add-ons"

	# day2 is where the soak lives, and it cannot be empty — a day-2 dimension with no soak asserts
	# nothing, which is the vacuous-proof shape the bar forbids.
	_a "ALETHIA_E2E_SOAK=10m" "$(_f day2 | grep '^ALETHIA_E2E_SOAK=')" "day2 turns the soak ON by default"
	_a "ALETHIA_E2E_SOAK=45m" "$(_f day2 45m | grep '^ALETHIA_E2E_SOAK=')" "day2 honours a widened E2E_SOAK window"
	_a "" "$(_f day2 off | grep 'SOAK=off' || true)" "day2 cannot be emptied by setting E2E_SOAK=off"

	# The heavier rungs each add exactly their own switch, and keep the soak out of it.
	_a "ALETHIA_E2E_MAX_CONFIG=1" "$(_f maxconfig | grep '^ALETHIA_E2E_MAX_CONFIG=')" "maxconfig enables the 11-kind assertion"
	_a "ALETHIA_E2E_SOAK=off" "$(_f maxconfig | grep '^ALETHIA_E2E_SOAK=')" "maxconfig does not smuggle in the soak"
	_a "ALETHIA_E2E_ALL_ADDONS=1" "$(_f addons | grep '^ALETHIA_E2E_ALL_ADDONS=')" "addons enables the add-on health assertion"
	_a "ALETHIA_E2E_SOAK=off" "$(_f addons | grep '^ALETHIA_E2E_SOAK=')" "addons does not smuggle in the soak"

	# `full` is the composite and must be the UNION — the FULLY-TESTED bar. If a dimension's switch is
	# ever added without adding it here, `full` silently stops being "every dimension in one apply".
	_a "ALETHIA_E2E_MAX_CONFIG=1" "$(_f full | grep '^ALETHIA_E2E_MAX_CONFIG=')" "full includes max-config"
	_a "ALETHIA_E2E_ALL_ADDONS=1" "$(_f full | grep '^ALETHIA_E2E_ALL_ADDONS=')" "full includes all-add-ons"
	_a "ALETHIA_E2E_SOAK=10m" "$(_f full | grep '^ALETHIA_E2E_SOAK=')" "full includes the day-2 soak"

	# Every declared dimension must HAVE a fidelity, and an undeclared one must be refused rather than
	# silently producing an empty env (which would run the cheapest shape while recording the heaviest
	# claim — the #2356 failure in the opposite direction).
	for d in $DIMENSIONS; do
		if fidelity_env "$d" >/dev/null 2>&1; then
			echo "ok   - dimension '$d' has a declared fidelity"
		else
			echo "FAIL - dimension '$d' is in DIMENSIONS but fidelity_env refuses it" >&2
			fails=$((fails + 1))
		fi
	done
	if fidelity_env teardown >/dev/null 2>&1; then
		# `teardown` was in the ledger legend as a dimension for months while provisioning-e2e.sh
		# rejected it: teardown is asserted on EVERY run, not chosen. Keep it un-declarable.
		echo "FAIL - fidelity_env accepted 'teardown', which is a property of every run, not a dimension" >&2
		fails=$((fails + 1))
	else
		echo "ok   - an undeclared dimension is refused, never given an empty fidelity"
	fi

	# VACUITY: the union above would also "hold" if every call returned nothing. Prove the table emits
	# ── The heavy node shape. THE REGRESSION: this was keyed on E2E_FULL_BAR, true for `full`
	# alone, so maxconfig and addons asserted a heavy surface on the cheapest floor pool. ──
	_h() { (E2E_SOAK="" heavy_shape "$1"); }

	_a "true" "$(_h full)" "full needs the heavy node shape"
	_a "true" "$(_h maxconfig)" "maxconfig needs the heavy shape — 11 kinds do not fit the floor pool"
	_a "true" "$(_h addons)" "addons needs the heavy shape — 18 charts do not fit the floor pool"
	_a "false" "$(_h floor)" "the floor keeps the cheapest shape"
	_a "false" "$(_h byo)" "byo runs a floor-sized cluster"
	_a "false" "$(_h day2)" "day2 soaks a floor-sized cluster"

	# Derived from fidelity_env, not from a second list — so a dimension that turns on a heavier
	# SURFACE gets the heavier shape without anyone remembering to add it in two places.
	_a "true" "$(_h maxconfig)" "heavy tracks MAX_CONFIG"
	_a "true" "$(_h addons)" "heavy tracks ALL_ADDONS"
	_a "2" "$(_h nonesuch >/dev/null 2>&1; echo $?)" "an unknown dimension is refused, not called cheap"
	_a "" "$(_h nonesuch 2>/dev/null)" "...and prints no shape at all"

	# Every dimension answers. A dimension the table forgot would exit 2 above rather than default
	# to `false`, which would silently re-create the bug this replaces.
	for _d in $DIMENSIONS; do
		case "$(_h "$_d")" in
		true | false) ;;
		*)
			echo "FAIL - heavy_shape has no answer for dimension '$_d'" >&2
			fails=$((fails + 1))
			;;
		esac
	done

	# ── byo must not be able to record a PASS having proven nothing. ──
	_a "ALETHIA_E2E_ARGO_REPOS_REQUIRE=1" "$(_f byo | grep '^ALETHIA_E2E_ARGO_REPOS_REQUIRE=')" "byo REQUIRES the A0.6 apps-repo proof rather than green-skipping it"
	_a "" "$(_f floor | grep 'ARGO_REPOS_REQUIRE' || true)" "the floor does not require it — A0.6 is byo's assertion, not the floor's"

	# ── --label must propagate resolve's refusal, not print `floor` for a typo. ──
	_a "2" "$(EVENT=workflow_dispatch DISPATCH_DIMENSION=addonz DISPATCH_FULL="" SCHEDULE="" bash "$0" --label >/dev/null 2>&1; echo $?)" "--label exits non-zero on an unknown dimension"
	_a "" "$(EVENT=workflow_dispatch DISPATCH_DIMENSION=addonz DISPATCH_FULL="" SCHEDULE="" bash "$0" --label 2>/dev/null)" "...and prints no label at all"
	_a "addons" "$(EVENT=workflow_dispatch DISPATCH_DIMENSION=addons DISPATCH_FULL="" SCHEDULE="" bash "$0" --label 2>/dev/null)" "--label still labels a good dimension"

	# real content.
	_a "3" "$(_f full | wc -l | tr -d ' ')" "vacuity: full emits three fidelity lines, not zero"
	if [ "$(_f full | grep -c '=')" -eq 3 ]; then
		echo "ok   - vacuity: every full fidelity line is a NAME=value assignment"
	else
		echo "FAIL - vacuity: full's fidelity lines are not all assignments" >&2
		fails=$((fails + 1))
	fi

	if [ "$fails" -eq 0 ]; then
		echo "self-test: all passed"
		exit 0
	fi
	echo "self-test: $fails check(s) FAILED" >&2
	exit 1
}

# Sourced (by nightly-rollup.sh, for dimension_label) rather than executed: define and stop, so the
# label mapping has exactly one definition and a `.` of this file is never also a CLI invocation.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
	return 0
fi

case "${1:-}" in
--self-test) run_self_test ;;
--label)
	# `|| exit $?` because the refusal is the point. `dimension_label "$(resolve)"` discarded
	# resolve's exit 2 and printed `floor` for a typo'd dimension — the silent downgrade the
	# validation in resolve() exists to stop, reintroduced on the sibling entry point.
	d="$(resolve)" || exit $?
	dimension_label "$d"
	;;
--heavy)
	if [ -n "${2:-}" ]; then
		heavy_shape "$2"
	else
		d="$(resolve)" || exit $?
		heavy_shape "$d"
	fi
	;;
--dimensions) echo "$DIMENSIONS" ;;
--fidelity)
	# `--fidelity` with no argument resolves the dimension from the trigger first, so the workflow
	# never has to name it twice.
	fidelity_env "${2:-$(resolve)}"
	;;
"") resolve ;;
*)
	echo "usage: resolve-dimension.sh [--self-test|--label|--dimensions|--fidelity [dimension]|--heavy [dimension]]" >&2
	exit 2
	;;
esac
