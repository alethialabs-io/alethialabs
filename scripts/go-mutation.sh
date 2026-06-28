#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Go mutation testing — the "non-biased check" for Go, mirroring Stryker for TS. Runs gremlins
# (https://github.com/go-gremlins/gremlins) per module (go.work has three: apps/cli, apps/runner,
# packages/core). A vacuous Go test scores ~0; a real test kills its mutants.
#
# Usage:
#   GREMLINS_THRESHOLD=70 scripts/go-mutation.sh        # gate at 70% efficacy
#   GREMLINS_MODULES="packages/core" scripts/go-mutation.sh   # scope to one module
#   scripts/go-mutation.sh                              # report-only (no gate)
#
# Install once: go install github.com/go-gremlins/gremlins/cmd/gremlins@latest
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THRESHOLD="${GREMLINS_THRESHOLD:-0}"
read -r -a MODULES <<<"${GREMLINS_MODULES:-apps/cli apps/runner packages/core}"

if ! command -v gremlins >/dev/null 2>&1; then
	echo "✗ gremlins not installed. Run: go install github.com/go-gremlins/gremlins/cmd/gremlins@latest" >&2
	exit 1
fi

fail=0
for m in "${MODULES[@]}"; do
	echo "=== gremlins: $m (threshold ${THRESHOLD}) ==="
	args=(unleash --workers=4)
	[ "$THRESHOLD" != "0" ] && args+=(--threshold-efficacy="$THRESHOLD")
	if ! (cd "$ROOT/$m" && gremlins "${args[@]}" ./...); then
		fail=1
		echo "✗ $m below mutation threshold" >&2
	fi
done

exit "$fail"
