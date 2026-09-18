#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Logic-scope coverage for the alethia CLI.
#
# The CLI is a thin client over the Alethia control plane. Its LOGIC — the HTTP
# wire client, output rendering (table/json/csv), data projections, formatting
# helpers, config + active-org persistence, and the auth-token lifecycle — is
# unit-tested. Files whose bodies are still partly INTERACTIVE / IO glue that the
# tests do not reach are excluded from the badge, exactly as the web app excludes
# vendored UI from its coverage scope:
#
#   * Bubble Tea / lipgloss renderers (table.go — both of them — and config_printer.go)
#   * device-code browser login  (login.go) + the `init` onboarding wizard
#   * interactive runners        (interactive.go: RunSpinner / AuthRequiredPrompt)
#   * version wiring, main.go, and connector_remove.go (39 of 40 statements covered)
#   * system exec (internal/cloudshell) and embedded assets (internal/connector)
#
# THIS LIST ONLY SHRINKS, and it is a measurement, not a category. It once also named
# stepper, selectors, helpers, jobs_table, logout, root, job_wait, jobs_{logs,cancel},
# connector{,_aws,_gcp,_azure,_alibaba}, runner_{deploy,destroy,remove} and
# project_{plan,apply,destroy,get} as "irreducible glue"; #3663's lanes put every one of
# them at 100% statement coverage (measured 2026-09-18), so excluding them only hid a
# future regression from the badge. #3664 removed them. When a file here reaches 100%,
# take it out; nothing checks that for you.
#
# Everything else — the files that hold real branching logic — stays IN scope and
# must carry its weight. Run from anywhere: apps/cli/scripts/coverage.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=$(mktemp)
FILTERED=$(mktemp)
trap 'rm -f "$PROFILE" "$FILTERED"' EXIT

go test ./... -coverprofile="$PROFILE" -covermode=set >/dev/null

# Files whose bodies are still partly interactive/IO glue the tests do not reach (see header).
EXCLUDE_FILES='/(table|config_printer|interactive|init|login|main|version|connector_remove)\.go:'
EXCLUDE_DIRS='/(internal/cloudshell|internal/connector|internal/version)/'

head -1 "$PROFILE" >"$FILTERED"
tail -n +2 "$PROFILE" | grep -vE "$EXCLUDE_FILES" | grep -vE "$EXCLUDE_DIRS" >>"$FILTERED"

# ── The measurement (#1990) ───────────────────────────────────────────────────────────────────
#
# This gate used to read `go tool cover -func | awk 'END{print $3}'`, and that number was wrong in
# the direction that matters: `-func` walks *ast.FuncDecl only, and the entire CLI lives in
# package-level initializers — `var xCmd = &cobra.Command{RunE: func(...) {...}}`. Those
# statements belong to no FuncDecl, so `-func` dropped them from BOTH halves of the fraction and
# reported 92.7% for a logic scope the profile puts at 60.9%. A ≥90% gate blind to the code most
# likely to regress is not a gate.
#
# The correct measurement already existed for the ratchet. It is now shared rather than copied, so
# the two tools cannot disagree about what the number is.
# Resolved from PWD, not from $0: the script has already `cd`-ed to apps/cli above, so a
# $0-relative path would be one level off.
# shellcheck source=../../scripts/lib/go-coverage-measure.sh
. "$(cd ../.. && pwd)/scripts/lib/go-coverage-measure.sh"

MODPATH=$(awk '$1 == "module" { print $2; exit }' go.mod)

# measure() emits one row per package; the gate is an overall figure, so sum the integer pairs.
sum_profile() { # $1 = profile -> "<covered> <total>"
	measure "$1" "$MODPATH" | awk '{c += $2; t += $3} END {printf "%d %d\n", c, t}'
}

read -r RAW_COV RAW_TOT < <(sum_profile "$PROFILE")
read -r COV TOT < <(sum_profile "$FILTERED")

if [[ "$TOT" -eq 0 ]]; then
	echo "FAIL: the logic scope matched no statements — the exclusion regex has swallowed the whole module" >&2
	exit 1
fi

pct() { awk -v c="$1" -v t="$2" 'BEGIN { printf "%.1f%%", (t ? 100 * c / t : 0) }'; }

echo "alethia CLI coverage"
echo "  raw (all statements):        $(pct "$RAW_COV" "$RAW_TOT")  ($RAW_COV/$RAW_TOT)"
echo "  logic-scope (badge):         $(pct "$COV" "$TOT")  ($COV/$TOT)"

# Optional gate: scripts/coverage.sh 90  -> exit non-zero if logic-scope < 90.
if [[ "${1:-}" != "" ]]; then
	want="$1"
	# Cross-multiplication on integers, never the rendered percentage. The old comparison used
	# `${LOGIC%\%}` — the ONE-DECIMAL DISPLAY STRING — so 89.96% printed "90.0%" and passed a gate
	# it did not meet. Same reasoning as the ratchet's floors: no division, no float, no rounding
	# enters the decision.
	if awk -v c="$COV" -v t="$TOT" -v w="$want" 'BEGIN { exit !(c * 100 < w * t) }'; then
		echo "FAIL: logic-scope coverage $(pct "$COV" "$TOT") ($COV/$TOT) is below the ${want}% threshold" >&2
		exit 1
	fi
	echo "OK: logic-scope coverage $(pct "$COV" "$TOT") ($COV/$TOT) meets the ${want}% threshold"
fi
