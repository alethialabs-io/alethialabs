#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alibaba-cleanup-argv-test.sh — pins the EXACT argv alibaba-cleanup.sh hands the `aliyun` CLI for
# its tag-filtered listers (#2545). Offline: `aliyun` is a stub on $PATH, no credentials, no cloud.
# The exit status is the test (0 pass, 1 fail); the printed lines are only a report.
#
# ── WHY ──────────────────────────────────────────────────────────────────────────────────────────
#
# The sweeper's own `--self-test` shadows the `ali` shell FUNCTION, so it never sees an argv and
# could not notice that the ALB listers were built from flags the real CLI refuses:
#
#   ERROR: '--Tag.1.Key' is not a valid parameter or flag. See `aliyun help alb ListLoadBalancers`.
#
# That is what CI's pinned aliyun-cli 3.0.263 prints for `alb ListLoadBalancers --Tag.1.Key …`
# (captured with `--dryrun` against the release binary, and identical on 3.4.6). ECS, VPC and SLB
# accept the same spelling because their metadata types `Tag` as a RepeatList; ALB's types it as an
# Array, and only `--force` gets the `Tag.1.Key` wire form past the CLI. See the comment above
# tagged_albs in alibaba-cleanup.sh for the full reasoning.
#
# ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────────────────────────
#
#   A  The stub records calls at all, and its refusal fires on the refused shape. Without this,
#      every "argv matched" below could be a logger that wrote nothing.
#   B  Each tag-filtered lister shape — project-tag and cluster-tag, for ECS and for ALB — was
#      issued with EXACTLY the expected argv (compared whole, argument by argument).
#   C  Every ALB call that carries a `--Tag.` flag carries `--force`. B pins the two sites known
#      today; C catches a third one added later without it.
#   D  End to end through the EXIT CODE: a VERIFY_ONLY run over an empty account exits 0. With the
#      refused flags the stub (like the real CLI) fails the ALB probe, the sweeper records it as
#      UNVERIFIABLE, and it exits 4 — so D fails on the #2545 defect without reading any text.
#
# ⚠️ WHAT THIS DOES NOT PROVE. The stub's refusal rule is a fixture captured from the pinned CLI, not
# the CLI itself, and nothing here shows Alibaba's ALB API honours the `Tag.1.Key` filter. That
# needs a real run, and the alibaba nightly is muted while the account is unfunded (#2545).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
FAILS=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/alethia-alibaba-argv.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

ENV_UNDER_TEST="argvtest-2545"
REGION_UNDER_TEST="eu-central-1"
TAG_VALUE="e2e-${ENV_UNDER_TEST}"
CLUSTER_UNDER_TEST="c-argv2545"
SEP=$'\037' # the stub joins argv with US, so an argument containing a space stays one argument

# ok <msg> — report a passing assertion.
ok() { echo "  ✓ $1"; }
# bad <msg> <detail> — report a failing assertion and count it toward the exit code.
bad() {
	echo "  ✗ $1 — $2" >&2
	FAILS=$((FAILS + 1))
}

# The stub. It logs every invocation's argv as one US-joined line, refuses a `--Tag.` flag on the
# `alb` product unless `--force` is present (the pinned CLI's behaviour, message verbatim), and
# answers the ACK cluster inventory from $ST_CLUSTERS and everything else with an empty document.
cat >"$WORK/bin/aliyun" <<'STUB'
#!/bin/sh
{
	for a in "$@"; do printf '%s\037' "$a"; done
	printf '\n'
} >>"$ST_CALLS"
if [ "$1" = "alb" ]; then
	force=0 tagged=""
	for a in "$@"; do
		case "$a" in
		--force) force=1 ;;
		--Tag.*) [ -n "$tagged" ] || tagged="$a" ;;
		esac
	done
	if [ -n "$tagged" ] && [ "$force" = 0 ]; then
		printf "ERROR: '%s' is not a valid parameter or flag. See \`aliyun help alb %s\`.\n" "$tagged" "$2" >&2
		exit 1
	fi
fi
case " $* " in
*" GET /api/v1/clusters "*) printf '%s\n' "$ST_CLUSTERS" ;;
*) printf '{}\n' ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/aliyun"

# run_sweeper <calls-log> <clusters-json> — one VERIFY_ONLY run against the stub; echoes its exit code.
run_sweeper() {
	local rc=0
	: >"$1"
	ST_CALLS="$1" ST_CLUSTERS="$2" PATH="$WORK/bin:$PATH" \
		VERIFY_ONLY=1 DRY_RUN=0 PREFLIGHT=0 \
		ALETHIA_E2E_ENV="$ENV_UNDER_TEST" ALETHIA_E2E_REGION="$REGION_UNDER_TEST" ALETHIA_E2E_PROJECT="" \
		bash scripts/e2e/alibaba-cleanup.sh >"$1.out" 2>&1 || rc=$?
	echo "$rc"
}

# joined <arg…> — the stub's log line for an argv, for whole-line comparison.
joined() {
	local a out=""
	for a in "$@"; do out="${out}${a}${SEP}"; done
	printf '%s' "$out"
}

