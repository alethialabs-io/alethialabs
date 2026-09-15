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
#   F  hetzner's CCM ingress load balancer is still ASKED ABOUT in this mode, and both modes reach
#      the same unverifiable ledger. See its own block.
#   F2 …and a leak that pass finds reaches the EXIT CODE, not just the ledger. F alone is green
#      through a mutation that drops the leak on the floor and prints "verified complete".
#   G  without `jq` the same question is RECORDED AS UNASKED rather than skipped in silence.
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
# ⚠️ THE DANGEROUS DIRECTION IS UNDER-MATCHING, AND THE FIRST CUT OF THIS FILE HAD IT.
#
# The header used to argue "deliberately generous … over-matching can only make this file stricter".
# That sentence is true and it is about the wrong failure. A stem this list omits is a mutating call
# classified as a READ, and assertion C — this file's central property — then passes over it. Three
# such calls were in the VERIFY_ONLY=0 logs THIS FILE ALREADY WRITES:
#
#   aws      s3 rm s3://<bucket> --recursive               emptying a bucket
#   gcp      storage rm -r gs://<bucket> --quiet            emptying a bucket
#   alibaba  vpc UnassociateEipAddress --AllocationId …     detaching an EIP
#
# `rm` was not a stem, and the CamelCase list had `Disassociate` but not `Unassociate`. So the list
# below is long on purpose, and the standard for adding to it is "could any of these five CLIs ever
# spell a mutation this way", not "do we call it today".
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
MUTATING_STEMS='delete|remove|destroy|terminate|purge|detach|deregister|disassociate|unassociate|revoke|release'
MUTATING_STEMS="${MUTATING_STEMS}|create|modify|update|patch|replace|set|put|add|attach|join|tag|untag"
MUTATING_STEMS="${MUTATING_STEMS}|rm|rb|mb|mv|cp|sync|move|rename|import|restore|rollback|apply"
MUTATING_STEMS="${MUTATING_STEMS}|start|run|stop|reboot|reset|restart|resize|scale|upgrade|disable|enable|abort|cancel|invoke"
MUTATING_CAMEL='Delete|Remove|Destroy|Terminate|Purge|Detach|Deregister|Disassociate|Unassociate|Revoke|Release'
MUTATING_CAMEL="${MUTATING_CAMEL}|Create|Modify|Update|Set|Put|Add|Attach|Join|Move|Rename|Import|Restore"
MUTATING_CAMEL="${MUTATING_CAMEL}|Start|Run|Stop|Reboot|Reset|Restart|Resize|Scale|Upgrade|Disable|Enable|Abort|Cancel|Invoke"
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

# THE THREE CALLS THE FIRST MATCHER MISSED, pinned as their own fixture. They are real invocations
# these sweepers make — lifted from the VERIFY_ONLY=0 logs this file writes — and each was
# classified as a READ, so assertion C would have passed over a run that recursively emptied an S3
# bucket. A narrowing of the stem list must red HERE, loudly, and not by silently going quiet.
: >"$WORK/missed"
cat >"$WORK/missed" <<'MISSED'
s3 rm s3://stub-4242 --recursive
--project stub-project storage rm -r gs://stub-4242 --quiet
vpc UnassociateEipAddress --AllocationId eip-stub --region us-east-1
MISSED
if [ "$(mutating_calls "$WORK/missed")" = "3" ]; then
	ok "…and on the three real mutations the first cut of this matcher classified as READS"
else
	bad "…and on the three real mutations the first cut classified as READS" \
		"matched $(mutating_calls "$WORK/missed") of 3 — a stem was narrowed and assertion C has gone blind to it"
fi

# The other direction, on the READS most likely to be caught by a careless stem. `starts_with(` is
# the one that actually bit: a matcher with no trailing boundary reads `addresses` as `add`.
: >"$WORK/reads"
cat >"$WORK/reads" <<'READS'
ec2 describe-addresses --region us-east-1
--project stub-project compute addresses list --format=value(name,region.basename())
group list --query [?starts_with(name,'rg-')].name -o tsv
keyvault list-deleted --query [].name -o tsv
resourcegroupstaggingapi get-resources --tag-filters Key=alethia:project-id
vpc DescribeVpcs --PageSize 100 --Tag.1.Key alethia:project-id
s3api head-bucket --bucket stub-4242
load-balancer list -o noheader -o columns=id
READS
if [ "$(mutating_calls "$WORK/reads")" = "0" ]; then
	ok "…and on NONE of eight real read-only calls, including the ones a careless stem catches"
