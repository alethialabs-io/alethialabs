# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# sweep-probe.sh — three-state verification for the five e2e cloud sweepers.
#
# Sourced by scripts/e2e/{aws,gcp,azure,alibaba,hcloud}-cleanup.sh. Run directly with
# `--self-test` to exercise this file on its own (no cloud, no credentials).
#
# ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────────────────────────
#
# Every sweeper verified teardown with probes shaped like:
#
#     aws … 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
#
# Three launderings in one line. `2>/dev/null` discards the reason. The pipe replaces the cloud
# call's exit status with the LAST stage's (`grep`'s), and even under `set -o pipefail` the
# trailing `|| true` normalises whatever survived. So an API that FAILED — expired credential,
# throttle, transient 5xx, a CLI too old for the subcommand — produced empty stdout and exit 0:
# byte-identical to "confirmed gone".
#
# `verify_swept` then tested only `[ -n "$x" ]` per resource type. One broken credential made
# EVERY type read clean and the sweeper announce "cleanup verified complete" over a live Aurora
# cluster, NAT gateway or EKS control plane. This runs on the `always()` teardown path that
# test/e2e/t2_provision_test.go defers to as "the guarantee" — the in-process destroy failing is
# tolerated BECAUSE the sweeper will catch it. If the sweeper cannot see, nothing does.
#
# hcloud-cleanup.sh invented the answer for two of its own probes (#2549) and it was never
# generalised, never applied to its own `list_ids`, and only ever emitted `::warning::` — it did
# not gate the exit code. This file is that answer, generalised, and it gates.
#
# ── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
#
# Every probe resolves to exactly one of three states, and the third is the whole point:
#
#   CLEAN         the API answered, and it listed nothing.          → exit 0
#   LEAKED        the API answered, and it listed something.        → exit 1  (caller's verify_swept)
#   UNVERIFIABLE  the API did not answer.                           → exit 4  (finalize_verification)
#
# "The API said nothing survives" and "the API did not answer" must never be the same value.
#
# ── WHY THE LEDGER IS A FILE AND NOT A SHELL VARIABLE ───────────────────────────────────────────
#
# Every probe in these scripts is called inside `$( )` or on the left of a pipe. Both run in a
# SUBSHELL, and a variable assigned there is discarded when it exits — so a variable-backed ledger
# would record nothing at exactly the moments that matter. The ledger is an append-only FILE for
# that reason alone. The same trap applies to anything the self-tests count (see PROBE_CALLS).

# ── Tunables. Probes are read-only and idempotent, so retrying one is free and safe. Retrying is
#    what keeps a transient 5xx from redding a healthy teardown while a genuinely dead credential
#    still fails every attempt and is reported. Set PROBE_RETRY_DELAY=0 in tests. ──
PROBE_RETRIES="${PROBE_RETRIES:-3}"
PROBE_RETRY_DELAY="${PROBE_RETRY_DELAY:-3}"

PROBE_LEDGER="${PROBE_LEDGER:-}"
PROBE_ERR_DIR="${PROBE_ERR_DIR:-}"

# probe_reset — begin (or restart) a verification ledger. Idempotent.
#
# Called once at startup. It is deliberately NOT called again before verify_swept: a discovery call
# that failed DURING the sweep means this script may have failed to delete something it never saw,
# and re-listing it later through a different API is not proof that it did. Any probe that could not
# answer, at any point in the run, leaves the run unverified.
probe_reset() {
	if [ -z "$PROBE_LEDGER" ]; then
		PROBE_ERR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alethia-sweep-probe.XXXXXX")"
		PROBE_LEDGER="${PROBE_ERR_DIR}/ledger"
	fi
	: >"$PROBE_LEDGER"
}

# probe_note_unverifiable <type> <reason> — record that <type> could NOT be looked at.
#
# Use it for a probe that failed AND for a structural inability to look at all: a missing
# credential, an absent CLI, a subcommand this CLI version does not have. Both mean the same thing
# to whoever reads the result — nobody checked — and both must gate.
probe_note_unverifiable() {
	[ -n "$PROBE_LEDGER" ] || probe_reset
	printf '%s(%s)\n' "$1" "$2" >>"$PROBE_LEDGER"
}

# probe_has_unverifiable — true when at least one probe could not answer.
probe_has_unverifiable() {
	[ -n "$PROBE_LEDGER" ] && [ -s "$PROBE_LEDGER" ]
}

# probe_unverifiable_types — the distinct resource types that could not be checked, space-separated.
# The headline: short enough for an ::error:: title, and stable across a hundred failing ids.
probe_unverifiable_types() {
	probe_has_unverifiable || return 0
	sed -E 's/\(.*//' "$PROBE_LEDGER" | sort -u | tr '\n' ' '
}

