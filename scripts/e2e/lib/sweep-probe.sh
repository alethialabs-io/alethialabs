# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# sweep-probe.sh — four-state verification for the five e2e cloud sweepers.
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
# Every probe resolves to exactly one of FOUR states:
#
#   CLEAN           the API answered, and it listed nothing.        → exit 0
#   LEAKED          the API answered, and it listed something.      → exit 1  (caller's verify_swept)
#   UNVERIFIABLE    the API did not answer.                         → exit 4  (finalize_verification)
#   UNATTRIBUTABLE  the API answered, and the answer is that
#                   something EXISTS which by design cannot be
#                   tied to this run.                               → exit UNCHANGED, reported loudly
#
# "The API said nothing survives" and "the API did not answer" must never be the same value. That
# is the #2549/#3138 half, and it gates.
#
# ── WHY THE FOURTH STATE EXISTS, AND WHY IT MUST NOT GATE ───────────────────────────────────────
#
# #3138 shipped the third state and, correctly, made it gate. It then routed a case into it that is
# not a probe failure at all, and hetzner went permanently red for it (run 33172643012, the only
# unverifiable was `imager-upload-helpers(unlabelled, cannot attribute)`).
#
# The hcloud-talos/imager provider boots a rescue server and registers an ssh key, both named
# `hcloud-upload-image-<hex>` and NEITHER carrying a label of any kind. Both listings SUCCEED. The
# account is shared with prod, and a CONCURRENT run's live upload server matches the same pattern,
# so `report_imager_helpers` is designed to report and never delete (#2463 tracks making them
# labelable upstream, which retires the whole case).
#
# That is not "I could not look". It is "I looked, the API answered, and the answer is structurally
# ambiguous". Gating on it makes the step red on every single run, and a signal that is always red
# carries exactly as much information as one that is always green — which is the defect class
# #3138 set out to remove, arriving from the other direction.
#
# So UNATTRIBUTABLE is loud (a `::warning::` annotation, a step-summary block, its own ledger, and a
# qualifier appended to the "✓ verified complete" line so that line can never read as clean) and it
# does NOT touch the exit code.
#
# ⚠️ THE LINE BETWEEN THE TWO IS NOT "IS IT ANNOYING". It is: did the probe get an answer, and does
# this sweeper still owe an action? A missing credential, an absent CLI, a subcommand this CLI
# version does not have, a 5xx, a throttle — all UNVERIFIABLE, all gate, unchanged. A resource this
# sweeper is REQUIRED to delete but could not bind to this run is also UNVERIFIABLE: something is
# left undone. Only a resource the design says to report and never delete — where reporting IS the
# complete discharge of the contract — is UNATTRIBUTABLE.
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
# TWO ledgers, never one with a flag column. They are read by different code with different
# consequences — one decides the exit code, one decides only what is printed — and a single file
# with a marker is one careless `grep` away from collapsing them back together, which is the exact
# regression this file now tests for in both directions.
PROBE_UNATTRIB_LEDGER="${PROBE_UNATTRIB_LEDGER:-}"

# ── THE ATTESTATION AND THE RECEIPT (#4398). Both empty by default, so every existing caller —
#    the always() teardown, the out-of-band reaper's PREFLIGHT, a hand-run sweep — behaves exactly
#    as it did. They exist so a SEPARATE PROCESS can read what this one measured. ──
#
# PROBE_ATTEST_FILE is the POSITIVE marker that the cloud was asked and answered nothing. Same
# argument as probe_report_discovery's, applied to the exit code rather than to the log: a sweeper
# that exits 0 having never reached its verification is byte-identical, to its PARENT, to one that
# verified a genuinely empty account. `0` is what a DRY_RUN prints "nothing deleted, nothing
# verified" and exits with; it is also what a script exits with if someone adds an early return
# above finalize_verification. Only probe_gate writes this line, and only on the path where every
# probe answered, so its presence is a claim no absence can fake.
PROBE_ATTEST_FILE="${PROBE_ATTEST_FILE:-}"
# PROBE_VERDICT_FILE is where --record-verdict writes the JSON receipt. Written by the PARENT of a
# sweeper run, never by the sweeper itself — see the `--record-verdict` block at the bottom.
PROBE_VERDICT_FILE="${PROBE_VERDICT_FILE:-}"

# probe_reset — begin (or restart) the verification ledgers. Idempotent.
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
	# The scratch dir probe_run writes each attempt's stderr into. It must be set even when
	# PROBE_LEDGER arrived from the ENVIRONMENT — which is how the post-teardown verification hands
	# a sweeper somewhere durable to write (#4398). Left empty, probe_run's `errf` resolves to
	# `/err.<pid>`, the redirect fails, and EVERY probe records itself UNVERIFIABLE for a reason that
	# has nothing to do with the cloud: a verification that can only ever say "I could not look".
	[ -n "$PROBE_ERR_DIR" ] || PROBE_ERR_DIR="$(dirname "$PROBE_LEDGER")"
	[ -n "$PROBE_UNATTRIB_LEDGER" ] || PROBE_UNATTRIB_LEDGER="${PROBE_LEDGER}.unattributable"
	: >"$PROBE_LEDGER"
	: >"$PROBE_UNATTRIB_LEDGER"
	# A stale attestation is worse than none: it is a positive claim about a cloud this process has
	# not looked at yet. Truncated with the ledgers, at the one point that starts a run.
	[ -n "$PROBE_ATTEST_FILE" ] && : >"$PROBE_ATTEST_FILE" 2>/dev/null
	return 0
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