else
	bad "…and on NONE of eight real read-only calls" \
		"matched $(mutating_calls "$WORK/reads"): $(grep -E "$MUTATING_RE" "$WORK/reads" | head -2 | tr '\n' ' ') — a false positive here reds this suite forever"
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
# Before the fix, sweep_unlabelled_lbs was not only a sweeper: it was the only place that recorded
# the CCM ingress load balancer as UNVERIFIABLE. (Three places now — that function,
# `report_unlabelled_lbs`, and verify_swept's `no jq` branch. Past tense on purpose: it describes
# the tree the bug lived in, not the one this test ships in.) verify_swept's own re-check goes
# through unlabelled_lb_ids, which
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

# ── F2. THE LEAK, not just the ledger. ─────────────────────────────────────────────────────────
#
# F above compares the two modes' UNVERIFIABLE ledgers, and that is not enough: `report_unlabelled_lbs`
# also echoes, on STDOUT, the ids of load balancers BOUND TO THIS RUN that are still alive — a
# confirmed LEAK, which only verify_swept can count. Mutating the branch that reads it
# (`if [ "$VERIFY_ONLY" = "1" ]` in verify_swept → `if false`) sends the check back through
# `unlabelled_lb_ids`, which returns SILENTLY once the network is gone, and the run reports
#
#     ✓ hcloud cleanup verified complete … no labelled resources remain
#
# over a live billing load balancer. That is H1's exact class, inside H1's own fix, and F alone is
# green through it.
#
# The fixture is the #3481 shape: a pre-destroy CAPTURE names this run's load balancer, the network
# is gone, and the project listing still returns the id.
echo "→ hetzner · a leak found by the read-only pass must reach the EXIT CODE, not just the ledger"
printf '# cluster=cl-selftest-4177-1\n9911\n' >"$WORK/lb-capture.txt"
write_stub hcloud '
for a in "$@"; do [ "$a" = "--selector" ] && exit 0; done
case " $* " in
  *" load-balancer list "*) echo 9911 ;;
esac'
for mode in 1 0; do
	out="$WORK/hz2-${mode}.out"
	rc=0
	PATH="$WORK/bin:$PATH" ST_CALLS="$WORK/hz2-${mode}.calls" \
		PROBE_LEDGER="$WORK/hz2-${mode}.ledger" PROBE_UNATTRIB_LEDGER="$WORK/hz2-${mode}.un" \
		PROBE_ATTEST_FILE="$WORK/hz2-${mode}.at" \
		ALETHIA_E2E_HCLOUD_LB_IDS="$WORK/lb-capture.txt" \
		VERIFY_ONLY="$mode" PROBE_RETRIES=1 PROBE_RETRY_DELAY=0 HCLOUD_TOKEN=stub \
		ALETHIA_E2E_ENV=selftest-4177-1 \
		timeout 60 bash scripts/e2e/hcloud-cleanup.sh cl-selftest-4177-1 >"$out" 2>&1 || rc=$?
	echo "$rc" >"$WORK/hz2-${mode}.rc"
done
# The read-only pass never deletes, so a live captured LB is a LEAK to it: exit 1, named.
if [ "$(cat "$WORK/hz2-1.rc")" = "1" ] && grep -q '9911' "$WORK/hz2-1.out"; then
	ok "F2 · VERIFY_ONLY=1 reports the captured load balancer as a LEAK — exit 1, id named"
else
	bad "F2 · VERIFY_ONLY=1 reports the captured load balancer as a LEAK" \
		"exit $(cat "$WORK/hz2-1.rc"), $(grep -c '9911' "$WORK/hz2-1.out") mention(s) of the id — a live billing LB just verified as clean"
fi
# The sweeping pass DELETES it and then re-reads; the stub is static, so the delete "fails" and it
# lands on UNVERIFIABLE (exit 4). Different code, same refusal to pass: the codes differ because
# only one of the two modes was allowed to try, which is the whole point of the split.
if [ "$(cat "$WORK/hz2-0.rc")" != "0" ] && grep -q '9911' "$WORK/hz2-0.out"; then
	ok "F2 · VERIFY_ONLY=0 also refuses to pass and names the id (exit $(cat "$WORK/hz2-0.rc"))"
else
	bad "F2 · VERIFY_ONLY=0 also refuses to pass and names the id" \
		"exit $(cat "$WORK/hz2-0.rc"), $(grep -c '9911' "$WORK/hz2-0.out") mention(s)"
fi

