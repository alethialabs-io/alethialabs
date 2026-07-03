#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Logic-scope coverage for the alethia CLI.
#
# The CLI is a thin client over the Alethia control plane. Its LOGIC — the HTTP
# wire client, output rendering (table/json/csv), data projections, formatting
# helpers, config + active-org persistence, and the auth-token lifecycle — is
# unit-tested. The irreducible INTERACTIVE / IO layer is excluded from the badge,
# exactly as the web app excludes vendored UI from its coverage scope:
#
#   * Bubble Tea views/models   (table.go, stepper.go, the paginated job table)
#   * huh selectors & spinners  (selectors.go, the interactive org/runner pickers)
#   * lipgloss pretty-printers   (config_printer.go)
#   * device-code browser login  (login.go) + the `init` onboarding wizard
#   * interactive runners        (interactive.go: RunSpinner / AuthRequiredPrompt)
#   * logout / banner / version wiring
#   * cloud-account + provisioning command adapters that are pure network/TTY glue
#     (connector{,_aws,_gcp,_azure,_remove}.go, runner_{deploy,destroy,remove}.go,
#      project_{plan,apply,destroy,get}.go, jobs_{logs,cancel}.go, job_wait.go)
#   * system exec (internal/cloudshell) and embedded assets (internal/connector)
#
# Everything else — the files that hold real branching logic — stays IN scope and
# must carry its weight. Run from anywhere: apps/cli/scripts/coverage.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=$(mktemp)
FILTERED=$(mktemp)
trap 'rm -f "$PROFILE" "$FILTERED"' EXIT

go test ./... -coverprofile="$PROFILE" -covermode=set >/dev/null

# Files whose bodies are predominantly interactive/IO glue (see header).
EXCLUDE_FILES='/(table|stepper|config_printer|selectors|helpers|jobs_table|interactive|init|login|logout|root|main|version|job_wait|jobs_logs|jobs_cancel|connector|connector_aws|connector_gcp|connector_azure|connector_remove|runner_deploy|runner_destroy|runner_remove|project_plan|project_apply|project_destroy|project_get)\.go:'
EXCLUDE_DIRS='/(internal/cloudshell|internal/connector|internal/version)/'

head -1 "$PROFILE" >"$FILTERED"
tail -n +2 "$PROFILE" | grep -vE "$EXCLUDE_FILES" | grep -vE "$EXCLUDE_DIRS" >>"$FILTERED"

RAW=$(go tool cover -func="$PROFILE" | awk 'END{print $3}')
LOGIC=$(go tool cover -func="$FILTERED" | awk 'END{print $3}')

echo "alethia CLI coverage"
echo "  raw (all statements):        $RAW"
echo "  logic-scope (badge):         $LOGIC"

# Optional gate: scripts/coverage.sh 90  -> exit non-zero if logic-scope < 90.
if [[ "${1:-}" != "" ]]; then
	want="$1"
	got=${LOGIC%\%}
	if awk "BEGIN{exit !($got < $want)}"; then
		echo "FAIL: logic-scope coverage $LOGIC is below the ${want}% threshold" >&2
		exit 1
	fi
	echo "OK: logic-scope coverage $LOGIC meets the ${want}% threshold"
fi
