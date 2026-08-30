#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Decide whether ONE proof bundle is strong enough to promote the cell it claims.
#
# WHY THIS EXISTS (#3281). `PROGRAMME.md` promotes a cell when the ledger's surviving claim is PASS
# and its bundle is a committed path that exists. Neither of those looks INSIDE the bundle. So a
# hetzner/addons run that drove 22 ArgoCD Applications to Healthy+Synced shipped a bundle recording
#
#     argocd_assert_outcome  unmeasured
#     argocd_healthy_synced  null
#
# and the cell went green on a line in a job log that expires. capture-proof.sh printed a WARNING at
# the time and nothing read it — which is the actual defect: a warning nobody is required to act on
# is indistinguishable from silence.
#
# THE RULE. For the dimensions whose CLAIM IS the ArgoCD convergence, an unmeasured bundle is a proof
# of nothing and must be refused. For the dimensions where convergence is a supporting fact, it is a
# warning, because refusing there would throw away real evidence over a missing nicety.
#
# WHAT THIS DELIBERATELY DOES NOT DO. It never deletes, edits or fails a CAPTURE. A failing run's
# bundle is the evidence of the failure and must always survive — the gate belongs at the moment a
# bundle is used to CLAIM something (scripts/e2e/commit-proof.sh), not at the moment it is written.
#
# Usage: check-proof-integrity.sh <bundle-dir> [--dimension <d>]
#        check-proof-integrity.sh --self-test
#
# Exit: 0 = may be promoted · 1 = REFUSED · 3 = indeterminate (no dimension to judge against)
set -euo pipefail

# EVERY dimension is classified, and a dimension in NEITHER list is indeterminate rather than a
# pass. That is the point: a new dimension must be placed deliberately, because the alternative —
# an unclassified dimension silently taking the lenient branch — is the same shape as the defect
# this script exists for. The self-test cross-checks both lists against the one deriver that owns
# the dimension vocabulary, scripts/e2e/resolve-dimension.sh.
#
# CLAIM: the cell's verdict IS the ArgoCD convergence. What it asserts is that a derived set of
# Applications reached Healthy+Synced, so a bundle that cannot say how many did has recorded no
# claim at all. (`byo` is the legacy alias of `gitops` and resolves to itself, so it is listed.)
ARGO_CLAIM_DIMENSIONS="addons maxconfig full gitops byo"
# SUPPORTING: the cell asserts something else and merely converges on the way. Missing counts are
# a warning here; refusing would throw away real evidence over a missing nicety.
#
# `cli-demo` is here, not above, and the placement is a decision rather than a default. What that
# cell claims is that the product was PROVISIONED THROUGH THE REAL BINARY — the actor, not the
# surface area — on a deliberately floor-shaped cluster. Its ArgoCD convergence is the same
# convergence `floor` already proves; refusing the bundle for want of counts would withhold the
# only evidence that the CLI drove anything.
ARGO_SUPPORTING_DIMENSIONS="floor byo-iac day2 cli-demo"