# expect_call <log> <label> <arg…> — assert that exact argv appears as a whole line in the log.
expect_call() {
	local log="$1" label="$2"
	shift 2
	if grep -Fxq -- "$(joined "$@")" "$log"; then
		ok "$label"
	else
		bad "$label" "no call with exactly: $*"
		echo "      calls seen for that product:" >&2
		grep -F -- "$1${SEP}$2${SEP}" "$log" | tr "$SEP" ' ' | sed 's/^/        /' >&2 || true
	fi
}

command -v jq >/dev/null 2>&1 || {
	echo "✗ jq is required (the sweeper parses every response with it)" >&2
	exit 1
}

echo "→ alibaba-cleanup.sh argv test (#2545)"

# ── A. THE INSTRUMENT. ──────────────────────────────────────────────────────────────────────────
a_log="$WORK/a.log"
: >"$a_log"
a_rc=0
ST_CALLS="$a_log" ST_CLUSTERS='{}' "$WORK/bin/aliyun" alb ListLoadBalancers --Tag.1.Key k --Tag.1.Value v \
	>/dev/null 2>"$WORK/a.err" || a_rc=$?
if [ "$(grep -c . "$a_log")" = 1 ] && [ "$a_rc" = 1 ] &&
	grep -Fq "'--Tag.1.Key' is not a valid parameter or flag" "$WORK/a.err"; then
	ok "A: the stub logs a call and refuses --Tag.1.Key on alb without --force"
else
	bad "A: the instrument" "logged $(grep -c . "$a_log") line(s), rc=${a_rc}"
fi

# ── B + C. A run whose cluster is discoverable, so the cluster-scoped listers fire too. The cluster
#    still being listed makes that run a LEAK (exit 1) — expected, and not what B/C measure. ──
clusters="{\"clusters\":[{\"cluster_id\":\"${CLUSTER_UNDER_TEST}\",\"name\":\"p-${ENV_UNDER_TEST}\",\"region_id\":\"${REGION_UNDER_TEST}\",\"tags\":[{\"key\":\"alethia:project-id\",\"value\":\"${TAG_VALUE}\"}]}]}"
b_log="$WORK/b.log"
b_rc="$(run_sweeper "$b_log" "$clusters")"
if grep -q "cluster (secondary scope): p-${ENV_UNDER_TEST} \[${CLUSTER_UNDER_TEST}\]" "$b_log.out"; then
	ok "B: the fixture cluster was discovered (sweeper exit ${b_rc}, a leak by design)"
else
	bad "B: cluster discovery" "the cluster-scoped listers would not run; output: $(tr '\n' ' ' <"$b_log.out" | cut -c1-300)"
fi

expect_call "$b_log" "B: ECS project-tag lister" \
	ecs DescribeInstances --PageSize 100 --Tag.1.Key alethia:project-id --Tag.1.Value "$TAG_VALUE" --region "$REGION_UNDER_TEST"
expect_call "$b_log" "B: ECS cluster-tag lister" \
	ecs DescribeInstances --PageSize 100 --Tag.1.Key ack.aliyun.com --Tag.1.Value "$CLUSTER_UNDER_TEST" --region "$REGION_UNDER_TEST"
expect_call "$b_log" "B: ALB project-tag lister" \
	alb ListLoadBalancers --force --Tag.1.Key alethia:project-id --Tag.1.Value "$TAG_VALUE" --region "$REGION_UNDER_TEST"
expect_call "$b_log" "B: ALB cluster-tag lister" \
	alb ListLoadBalancers --force --Tag.1.Key ack.aliyun.com --Tag.1.Value "$CLUSTER_UNDER_TEST" --region "$REGION_UNDER_TEST"

alb_tagged="$(grep -c "^alb${SEP}.*${SEP}--Tag\." "$b_log" || true)"
alb_unforced="$(grep "^alb${SEP}.*${SEP}--Tag\." "$b_log" | grep -vc "${SEP}--force${SEP}" || true)"
if [ "${alb_tagged:-0}" -gt 0 ] && [ "${alb_unforced:-0}" = 0 ]; then
	ok "C: all ${alb_tagged} tag-filtered ALB call(s) carry --force"
else
	bad "C: ALB tag filters without --force" "${alb_unforced:-?} of ${alb_tagged:-0} tag-filtered ALB call(s)"
fi

# ── D. End to end, read through the exit code: an empty account verifies CLEAN. ─────────────────
d_log="$WORK/d.log"
d_rc="$(run_sweeper "$d_log" '{"clusters":[]}')"
if [ "$d_rc" = 0 ]; then
	ok "D: VERIFY_ONLY over an empty account exits 0 (no probe refused)"
else
	bad "D: VERIFY_ONLY over an empty account" "exit ${d_rc}, expected 0 (4 means a probe was refused); output: $(tr '\n' ' ' <"$d_log.out" | cut -c1-400)"
fi

if [ "$FAILS" -ne 0 ]; then
	echo "✗ alibaba-cleanup-argv-test.sh: ${FAILS} failure(s)" >&2
	exit 1
fi
echo "✓ alibaba-cleanup-argv-test.sh passed"
exit 0
