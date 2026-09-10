#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# verify-only-readonly-test.sh — the committed proof that `VERIFY_ONLY=1` DELETES NOTHING (#4398).
#
# No cloud, no credentials, no network: every provider CLI is shadowed by a stub on $PATH that
# LOGS each invocation and answers from a fixture. Run it directly.
#
# ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
#
# #4398 added a read-only mode to five scripts whose day job is deleting cloud resources. "It only
# lists" was, in the first cut, asserted in a PR description and in comments — and an adversarial
# review then mutated the guard in each of its three structural shapes and watched every mutant
# SURVIVE the whole check suite:
#
#   aws-cleanup.sh      `if [ "$VERIFY_ONLY" != "1" ]`  → `if true`     SURVIVED
#   azure-cleanup.sh    `if [ "$VERIFY_ONLY" = "1" ]`   → `if false`    SURVIVED
#   hcloud-cleanup.sh   `if [ "$VERIFY_ONLY" != "1" ]`  → `if true`     SURVIVED
#   aws-cleanup.sh      the DRY_RUN/PREFLIGHT refusal   → `if false`    SURVIVED
#
# `grep -rn VERIFY_ONLY` found no test referencing the flag anywhere. A smoke run that lives in a
# transcript is not a test: nothing re-runs it, and the next person to touch the orchestration gets
# no signal at all. This is the one place this repo cannot afford that — the mode's whole licence is
# that it is safe to point at a live account after a teardown.
#
# ── WHAT IT ASSERTS, AND WHAT EACH ASSERTION CATCHES ────────────────────────────────────────────
#
#   A  THE INSTRUMENT WORKS. The stub records, and the mutating-verb matcher fires on a known
#      mutating invocation. Without this, every "0 mutating calls" below could be a broken logger
#      or a regex that matches nothing — a guard reporting green on what it never looked at, which
#      is the defect class this whole change is about.
#   B  VERIFY_ONLY=1 CALLED THE CLOUD AT ALL. "It issued no deletes" also passes when it issued
#      nothing, i.e. when the mode is a no-op that would report CLEAN over an unasked question.
#   C  VERIFY_ONLY=1 ISSUED ZERO MUTATING CALLS. The property itself. Kills mutants 1-3 above.
#   D  VERIFY_ONLY=0 ISSUED AT LEAST ONE. Non-vacuity for C: it proves this fixture CAN drive the
#      sweeps into deleting, so C means "the guard stopped them" rather than "nothing was there".
#   E  THE REFUSAL HOLDS. `VERIFY_ONLY=1` with `DRY_RUN=1` or `PREFLIGHT=1` exits 2 — both of those
#      exit 0 WITHOUT verifying, and that exit status is read as a cloud verdict. Kills mutant 4.
#   F  hetzner's CCM ingress load balancer is still ASKED ABOUT in this mode. See its own block.
#
# ⚠️ WHAT THIS DOES NOT PROVE. The stubs answer a fixture, not a cloud. This file proves the guard
# skips the mutating passes and that the verification still queries; it does not prove any
# provider's real API behaves as the fixture says. That evidence only exists after a real nightly.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
FAILS=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/alethia-verify-only.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

ok() { echo "  ✓ $1"; }
bad() {
	echo "  ✗ $1 — $2" >&2
	FAILS=$((FAILS + 1))
}

# ── The mutating-verb matcher. ──────────────────────────────────────────────────────────────────
#
# Deliberately GENEROUS on the stem list. The load-bearing assertion (C) is that the count is ZERO,
# so over-matching on stems can only make this file stricter.
#
# ⚠️ IT IS *NOT* GENEROUS ON THE BOUNDARIES, and that is not tidiness — a matcher with no trailing
# boundary reads `gcloud compute addresses list` as a mutating call (`add` + "resses"), and a
# false positive on a READ turns the whole suite permanently red, which is how a guard stops being
# read at all. Every stem therefore needs BOTH ends:
#
#   leading   start of line, a space, or `/` — so `describe-addresses` and `list-deleted` are
#             reads: their stems sit after a `-`, which is not a boundary here.
#   trailing  `-`, a space, or end of line for the kebab-case CLIs (aws/gcloud/az/hcloud); a
#             following CAPITAL for alibaba's CamelCase RPC actions (`DeleteInstance`).
#
# Three alternations rather than one case-insensitive pass, because `grep -i` would fold `[A-Z]`
# too and hand back exactly the `addresses` false positive the boundary exists to stop. The third
# covers the all-caps HTTP verbs alibaba's `cs` product takes (`aliyun cs DELETE /clusters/<id>`).
MUTATING_STEMS='delete|remove|destroy|terminate|purge|detach|deregister|disassociate|revoke|release|create|modify|update|put|add|attach|stop|reboot|disable|enable'
MUTATING_CAMEL='Delete|Remove|Destroy|Terminate|Purge|Detach|Deregister|Disassociate|Revoke|Release|Create|Modify|Update|Put|Add|Attach|Stop|Reboot|Disable|Enable'
MUTATING_RE="(^|[ /])((${MUTATING_STEMS})([- ]|\$)|(${MUTATING_CAMEL})[A-Z]|(DELETE|PUT|POST|PATCH)([ /]|\$))"