# probe_unverifiable_detail — every distinct type(reason), one per line, capped. The cap matters:
# a broken credential fails every probe of every resource, and a thousand-line ::error:: is a wall
# nobody reads.
probe_unverifiable_detail() {
	probe_has_unverifiable || return 0
	local total
	total="$(sort -u "$PROBE_LEDGER" | grep -c . || true)"
	sort -u "$PROBE_LEDGER" | head -n 20 | sed 's/^/      · /'
	[ "${total:-0}" -gt 20 ] && echo "      · … and $((total - 20)) more"
	return 0
}

# probe_run <type> <cmd…> — run a cloud LIST/DESCRIBE call and resolve its three-state result.
#
# Echoes the command's stdout UNFILTERED (the caller pipes it through tr/grep/jq as before — the
# filtering is now downstream of the exit-status decision, which is the fix). Returns the command's
# REAL exit status, never a pipeline's. On failure, after PROBE_RETRIES attempts, records
# UNVERIFIABLE for <type> with the exit code and the first line of stderr.
#
# ⚠️ Callers must NOT write `probe_run … | head -1` and then read `$?` — that is the original
# defect. Capture first, filter second.
probe_run() {
	local ptype="$1"
	shift
	[ -n "$PROBE_ERR_DIR" ] || probe_reset
	local out="" rc=0 attempt=1 delay="$PROBE_RETRY_DELAY" errf why
	# $BASHPID (not $$) is this SUBSHELL's pid — probes run inside `$( )`, where $$ is still the
	# parent's, so $$ would collide between concurrent captures.
	errf="${PROBE_ERR_DIR}/err.${BASHPID:-$$}"
	while :; do
		rc=0
		out="$("$@" 2>"$errf")" || rc=$?
		[ "$rc" -eq 0 ] && break
		[ "$attempt" -ge "$PROBE_RETRIES" ] && break
		[ "$delay" -gt 0 ] && sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	if [ "$rc" -ne 0 ]; then
		why="$(tr '\n' ' ' <"$errf" 2>/dev/null | tr -s ' ' | cut -c1-200)"
		probe_note_unverifiable "$ptype" "exit ${rc} after ${attempt} attempt(s)${why:+ — ${why}}"
	fi
	if [ -n "$out" ]; then printf '%s\n' "$out"; fi
	return "$rc"
}

# probe_confirm <type> <cmd…> — the same, for a per-RESOURCE existence check where a NotFound is
# the answer "gone", not a failure to look.
#
# Uses the caller's `looks_gone` (each sweeper defines one over its own cloud's error strings) to
# tell the two apart. A NotFound resolves CLEAN and is silent; ANY OTHER error is UNVERIFIABLE.
# Without that split a throttled `describe-db-cluster` reads exactly like a deleted Aurora cluster.
probe_confirm() {
	local ptype="$1"
	shift
	[ -n "$PROBE_ERR_DIR" ] || probe_reset
	local out="" rc=0 attempt=1 delay="$PROBE_RETRY_DELAY" errf err why
	errf="${PROBE_ERR_DIR}/err.${BASHPID:-$$}"
	while :; do
		rc=0
		out="$("$@" 2>"$errf")" || rc=$?
		[ "$rc" -eq 0 ] && break
		err="$(cat "$errf" 2>/dev/null || true)"
		if declare -F looks_gone >/dev/null 2>&1 && looks_gone "$err"; then
			return 0 # confirmed absent — CLEAN, and nothing to print
		fi
		[ "$attempt" -ge "$PROBE_RETRIES" ] && break
		[ "$delay" -gt 0 ] && sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	if [ "$rc" -ne 0 ]; then
		why="$(tr '\n' ' ' <"$errf" 2>/dev/null | tr -s ' ' | cut -c1-200)"
		probe_note_unverifiable "$ptype" "exit ${rc} after ${attempt} attempt(s)${why:+ — ${why}}"
	fi
	if [ -n "$out" ]; then printf '%s\n' "$out"; fi
	return "$rc"
}

# probe_gate <cloud> <scope-description> — the exit-code half of the contract.
#
# Returns 0 when every probe answered, 4 when one did not. Callers run it AFTER verify_swept so a
# real leak (exit 1) still outranks "could not check". `::error::` and not `::warning::`: the whole
# point is that the step goes red, because the account may be billing and nobody knows.
probe_gate() {
	local cloud="$1" scope="$2"
	probe_has_unverifiable || return 0
	echo "  ✗ verification INCOMPLETE — these probes could not answer:" >&2
	probe_unverifiable_detail >&2
	echo "::error::${cloud} cleanup UNVERIFIED for ${scope} — $(probe_unverifiable_types)could not be checked, so nothing here proves the account is empty. A failed probe and an empty account look identical; treat this as a possible leak and confirm by hand." >&2
	return 4
}