# ── THE FOURTH STATE. Everything below is deliberately a PARALLEL set of functions over a SECOND
#    ledger, not a parameter on the first. See the header: the two are read by different code with
#    different consequences, and the one thing that must never happen is a change that makes an API
#    failure stop gating. A shared ledger makes that a one-character mistake. ──

# probe_note_unattributable <type> <reason> — record that <type> WAS looked at, the API DID answer,
# and the answer is that something exists which by design carries nothing tying it to this run.
#
# NOT for a probe that failed — that is probe_note_unverifiable, and it gates. Use this ONLY where
# the sweeper's design says "report, never delete", so that reporting is the complete discharge of
# its contract and there is no action left undone.
probe_note_unattributable() {
	[ -n "$PROBE_UNATTRIB_LEDGER" ] || probe_reset
	printf '%s(%s)\n' "$1" "$2" >>"$PROBE_UNATTRIB_LEDGER"
}

# probe_has_unattributable — true when at least one probe answered with something unattributable.
probe_has_unattributable() {
	[ -n "$PROBE_UNATTRIB_LEDGER" ] && [ -s "$PROBE_UNATTRIB_LEDGER" ]
}

# probe_unattributable_types — the distinct resource types, space-separated (headline form).
probe_unattributable_types() {
	probe_has_unattributable || return 0
	sed -E 's/\(.*//' "$PROBE_UNATTRIB_LEDGER" | sort -u | tr '\n' ' '
}

# probe_unattributable_detail — every distinct type(reason), one per line, capped like the other.
probe_unattributable_detail() {
	probe_has_unattributable || return 0
	local total
	total="$(sort -u "$PROBE_UNATTRIB_LEDGER" | grep -c . || true)"
	sort -u "$PROBE_UNATTRIB_LEDGER" | head -n 20 | sed 's/^/      · /'
	[ "${total:-0}" -gt 20 ] && echo "      · … and $((total - 20)) more"
	return 0
}

# probe_report_unattributable <cloud> <scope> — the LOUD, NON-GATING half of the contract.
#
# `::warning::` and not `::error::`, and it always returns 0. The resource is real and a human may
# well have to remove it, but this sweeper is structurally incapable of ever resolving it, so
# failing on it would red every run forever — see the header.
#
# The word "UNATTRIBUTABLE" is in every line it emits, and never the word "clean". That is the
# reader-facing half of the contract: no log line or step-summary row for this state may be
# mistakable for a clean sweep, and the self-test asserts the word rather than assuming it.
probe_report_unattributable() {
	probe_has_unattributable || return 0
	local cloud="$1" scope="$2"
	echo "  ⚠ UNATTRIBUTABLE — looked at, the API ANSWERED, and the answer cannot be tied to this run:" >&2
	probe_unattributable_detail >&2
	echo "::warning::${cloud} sweep for ${scope} found UNATTRIBUTABLE resource(s): $(probe_unattributable_types)— they EXIST, they were deliberately NOT swept, and nothing on them ties them to this run. This is NOT a clean result and NOT a failed probe: the probe answered. It does not gate the exit code, because a state this sweeper can never resolve would red every run forever and an always-red signal carries no information. Confirm by hand." >&2
	# The step summary is where a human looks first, and "0 leaks, exit 0" with nothing beside it is
	# what they would otherwise read here.
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		{
			echo "### ⚠ ${cloud} sweep — UNATTRIBUTABLE resources"
			echo
			echo "Scope: \`${scope}\` · **not clean, not unverifiable, not gating.**"
			echo
			echo "Looked at; the API answered. These exist and by design carry nothing that ties them"
			echo "to this run, so a scope-locked sweep must not delete them."
			echo
			probe_unattributable_detail | sed -E 's/^ *· (.*)$/- `\1`/'
		} >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
	fi
	return 0
}

# probe_clean_suffix — what the caller MUST append to its "✓ … verified complete" line.
#
# Empty on a genuinely clean run, so nothing changes there. Otherwise the success sentence carries
# the finding, because "✓ cleanup verified complete — no billable resources remain" followed by
# nothing is precisely the sentence a reader converts into "the account is empty".
probe_clean_suffix() {
	probe_has_unattributable || return 0
	printf '; ⚠ ALSO PRESENT and deliberately NOT swept, because nothing ties them to this run: %s(UNATTRIBUTABLE — see the warning above)' "$(probe_unattributable_types)"
}

# probe_run <type> <cmd…> — run a cloud LIST/DESCRIBE call and resolve CLEAN / LEAKED /
# UNVERIFIABLE. It never produces UNATTRIBUTABLE: that state is a judgement about what a
# SUCCESSFUL answer means, which only the caller knows (see probe_note_unattributable).
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
	probe_confirm_re "$ptype" "$PROBE_GONE_BY_LOOKS_GONE" "$@"
}

# The sentinel that makes probe_confirm_re consult the caller's `looks_gone` instead of a regex.
# Deliberately a shape no cloud's error text can contain, so it can never be mistaken for one.
PROBE_GONE_BY_LOOKS_GONE='@@probe:looks_gone@@'