mutating_calls() { grep -Ec "$MUTATING_RE" "$1" 2>/dev/null || true; }
total_calls() { grep -c . "$1" 2>/dev/null || true; }

# ── The stubs. One per CLI, each answering with enough of a resource inventory that the sweep has
#    something to try to delete — which is what makes assertion D non-vacuous. ──
write_stub() { # <cli> <body>
	{
		echo '#!/bin/sh'
		echo 'printf "%s\n" "$*" >> "$ST_CALLS"'
		printf '%s\n' "$2"
		echo 'exit 0'
	} >"$WORK/bin/$1"
	chmod +x "$WORK/bin/$1"
}

write_stub aws '
case " $* " in
  *" describe"*|*" list"*|*" get-"*|*"head-bucket"*) echo "stub-4242" ;;
esac'

write_stub gcloud '
case " $* " in
  *" list "*|*" list"|*" describe "*) echo "stub-4242" ;;
esac'

# `group exists` must answer `true` and the handle-tag query must answer this run'"'"'s tag, or
# assert_rg_in_scope refuses every group and the sweep deletes nothing — a fixture that would make
# assertion D pass for the wrong reason.
write_stub az '
case " $* " in
  *" exists "*) echo true ;;
  *"alethia:project-id"*"-o tsv"*) echo "e2e-selftest-4177-1" ;;
  *" list "*|*" list-deleted "*|*" show "*) echo "rg-stub-selftest-4177-1" ;;
esac'

# One blob carrying every container `tagged_ids` reads (alibaba-cleanup.sh:252-261, 326-328), so a
# single fixture answers all of them. jq selects the key it wants and ignores the rest.
write_stub aliyun '
case " $* " in
  *Describe*|*List*|*" GET "*) cat <<JSON
{"Instances":{"Instance":[{"InstanceId":"i-stub"}]},
 "Disks":{"Disk":[{"DiskId":"d-stub"}]},
 "SecurityGroups":{"SecurityGroup":[{"SecurityGroupId":"sg-stub"}]},
 "Vpcs":{"Vpc":[{"VpcId":"vpc-stub"}]},
 "VSwitches":{"VSwitch":[{"VSwitchId":"vsw-stub"}]},
 "NatGateways":{"NatGateway":[{"NatGatewayId":"ngw-stub","SnatTableIds":{"SnatTableId":["stb-stub"]}}]},
 "EipAddresses":{"EipAddress":[{"AllocationId":"eip-stub"}]},
 "LoadBalancers":{"LoadBalancer":[{"LoadBalancerId":"lb-stub"}]},
 "clusters":[{"cluster_id":"c-stub","name":"p-selftest-4177-1"}]}
JSON
  ;;
esac'

write_stub hcloud '
case " $* " in
  *" list "*|*" list"*)
    case " $* " in
      *json*) echo "[{\"id\":4242,\"private_net\":[{\"network\":42}]}]" ;;
      *) echo 4242 ;;
    esac ;;
esac'

# ── A. THE INSTRUMENT. Asserted before anything is measured with it. ────────────────────────────
ST_CALLS="$WORK/instrument" && : >"$ST_CALLS"
export ST_CALLS
PATH="$WORK/bin:$PATH" "$WORK/bin/aws" ec2 delete-vpc --vpc-id vpc-1 >/dev/null 2>&1
PATH="$WORK/bin:$PATH" "$WORK/bin/aws" ec2 describe-vpcs >/dev/null 2>&1
if [ "$(total_calls "$ST_CALLS")" = "2" ]; then
	ok "the stub records every invocation"