# probe_warn_unverifiable <cloud> <scope> — the PREFLIGHT variant. Preflight is explicitly
# best-effort and never blocks its caller, so it warns instead of gating; the always() teardown and
# the next preflight are what gate.
probe_warn_unverifiable() {
	probe_has_unverifiable || return 0
	echo "::warning::${1} preflight for ${2} could not check $(probe_unverifiable_types)— the sweep is best-effort and does not block, but these were NOT verified." >&2
	probe_unverifiable_detail >&2
	return 0
}

# ── Self-test. Runs only when this file is EXECUTED, never when it is sourced. ──
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--self-test" ]; then
	set -euo pipefail
	st_fails=0
	PROBE_RETRY_DELAY=0
	probe_reset

	ok() { echo "  ✓ $1"; }
	bad() {
		echo "  ✗ $1 — $2" >&2
		st_fails=$((st_fails + 1))
	}

	# THE SUBSHELL TRAP, made a fixture rather than a comment. The stub is invoked from inside
	# `$( )`, so a call counter kept in a shell VARIABLE rewinds to its pre-call value the moment the
	# substitution closes — a retry test built on one would pass while asserting nothing. The counter
	# is a FILE for the same reason the ledger is.
	PROBE_CALLS="${PROBE_ERR_DIR}/calls"
	: >"$PROBE_CALLS"
	st_calls() { grep -c . "$PROBE_CALLS" 2>/dev/null || echo 0; }

	# stub — $ST_OUT on stdout, $ST_ERR on stderr, exit $ST_RC. When $ST_FAIL_FIRST is set it fails
	# that many times and then succeeds, which is what a transient 5xx looks like.
	stub() {
		echo x >>"$PROBE_CALLS"
		local n
		n="$(st_calls)"
		[ -n "$ST_OUT" ] && printf '%s\n' "$ST_OUT"
		if [ "${ST_FAIL_FIRST:-0}" -gt 0 ] && [ "$n" -le "${ST_FAIL_FIRST}" ]; then
			printf '%s\n' "${ST_ERR:-transient}" >&2
			return 52
		fi
		[ "${ST_RC:-0}" -ne 0 ] && printf '%s\n' "${ST_ERR:-}" >&2
		return "${ST_RC:-0}"
	}

	echo "→ sweep-probe.sh self-test"

	# ── The three states. ──
	#
	# The RETURN STATUS is asserted alongside the state, not just the ledger. It is the half every
	# caller reads (`… || return 0`, `… || true`), and a mutation that made probe_run always return
	# 0 — precisely the laundering this whole change removes — passed every other case in this file.
	# A guard's own test has to fail when the guard is removed, in every direction it claims.
	st_state() { # <name> <ST_OUT> <ST_RC> <expected state> <expected stdout> <expected return status>
		probe_reset
		: >"$PROBE_CALLS"
		ST_OUT="$2" ST_RC="$3" ST_ERR="boom" ST_FAIL_FIRST=0
		local got rc=0 state
		got="$(probe_run widget stub)" || rc=$?
		if probe_has_unverifiable; then
			state=UNVERIFIABLE
		elif [ -n "$got" ]; then
			state=LEAKED
		else
			state=CLEAN
		fi
		if [ "$state" != "$4" ]; then
			bad "$1" "expected $4, got ${state} (rc=${rc}, out='${got}')"
			return 0
		fi
		if [ "$got" != "$5" ]; then
			bad "$1" "expected stdout '$5', got '${got}'"
			return 0
		fi
		if [ "$rc" != "$6" ]; then
			bad "$1" "expected probe_run to RETURN $6, got ${rc} — the caller's \`|| return 0\` reads this"
			return 0
		fi
		ok "$1"
	}
	st_state "an API that answers with nothing is CLEAN" "" 0 CLEAN "" 0
	st_state "an API that answers with a resource is LEAKED" "i-0abc" 0 LEAKED "i-0abc" 0
	st_state "an API that FAILS is UNVERIFIABLE, not CLEAN" "" 255 UNVERIFIABLE "" 255
	# THE REGRESSION IN ONE LINE. Before this change both of the two cases above that produce no
	# stdout resolved to the same value, and the sweeper reported "verified complete" for both.
	st_state "a FAILED probe that also printed a partial page is still UNVERIFIABLE" "i-0abc" 255 UNVERIFIABLE "i-0abc" 255

	# ── The exit-code gate. Warning-only was the second half of the old defect. ──
	probe_reset
	if probe_gate aws "run e2e-1-1" >/dev/null 2>&1; then ok "an empty ledger does not gate"; else bad "an empty ledger does not gate" "probe_gate returned non-zero on a clean run"; fi
	probe_note_unverifiable ec2-instance "exit 255 — ExpiredToken"
	st_rc=0
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1 || st_rc=$?
	if [ "$st_rc" -eq 4 ]; then ok "an unverifiable probe gates with exit 4"; else bad "an unverifiable probe gates with exit 4" "got rc=${st_rc}"; fi
	if [ "$(probe_unverifiable_types)" = "ec2-instance " ]; then ok "the headline names the type"; else bad "the headline names the type" "got '$(probe_unverifiable_types)'"; fi

	# ── Recorded from inside a subshell. The pipeline form is what every real caller uses. ──
	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=7 ST_ERR="AuthFailure" ST_FAIL_FIRST=0
	st_out="$(probe_run ebs-volume stub | tr '\t' '\n' | grep -v '^$' || true)"
	if probe_has_unverifiable; then ok "a failure inside \$( ) and a pipe still reaches the ledger"; else bad "a failure inside \$( ) and a pipe still reaches the ledger" "ledger empty"; fi
	if [ -z "$st_out" ]; then ok "the laundered pipeline still yields no rows"; else bad "the laundered pipeline still yields no rows" "got '$st_out'"; fi

	# ── Retries. A transient failure must NOT gate; a permanent one must. The call count proves the
	#    retry actually ran rather than the assertion passing for the wrong reason. ──
	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=0 ST_ERR="throttled" ST_FAIL_FIRST=2
	st_out="$(probe_run widget stub)" || true
	if probe_has_unverifiable; then bad "two transient failures then success is CLEAN" "ledger not empty"; else ok "two transient failures then success is CLEAN"; fi
	if [ "$(st_calls)" = "3" ]; then ok "it retried exactly 3 times (counter kept in a FILE)"; else bad "it retried exactly 3 times" "counted $(st_calls)"; fi

	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=255 ST_ERR="ExpiredToken" ST_FAIL_FIRST=0
	st_out="$(probe_run widget stub)" || true
	if probe_has_unverifiable; then ok "a permanent failure gates after the retries"; else bad "a permanent failure gates after the retries" "ledger empty"; fi
	if [ "$(st_calls)" = "3" ]; then ok "a permanent failure stops at PROBE_RETRIES"; else bad "a permanent failure stops at PROBE_RETRIES" "counted $(st_calls)"; fi
	case "$(probe_unverifiable_detail)" in *ExpiredToken*) ok "the reason survives into the report" ;; *) bad "the reason survives into the report" "got '$(probe_unverifiable_detail)'" ;; esac

	# ── probe_confirm: NotFound is an answer, everything else is not. ──
	looks_gone() { printf '%s' "$1" | grep -Eqi 'NotFound|does not exist'; }
	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=254 ST_ERR="ResourceNotFoundException: no cluster" ST_FAIL_FIRST=0
	st_out="$(probe_confirm eks-cluster stub)" || true
	if probe_has_unverifiable; then bad "a NotFound confirms GONE, it is not unverifiable" "ledger not empty"; else ok "a NotFound confirms GONE, it is not unverifiable"; fi
	if [ "$(st_calls)" = "1" ]; then ok "a NotFound is not retried"; else bad "a NotFound is not retried" "counted $(st_calls)"; fi

	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=254 ST_ERR="ThrottlingException: rate exceeded" ST_FAIL_FIRST=0
	st_rc2=0
	st_out="$(probe_confirm eks-cluster stub)" || st_rc2=$?
	if probe_has_unverifiable; then ok "a throttle is UNVERIFIABLE, not 'gone'"; else bad "a throttle is UNVERIFIABLE, not 'gone'" "ledger empty"; fi
	if [ "$st_rc2" = "254" ]; then ok "probe_confirm RETURNS the failure, it does not launder it"; else bad "probe_confirm RETURNS the failure" "got rc=${st_rc2}"; fi

	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="eks-ue1-x" ST_RC=0 ST_ERR="" ST_FAIL_FIRST=0
	st_out="$(probe_confirm eks-cluster stub)" || true
	if [ "$st_out" = "eks-ue1-x" ] && ! probe_has_unverifiable; then ok "a resource that still describes is LEAKED"; else bad "a resource that still describes is LEAKED" "out='${st_out}'"; fi
	unset -f looks_gone

	rm -rf "$PROBE_ERR_DIR"
	if [ "$st_fails" -ne 0 ]; then
		echo "✗ sweep-probe.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ sweep-probe.sh self-test passed"
	exit 0
fi