# probe_is_gone <stderr-text> <gone-regex-or-sentinel> — THE one place that decides whether an
# error means "confirmed absent" (CLEAN) or "the API did not answer" (UNVERIFIABLE).
#
# probe_confirm and probe_confirm_re were verbatim copies differing only in this test, in a file
# whose whole thesis is that this decision must live in one place. Two copies of a retry loop, a
# ledger entry and an output contract can drift independently, and the drift would be invisible
# until a cloud bills for it.
probe_is_gone() {
	if [ "$2" = "$PROBE_GONE_BY_LOOKS_GONE" ]; then
		declare -F looks_gone >/dev/null 2>&1 && looks_gone "$1"
		return
	fi
	printf '%s' "$1" | grep -Eqi -- "$2"
}

# probe_confirm_re <type> <gone-regex> <cmd…> — probe_confirm with an EXPLICIT "gone" shape,
# for a call where the caller's `looks_gone` union is wider than the answer this call can give.
#
# `looks_gone` is a union over every resource kind a sweeper touches — s3api head-bucket's `(404)`,
# sqs's `NonExistent`, the whole `NoSuch*` S3 family — and its own header already warns that "a
# shape wrongly ADDED here turns a throttle into 'gone'". Handing that union to a membership test
# widens it the same way: an `elb describe-tags` failing through a misrouted endpoint or a proxy
# answers `An error occurred (404) when calling the DescribeTags operation: Not Found`, which hits
# three alternatives, and a live billing balancer drops out of the leak list on a run that exits 0.
#
# So a caller that knows exactly which error means "gone" says so, and EVERYTHING else — including
# the other ten alternatives — stays UNVERIFIABLE. Same retry and same ledger entry as
# probe_confirm otherwise; the only difference is how narrow the CLEAN answer is.
probe_confirm_re() {
	local ptype="$1" gone_re="$2"
	shift 2
	[ -n "$PROBE_ERR_DIR" ] || probe_reset
	local out="" rc=0 attempt=1 delay="$PROBE_RETRY_DELAY" errf err why
	errf="${PROBE_ERR_DIR}/err.${BASHPID:-$$}"
	while :; do
		rc=0
		out="$("$@" 2>"$errf")" || rc=$?
		[ "$rc" -eq 0 ] && break
		err="$(cat "$errf" 2>/dev/null || true)"
		if probe_is_gone "$err" "$gone_re"; then
			return 0 # confirmed absent, by the shape this call can answer with — CLEAN
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
#
# UNATTRIBUTABLE findings are reported here too — every caller already calls probe_gate, so routing
# the report through it is what makes the fourth state reach all five clouds in one place rather
# than five copies that drift. It is reported FIRST and unconditionally: a run whose only finding is
# unattributable still has to print it, and that run returns 0 from here.
probe_gate() {
	local cloud="$1" scope="$2"
	probe_report_unattributable "$cloud" "$scope"
	if ! probe_has_unverifiable; then
		# The one place that may attest. Reached only when verify_swept already returned clean
		# (finalize_verification calls it first and returns 1 without ever getting here on a leak)
		# AND every probe answered. That conjunction is exactly "CLEAN" in this file's taxonomy.
		probe_attest "$cloud" "$scope"
		return 0
	fi
	echo "  ✗ verification INCOMPLETE — these probes could not answer:" >&2
	probe_unverifiable_detail >&2
	echo "::error::${cloud} cleanup UNVERIFIED for ${scope} — $(probe_unverifiable_types)could not be checked, so nothing here proves the account is empty. A failed probe and an empty account look identical; treat this as a possible leak and confirm by hand." >&2
	return 4
}

# probe_warn_unverifiable <cloud> <scope> — the PREFLIGHT variant. Preflight is explicitly
# best-effort and never blocks its caller, so it warns instead of gating; the always() teardown and
# the next preflight are what gate.
probe_warn_unverifiable() {
	probe_report_unattributable "$1" "$2"
	probe_has_unverifiable || return 0
	echo "::warning::${1} preflight for ${2} could not check $(probe_unverifiable_types)— the sweep is best-effort and does not block, but these were NOT verified." >&2
	probe_unverifiable_detail >&2
	return 0
}

# ── THE POSITIVE DISCOVERY MARKER — the one thing above that an ABSENCE cannot fake. ────────────
#
# probe_report_discovery <cloud> <scope> — "this preflight's orphan discovery RAN TO ITS END, and
# here is what it could not see on the way". Call it on EVERY path a preflight can leave after
# discovery, and in particular BEFORE the `[ -z "$orphans" ] → exit 0` early return.
#
# WHY A POSITIVE MARKER AND NOT JUST THE WARNING ABOVE. Every preflight ends a quiet day with
#
#     ✓ preflight: no BILLING prior-run e2e orphans in us-east-1 — nothing to sweep
#
# and that line prints in BOTH of these situations:
#
#   · discovery answered, and the answer was "nothing";
#   · discovery never answered — an expired session, a throttled tagging API, a CLI too old —
#     so the orphan list came back empty and the early return fired.
#
# Exit 0, zero warnings, byte-identical logs. scripts/e2e/reaper-result.mjs then records `clean`
# and PROGRAMME.md publishes "nothing is standing", about resources that BILL.
#
# `probe_warn_unverifiable` alone cannot close that, because a warning's ABSENCE is exactly what a
# silent failure produces, and on four of five clouds its call site sat BELOW the early return so
# it never ran at all. Only a line that must be PRESENT can: no marker in the log ⇒ discovery is
# not known to have completed ⇒ the durable result is indeterminate, never clean. Same rule as the
# rest of this file — a "nothing found" branch must not be indistinguishable from "nothing wrong" —
# applied to the preflight itself rather than to one probe.
#
# ⚠️ THE STRING IS A CONTRACT WITH A READER IN ANOTHER LANGUAGE. `summarizeReaperLog` in
# scripts/e2e/reaper-result.mjs matches this exact prefix, and its self-test sources THIS file and
# runs THIS function rather than restating the literal — so the two cannot drift apart silently.
# Changing the wording here without changing it there turns every cloud permanently indeterminate.
probe_report_discovery() {
	probe_warn_unverifiable "$1" "$2"
	printf '✓ preflight discovery reported for %s: %s\n' "$1" "$2"
}

# ── THE VERDICT RECEIPT (#4398) — carrying a CLOUD MEASUREMENT out of the job that took it. ──────
#
# scripts/e2e/nightly-rollup.sh's teardown_outcome() asked the GitHub Actions jobs API whether the
# `Guaranteed teardown` STEP reported a conclusion, and mapped every non-empty conclusion to `done`.
# That is not a measurement of the cloud, and it cannot become one: a step conclusion is a boolean
# with a fourth state (missing), and this file's whole thesis is that
#
#     CLEAN (we asked, nothing is there)  and  UNVERIFIABLE (we could not ask)
#
# must never be the same value. Collapsed into `success`/`failure` they are, in BOTH directions —
# a sweeper that exits 4 because a credential expired reads `failure`, exactly like a leak, and the
# rollup called both of them `done`, i.e. "swept".
#
# So the verdict travels as DATA. The exit status of a sweeper's `finalize_verification` is already
# three-valued and already tested (0 clean · 1 leak · 4 unverifiable); the receipt is that status
# plus the two ledgers plus the attestation, written as JSON that another job can download and read.
#
# ⚠️ THE DEFAULT DIRECTION IS UNVERIFIABLE, AND THAT IS THE WHOLE DESIGN. Only the literal exit 0
# WITH an attestation is CLEAN. A timeout (124), a kill (137/143), a scope refusal (2), a missing
# interpreter (126/127), an exit 0 from some path that never verified — every one of them is
# "nothing here proves the account is empty", which is UNVERIFIABLE, never clean. An error reported
# as absence is precisely how this repo has been bitten before.

# probe_attest <cloud> <scope> — record the positive marker. No-op when PROBE_ATTEST_FILE is unset,
# which is every caller that does not want a receipt. Never fails the caller: an unwritable path
# yields no marker, which resolves to UNVERIFIABLE — the safe direction.
probe_attest() {
	[ -n "$PROBE_ATTEST_FILE" ] || return 0
	printf 'CLEAN\t%s\t%s\t%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		>>"$PROBE_ATTEST_FILE" 2>/dev/null || true
	return 0
}

# probe_has_attestation — did the sweep this receipt is about reach probe_gate's clean path?
probe_has_attestation() {
	[ -n "$PROBE_ATTEST_FILE" ] && [ -s "$PROBE_ATTEST_FILE" ]
}

# probe_verdict_from_rc <rc> — the sweeper's exit status as one of the three reportable states.
#
# Echoes `<verdict>\t<reason>`. Separated from probe_write_verdict so the mapping — the part a
# mutation must be able to red — is testable on its own, with no filesystem and no jq.
probe_verdict_from_rc() {
	case "${1:-}" in
	0)
		if probe_has_attestation; then
			printf 'CLEAN\tthe cloud was re-listed after the sweep and listed nothing for this run\n'
		else
			# Exit 0 is the ONE status a caller is tempted to read as "fine". It is not, on its own:
			# every early return in these sweepers (DRY_RUN, PREFLIGHT with nothing to do, a guard
			# that decided there was nothing to do) also exits 0 without ever asking the cloud.
			printf 'UNVERIFIABLE\tthe sweeper exited 0 WITHOUT reaching its verification (no attestation) — an early return, not an empty account\n'
		fi
		;;
	1) printf 'RESIDUAL\tthe cloud was re-listed after the sweep and STILL LISTS billable resources for this run\n' ;;
	4) printf 'UNVERIFIABLE\tat least one probe did not answer, so nothing here proves the account is empty\n' ;;
	124 | 125) printf 'UNVERIFIABLE\tthe verification pass hit its wall-clock budget and was cut off — it did not finish asking\n' ;;
	130 | 137 | 143) printf 'UNVERIFIABLE\tthe verification pass was KILLED (exit %s) before it could answer\n' "$1" ;;
	*) printf 'UNVERIFIABLE\tthe sweeper exited %s, which is not a verification verdict — it did not get to ask\n' "${1:-<none>}" ;;
	esac
}