else
	bad "the stub records every invocation" "logged $(total_calls "$ST_CALLS") of 2"
fi
if [ "$(mutating_calls "$ST_CALLS")" = "1" ]; then
	ok "the mutating-verb matcher fires on a delete and NOT on a describe"
else
	bad "the mutating-verb matcher fires on a delete and NOT on a describe" "matched $(mutating_calls "$ST_CALLS") of 1"
fi

# ── The runner. Re-enters the real sweeper as a subprocess so the REAL orchestration is exercised;
#    a self-test inside each script could not reach it, because the self-test exits above it. ──
run_sweeper() { # <script> <verify-only> <calls-file> [extra env assignments…]
	local script="$1" vo="$2" calls="$3"
	shift 3
	: >"$calls"
	# The bounds keep a stub that never stops answering from spending real time: the sweepers wait
	# on detaches and on resource groups finishing their deletes, and a stub always says "still
	# there". They change no decision this file asserts on.
	PATH="$WORK/bin:$PATH" ST_CALLS="$calls" \
		VERIFY_ONLY="$vo" DRY_RUN=0 PREFLIGHT=0 \
		PROBE_RETRIES=1 PROBE_RETRY_DELAY=0 \
		DETACH_TIMEOUT=0 DELETE_RETRIES=1 DELETE_WAIT_TIMEOUT=0 \
		HCLOUD_TOKEN=stub \
		ALETHIA_E2E_ENV=selftest-4177-1 \
		ALETHIA_E2E_REGION=us-east-1 \
		ALETHIA_E2E_GCP_PROJECT_ID=stub-project \
		"$@" \
		timeout 120 bash "$script" cl-selftest-4177-1 >/dev/null 2>&1
	return 0
}

# ── B / C / D, per cloud. ───────────────────────────────────────────────────────────────────────
for spec in \
	"aws:scripts/e2e/aws-cleanup.sh" \
	"gcp:scripts/e2e/gcp-cleanup.sh" \
	"azure:scripts/e2e/azure-cleanup.sh" \
	"alibaba:scripts/e2e/alibaba-cleanup.sh" \
	"hetzner:scripts/e2e/hcloud-cleanup.sh"; do
	cloud="${spec%%:*}"
	script="${spec#*:}"
	echo "→ ${cloud} (${script})"

	run_sweeper "$script" 1 "$WORK/${cloud}.verify"
	run_sweeper "$script" 0 "$WORK/${cloud}.sweep"

	v_total="$(total_calls "$WORK/${cloud}.verify")"
	v_mut="$(mutating_calls "$WORK/${cloud}.verify")"
	s_mut="$(mutating_calls "$WORK/${cloud}.sweep")"

	if [ "${v_total:-0}" -gt 0 ]; then
		ok "B · VERIFY_ONLY=1 queried the cloud (${v_total} call(s)) — the mode is not a no-op"
	else
		bad "B · VERIFY_ONLY=1 queried the cloud" "it issued NO calls at all, so 'no deletes' means nothing"
	fi

	if [ "${v_mut:-0}" -eq 0 ]; then
		ok "C · VERIFY_ONLY=1 issued ZERO mutating calls"
	else
		bad "C · VERIFY_ONLY=1 issued ZERO mutating calls" "it issued ${v_mut}: $(grep -E "$MUTATING_RE" "$WORK/${cloud}.verify" | head -3 | tr '\n' ' ')"
	fi

	if [ "${s_mut:-0}" -gt 0 ]; then
		ok "D · VERIFY_ONLY=0 issued ${s_mut} mutating call(s) — C is not vacuous"
	else
		bad "D · VERIFY_ONLY=0 issued at least one mutating call" "the fixture never drove a delete, so C proves nothing about this cloud"
	fi

	# ── E. The refusal. Both incompatible modes exit 0 WITHOUT verifying, and this script's exit
	#      status is read as a cloud verdict — so combining them must be refused, not ignored.
	for incompatible in DRY_RUN PREFLIGHT; do
		rc=0
		# `env` and not a `NAME=1` prefix: the name is in a VARIABLE here, and bash reads
		# `"$incompatible"=1 cmd` as a COMMAND called `DRY_RUN=1`, not as an assignment. That is
		# exit 127 for every cloud — a suite reporting a real-looking failure it never tested.
		PATH="$WORK/bin:$PATH" \
			timeout 60 env ST_CALLS="$WORK/refuse" VERIFY_ONLY=1 "${incompatible}=1" \
			ALETHIA_E2E_ENV=selftest-4177-1 ALETHIA_E2E_REGION=us-east-1 HCLOUD_TOKEN=stub \
			bash "$script" cl-selftest-4177-1 >/dev/null 2>&1 || rc=$?
		if [ "$rc" -eq 2 ]; then
			ok "E · VERIFY_ONLY=1 with ${incompatible}=1 is REFUSED (exit 2)"
		else
			bad "E · VERIFY_ONLY=1 with ${incompatible}=1 is REFUSED" "got exit ${rc}, so a mode that never verifies would report a cloud verdict"
		fi
	done
