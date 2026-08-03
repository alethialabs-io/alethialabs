#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# nightly-rollup.sh — derive the 5-cloud verdict for one E2E-nightly run. PURE: no network, no gh,
# no token. Proofs directory + the run's job list in; step-summary table, per-leg verdicts, issue
# titles and issue bodies out. Every `gh issue create|edit|close` stays in e2e-nightly.yml, driven
# by what this writes. That seam is the point: all the CONTENT is testable offline, and only the
# API calls — which have no logic left in them — stay untested.
#
# WHY THIS EXISTS (#1613). Run 30341785056 provisioned aws for real and failed at `tofu plan`. The
# rollup reported it as `SKIP — gate off, no secret/var wired`, filed the red under the cloudless
# title "e2e nightly: job RED", refreshed the coverage issue to claim aws needed a var it already
# has, and appended NO ledger row. One cause under all four: every leg's state was derived from a
# hardcoded artifact DIRECTORY PATH (`proofs/e2e-proof-<p>-<run_id>/…`), and that path did not
# exist — actions/download-artifact had extracted to the root of `proofs`. Absence of a file was
# read as "this cloud was never enabled", which is the one conclusion it cannot support.
#
# So discovery here never looks at a path. It reads every provision-summary.json under the proofs
# tree and keys on the bundle's OWN `.provider`, accepting it only when `.run_tag` names THIS run
# (the tree also carries checked-in history — the aws artifact held a bundle from six days earlier).
# Gate-off legs write an explicit `outcome: skipped` summary using that same contract. Existence gets
# a SECOND, INDEPENDENT source from the run's jobs API only as a fail-closed fallback: a matrix job
# with no current-run success/failure/skip summary is FAIL, never an inferred SKIP.
#
# Usage:
#   nightly-rollup.sh                 # derive (reads the env below, writes OUT_DIR)
#   nightly-rollup.sh --self-test     # run the offline fixtures; no network, no token
#
# Env:
#   RUN_ID        (required) the workflow run id — scopes which bundles count as this run's.
#   PROOFS_DIR    (default `proofs`) root of the downloaded artifacts. Layout-agnostic.
#   JOBS_JSON     path to the run's `actions/runs/<id>/jobs` payload. Absent/unreadable ⇒ the
#                 existence cross-check degrades to summary-presence, LOUDLY (::warning::).
#   OUT_DIR       (default `$RUNNER_TEMP` or a temp dir) where the rendered artifacts land.
#   MATRIX_RESULT the `needs.provision.result` aggregate.
#   RUN_URL       link used in the issue bodies.
#   E2E_DIMENSION `full` | `floor` — which dimension this run proved, from resolve-dimension.sh.
#                 Absent ⇒ `floor`, matching that script's fail-safe default.
#
# Writes into OUT_DIR:
#   summary.md              the step-summary block (table + coverage)
#   state.env               REDS / SKIPS / JOB_NO_SUMMARY / ENABLED_N / SKIP_N / TOTAL / COV_TITLE
#                           / DIMENSION / DIMENSION_LABEL
#   issue-red-<id>.md       one body per red leg, with its title on the first `title:` line
#   issue-body-coverage.md  the standing coverage-issue body
#   ledger.tsv              provider<TAB>verdict<TAB>detail<TAB>bundle — one row per PASS/FAIL leg;
#                           explicit gate-off SKIPs are omitted. The ledger step reuses this
#                           discovery instead of repeating the join that just lost a whole run.
set -uo pipefail

# dimension_label lives in resolve-dimension.sh — ONE mapping, so the title this renders (the dedup
# key) and the row the ledger step appends can never drift apart. Sourced, not executed (#1755).
# shellcheck source=scripts/e2e/resolve-dimension.sh
. "$(dirname "${BASH_SOURCE[0]}")/resolve-dimension.sh"

PROVIDERS="hetzner aws gcp azure alibaba"
TOTAL=5

