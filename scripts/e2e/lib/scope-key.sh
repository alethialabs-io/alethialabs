# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# scope-key.sh — WHICH tag key an e2e cloud sweeper scopes by (#5096).
#
# Sourced by scripts/e2e/{aws,gcp,azure,alibaba,hcloud}-cleanup.sh. Run directly with `--self-test`
# to exercise this file on its own (no cloud, no credentials).
#
# ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
#
# Every sweeper found a run's resources by ONE handle: `alethia:project-id=e2e-<ENV>` (rendered per
# cloud — `alethia_project-id` on the label clouds). packages/core/cloud/tags.go emits that handle
# from `ProjectConfig.ID`, and the seeded T2 path builds the config itself, so it sets the ID to
# `e2e-<ENV>`. The `cli-demo` dimension does not build the config — the console does, from a project
# the CLI created — so its ID is the project's UUID and its handle is not `e2e-` anything. Run
# 36135826614's plan showed `"alethia_project-id" = "3e9d7e82-…"` on every hetzner resource. A stack
# the CLI creates and then leaks was invisible to every sweeper and to the orphan reaper, on every
# cloud.
#
# ── THE FIX, AND WHY IT IS A CLASSIFICATION ─────────────────────────────────────────────────────
#
# The maintainer's ruling on #5096 (option 1): a second handle that no customer resource carries by
# accident — the `e2e-run` CLASSIFICATION dimension. Classification is a real product input (a
# governed org taxonomy the console snapshots into the job and tags.go renders onto every resource
# as `alethia:<dimension>`), so nothing e2e-specific leaks into the product: the cli-demo org SEEDS
# the dimension and the CLI ASSIGNS it (`alethia classification assign project <id> e2e-run
# e2e-<ENV>`), exactly as a customer would classify a project. The seeded paths stamp the same
# value into the snapshot they build. So every e2e stack carries `alethia:e2e-run=e2e-<ENV>`
# whoever the actor was.
#
# ── THE TWO KEYS, AND WHY BOTH ──────────────────────────────────────────────────────────────────
#
#   project-id  every stack a SEEDED run created, including every one standing TODAY. Keeping it is
#               what stops this change from making the existing backlog invisible.
#   e2e-run     every stack created after this change, whoever the actor — and the ONLY handle a
#               CLI-created (cli-demo) stack carries.
#
# A sweep is scope-locked to ONE (key, value) pair; it never ORs keys inside one delete. The
# preflight discovers under BOTH keys and attributes each resource to exactly one pair
# (e2e_scope_attribute), then sweeps each pair on its own, with every existing guard re-run.
#
# ALETHIA_E2E_SCOPE_KEY picks the key for a NON-preflight run (the in-run teardown and VERIFY_ONLY).
# Unset means `project-id`, which is exactly the behaviour before this file existed. The cli-demo
# dimension sets it to `e2e-run` (scripts/e2e/resolve-dimension.sh --fidelity cli-demo), because its
# own stack carries no `e2e-` project-id at all. Any other value is REFUSED: it is the key half of a
# delete filter, and a typo there must not become a different filter.

# The two handle names a sweeper may scope by, in PREFERENCE order (see e2e_scope_attribute).
E2E_SCOPE_KEYS="project-id e2e-run"

# e2e_scope_key — print the validated scope key NAME (the segment after `alethia` + the cloud's
# separator). Returns 2, with the reason on stderr, for anything but the two known names.
e2e_scope_key() {
	local k="${ALETHIA_E2E_SCOPE_KEY:-project-id}"
	case "$k" in
	project-id | e2e-run)
		printf '%s\n' "$k"
		;;
	*)
		echo "✗ REFUSING TO RUN: ALETHIA_E2E_SCOPE_KEY='${k}' is not a known sweep handle (want one of: ${E2E_SCOPE_KEYS})." >&2
		echo "  It is the KEY half of every delete filter; an unknown key is refused so a typo cannot become a different filter." >&2
		return 2
		;;
	esac
}

