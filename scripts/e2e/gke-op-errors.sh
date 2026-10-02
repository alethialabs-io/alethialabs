#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# gke-op-errors.sh — print the GKE OPERATIONS of this run's cluster, and the error each failed one
# recorded, so a red gcp leg names its own cause (#5273).
#
# WHY THIS EXISTS. The gcp floor went red on 2026-10-01 and 2026-10-02 and every artefact the run
# kept said the same thing: tofu's `Error waiting for creating GKE cluster: Failed to create
# cluster`. That sentence is the google provider's wrapper — it polls the GKE operation and, when
# it ends in error, reports the wait rather than the reason. The reason exists only on the
# operation, and was read by hand afterwards with `gcloud container operations list`:
#
#   10-01 europe-west3-a  Conflicting IP cidr range: Invalid IPCidrRange: 172.16.0.0/28 conflicts
#                         with reserved IP range '172.16.0.0/16'.
#   10-02 europe-west3-b  code 13 INTERNAL "Failed to create cluster"
#
# Two different causes behind one identical log line. This asks the same question the triager did,
# inside the job, while the credentials still exist.
#
# SCOPE. Only operations whose targetLink embeds `-<ENV>-` — the run-unique segment of the GKE name
# `gke-<short>-<ENV>-<project>` (infra/templates/project/gcp/locals.tf, `gke_name`). The e2e
# project may be shared; another cluster's operations are not this run's evidence and are never
# printed. It is READ-ONLY: one `operations list`, nothing created, changed or deleted.
#
# IT NEVER FAILS THE STEP. It runs only after the leg is already red, and a diagnostic that exits
# non-zero would add a second red reason on top of the real one. Every way of not getting an
# answer — no ENV, no zone, gcloud refused, unparsable output — is a LABELLED line, never silence
# and never an exit code. `--self-test` is the only mode whose exit code means anything.
#
# Usage:
#   ALETHIA_E2E_ENV=<run env> ALETHIA_E2E_REGION=<zone> scripts/e2e/gke-op-errors.sh
#   scripts/e2e/gke-op-errors.sh --self-test
# Optional: ALETHIA_E2E_GCP_PROJECT_ID / CLOUDSDK_CORE_PROJECT / GOOGLE_CLOUD_PROJECT (the same
# precedence gcp-cleanup.sh uses; unset ⇒ gcloud's active config).
set -uo pipefail

# workflow_escape — make an arbitrary message safe as the body of a `::error::` workflow command.
# A raw newline would end the command and let the next line be read as a NEW command, so the
# characters the runner decodes are encoded (actions/toolkit `escapeData`).
workflow_escape() {
	local s="$1"
	s="${s//'%'/%25}"
	s="${s//$'\r'/%0D}"
	s="${s//$'\n'/%0A}"
	printf '%s' "$s"
}