# The provision matrix's display name. Cross-checking existence means depending on it, and a rename
# would silently return us to "absence means never enabled" — so a jobs payload that contains jobs
# but NONE matching this prefix is reported as a wiring break rather than quietly believed.
PROVISION_JOB_PREFIX="${PROVISION_JOB_PREFIX:-Provision + verify + teardown}"

# ── discovery ──────────────────────────────────────────────────────────────────────────────────
# scan_summaries: every provision-summary.json under $PROOFS_DIR as
# path<TAB>provider<TAB>run_tag<TAB>outcome<TAB>verdict. Sorted so a tree with two candidate
# bundles resolves the same way twice.
scan_summaries() {
	local dir="$1" f
	[ -d "$dir" ] || return 0
	find "$dir" -type f -name provision-summary.json 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
		jq -r --arg path "$f" \
			'[$path, (.provider // ""), (.run_tag // ""), (.outcome // "unknown"), (.verdict // "")] | @tsv' \
			"$f" 2>/dev/null || true
	done
}

# summary_for <provider> <run_id> — the first bundle claiming this provider AND this run.
# `.run_tag` is written as nightly-<run_id>-<attempt> by demos/proofs/capture-proof.sh, so the
# prefix match is exact and a bundle from any other run is invisible here.
summary_for() {
	local want="$1" run_id="$2" path prov tag rest
	while IFS="$(printf '\t')" read -r path prov tag rest; do
		[ "$prov" = "$want" ] || continue
		case "$tag" in
		"nightly-${run_id}-"*) printf '%s\t%s\n' "$path" "$rest"; return 0 ;;
		esac
	done <<-EOF
		$(scan_summaries "$PROOFS_DIR")
	EOF
	return 1
}

# job_exists <provider> — did Actions create this cloud's matrix job?
# Echoes yes | no | unknown. `unknown` is deliberate and distinct from `no`: it means we could not
# ask, and the caller must NOT infer whether the gate was enabled.
job_exists() {
	local want="$1"
	[ -n "${JOBS_JSON:-}" ] && [ -r "${JOBS_JSON:-}" ] || { echo unknown; return; }
	jq -e '(.jobs // []) | length > 0' "$JOBS_JSON" >/dev/null 2>&1 || { echo unknown; return; }
	if ! jq -e --arg pre "$PROVISION_JOB_PREFIX" \
		'[(.jobs // [])[] | select(.name | startswith($pre))] | length > 0' "$JOBS_JSON" >/dev/null 2>&1; then
		echo unknown
		return
	fi
	if jq -e --arg pre "$PROVISION_JOB_PREFIX" --arg p "$want" \
		'[(.jobs // [])[] | select((.name | startswith($pre)) and (.name | endswith("(" + $p + ")")))] | length > 0' \
		"$JOBS_JSON" >/dev/null 2>&1; then
		echo yes
	else
		echo no
	fi
}

# jobs_payload_is_broken: jobs exist but none is a provision leg ⇒ the display name moved and the
# cross-check is dead. Loud, because a silent degrade here is the whole bug.
jobs_payload_is_broken() {
	[ -n "${JOBS_JSON:-}" ] && [ -r "${JOBS_JSON:-}" ] || return 1
	jq -e '(.jobs // []) | length > 0' "$JOBS_JSON" >/dev/null 2>&1 || return 1
	jq -e --arg pre "$PROVISION_JOB_PREFIX" \
		'[(.jobs // [])[] | select(.name | startswith($pre))] | length == 0' "$JOBS_JSON" >/dev/null 2>&1
}

