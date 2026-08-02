#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# resolve-dimension.sh — resolve which DIMENSION one E2E-nightly run is proving. PURE: no network,
# no gh, no token. Trigger in, the single token `full` or `floor` out.
#
# E2E Nightly runs two dimensions on two crons:
#   `17 3 * * *`  the cheap green-floor smoke   → floor
#   `17 5 * * 0`  the weekly full bar           → full   (ALETHIA_E2E_MAX_CONFIG + _ALL_ADDONS)
# plus a manual `workflow_dispatch` whose `full_bar` input picks either.
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
#   resolve-dimension.sh              # print `full` or `floor`
#   resolve-dimension.sh --self-test  # run the offline cases
#
# Env:
#   EVENT          github.event_name          (`schedule` | `workflow_dispatch` | …)
#   DISPATCH_FULL  github.event.inputs.full_bar   (`true` picks the full bar on a dispatch)
#   SCHEDULE       github.event.schedule      (the cron string that fired this run)
set -uo pipefail

# The one cron that means "full bar". Kept here, not in the workflow, so the provision job, the
# rollup filer and the parity ledger cannot disagree about which Sunday run is which.
FULL_BAR_CRON="17 5 * * 0"

# resolve prints the dimension token consumed everywhere downstream: `full` and `floor` are two of
# provisioning-e2e.sh's dimension names, so a row it appends and a title the filer renders always
# name the same thing.
resolve() {
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

# dimension_label turns the token into the words that go in an issue TITLE. The title is the dedup
# key, so this mapping is load-bearing: change it and every open nightly issue is orphaned and
# re-filed under the new name.
dimension_label() { # <token>
	case "${1:-}" in
	full) echo "full-bar" ;;
	*) echo "floor" ;;
	esac
}

run_self_test() {
	local fails=0
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }

	_r() { # <event> <dispatch_full> <schedule>
		(EVENT="$1" DISPATCH_FULL="$2" SCHEDULE="$3" resolve)
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

	_a "full-bar" "$(dimension_label full)" "the full token labels as full-bar in an issue title"
	_a "floor" "$(dimension_label floor)" "the floor token labels as floor in an issue title"

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
--label) dimension_label "$(resolve)" ;;
"") resolve ;;
*)
	echo "usage: resolve-dimension.sh [--self-test|--label]" >&2
	exit 2
	;;
esac