# render_ops <env> — read a `gcloud container operations list --format=json` array on stdin and
# print this run's operations, oldest first. One record per operation, fields separated by US
# (\x1f) — NOT a tab: tab is IFS whitespace, so `read` would collapse an empty <code> and shift the
# message into it:
#   <startTime> <operationType> <status> <cluster> <code> <message>
# <code>/<message> are empty for an operation that recorded no error. `error` is the GKE Status
# field; `statusMessage` is its deprecated predecessor and is read only when `error` is absent.
render_ops() {
	jq -r --arg env "$1" '
		[ .[]
		  | select((.targetLink // "") | contains("-" + $env + "-"))
		  | { start: (.startTime // ""), type: (.operationType // "?"), status: (.status // "?"),
		      cluster: ((.targetLink // "") | (capture("/clusters/(?<c>[^/]+)").c? // (split("/") | .[-1]))),
		      code: ((.error.code // "") | tostring),
		      msg: ((.error.message // .statusMessage // "") | gsub("[\t\r\n]+"; " ")) } ]
		| sort_by(.start)
		| .[] | [.start, .type, .status, .cluster, .code, .msg] | join("\u001f")'
}

# main — list, filter, print. Always returns 0 (see header).
main() {
	local env="${ALETHIA_E2E_ENV:-${E2E_ENV:-}}"
	local zone="${ALETHIA_E2E_REGION:-${E2E_REGION:-}}"
	local project="${ALETHIA_E2E_GCP_PROJECT_ID:-${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}}"
	echo "──── GKE operations for this run (read-only) ────"
	if [ -z "$env" ]; then
		echo "gke-op-errors: (not asked — ALETHIA_E2E_ENV/E2E_ENV is unset, so nothing scopes the list to this run)"
		return 0
	fi
	if [ -z "$zone" ]; then
		echo "gke-op-errors: (not asked — ALETHIA_E2E_REGION/E2E_REGION is unset)"
		return 0
	fi
	if ! command -v jq >/dev/null 2>&1; then
		echo "gke-op-errors: (not asked — jq is not on PATH)"
		return 0
	fi

	local args=(container operations list --zone "$zone" --format=json)
	[ -n "$project" ] && args=(--project "$project" "${args[@]}")
	local out err rc=0
	err="$(mktemp "${TMPDIR:-/tmp}/gke-op-errors.XXXXXX")"
	out="$(gcloud "${args[@]}" 2>"$err")" || rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "gke-op-errors: (UNANSWERED — gcloud exited $rc; the operation list was not read)"
		head -n 3 "$err" | sed 's/^/  gcloud: /'
		rm -f "$err"
		return 0
	fi
	rm -f "$err"

	local rows
	if ! rows="$(printf '%s' "$out" | render_ops "$env" 2>&1)"; then
		echo "gke-op-errors: (UNANSWERED — the operation list did not parse: ${rows%%$'\n'*})"
		return 0
	fi
	if [ -z "$rows" ]; then
		echo "gke-op-errors: no GKE operation in $zone targets a cluster of run $env — the create was never accepted by GKE (look at tofu's own error), or it ran in another zone."
		return 0
	fi

	local start type status cluster code msg failed=0
	while IFS=$'\x1f' read -r start type status cluster code msg; do
		if [ -n "$msg" ] || [ -n "$code" ]; then
			failed=$((failed + 1))
			echo "  $start  $type  $status  $cluster  ERROR${code:+ code $code}: ${msg:-(no message)}"
			echo "::error title=GKE $type failed ($cluster)::$(workflow_escape "${code:+code $code: }${msg:-(no message)}")"
		else
			echo "  $start  $type  $status  $cluster"
		fi
	done <<<"$rows"
	if [ "$failed" -eq 0 ]; then
		echo "gke-op-errors: no operation of run $env recorded an error — the failure is not a GKE operation error."
	fi
	return 0
}

# self_test — drive main against a stub `gcloud` on PATH. Hermetic: no cloud, no credentials.
self_test() {
	local fails=0 work out
	work="$(mktemp -d "${TMPDIR:-/tmp}/gke-op-errors-test.XXXXXX")"
	trap 'rm -rf "$work"' RETURN
	mkdir -p "$work/bin"
	cat >"$work/ops.json" <<-'JSON'
		[
		  {"name":"operation-ok","operationType":"CREATE_CLUSTER","status":"DONE","startTime":"2026-09-30T02:00:00Z",
		   "targetLink":"https://container.googleapis.com/v1/projects/p/zones/europe-west3-a/clusters/gke-euw3-e2e-old-alethia"},
		  {"name":"operation-cidr","operationType":"CREATE_CLUSTER","status":"DONE","startTime":"2026-10-01T02:10:00Z",
		   "targetLink":"https://container.googleapis.com/v1/projects/p/zones/europe-west3-a/clusters/gke-euw3-e2e-run1-alethia",
		   "error":{"code":3,"message":"Conflicting IP cidr range: Invalid IPCidrRange: 172.16.0.0/28 conflicts with reserved IP range '172.16.0.0/16'.\nsecond line"}},
		  {"name":"operation-legacy","operationType":"DELETE_CLUSTER","status":"DONE","startTime":"2026-10-01T02:30:00Z",
		   "targetLink":"https://container.googleapis.com/v1/projects/p/zones/europe-west3-a/clusters/gke-euw3-e2e-run1-alethia",
		   "statusMessage":"Failed to delete cluster"},
		  {"name":"operation-np","operationType":"CREATE_NODE_POOL","status":"DONE","startTime":"2026-10-01T02:05:00Z",
		   "targetLink":"https://container.googleapis.com/v1/projects/p/zones/europe-west3-a/clusters/gke-euw3-e2e-run1-alethia/nodePools/np"},
		  {"name":"operation-foreign","operationType":"CREATE_CLUSTER","status":"DONE","startTime":"2026-10-01T02:00:00Z",
		   "targetLink":"https://container.googleapis.com/v1/projects/p/zones/europe-west3-a/clusters/someone-elses-cluster",
		   "error":{"code":13,"message":"FOREIGN-ERROR"}}
		]
	JSON
	cat >"$work/bin/gcloud" <<-'STUB'
		#!/usr/bin/env bash
		printf '%s\n' "$*" >>"$STUB_LOG"
		case "${STUB_MODE:-ok}" in
		  ok)    cat "$STUB_FIXTURE" ;;
		  fail)  echo "ERROR: (gcloud.container.operations.list) PERMISSION_DENIED" >&2; exit 1 ;;
		  junk)  echo "not json" ;;
		esac
	STUB
	chmod +x "$work/bin/gcloud"
	export STUB_LOG="$work/argv.log" STUB_FIXTURE="$work/ops.json"

	# check <description> <condition-exit-code>
	check() {
		if [ "$2" -eq 0 ]; then echo "  ✓ $1"; else
			echo "  ✗ $1" >&2
			fails=$((fails + 1))
		fi
	}
	# run_main <env> <zone> <project> <mode> — run main in a clean env, print its output and exit code.
	run_main() {
		env -i PATH="$work/bin:$PATH" TMPDIR="${TMPDIR:-/tmp}" STUB_LOG="$STUB_LOG" STUB_FIXTURE="$STUB_FIXTURE" \
			STUB_MODE="$4" ALETHIA_E2E_ENV="$1" ALETHIA_E2E_REGION="$2" GOOGLE_CLOUD_PROJECT="$3" \
			bash "${BASH_SOURCE[0]}"
		echo "EXIT=$?"
	}

	echo "gke-op-errors self-test"
	out="$(run_main e2e-run1 europe-west3-a itgix-test ok)"
	grep -q "^::error title=GKE CREATE_CLUSTER failed (gke-euw3-e2e-run1-alethia)::code 3: Conflicting IP cidr range" <<<"$out"
	check "a failed CREATE_CLUSTER is annotated with its code and GKE's own message" $?
	grep -q "reserved IP range '172.16.0.0/16'. second line" <<<"$out"
	check "a multi-line message is flattened onto one line (cannot inject a workflow command)" $?
	grep -q "^::error title=GKE DELETE_CLUSTER failed (gke-euw3-e2e-run1-alethia)::Failed to delete cluster" <<<"$out"
	check "the deprecated statusMessage is read when error is absent" $?
	grep -q "CREATE_NODE_POOL  DONE  gke-euw3-e2e-run1-alethia$" <<<"$out"
	check "a successful node-pool operation is listed under its CLUSTER, without an annotation" $?
	! grep -q "FOREIGN-ERROR\|someone-elses-cluster\|e2e-old" <<<"$out"
	check "operations of other clusters are never printed" $?
	local first_create first_delete
	first_create="$(grep -n 'CREATE_CLUSTER  DONE' <<<"$out" | head -1 | cut -d: -f1)"
	first_delete="$(grep -n 'DELETE_CLUSTER  DONE' <<<"$out" | head -1 | cut -d: -f1)"
	check "operations are listed oldest first" "$([ "${first_create:-0}" -gt 0 ] && [ "$first_create" -lt "${first_delete:-0}" ] && echo 0 || echo 1)"
	grep -q -- "--project itgix-test container operations list --zone europe-west3-a --format=json" "$STUB_LOG"
	check "the list is scoped to the run's project and zone" $?
	! grep -qv "operations list" "$STUB_LOG"
	check "the only gcloud verb issued is a read (operations list)" $?
	grep -q "^EXIT=0$" <<<"$out"
	check "exit 0 on the answered path" $?

	out="$(run_main e2e-nomatch europe-west3-a "" ok)"
	grep -q "no GKE operation in europe-west3-a targets a cluster of run e2e-nomatch" <<<"$out" && grep -q "^EXIT=0$" <<<"$out"
	check "no operation for this run is said out loud, exit 0" $?
	! grep -q -- "--project" <(tail -1 "$STUB_LOG")
	check "an unset project falls back to the active config (no empty --project)" $?

	out="$(run_main e2e-run1 europe-west3-a "" fail)"
	grep -q "UNANSWERED — gcloud exited 1" <<<"$out" && grep -q "gcloud: ERROR: (gcloud.container.operations.list) PERMISSION_DENIED" <<<"$out" && grep -q "^EXIT=0$" <<<"$out"
	check "a gcloud failure is a labelled UNANSWERED line with its reason, exit 0" $?

	out="$(run_main e2e-run1 europe-west3-a "" junk)"
	grep -q "UNANSWERED — the operation list did not parse" <<<"$out" && grep -q "^EXIT=0$" <<<"$out"
	check "unparsable output is a labelled UNANSWERED line, not 'no operation'" $?

	: >"$STUB_LOG"
	out="$(run_main "" europe-west3-a "" ok)"
	grep -q "not asked — ALETHIA_E2E_ENV/E2E_ENV is unset" <<<"$out" && [ ! -s "$STUB_LOG" ] && grep -q "^EXIT=0$" <<<"$out"
	check "no run ENV ⇒ refuses to list unscoped, calls nothing" $?

	if [ "$fails" -ne 0 ]; then
		echo "gke-op-errors self-test: $fails failure(s)" >&2
		return 1
	fi
	echo "gke-op-errors self-test: all checks passed"
}

if [ "${1:-}" = "--self-test" ]; then
	self_test
	exit $?
fi
main
exit 0