# ── derivation ─────────────────────────────────────────────────────────────────────────────────
derive() {
	local run_id="${RUN_ID:?RUN_ID is required — it is what scopes a bundle to this run}"
	local out="${OUT_DIR:-${RUNNER_TEMP:-}}"
	[ -n "$out" ] || out="$(mktemp -d)"
	mkdir -p "$out"
	: >"$out/ledger.tsv"

	local reds="" skips="" job_no_summary="" p hit path outcome verdict detail status exists

	if jobs_payload_is_broken; then
		echo "::warning::the jobs payload has no job starting with '${PROVISION_JOB_PREFIX}' — the existence cross-check is DEAD (was the matrix job renamed?). Falling back to proof-presence, which cannot tell a red leg from an unwired one."
	fi

	{
		echo "## E2E nightly — 5-cloud verdict rollup"
		echo
		echo "matrix result: \`${MATRIX_RESULT:-unknown}\` · [run](${RUN_URL:-})"
		echo
		echo "| cloud | status | detail |"
		echo "|---|---|---|"
	} >"$out/summary.md"

	for p in $PROVIDERS; do
		hit="$(summary_for "$p" "$run_id" || true)"
		exists="$(job_exists "$p")"
		if [ -n "$hit" ]; then
			path="${hit%%	*}"
			outcome="$(jq -r '.outcome // "unknown"' "$path" 2>/dev/null || echo unknown)"
			verdict="$(jq -r '.verdict // ""' "$path" 2>/dev/null || echo "")"
			detail="${verdict:-$outcome}"
			if [ "$outcome" = "success" ]; then
				status="PASS"
				printf '%s\t%s\t%s\t%s\n' "$p" "$status" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
			elif [ "$outcome" = "skipped" ]; then
				status="SKIP"
				skips="$skips $p"
			else
				status="FAIL"
				reds="$reds $p"
				printf '%s\t%s\t%s\t%s\n' "$p" "$status" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
			fi
		elif [ "$exists" = "yes" ]; then
			# The matrix job exists but emitted no explicit success/failure/skip summary. That is a
			# failure to report, not evidence that the cloud's gate was off.
			status="FAIL"
			detail="matrix job produced no readable explicit summary"
			reds="$reds $p"
			job_no_summary="$job_no_summary $p"
			printf '%s\t%s\t%s\t%s\n' "$p" "FAIL" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
		else
			status="SKIP"
			detail="gate off — no secret/var wired"
			skips="$skips $p"
		fi
		detail="${detail//|/\\|}"
		echo "| ${p} | ${status} | ${detail} |" >>"$out/summary.md"
	done

	# A wholesale matrix failure that produced no per-leg verdict at all is still red. It is labelled
	# `(matrix)` and NOT `job`: the label lands in an issue title, the title IS the dedup key, and
	# `job` was indistinguishable from a cloud name — so every cloud's red collapsed onto one
	# nameless issue (#1601).
	local matrix_red=""
	if [ "${MATRIX_RESULT:-}" = "failure" ] && [ -z "${reds// /}" ]; then
		echo "| (matrix) | FAIL | provision matrix failed with no per-leg proof bundle |" >>"$out/summary.md"
		matrix_red="matrix"
		reds="$reds matrix"
	fi

	local skip_n enabled_n
	skip_n="$(printf '%s' "$skips" | wc -w | tr -d ' ')"
	enabled_n=$((TOTAL - skip_n))
	{
		echo
		if [ "$skip_n" -eq 0 ]; then
			echo "**Coverage: ${enabled_n}/${TOTAL} clouds enabled** — every leg is wired."
		else
			echo "**Coverage: ${enabled_n}/${TOTAL} clouds enabled** · inert (gate off):${skips}"
			echo
			echo "> An inert leg proves nothing. See \`docs/testing/e2e-nightly-enablement.md\` to wire one."
		fi
		if [ -n "${job_no_summary// /}" ]; then
			echo
			echo "> ⚠️ Matrix job left no readable explicit summary:${job_no_summary} — counted as FAIL, not as an unwired leg."
		fi
	} >>"$out/summary.md"

	# ── issue bodies. Rendered here so their CONTENT is under test; the workflow only posts them. ──
	#
	# The DIMENSION belongs in the red title because the title IS the dedup key (#1755). Keyed on the
	# cloud alone, the floor and full-bar runs collapse onto one issue that silently re-points at
	# whichever ran last: on 2026-08-02 the full bar's five apply-stage defects were deduped away
	# against the floor's ArgoCD failure and had to be filed by hand. Dedup stays PER-DIMENSION, not
	# per-run — three consecutive floor reds still land on one issue, which is the behaviour that
	# makes this a tracker rather than a firehose.
	local dim dim_label
	dim="${E2E_DIMENSION:-floor}"
	dim_label="$(dimension_label "$dim")"

	# The coverage issue deliberately gets NO dimension suffix. It reports which clouds are unwired,
	# which is a property of the repo's gate variables and identical on both crons; suffixing it would
	# orphan the open issue and file a second one every Sunday. Its matcher in e2e-nightly.yml is
	# anchored (`^e2e nightly: [0-9]+ of [0-9]+ clouds are not enabled$`) and must keep matching.
	local cov_title="e2e nightly: ${skip_n} of ${TOTAL} clouds are not enabled" s
	{
		printf '%s\n\n' "Only **${enabled_n} of ${TOTAL}** nightly legs provision anything. The rest green-skip at the gate, so the run reports success while proving nothing for them."
		printf '%s\n\n' "Run: ${RUN_URL:-}"
		printf '%s\n' "| cloud | needs |"
		printf '%s\n' "|---|---|"
		for s in $skips; do
			case "$s" in
			hetzner) printf '%s\n' "| hetzner | \`HCLOUD_TOKEN\` (repo **secret**) |" ;;
			aws) printf '%s\n' "| aws | \`E2E_AWS_ROLE_ARN\` (repo variable) — from \`infra/aws-oidc\` |" ;;
			gcp) printf '%s\n' "| gcp | \`E2E_GCP_WIF_PROVIDER\` **and** \`E2E_GCP_SA_EMAIL\` — from \`infra/gcp-e2e\` |" ;;
			azure) printf '%s\n' "| azure | \`E2E_AZURE_CLIENT_ID\`, \`E2E_AZURE_TENANT_ID\`, \`E2E_AZURE_SUBSCRIPTION_ID\`, \`ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID\` — from \`infra/azure-e2e\` |" ;;
			alibaba) printf '%s\n' "| alibaba | \`E2E_ALIBABA_ROLE_ARN\` **and** \`E2E_ALIBABA_OIDC_PROVIDER_ARN\` — from \`infra/alibaba-e2e\` |" ;;
			esac
		done
		printf '\n%s\n' "Procedure (apply the stack → dispatch that cloud alone → kill-drill → set the gate var): \`docs/testing/e2e-nightly-enablement.md\`."
		printf '%s\n' "_Auto-maintained by the e2e-nightly rollup: refreshed while legs are inert, closed automatically at ${TOTAL}/${TOTAL}._"
	} >"$out/issue-body-coverage.md"

	local cloud title
	for cloud in $reds; do
		if [ "$cloud" = "matrix" ] && [ -n "$matrix_red" ]; then
			title="e2e nightly: matrix RED (${dim_label} · no per-leg proof)"
			printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
			{
				printf '%s\n\n' "The T2 real-cloud **${dim_label}** nightly matrix went **RED** without producing a per-leg proof bundle for any cloud, so no single cloud can be named."
				printf '%s\n\n' "Run: ${RUN_URL:-}"
				printf '%s\n' "Start from the run's job list: the leg that died is the one whose job is red. A leg that ran and left no bundle usually died before the \`always()\` proof capture."
				printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title._"
			} >"$out/issue-red-${cloud}.md"
			continue
		fi
		title="e2e nightly: ${cloud} RED (${dim_label})"
		printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
		{
			printf '%s\n\n' "The T2 real-cloud nightly went **RED** for \`${cloud}\` on the **${dim_label}** dimension."
			printf '%s\n\n' "Run: ${RUN_URL:-}"
			case "$dim" in
			full) printf '%s\n\n' "The full bar runs the weekly \`17 5 * * 0\` cron with \`ALETHIA_E2E_MAX_CONFIG=1\` + \`ALETHIA_E2E_ALL_ADDONS=1\` — it provisions the whole 11-kind surface, so it fails at stages the floor never reaches. Do NOT read it as the floor re-running." ;;
			*) printf '%s\n\n' "The floor is the nightly \`17 3 * * *\` smoke — base provision + ArgoCD Healthy+Synced. It never provisions the max-config surface, so a full-bar failure is a separate issue with a separate title." ;;
			esac
			case " $job_no_summary " in
			*" $cloud "*)
				printf '%s\n\n' "This cloud's matrix job existed but produced no readable \`provision-summary.json\`, so there is no explicit PASS, FAIL, or SKIP verdict to quote. It is reported as FAIL rather than inferred to be unwired."
				;;
			esac
			printf '%s\n' "See the run's step-summary rollup + the \`e2e-proof-${cloud}-${run_id}\` artifact for the failing stage (deploy stage / cost / leak / stale sweep)."
			printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title — close it once \`${cloud}\` is green again._"
		} >"$out/issue-red-${cloud}.md"
	done

	# Shell-quoted so the workflow can `.` this file: every value here is a space-separated list or
	# a sentence, and an unquoted `SKIPS=hetzner aws gcp …` sources as a COMMAND (it ran the real
	# aws CLI the first time this was written).
	{
		echo "REDS='${reds# }'"
		echo "SKIPS='${skips# }'"
		echo "JOB_NO_SUMMARY='${job_no_summary# }'"
		echo "ENABLED_N='${enabled_n}'"
		echo "SKIP_N='${skip_n}'"
		echo "TOTAL='${TOTAL}'"
		echo "COV_TITLE='${cov_title}'"
		# Exported so the ledger step downstream consumes THIS answer instead of re-deriving the
		# dimension from the trigger a third time (#1755).
		echo "DIMENSION='${dim}'"
		echo "DIMENSION_LABEL='${dim_label}'"
	} >"$out/state.env"

	echo "coverage:${enabled_n}/${TOTAL} dimension:${dim} reds:${reds:-<none>} skips:${skips:-<none>}"
}

# ── self-test ──────────────────────────────────────────────────────────────────────────────────
# Every case below is a bug that HAPPENED or is one layout change away from happening. They run
# offline against synthetic trees: no network, no gh, no token.
write_summary() { # <dir> <provider> <run_tag> <outcome>
	mkdir -p "$1"
	cat >"$1/provision-summary.json" <<EOF
{ "provider": "$2", "run_tag": "$3", "outcome": "$4",
  "verdict": "$2: verdict for $3" }
EOF
}

write_jobs() { # <file> <provider...>
	local f="$1" p names=""
	shift
	for p in "$@"; do
		names="${names}{\"name\":\"Provision + verify + teardown (real cloud) (${p})\",\"conclusion\":\"failure\"},"
	done
	printf '{"jobs":[%s{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' "$names" >"$f"
}

run_self_test() {
	local fails=0 tmp
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }

	# Runs one derivation in an isolated dir and echoes "<reds>|<skips>|<enabled_n>".
	_derive() { # <case-dir>
		local d="$1" out="$1/out"
		rm -rf "$out"
		(
			PROOFS_DIR="$d/proofs" OUT_DIR="$out" JOBS_JSON="$d/jobs.json" \
				RUN_ID="${CASE_RUN_ID:-777}" MATRIX_RESULT="${CASE_MATRIX:-failure}" RUN_URL="http://x" \
				E2E_DIMENSION="${CASE_DIMENSION:-floor}" \
				derive >/dev/null 2>&1
		)
		# shellcheck disable=SC1091
		. "$out/state.env"
		# Generated by derive() immediately above and loaded from state.env.
		# shellcheck disable=SC2153
		printf '%s|%s|%s' "$REDS" "$SKIPS" "$ENABLED_N"
	}

	# 1. FLAT layout — the shape run 30341785056 actually produced: the bundle sits at the root of
	#    `proofs`, with no per-artifact directory. This is the case that fails on the old code.
	local c="$tmp/flat"
	write_summary "$c/proofs/2026-07-28T084732Z" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "flat layout: a red aws leg is FAIL, not SKIP (#1613)"
	# …and the detail must come from the BUNDLE, not from the ran-but-no-proof fallback. Without this
	# the job cross-check alone would satisfy the assertion above and discovery could rot unnoticed.
	_a "aws: verdict for nightly-777-1" \
		"$(sed -n 's/^| aws | FAIL | \(.*\) |$/\1/p' "$c/out/summary.md")" "flat layout: the verdict is READ FROM the bundle, not inferred"

	# 2. PER-ARTIFACT SUBDIRECTORY — the layout the old code assumed. Both must yield one answer,
	#    which is the point of not keying on the path at all.
	c="$tmp/nested"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-07-28T084732Z" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "nested layout: same verdict as flat"

	# 3. STALE HISTORY — `demos/proofs/<provider>/` is checked in, so an artifact carries older
	#    bundles (the real aws artifact held one from six days earlier). A bundle from another run
	#    must be invisible, or we would publish a stale verdict as this run's proof.
	c="$tmp/stale"
	write_summary "$c/proofs/20260722T164107Z" aws "nightly-111-1" success
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "stale bundle from another run is ignored (its PASS must not leak in)"

	# 4. RAN, NO SUMMARY — a job conclusion exists, no readable bundle. FAIL, never SKIP.
	c="$tmp/noproof"
	mkdir -p "$c/proofs"
	write_jobs "$c/jobs.json" gcp
	_a "gcp|hetzner aws azure alibaba|1" "$(_derive "$c")" "ran but left no proof ⇒ FAIL, never 'not enabled'"

	# 5. EXPLICIT GATE-OFF — the matrix jobs exist, but every leg emitted the structured SKIP
	# summary written by the workflow. Job existence must not turn those inert legs red (#1683).
	c="$tmp/gateoff"
	for p in hetzner aws gcp azure alibaba; do
		write_summary "$c/proofs/$p/gate" "$p" "nightly-777-1" skipped
	done
	write_jobs "$c/jobs.json" hetzner aws gcp azure alibaba
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" \
		"explicit gate-off summaries stay SKIP even though all matrix jobs exist (#1683)"
	_a "0" "$(wc -l <"$c/out/ledger.tsv" | tr -d ' ')" "gate-off legs do not enter the execution ledger"

	# 6. ALL LEGS OFF — nothing ran, nothing found, no red. The genuinely-inert night.
	c="$tmp/alloff"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" "no legs enabled ⇒ 0/5, no red"

	# 7. MATRIX FALLBACK — red aggregate, nothing attributable. Labelled `(matrix)`, never `job`.
	c="$tmp/matrix"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	_a "matrix|hetzner aws gcp azure alibaba|0" "$(_derive "$c")" "matrix-wide red is labelled 'matrix', not the cloud-lookalike 'job'"
	_a "e2e nightly: matrix RED (floor · no per-leg proof)" \
		"$(cat "$c/out/issue-red-matrix.title")" "matrix red title cannot be mistaken for a cloud"

	# 7b. THE SAME MATRIX RED ON THE OTHER DIMENSION IS A DIFFERENT ISSUE. Both fixtures below are
	# byte-identical apart from the dimension, so a title collision here is a real collision.
	c="$tmp/matrix-full"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	CASE_DIMENSION=full _derive "$c" >/dev/null
	_a "e2e nightly: matrix RED (full-bar · no per-leg proof)" \
		"$(cat "$c/out/issue-red-matrix.title")" "a full-bar matrix red does not collide with the floor's"

	# 8. NON-VACUITY — an all-green fixture must produce NO reds. Without this the guard could pass
	#    by finding nothing at all, which is exactly the failure it exists to catch.
	c="$tmp/green"
	local p
	for p in hetzner aws gcp azure alibaba; do write_summary "$c/proofs/$p/stamp" "$p" "nightly-777-1" success; done
	write_jobs "$c/jobs.json" hetzner aws gcp azure alibaba
	_a "||5" "$(CASE_MATRIX=success _derive "$c")" "all-green: 5/5 enabled and no red filed"

	# 9. A MIXED night, which is what a real 5-cloud run looks like once more legs are wired.
	c="$tmp/mixed"
	write_summary "$c/proofs/e2e-proof-hetzner-777/s" hetzner "nightly-777-1" skipped
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_summary "$c/proofs/e2e-proof-gcp-777/s" gcp "nightly-777-1" success
	write_summary "$c/proofs/e2e-proof-alibaba-777/s" alibaba "nightly-777-1" skipped
	write_jobs "$c/jobs.json" hetzner aws gcp azure alibaba
	_a "aws azure|hetzner alibaba|3" "$(_derive "$c")" "mixed: aws FAIL + gcp PASS + azure ran-without-proof"

	# 10. The existence cross-check DEGRADING must be loud. A renamed matrix job would otherwise put
	#    us straight back into "absence means never enabled" with nothing on screen to say so.
	c="$tmp/renamed"
	mkdir -p "$c/proofs" "$c/out"
	printf '{"jobs":[{"name":"Totally Renamed Job (aws)","conclusion":"failure"}]}\n' >"$c/jobs.json"
	local warn
	warn="$(PROOFS_DIR="$c/proofs" OUT_DIR="$c/out" JOBS_JSON="$c/jobs.json" RUN_ID=777 \
		MATRIX_RESULT=success RUN_URL=http://x derive 2>&1 | grep -c 'existence cross-check is DEAD' || true)"
	_a "1" "$warn" "a renamed provision job warns loudly instead of silently degrading"

	# 11. LEDGER rows come from the same discovery, so the parity ledger cannot lose a run the table
	#     reported. Run 30341785056 appended nothing while showing a real aws failure.
	_a "aws	FAIL	aws: verdict for nightly-777-1	e2e-proof-aws-777" \
		"$(head -1 "$tmp/flat/out/ledger.tsv")" "ledger row is emitted for the leg the table reports"

	# 12. #1755 — THE DEDUP KEY MUST SEPARATE THE TWO DIMENSIONS. The same cloud red on the floor and
	#     on the full bar has to produce two DIFFERENT titles, because the filer dedups on an exact
	#     title match. Both fixtures are identical apart from the dimension: on 2026-08-02 the floor
	#     (ArgoCD install) and the full bar (five apply-stage defects) collapsed into one issue and
	#     the full bar's had to be filed by hand.
	c="$tmp/dim-floor"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	CASE_DIMENSION=floor _derive "$c" >/dev/null
	local t_floor t_full
	t_floor="$(cat "$c/out/issue-red-aws.title")"

	c="$tmp/dim-full"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	CASE_DIMENSION=full _derive "$c" >/dev/null
	t_full="$(cat "$c/out/issue-red-aws.title")"

	_a "e2e nightly: aws RED (floor)" "$t_floor" "a floor red is titled (floor)"
	_a "e2e nightly: aws RED (full-bar)" "$t_full" "a full-bar red is titled (full-bar)"
	_a "differ" "$([ "$t_floor" != "$t_full" ] && echo differ || echo COLLIDE)" \
		"the two dimensions cannot dedup onto one issue"

	# The dimension reaches state.env so the ledger step reuses it instead of re-deriving (#1755).
	# shellcheck disable=SC1091
	. "$c/out/state.env"
	# shellcheck disable=SC2153
	_a "full" "${DIMENSION}" "state.env carries the dimension for the ledger step"

	# The COVERAGE title stays dimension-free — it reports unwired gate vars, which are identical on
	# both crons, and e2e-nightly.yml matches it with an anchored regex. A suffix here would orphan
	# the open coverage issue and file a duplicate every Sunday.
	# shellcheck disable=SC2153
	_a "e2e nightly: 4 of 5 clouds are not enabled" "${COV_TITLE}" \
		"the coverage issue title is NOT dimension-suffixed"

	if [ "$fails" -eq 0 ]; then
		echo "self-test: all passed"
		exit 0
	fi
	echo "self-test: $fails check(s) FAILED" >&2
	exit 1
}

case "${1:-}" in
--self-test) run_self_test ;;
"") derive ;;
*)
	echo "usage: nightly-rollup.sh [--self-test]" >&2
	exit 2
	;;
esac