# e2e_scope_run_value_ok <value> — is this an `e2e-run` value a CI run could have written?
#
# Stricter than the project-id guard ON PURPOSE. `project-id` is emitted from `ProjectConfig.ID`,
# which no user input can set, so `e2e-` alone is a test-only marker there. `e2e-run` is a
# classification dimension, and any org can define one — so discovery accepts only the exact shape
# the harness writes in CI, `e2e-<run_id>-<attempt>`, and a customer label that merely starts with
# `e2e-` is not a prior nightly. (An in-run sweep is not held to this: it is handed its ENV rather
# than discovering it.)
e2e_scope_run_value_ok() {
	printf '%s' "${1:-}" | grep -Eq '^e2e-[0-9]+-[0-9]+$'
}

# e2e_scope_attribute <project-id value> <e2e-run value> — attribute ONE resource to the single
# (ENV, key) pair that sweeps it, printed as `<env>\t<key>`; prints nothing when it is not an e2e
# resource at all.
#
# project-id WINS when it is itself an `e2e-` handle. A seeded stack carries both keys with the same
# ENV, and its project-id sweep already reaches every resource the e2e-run one would — attributing
# it to both would sweep the same stack twice and spend the preflight's budget on a no-op. A
# CLI-created stack's project-id is a UUID, so it falls through to its e2e-run handle. The
# per-resource decision is what makes this exact: a stack is never dropped because ANOTHER stack
# happened to share its ENV under the other key.
e2e_scope_attribute() {
	local pid="${1:-}" run="${2:-}"
	case "$pid" in
	e2e-?*)
		printf '%s\tproject-id\n' "${pid#e2e-}"
		return 0
		;;
	esac
	if e2e_scope_run_value_ok "$run"; then
		printf '%s\te2e-run\n' "${run#e2e-}"
	fi
	return 0
}

# ── Self-test. The exit code is the verdict; nothing runs in a subshell whose status is dropped. ──
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--self-test" ]; then
	set -uo pipefail
	fails=0
	check() { # <name> <want> <got>
		if [ "$2" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — want '$2', got '$3'" >&2
			fails=$((fails + 1))
		fi
	}
	tab="$(printf '\t')"
	echo "→ scope-key.sh self-test"

	check "unset scope key defaults to project-id (the pre-#5096 behaviour)" "project-id" "$(ALETHIA_E2E_SCOPE_KEY='' e2e_scope_key 2>/dev/null)"
	check "e2e-run is accepted" "e2e-run" "$(ALETHIA_E2E_SCOPE_KEY=e2e-run e2e_scope_key 2>/dev/null)"
	rc=0
	ALETHIA_E2E_SCOPE_KEY=cluster e2e_scope_key >/dev/null 2>&1 || rc=$?
	check "an unknown key is refused with exit 2" "2" "$rc"
	rc=0
	ALETHIA_E2E_SCOPE_KEY='project-id,e2e-run' e2e_scope_key >/dev/null 2>&1 || rc=$?
	check "a key LIST is refused (one delete filter, one key)" "2" "$rc"

	check "a seeded resource is attributed to its project-id handle" "36135826614-1${tab}project-id" \
		"$(e2e_scope_attribute e2e-36135826614-1 e2e-36135826614-1)"
	check "an old seeded resource with no e2e-run tag is still found (backward compatible)" "31459117502-1${tab}project-id" \
		"$(e2e_scope_attribute e2e-31459117502-1 '')"
	check "a CLI-created resource (UUID project-id) is attributed to its e2e-run handle" "36135826614-1${tab}e2e-run" \
		"$(e2e_scope_attribute 3e9d7e82-6bfc-4faa-9006-7c1e27d72249 e2e-36135826614-1)"
	check "a customer resource with neither handle is not attributed" "" \
		"$(e2e_scope_attribute 3e9d7e82-6bfc-4faa-9006-7c1e27d72249 '')"
	check "a customer's own e2e-run classification that is not a CI run shape is not attributed" "" \
		"$(e2e_scope_attribute 3e9d7e82-6bfc-4faa-9006-7c1e27d72249 e2e-staging)"
	check "a bare e2e- value is not a handle" "" "$(e2e_scope_attribute e2e- '')"

	if [ "$fails" -ne 0 ]; then
		echo "✗ scope-key.sh self-test: ${fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ scope-key.sh self-test passed"
	exit 0
fi