# ── G. WITHOUT `jq`, THE QUESTION IS RECORDED AS UNASKED. ───────────────────────────────────────
#
# `jq` is what binds an unlabelled CCM load balancer to this run — its only binding is a
# private-network attachment that has to be read out of JSON. Without it the check cannot run at
# ALL, and `verify_swept` used to guard it with `if command -v jq` and no `else`: a silent skip, on
# a verification path, over the resource this cloud most often leaks. That `else` now records
# `ccm-load-balancers "no jq"`, and deleting it left this suite green — a correct fix with nothing
# holding it in place.
#
# The only way to test it is to genuinely take `jq` off $PATH, so the mirror below is a symlink farm
# over the system directories with that one name skipped. It is built here and nowhere else because
# it costs a second; every other case runs with the real environment.
echo "→ hetzner · without jq, the CCM load balancer is recorded as UNASKED, not skipped"
mkdir -p "$WORK/nojq"
for d in /usr/bin /bin /usr/sbin /sbin; do
	[ -d "$d" ] || continue
	for f in "$d"/*; do
		b="${f##*/}"
		[ "$b" = "jq" ] && continue
		[ -e "$WORK/nojq/$b" ] || ln -s "$f" "$WORK/nojq/$b" 2>/dev/null
	done
done
# THE INSTRUMENT, again: a mirror that still finds jq proves nothing, and one that lost `grep`
# would fail the sweeper for a reason that has nothing to do with the assertion.
if PATH="$WORK/nojq" command -v jq >/dev/null 2>&1; then
	bad "G · the jq-less PATH really lacks jq" "jq is still resolvable, so the assertion below is vacuous"
elif ! PATH="$WORK/nojq" command -v grep >/dev/null 2>&1; then
	bad "G · the jq-less PATH still has the core utilities" "grep is missing — the sweeper would fail for the wrong reason"
else
	ok "G · the jq-less PATH lacks jq and keeps the core utilities"
	# BOTH modes. The question "is the CCM load balancer accounted for" has to survive a jq-less
	# runner on the sweeping path as well as the read-only one, and the two reach it through
	# different functions.
	for mode in 1 0; do
		: >"$WORK/nojq-${mode}.ledger"
		PATH="$WORK/bin:$WORK/nojq" ST_CALLS="$WORK/nojq-${mode}.calls" \
			PROBE_LEDGER="$WORK/nojq-${mode}.ledger" PROBE_UNATTRIB_LEDGER="$WORK/nojq-${mode}.un" \
			PROBE_ATTEST_FILE="$WORK/nojq-${mode}.at" \
			VERIFY_ONLY="$mode" PROBE_RETRIES=1 PROBE_RETRY_DELAY=0 HCLOUD_TOKEN=stub \
			ALETHIA_E2E_ENV=selftest-4177-1 \
			bash scripts/e2e/hcloud-cleanup.sh cl-selftest-4177-1 >"$WORK/nojq-${mode}.out" 2>&1
		if grep -q 'ccm-load-balancers(no jq)' "$WORK/nojq-${mode}.ledger" 2>/dev/null; then
			ok "G · VERIFY_ONLY=${mode} on a jq-less runner records the CCM load balancer as UNVERIFIABLE"
		else
			bad "G · VERIFY_ONLY=${mode} on a jq-less runner records the CCM load balancer as UNVERIFIABLE" \
				"the ledger is '$(tr '\n' ' ' <"$WORK/nojq-${mode}.ledger")' — the check was skipped in silence"
		fi
	done
	# ⚠️ WHAT G PROVES AND WHAT IT DOES NOT, both measured rather than assumed. hcloud-cleanup.sh has
	# THREE `no jq` recorders — sweep_unlabelled_lbs, report_unlabelled_lbs, and verify_swept's
	# `else` — and G asserts the BEHAVIOUR, so it cannot attribute the entry to one of them:
	#
	#   delete verify_swept's entry alone            → this suite stays GREEN (the other two mask it)
	#   delete the other two, keep verify_swept's    → VERIFY_ONLY=1 REDS, VERIFY_ONLY=0 stays green
	#
	# The second row is the useful one: it shows verify_swept's `else` really is the backstop on the
	# sweeping path, not dead code. What no black-box test here can do is pin it as the SOLE source,
	# because no front-door path reaches the gate without one of the other two having run first.
fi

if [ "$FAILS" -ne 0 ]; then
	echo "✗ verify-only-readonly-test.sh: ${FAILS} failure(s)" >&2
	exit 1
fi
echo "✓ verify-only-readonly-test.sh: VERIFY_ONLY=1 deletes nothing, on all five clouds"