# probe_write_verdict <cloud> <run-tag> <scope> <rc> — render the receipt to $PROBE_VERDICT_FILE.
#
# `run_tag` is carried IN THE PAYLOAD and not in the path, for the reason nightly-rollup.sh's header
# gives at length (#1613): the rollup keys on what a bundle SAYS it is, never on where the artifact
# downloader happened to put it.
probe_write_verdict() {
	local cloud="$1" run_tag="$2" scope="$3" rc="$4" verdict reason pair rc_json
	[ -n "$PROBE_VERDICT_FILE" ] || {
		echo "probe_write_verdict: PROBE_VERDICT_FILE is unset — refusing to write a receipt nowhere" >&2
		return 2
	}
	pair="$(probe_verdict_from_rc "$rc")"
	# `cut` with its default TAB delimiter, not a literal tab inside a parameter expansion: an editor
	# that retabs this file would silently turn that into a no-op split, and a silently wrong split
	# is the class of defect this whole file exists to remove.
	verdict="$(printf '%s' "$pair" | cut -f1)"
	reason="$(printf '%s' "$pair" | cut -f2-)"
	# A non-numeric status cannot enter the JSON as a number. `null` is honest — the verdict above
	# has already read it as "not a verification verdict" — and it keeps jq from failing the receipt.
	case "$rc" in
	'' | *[!0-9]*) rc_json=null ;;
	*) rc_json="$rc" ;;
	esac
	mkdir -p "$(dirname "$PROBE_VERDICT_FILE")" 2>/dev/null || true
	jq -n \
		--arg cloud "$cloud" --arg run_tag "$run_tag" --arg scope "$scope" \
		--arg verdict "$verdict" --arg reason "$reason" \
		--argjson exit_code "$rc_json" \
		--arg unver "$(probe_unverifiable_types)" --arg unattr "$(probe_unattributable_types)" \
		--arg detail "$(probe_unverifiable_detail | sed -E 's/^ *· //')" \
		--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{schema: "alethia.e2e.teardown-verify/1",
		  provider: $cloud, run_tag: $run_tag, scope: $scope,
		  verdict: $verdict, reason: $reason, exit_code: $exit_code,
		  unverifiable: ($unver | split(" ") | map(select(length > 0))),
		  unattributable: ($unattr | split(" ") | map(select(length > 0))),
		  unverifiable_detail: ($detail | split("\n") | map(select(length > 0))),
		  measured_at: $at}' >"$PROBE_VERDICT_FILE" || return 1
	printf '✓ teardown verification receipt for %s: %s (exit %s) → %s\n' \
		"$cloud" "$verdict" "$rc" "$PROBE_VERDICT_FILE"
}