done

# ── F. hetzner's CCM ingress load balancer (#4398, the regression this file was extended for). ──
#
# sweep_unlabelled_lbs is not only a sweeper: it is the ONLY place that records the CCM ingress load
# balancer as UNVERIFIABLE, and verify_swept's own re-check goes through unlabelled_lb_ids, which
# returns SILENTLY when the private-network binding cannot be resolved. After a teardown that
# network is gone BY CONSTRUCTION. The first cut of VERIFY_ONLY skipped the sweeper, so on the one
# cloud that runs every night — into a shared account where "the project holds a load balancer" is
# the normal case — the mode reported CLEAN over a question nobody had asked.
#
# The fixture is the exact shape: selector-scoped listings find nothing (the labelled sweep is
# clean, the network is gone) while the PROJECT-WIDE load-balancer list finds one. Both modes must
# reach the same verdict, and it must not be "clean".
echo "→ hetzner · the CCM ingress load balancer must still be ASKED ABOUT in VERIFY_ONLY"
write_stub hcloud '
for a in "$@"; do [ "$a" = "--selector" ] && exit 0; done
case " $* " in
  *" load-balancer list "*) echo 9911 ;;
esac'
for mode in 1 0; do
	ledger="$WORK/hz-${mode}.ledger"
	: >"$ledger"
	PATH="$WORK/bin:$PATH" ST_CALLS="$WORK/hz-${mode}.calls" \
		PROBE_LEDGER="$ledger" PROBE_UNATTRIB_LEDGER="${ledger}.un" PROBE_ATTEST_FILE="${ledger}.at" \
		VERIFY_ONLY="$mode" PROBE_RETRIES=1 PROBE_RETRY_DELAY=0 HCLOUD_TOKEN=stub \
		ALETHIA_E2E_ENV=selftest-4177-1 \
		timeout 60 bash scripts/e2e/hcloud-cleanup.sh cl-selftest-4177-1 >/dev/null 2>&1 || true
done
for mode in 1 0; do
	label="VERIFY_ONLY=${mode}"
	if grep -q 'ccm-load-balancers' "$WORK/hz-${mode}.ledger" 2>/dev/null; then
		ok "F · ${label} records the CCM load balancer as UNVERIFIABLE, so the run cannot read as clean"
	else
		bad "F · ${label} records the CCM load balancer as UNVERIFIABLE" "the ledger is '$(tr '\n' ' ' <"$WORK/hz-${mode}.ledger")' — a failed look would publish as an empty account"
	fi
done
if diff -q <(sed -E 's/\(.*//' "$WORK/hz-1.ledger" | sort -u) \
	<(sed -E 's/\(.*//' "$WORK/hz-0.ledger" | sort -u) >/dev/null 2>&1; then
	ok "F · the two modes reach the SAME set of unverifiable types — the read-only pass hides nothing"
else
	bad "F · the two modes reach the same set of unverifiable types" \
		"verify='$(sed -E 's/\(.*//' "$WORK/hz-1.ledger" | sort -u | tr '\n' ' ')' sweep='$(sed -E 's/\(.*//' "$WORK/hz-0.ledger" | sort -u | tr '\n' ' ')'"
fi

if [ "$FAILS" -ne 0 ]; then
	echo "✗ verify-only-readonly-test.sh: ${FAILS} failure(s)" >&2
	exit 1
fi
echo "✓ verify-only-readonly-test.sh: VERIFY_ONLY=1 deletes nothing, on all five clouds"