_integrity_verdict() { # _integrity_verdict <bundle-dir> <dimension>  → prints reason; returns 0/1/3
	local dir="$1" dim="$2" outcome assert healthy plan_short plan_full
	if [ ! -f "$dir/provision-summary.json" ]; then
		echo "no provision-summary.json in $dir — this is not a proof bundle"
		return 3
	fi
	outcome="$(jq -r '.outcome // "unknown"' "$dir/provision-summary.json")"
	assert="$(jq -r '.argocd_assert_outcome // "unmeasured"' "$dir/provision-summary.json")"
	healthy="$(jq -r '.argocd_healthy_synced_asserted // "null"' "$dir/provision-summary.json")"

	if [ -z "$dim" ] || [ "$dim" = "null" ]; then
		# NOT a pass. A check that cannot tell which claim it is judging must say so, or it
		# reports green on everything it failed to look at.
		echo "the bundle records no dimension and none was given — cannot judge; pass --dimension <d>"
		return 3
	fi

	# A failing run's bundle is evidence OF THE FAILURE. It is never refused: there is no claim to
	# protect, and refusing would delete the only record of what went wrong.
	if [ "$outcome" != "success" ]; then
		echo "outcome=$outcome — a non-success bundle records a failure, not a claim; nothing required"
		return 0
	fi

	# ── THE SIGNED RECEIPT MUST COVER THE PLAN THIS BUNDLE REPORTS. ───────────────────────────
	#
	# Same shape as #3281, one artifact over: capture-proof.sh pins the receipt by asking the DB
	# for the DEPLOY job whose receipt matches the plan the runner log named
	# (`LIKE '$receipt_plan_sha%'`), and when no job matches it FALLS BACK to the earliest
	# receipt-bearing job and prints
	#
	#     ::warning::… no DEPLOY job carries a receipt for plan <sha>; fell back … The committed
	#     receipt may not cover the plan this bundle reports.
	#
	# Nothing was required to act on that warning, so the bundle ships anyway: VERDICT.txt reads
	# `receipt: signed=true sha256=710ebacbbecc` while receipt.json attests
	# `plan_sha256: 7b60f65b1578fe55…`. MEASURED on azure/20260830T005214Z (#3426) and
	# aws/20260828T125612Z — 2 of 22 bundles on dev. A warning nobody must act on is
	# indistinguishable from silence; that sentence is already in this file's header, and this is
	# the second artifact it applies to.
	#
	# `signed=true` next to a hash the receipt does not carry is the worst of both: it reads as
	# cryptographic attestation of THIS plan while attesting a different one.
	#
	# PREFIX, NOT EQUALITY. The runner logs a short hash and the receipt carries the full 64; the
	# capture's own SQL already compares them that way, so this asks the identical question rather
	# than a new one.
	#
	# ONLY WHEN BOTH ARE PRESENT. An unsigned run, or one whose bundle carries no receipt, is a
	# different state and is not this check's business — silence about a value that is absent is
	# correct, and newly failing on absence would refuse bundles this defect never touched.
	if [ -f "$dir/receipt.json" ]; then
		plan_short="$(jq -r '.receipt_plan_sha256 // ""' "$dir/provision-summary.json")"
		plan_full="$(jq -r '.receipt.plan_sha256 // ""' "$dir/receipt.json")"
		if [ -n "$plan_short" ] && [ -n "$plan_full" ] && [ "${plan_full#"$plan_short"}" = "$plan_full" ]; then
			echo "the committed receipt does not cover the plan this bundle reports: provision-summary.json
  says receipt_plan_sha256=$plan_short but receipt.json attests plan_sha256=$plan_full.
  So \`signed=true\` here attests a DIFFERENT plan than the one the cell is claiming. capture-proof.sh
  warned about exactly this at capture time and nothing was required to act on it (#3426).
  Re-capture from the run whose DEPLOY job carries the receipt for $plan_short, rather than promoting
  a bundle whose signature and whose claim are about two different plans."
			return 1
		fi
	fi

	case " $ARGO_CLAIM_DIMENSIONS " in
		*" $dim "*) ;;
		*)
			case " $ARGO_SUPPORTING_DIMENSIONS " in
				*" $dim "*)
					echo "dimension=$dim — ArgoCD convergence is a supporting fact here, not the claim (assert=$assert)"
					return 0 ;;
			esac
			# Fail CLOSED on an unknown dimension. Taking the lenient branch for anything
			# unrecognised is how a new dimension would inherit "no counts needed" without anyone
			# deciding that.
			echo "dimension=$dim is classified NEITHER as an ArgoCD-claim dimension nor as a supporting one — add it to one of the two lists in this script rather than letting it inherit the lenient branch"
			return 3 ;;
	esac

	if [ "$assert" = "converged" ] && printf '%s' "$healthy" | grep -qE '^[0-9]+$'; then
		echo "dimension=$dim — $healthy Applications measured Healthy+Synced"
		return 0
	fi
	echo "dimension=$dim claims an ArgoCD convergence, but the bundle records argocd_assert_outcome=$assert and argocd_healthy_synced_asserted=$healthy.
  The run may well have converged — but this artifact cannot say so, and a job log expires.
  See #3281. A bundle captured by a binary that predates its fix carries this; promote it only with
  ALETHIA_ACCEPT_UNMEASURED=\"<why, with the run id that DOES show the counts>\", which records the
  reason in the ledger row rather than hiding it."
	return 1
}

# ── --self-test. Both directions, on bundles this script writes, and across the axis that matters
#    — WHICH DIMENSION — because the defect it guards was invisible to a check that varied the
#    counts and held the dimension fixed. ──
if [ "${1:-}" = "--self-test" ]; then
	command -v jq >/dev/null 2>&1 || { echo "check-proof-integrity --self-test: jq is required" >&2; exit 1; }
	fails=0
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	_mk() { # _mk <label> <outcome> <assert-outcome> <healthy> [dimension]
		local d="$tmp/$1"; mkdir -p "$d"
		jq -n --arg o "$2" --arg a "$3" --argjson h "$4" --arg dim "${5:-}" \
			'{outcome:$o, argocd_assert_outcome:$a, argocd_healthy_synced_asserted:$h}
			 + (if $dim == "" then {} else {dimension:$dim} end)' >"$d/provision-summary.json"
		printf '%s' "$d"
	}
	_expect() { # _expect <name> <bundle> <dimension> <want-code>
		local got=0
		_integrity_verdict "$2" "$3" >/dev/null 2>&1 || got=$?
		if [ "$got" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — want exit $4, got $got" >&2
			fails=$((fails + 1))
		fi
	}

	echo "check-proof-integrity --self-test"
	measured="$(_mk measured success converged 22)"
	unmeasured="$(_mk unmeasured success unmeasured null)"
	vacuous="$(_mk vacuous success vacuous null)"
	failed="$(_mk failed failure unmeasured null)"

	# EVERY dimension, tabulated, against BOTH a measured and an unmeasured bundle. A new dimension
	# added to ARGO_CLAIM_DIMENSIONS without a row here changes no result and would go unnoticed —
	# so the row count is asserted at the end.
	rows=0
	for dim in addons maxconfig full gitops byo; do
		_expect "a measured $dim bundle is promotable"   "$measured"   "$dim" 0
		_expect "an unmeasured $dim bundle is REFUSED"   "$unmeasured" "$dim" 1
		_expect "a vacuous $dim bundle is REFUSED"       "$vacuous"    "$dim" 1
		rows=$((rows + 3))
	done
	for dim in floor byo-iac day2 cli-demo; do
		_expect "an unmeasured $dim bundle only warns"   "$unmeasured" "$dim" 0
		_expect "a measured $dim bundle is promotable"   "$measured"   "$dim" 0
		rows=$((rows + 2))
	done
	# A FAILING run is never refused, on the dimension that would otherwise refuse hardest.
	_expect "a FAILED addons run keeps its evidence" "$failed" "addons" 0
	# No dimension at all is indeterminate, NOT a pass.
	_expect "no dimension is indeterminate, not green" "$measured" "" 3
	# A bundle read from its own recorded dimension, with no flag.
	self="$(_mk self success unmeasured null addons)"
	_expect "the bundle's own dimension is used when no flag is given" "$self" \
		"$(jq -r '.dimension // ""' "$self/provision-summary.json")" 1
	rows=$((rows + 3))

	# An unclassified dimension must be INDETERMINATE, never lenient.
	_expect "an unknown dimension fails closed" "$unmeasured" "somethingnew" 3

	# ── The classification must mirror its EMITTER. scripts/e2e/resolve-dimension.sh owns the
	#    dimension vocabulary; every token it can emit has to be classified here, or this script
	#    silently starts failing closed (or, worse, leniently) on a dimension nobody placed. A list
	#    that drifts from the thing that produces its inputs is a guard about nothing.
	resolver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/e2e/resolve-dimension.sh"
	if [ ! -f "$resolver" ]; then
		echo "  ✗ cannot find scripts/e2e/resolve-dimension.sh — the classification cannot be checked against its emitter" >&2
		fails=$((fails + 1))
	else
		emitted="$(sed -n 's/^DIMENSIONS="\(.*\)"$/\1/p' "$resolver") byo"
		[ -n "$(printf '%s' "$emitted" | tr -d ' ')" ] || { echo "  ✗ read NO dimensions out of the resolver — this check would pass having read nothing" >&2; fails=$((fails + 1)); }
		missing=""
		for dim in $emitted; do
			case " $ARGO_CLAIM_DIMENSIONS $ARGO_SUPPORTING_DIMENSIONS " in
				*" $dim "*) ;;
				*) missing="$missing $dim" ;;
			esac
		done
		if [ -n "$missing" ]; then
			echo "  ✗ resolve-dimension.sh can emit dimension(s) this script does not classify:$missing" >&2
			fails=$((fails + 1))
		else
			echo "  ✓ every dimension resolve-dimension.sh can emit is classified ($(printf '%s' "$emitted" | wc -w | tr -d ' ') of them)"
		fi
		# And nothing here may be invented: a classified dimension the resolver cannot emit is a
		# typo that would never fire.
		stray=""
		for dim in $ARGO_CLAIM_DIMENSIONS $ARGO_SUPPORTING_DIMENSIONS; do
			case " $emitted " in
				*" $dim "*) ;;
				*) stray="$stray $dim" ;;
			esac
		done
		if [ -n "$stray" ]; then
			echo "  ✗ this script classifies dimension(s) resolve-dimension.sh cannot emit:$stray" >&2
			fails=$((fails + 1))
		else
			echo "  ✓ every classified dimension is one the resolver can actually emit"
		fi
	fi

	# ── The receipt must cover the plan the bundle reports (#3426). Four cases, because the two
	#    that matter are the two ABSENCE shapes: a check that refused whenever it could not find
	#    both values would reject every unsigned run, and a check that skipped whenever either
	#    lookup returned empty would be satisfied by a typo in the jq path — the mismatch case
	#    below is what proves the path resolves.
	_mk_receipt() { # _mk_receipt <label> <short-in-summary> <full-in-receipt>  → echoes bundle dir
		local d
		d="$(_mk "$1" success converged 20 addons)"
		[ -n "$2" ] && jq --arg s "$2" '. + {receipt_plan_sha256:$s}' "$d/provision-summary.json" >"$d/ps.tmp" \
			&& mv "$d/ps.tmp" "$d/provision-summary.json"
		[ -n "$3" ] && jq -n --arg f "$3" '{key_id:"deadbeef", receipt:{plan_sha256:$f}}' >"$d/receipt.json"
		printf '%s' "$d"
	}
	full_sha=7b60f65b1578fe552eaef50e1d76809aa217a8820ace2e76251ac489bce7a871
	_expect "a receipt covering the reported plan is promotable" \
		"$(_mk_receipt rcpt_match 7b60f65b1578 "$full_sha")" addons 0
	# THE DEFECT ITSELF, with the real hashes off azure/20260830T005214Z.
	_expect "a receipt attesting a DIFFERENT plan is refused" \
		"$(_mk_receipt rcpt_mismatch 710ebacbbecc "$full_sha")" addons 1
	_expect "a bundle with no receipt.json is not newly refused" \
		"$(_mk_receipt rcpt_noreceipt 710ebacbbecc "")" addons 0
	_expect "a bundle recording no plan sha is not newly refused" \
		"$(_mk_receipt rcpt_nosha "" "$full_sha")" addons 0
	rows=$((rows + 4))

	if [ "$fails" -ne 0 ]; then
		echo "check-proof-integrity --self-test: $fails assertion(s) FAILED" >&2
		exit 1
	fi
	echo "check-proof-integrity --self-test: OK ($rows cases)"
	exit 0
fi

bundle="${1:?usage: check-proof-integrity.sh <bundle-dir> [--dimension <d>]}"
shift
dimension=""
while [ $# -gt 0 ]; do
	case "$1" in
		--dimension) dimension="${2:-}"; shift 2 ;;
		*) echo "check-proof-integrity: unknown argument '$1'" >&2; exit 2 ;;
	esac
done
command -v jq >/dev/null 2>&1 || { echo "check-proof-integrity: jq is required" >&2; exit 2; }
[ -d "$bundle" ] || { echo "check-proof-integrity: no such bundle directory: $bundle" >&2; exit 2; }
if [ -z "$dimension" ] && [ -f "$bundle/provision-summary.json" ]; then
	dimension="$(jq -r '.dimension // ""' "$bundle/provision-summary.json")"
fi

code=0
reason="$(_integrity_verdict "$bundle" "$dimension")" || code=$?
case "$code" in
	0) echo "check-proof-integrity: OK — $reason" ;;
	1) echo "check-proof-integrity: REFUSED — $reason" >&2 ;;
	*) echo "check-proof-integrity: INDETERMINATE — $reason" >&2 ;;
esac
exit "$code"