# ── `--record-verdict` — the PARENT-side entry point (#4398). ───────────────────────────────────
#
#   PROBE_LEDGER=… PROBE_UNATTRIB_LEDGER=… PROBE_ATTEST_FILE=… PROBE_VERDICT_FILE=… \
#     bash scripts/e2e/lib/sweep-probe.sh --record-verdict <cloud> <run-tag> <scope> <exit-code>
#
# It runs in the process that INVOKED a sweeper, after that sweeper exited, and reads the three
# files the sweeper wrote through the env paths the parent handed it. That indirection is the whole
# reason the ledgers were files in the first place (see the header): a sweeper's shell variables die
# with it, and every one of its probes runs in a subshell anyway.
#
# It deliberately does NOT call probe_reset — that truncates the very evidence it is here to read.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--record-verdict" ]; then
	set -uo pipefail
	if [ "$#" -ne 5 ]; then
		echo "usage: sweep-probe.sh --record-verdict <cloud> <run-tag> <scope> <exit-code>" >&2
		exit 2
	fi
	probe_write_verdict "$2" "$3" "$4" "$5"
	exit "$?"
fi

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
	# Explicit gone regexes must both confirm immediately and retry non-matching failures.
	probe_reset; : >"$PROBE_CALLS"
	ST_OUT="" ST_RC=255 ST_ERR="LoadBalancerNotFound" ST_FAIL_FIRST=0
	st_rc=0; probe_confirm_re load-balancer 'LoadBalancerNotFound' stub >/dev/null || st_rc=$?
	if [ "$st_rc" -eq 0 ] && ! probe_has_unverifiable && [ "$(st_calls)" -eq 1 ]; then ok "explicit gone regex confirms on the first matching attempt"; else bad "explicit gone regex confirms on the first matching attempt" "rc=$st_rc calls=$(st_calls)"; fi
	probe_reset; : >"$PROBE_CALLS"
	ST_OUT="ok" ST_RC=0 ST_ERR="transient" ST_FAIL_FIRST=1
	st_rc=0; probe_confirm_re widget 'LoadBalancerNotFound' stub >/dev/null || st_rc=$?
	if [ "$st_rc" -eq 0 ] && [ "$(st_calls)" -eq 2 ]; then ok "non-matching explicit regex retries and records no false gone"; else bad "non-matching explicit regex retries and records no false gone" "rc=$st_rc calls=$(st_calls)"; fi

	# ── The exit-code gate. Warning-only was the second half of the old defect. ──
	probe_reset
	if probe_gate aws "run e2e-1-1" >/dev/null 2>&1; then ok "an empty ledger does not gate"; else bad "an empty ledger does not gate" "probe_gate returned non-zero on a clean run"; fi
	probe_note_unverifiable ec2-instance "exit 255 — ExpiredToken"
	st_rc=0
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1 || st_rc=$?
	if [ "$st_rc" -eq 4 ]; then ok "an unverifiable probe gates with exit 4"; else bad "an unverifiable probe gates with exit 4" "got rc=${st_rc}"; fi
	if [ "$(probe_unverifiable_types)" = "ec2-instance " ]; then ok "the headline names the type"; else bad "the headline names the type" "got '$(probe_unverifiable_types)'"; fi

	# ── THE FOURTH STATE, and the two directions it can be broken in. ─────────────────────────────
	#
	# #3138 gave UNVERIFIABLE the exit code, correctly. It then routed hcloud's imager upload helpers
	# into it — a case where BOTH listings SUCCEED and the answer is simply that an unlabelled
	# resource exists which no selector can attribute — and hetzner went permanently red for it.
	#
	# These cases pin the boundary from BOTH sides, because one assertion alone is satisfiable by
	# the wrong fix. "Unattributable does not gate" passes if UNVERIFIABLE stops gating too, which
	# reinstates the original defect wholesale; "a failed API gates" passes if everything gates,
	# which is the regression being fixed here. Each direction has to be able to go red alone.

	# DIRECTION 1 — collapsing UNATTRIBUTABLE back into UNVERIFIABLE must fail. If
	# probe_note_unattributable is ever made an alias of probe_note_unverifiable, or the ledgers are
	# merged, probe_gate returns 4 here and this reds.
	probe_reset
	probe_note_unattributable imager-upload-helpers "unlabelled, cannot attribute"
	st_rc=0
	probe_gate hcloud "cluster=alethia-nl-1-1" >/dev/null 2>&1 || st_rc=$?
	if [ "$st_rc" -eq 0 ]; then ok "an UNATTRIBUTABLE finding does NOT gate the exit code"; else bad "an UNATTRIBUTABLE finding does NOT gate the exit code" "probe_gate returned ${st_rc} — the two states have been collapsed"; fi
	if probe_has_unattributable; then ok "it is recorded — reported, not swallowed"; else bad "it is recorded" "the unattributable ledger is empty"; fi
	if probe_has_unverifiable; then bad "it does NOT land in the UNVERIFIABLE ledger" "it did — the ledgers are shared"; else ok "it does NOT land in the UNVERIFIABLE ledger"; fi
	if [ "$(probe_unattributable_types)" = "imager-upload-helpers " ]; then ok "the headline names the unattributable type"; else bad "the headline names the unattributable type" "got '$(probe_unattributable_types)'"; fi

	# DIRECTION 2 — routing a genuine API failure into UNATTRIBUTABLE must fail. If someone "fixes"
	# a noisy red by calling probe_note_unattributable from probe_run, or by making probe_run's
	# failure path non-gating, this reds: the ledger split AND the exit code are both asserted.
	probe_reset
	: >"$PROBE_CALLS"
	ST_OUT="" ST_RC=255 ST_ERR="ExpiredToken" ST_FAIL_FIRST=0
	st_out="$(probe_run widget stub)" || true
	if probe_has_unverifiable; then ok "a FAILED API call is still UNVERIFIABLE"; else bad "a FAILED API call is still UNVERIFIABLE" "the unverifiable ledger is empty"; fi
	if probe_has_unattributable; then bad "a FAILED API call is NOT unattributable" "it was routed into the non-gating ledger — a dead credential would now exit 0"; else ok "a FAILED API call is NOT unattributable"; fi
	st_rc=0
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1 || st_rc=$?
	if [ "$st_rc" -eq 4 ]; then ok "and it still gates with exit 4 (#3138 unweakened)"; else bad "and it still gates with exit 4" "got rc=${st_rc}"; fi

	# BOTH AT ONCE. The gating state wins the exit code and the other is still printed — a real
	# failure must never be hidden by a finding that does not gate, and vice versa.
	probe_reset
	probe_note_unattributable imager-upload-helpers "unlabelled, cannot attribute"
	probe_note_unverifiable dns-zones "exit 1 — hcloud zone list unavailable"
	st_rc=0
	st_out="$(probe_gate hcloud "cluster=x" 2>&1)" || st_rc=$?
	if [ "$st_rc" -eq 4 ]; then ok "unverifiable + unattributable together still exit 4"; else bad "unverifiable + unattributable together still exit 4" "got rc=${st_rc}"; fi
	case "$st_out" in *imager-upload-helpers*) ok "…and the unattributable finding is still printed" ;; *) bad "…and the unattributable finding is still printed" "not in output" ;; esac
	case "$st_out" in *dns-zones*) ok "…and so is the unverifiable one" ;; *) bad "…and so is the unverifiable one" "not in output" ;; esac

	# THE READER-FACING HALF. A human reads two things: the annotation and the ✓ line. Neither may
	# be mistakable for a clean sweep, so the word is asserted rather than assumed.
	probe_reset
	probe_note_unattributable imager-upload-helpers "unlabelled, cannot attribute"
	st_out="$(probe_report_unattributable hcloud "cluster=x" 2>&1)"
	case "$st_out" in *UNATTRIBUTABLE*) ok "the annotation says UNATTRIBUTABLE out loud" ;; *) bad "the annotation says UNATTRIBUTABLE out loud" "got '${st_out}'" ;; esac
	case "$st_out" in *"::warning::"*) ok "it is a warning annotation, so it surfaces in the Actions UI" ;; *) bad "it is a warning annotation" "no ::warning:: in '${st_out}'" ;; esac
	case "$st_out" in *"::error::"*) bad "it is NOT an error annotation" "an ::error:: would red the step it is not allowed to red" ;; *) ok "it is NOT an error annotation" ;; esac
	st_out="$(probe_clean_suffix)"
	case "$st_out" in *UNATTRIBUTABLE*imager-upload-helpers*|*imager-upload-helpers*UNATTRIBUTABLE*) ok "the ✓ line carries the finding, so it cannot read as clean" ;; *) bad "the ✓ line carries the finding" "got '${st_out}'" ;; esac
	probe_reset
	if [ -z "$(probe_clean_suffix)" ]; then ok "a genuinely clean run appends nothing"; else bad "a genuinely clean run appends nothing" "got '$(probe_clean_suffix)'"; fi

	# The step-summary block. It is the row a human reads first, and "exit 0" beside nothing is what
	# they would otherwise read.
	probe_reset
	probe_note_unattributable imager-upload-helpers "unlabelled, cannot attribute"
	GITHUB_STEP_SUMMARY="${PROBE_ERR_DIR}/summary"
	: >"$GITHUB_STEP_SUMMARY"
	probe_report_unattributable hcloud "cluster=x" >/dev/null 2>&1
	if grep -q 'UNATTRIBUTABLE' "$GITHUB_STEP_SUMMARY" && grep -q 'imager-upload-helpers' "$GITHUB_STEP_SUMMARY"; then
		ok "the step summary names the state and the type"
	else
		bad "the step summary names the state and the type" "got '$(cat "$GITHUB_STEP_SUMMARY")'"
	fi
	unset GITHUB_STEP_SUMMARY

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

	# ── THE POSITIVE DISCOVERY MARKER. Both directions, and on the RIGHT STREAM. ──
	#
	# The marker must be on STDOUT: probe_warn_unverifiable writes to stderr, and if the marker
	# went there too then folding them with 2>&1 here would let a caller emit only the warning and
	# still look correct. It must also print when discovery SUCCEEDED — that is the whole point,
	# since a silent failure is defined by the absence of a warning.
	probe_reset
	st_out="$(probe_report_discovery aws "the preflight orphan scan in us-east-1" 2>/dev/null)"
	case "$st_out" in
	"✓ preflight discovery reported for aws: the preflight orphan scan in us-east-1") ok "a clean discovery still emits the marker, on STDOUT" ;;
	*) bad "a clean discovery still emits the marker, on STDOUT" "got '${st_out}'" ;;
	esac
	probe_reset
	probe_note_unverifiable orphan-scan "exit 255 — ExpiredToken"
	st_rc=0
	st_out="$(probe_report_discovery aws "the preflight orphan scan in us-east-1" 2>/dev/null)" || st_rc=$?
	case "$st_out" in
	"✓ preflight discovery reported for aws:"*) ok "a FAILED discovery still emits the marker (it reports, it does not vanish)" ;;
	*) bad "a FAILED discovery still emits the marker" "got '${st_out}'" ;;
	esac
	st_out="$(probe_report_discovery aws "the preflight orphan scan in us-east-1" 2>&1 >/dev/null)"
	case "$st_out" in
	*"preflight for the preflight orphan scan in us-east-1 could not check"*) ok "…and the unverifiable warning travels with it" ;;
	*) bad "…and the unverifiable warning travels with it" "got '${st_out}'" ;;
	esac
	if [ "$st_rc" -eq 0 ]; then ok "reporting discovery never gates — preflight does not block its caller"; else bad "reporting discovery never gates" "got rc=${st_rc}"; fi

	# ── THE VERDICT RECEIPT (#4398). ────────────────────────────────────────────────────────────
	#
	# The property under test is one sentence: an exit status that is not a verification verdict
	# must never render as CLEAN. Every case below is a way of NOT having asked the cloud, and every
	# one of them has to come out UNVERIFIABLE — because the consumer of this receipt is a rollup
	# that will otherwise publish "nothing is standing" about an account nobody looked at.
	PROBE_ATTEST_FILE="${PROBE_ERR_DIR}/attest"
	PROBE_VERDICT_FILE="${PROBE_ERR_DIR}/verdict.json"

	st_verdict() { printf '%s' "$(probe_verdict_from_rc "$1")" | cut -f1; }
	st_case() { # <name> <rc> <expected verdict>
		local got
		got="$(st_verdict "$2")"
		if [ "$got" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got ${got}"; fi
	}

	# An exit 0 with NO attestation. This is the DRY_RUN shape — "nothing deleted, nothing verified",
	# exit 0 — and every other early return above finalize_verification. It is the single most
	# dangerous input this function takes, because 0 is what a caller reads as "fine".
	probe_reset
	st_case "exit 0 with NO attestation is UNVERIFIABLE, never CLEAN" 0 UNVERIFIABLE

	# …and with one, from the ONLY thing allowed to write it.
	probe_reset
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1
	if probe_has_attestation; then ok "probe_gate's clean path writes the attestation"; else bad "probe_gate's clean path writes the attestation" "no marker in $PROBE_ATTEST_FILE"; fi
	st_case "exit 0 WITH an attestation is CLEAN" 0 CLEAN

	# The gating state must also withhold the attestation — otherwise a run with a dead credential
	# could exit 0 from somewhere and still read clean. Both halves, or neither means anything.
	probe_reset
	probe_note_unverifiable ec2-instance "exit 255 — ExpiredToken"
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1 || true
	if probe_has_attestation; then bad "an unverifiable probe withholds the attestation" "probe_gate attested over a failed probe"; else ok "an unverifiable probe withholds the attestation"; fi
	st_case "…so its exit 4 is UNVERIFIABLE" 4 UNVERIFIABLE

	# A stale marker is a positive claim about a cloud this process has not looked at.
	probe_reset
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1
	probe_reset
	if probe_has_attestation; then bad "probe_reset clears a stale attestation" "the previous run's marker survived"; else ok "probe_reset clears a stale attestation"; fi

	# The leak. RESIDUAL is its own word: it is not "we could not look", and it is not clean.
	probe_reset
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1
	st_case "exit 1 is RESIDUAL — the API answered and something is still standing" 1 RESIDUAL
	# ⚠️ and it must NOT be reachable from the attestation. A leak returns before probe_gate.
	st_case "a timeout (124) is UNVERIFIABLE even with an attestation present" 124 UNVERIFIABLE
	st_case "a kill (137) is UNVERIFIABLE" 137 UNVERIFIABLE
	st_case "a scope refusal (2) is UNVERIFIABLE" 2 UNVERIFIABLE
	st_case "a missing interpreter (127) is UNVERIFIABLE" 127 UNVERIFIABLE

	# The rendered receipt. The consumer is nightly-rollup.sh in another JOB, so what is asserted is
	# the PAYLOAD, not a log line: provider and run_tag are what it keys on (never the path, #1613),
	# and the ledger has to survive into the receipt or the detail is lost at the job boundary.
	probe_reset
	probe_note_unverifiable ec2-instance "exit 255 — ExpiredToken"
	probe_note_unattributable imager-upload-helpers "unlabelled, cannot attribute"
	probe_write_verdict aws "nightly-777-1" "run 777-1" 4 >/dev/null 2>&1
	st_out="$(jq -r '[.provider, .run_tag, .verdict, (.exit_code|tostring), (.unverifiable|join(",")), (.unattributable|join(","))] | join("|")' "$PROBE_VERDICT_FILE" 2>/dev/null || echo BROKEN)"
	if [ "$st_out" = "aws|nightly-777-1|UNVERIFIABLE|4|ec2-instance|imager-upload-helpers" ]; then
		ok "the receipt carries provider, run_tag, verdict, exit code and BOTH ledgers"
	else
		bad "the receipt carries provider, run_tag, verdict, exit code and BOTH ledgers" "got '${st_out}'"
	fi
	case "$(jq -r '.unverifiable_detail | join(" ")' "$PROBE_VERDICT_FILE" 2>/dev/null)" in
	*ExpiredToken*) ok "…and the REASON, so the next reader does not have to open the run's logs" ;;
	*) bad "…and the REASON" "got '$(jq -r '.unverifiable_detail|join(" ")' "$PROBE_VERDICT_FILE" 2>/dev/null)'" ;;
	esac

	# THE DISTINCTION, end to end, from two runs that differ in NOTHING a log could show: same
	# empty resource list, same silence, different verdict.
	probe_reset
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1
	probe_write_verdict aws "nightly-777-1" "run 777-1" 0 >/dev/null 2>&1
	st_out="$(jq -r .verdict "$PROBE_VERDICT_FILE" 2>/dev/null)"
	probe_reset
	probe_note_unverifiable orphan-scan "exit 255 — ExpiredToken"
	probe_gate aws "run e2e-1-1" >/dev/null 2>&1 || true
	probe_write_verdict aws "nightly-777-1" "run 777-1" 4 >/dev/null 2>&1
	st_out2="$(jq -r .verdict "$PROBE_VERDICT_FILE" 2>/dev/null)"
	if [ "$st_out" = "CLEAN" ] && [ "$st_out2" = "UNVERIFIABLE" ]; then
		ok "an empty account and an unaskable one produce DIFFERENT receipts"
	else
		bad "an empty account and an unaskable one produce DIFFERENT receipts" "got '${st_out}' and '${st_out2}'"
	fi

	# AN EXTERNALLY-SUPPLIED LEDGER PATH MUST STILL LEAVE THE PROBES ABLE TO RUN. The verification
	# step hands these paths in through the environment so the receipt survives the sweeper's exit;
	# before #4398 that left PROBE_ERR_DIR empty, probe_run's stderr redirect resolved to
	# `/err.<pid>`, and every probe failed to execute at all — reporting UNVERIFIABLE about a cloud
	# it never called. A probe that cannot run is the loudest possible false negative.
	# Run in a FRESH bash, not a subshell: the condition under test is PROBE_ERR_DIR being genuinely
	# absent from the environment, which is how the workflow invokes a sweeper. Unsetting it in a
	# subshell of this script would also be a local modification shellcheck rightly complains about,
	# and it would leave the assertion depending on this file's own state rather than on the env.
	st_ext="$(mktemp -d "${TMPDIR:-/tmp}/alethia-probe-ext.XXXXXX")"
	if PROBE_LEDGER="$st_ext/ledger" PROBE_UNATTRIB_LEDGER="$st_ext/unattr" \
		bash -c '
			. "$1"
			probe_reset
			ext_stub() { printf "i-0abc\n"; }
			out="$(probe_run widget ext_stub)" || exit 9
			[ "$out" = "i-0abc" ] || exit 9
			probe_has_unverifiable && exit 9
			exit 0
		' _ "${BASH_SOURCE[0]}" 2>/dev/null; then
		ok "an env-supplied PROBE_LEDGER still leaves probes runnable (PROBE_ERR_DIR derived)"
	else
		bad "an env-supplied PROBE_LEDGER still leaves probes runnable" "probe_run could not execute, or recorded a false UNVERIFIABLE"
	fi
	rm -rf "$st_ext"

	# A receipt with nowhere to go is refused rather than silently skipped: the caller asked for a
	# measurement to be carried and it would not have been.
	probe_reset
	st_rc=0
	PROBE_VERDICT_FILE="" probe_write_verdict aws "nightly-777-1" "run 777-1" 0 >/dev/null 2>&1 || st_rc=$?
	if [ "$st_rc" -ne 0 ]; then ok "an unset PROBE_VERDICT_FILE is an error, not a quiet no-op"; else bad "an unset PROBE_VERDICT_FILE is an error" "returned 0"; fi

	rm -rf "$PROBE_ERR_DIR"
	if [ "$st_fails" -ne 0 ]; then
		echo "✗ sweep-probe.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ sweep-probe.sh self-test passed"
	exit 0
fi
