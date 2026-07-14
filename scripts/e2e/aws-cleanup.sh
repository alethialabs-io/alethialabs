#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# aws-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (AWS/EKS).
#
# Cloned guard-for-guard from scripts/e2e/hcloud-cleanup.sh (BYOC A1.3). The T2 harness tears
# the cluster down GRACEFULLY in-process via `tofu destroy` (provisioner.RunDestroy) on the
# normal path. But if the test PROCESS is hard-killed (a `go test -timeout` panic, a CI step
# SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable AWS resources leak — most
# dangerously the OUT-OF-BAND ones tofu never tracked: Karpenter-launched EC2/EBS, the AWS Load
# Balancer Controller's ELBs, and CSI pvc-* volumes. This script is the guarantee: the nightly
# runs it in an `always()` step so the run's resources are gone no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The AWS account (270587882865) is the SHARED platform account. An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * DISCOVERY is tag-driven. `resourcegroupstaggingapi get-resources` matches EXACTLY the ARNs
#     carrying our unique per-run handle `alethia:project-id=e2e-<ENV>` (Values= is an EXACT
#     match, no wildcards). Every tofu-tagged resource inherits it via provider default_tags /
#     eks_tags / EBS-CSI extraVolumeTags (B1.3). ENV = <run_id>-<attempt>, unique per run.
#   * OUT-OF-BAND resources that do NOT inherit default_tags (LB-controller ELBs tagged
#     `elbv2.k8s.aws/cluster=<eks_name>`; Karpenter EC2 tagged `kubernetes.io/cluster/<eks_name>`)
#     are swept by a SECONDARY filter bound to THIS run's cluster name — discovered from the
#     tagged EKS ARN, and (if the cluster is already gone) from any cluster tag whose value embeds
#     `-<ENV>-` (so a mid-destroy kill still finds + sweeps + VERIFIES the orphans). Still never
#     account-wide: the secondary equality match on `<eks_name>` (which itself embeds <ENV>)
#     excludes every other run's / prod's resources.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last
#     line of defence — a leak NEVER exits green: verify_swept re-lists BOTH scopes and
#     AUTHORITATIVELY confirms (direct describe) each billable survivor before failing the step,
#     so tag-API lag can't false-RED and a real leak can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=us-east-1 ./scripts/e2e/aws-cleanup.sh
#   (positional $1 accepted for call-site symmetry with hcloud-cleanup.sh but IGNORED.)
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# ── PREFLIGHT (stale-cluster preflight, BYOC A1.4) ──────────────────────────────────────────
# A prior nightly that was hard-killed before BOTH its graceful destroy AND its always() sweep
# leaks billable resources that keep costing until the NEXT run notices. PREFLIGHT=1 runs before
# provisioning and sweeps those orphans. It discovers every OTHER e2e run's handle via
# `resourcegroupstaggingapi get-tag-values` (all values of the `alethia:project-id` key), keeps
# only `e2e-`-prefixed values, EXCLUDES this run, re-validates each against the same specificity +
# prod/shared denylist guards, and runs the identical scope-locked sweep+verify per orphan. It is
# safe to sweep another e2e-* handle because same-cloud nightly runs are SERIALIZED (the
# `e2e-nightly-aws` concurrency group) — so any other e2e-* value is a prior-run orphan, never a
# concurrent sibling. Posture is best-effort: a residual orphan emits `::warning::` but does NOT
# fail (a flaky tag/API call must not red an otherwise-healthy provisioning night; the per-run
# always() teardown stays the fail-closed guarantee for THIS run, and the next preflight retries).
#
# Requires: awscli v2 (digest-pinned in the workflow), configured creds (OIDC in CI), jq.
set -euo pipefail

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only. A silent fallback to an ambient
# AWS_REGION that differs from where the run provisioned would make every (regional) tag query
# empty → delete nothing, verify nothing, exit green while the real region bills (grill F3).
REGION="${ALETHIA_E2E_REGION:-}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
DETACH_TIMEOUT="${DETACH_TIMEOUT:-180}"

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resources tagged alethia:project-id=e2e-<ENV> — never" >&2
	echo "  account-wide. Set ALETHIA_E2E_ENV to the unique per-run value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the tag filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback — grill F3). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  Tag discovery is regional; a wrong/empty region deletes+verifies nothing and false-greens." >&2
	exit 2
fi

for bin in aws jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "✗ the '$bin' CLI is not installed." >&2
		exit 2
	fi
done

PROJECT_ID_TAG="e2e-${ENV}"
CLUSTER="" # discovered below (eks-<regionShort>-<env>-<project>); may be found via ENV-embed fallback

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ]; then
	echo "→ aws belt-and-suspenders cleanup in ${REGION}, scope alethia:project-id=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# tagged_arns [service] — every ARN carrying our project-id handle (optionally one service). The
# tag filter is mandatory; never returns an unscoped list.
tagged_arns() {
	assert_scope
	local svc="${1:-}"
	local args=(resourcegroupstaggingapi get-resources
		--tag-filters "Key=alethia:project-id,Values=${PROJECT_ID_TAG}"
		--query 'ResourceTagMappingList[].ResourceARN' --output text)
	[ -n "$svc" ] && args+=(--resource-type-filters "$svc")
	aws "${args[@]}" 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

arn_id() { printf '%s\n' "$1" | sed -E 's#^.*[:/]##'; }

# looks_gone <stderr-text> — true if an AWS delete error means the resource is already absent
# (idempotency: eventual consistency can list an already-deleted ARN; a NotFound on delete is
# success, not failure — grill F4). Covers ec2 InvalidX.NotFound, eks/elbv2 NotFound, EIP, etc.
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'NotFound|does not exist|InvalidAllocationID|no such|could not be found|ResourceNotFoundException|LoadBalancerNotFound'
}

# retry_delete <human> <cmd...> — delete with backoff. "Already gone" = success. NEVER returns
# non-zero (so `set -e` can't abort the sweep BEFORE verify_swept, the real gate — grill F4);
# an unresolved failure logs a WARN and lets verify catch it authoritatively.
retry_delete() {
	local human="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		echo "      would delete ${human}"
		return 0
	fi
	local attempt=1 delay=3 err
	while [ "$attempt" -le "$DELETE_RETRIES" ]; do
		if err="$("$@" 2>&1)"; then
			echo "      deleted ${human}"
			return 0
		fi
		if looks_gone "$err"; then
			echo "      ${human} already gone"
			return 0
		fi
		echo "      retry ${attempt}/${DELETE_RETRIES}: ${human} not deletable yet (waiting ${delay}s)" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	echo "      WARN: could not delete ${human} after ${DELETE_RETRIES} attempts (verify_swept will gate)" >&2
	return 0
}

# ── Discover THIS run's EKS cluster name for the out-of-band secondary sweeps. First the tagged
#    EKS ARN; if the cluster is already gone (the likeliest hard-kill point — mid tofu-destroy),
#    fall back to any EC2/LB cluster tag whose value embeds `-<ENV>-` (the eks name is
#    eks-<short>-<ENV>-<project>). Never guessed, never broadened past this run's ENV. ──
discover_cluster() {
	local eks_arn cand
	eks_arn="$(tagged_arns eks:cluster | head -n1)"
	if [ -n "$eks_arn" ]; then
		CLUSTER="$(arn_id "$eks_arn")"
	else
		# Fallback: scan instance `kubernetes.io/cluster/<name>` tag KEYS and LB
		# `elbv2.k8s.aws/cluster` tag VALUES for a name containing our unique ENV.
		# shellcheck disable=SC2016 # backticks are JMESPath, not command substitution
		cand="$(aws ec2 describe-instances \
			--filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
			--query 'Reservations[].Instances[].Tags[?starts_with(Key, `kubernetes.io/cluster/`)].Key' \
			--output text 2>/dev/null | tr '\t' '\n' | sed -E 's#^kubernetes.io/cluster/##' \
			| grep -E -- "-${ENV}-" | sort -u | head -n1 || true)"
		[ -n "$cand" ] && CLUSTER="$cand"
	fi
	if [ -n "$CLUSTER" ]; then
		echo "  · cluster (secondary scope): ${CLUSTER}"
	else
		echo "  · no cluster found for ENV ${ENV} (nothing out-of-band to sweep, or already gone)"
	fi
}

# cluster_instance_ids — running/stopped EC2 tagged for THIS cluster (Karpenter + nodegroup),
# incl. those lacking project-id default_tags. Empty when CLUSTER unknown.
cluster_instance_ids() {
	[ -z "$CLUSTER" ] && return 0
	aws ec2 describe-instances \
		--filters "Name=tag:kubernetes.io/cluster/${CLUSTER},Values=owned,shared" \
		"Name=instance-state-name,Values=pending,running,stopping,stopped" \
		--query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

# cluster_lb_arns — ELBv2 ARNs tagged elbv2.k8s.aws/cluster=<CLUSTER>. Empty when CLUSTER unknown.
cluster_lb_arns() {
	[ -z "$CLUSTER" ] && return 0
	local arns arn
	arns="$(aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		if aws elbv2 describe-tags --resource-arns "$arn" \
			--query "TagDescriptions[].Tags[?Key=='elbv2.k8s.aws/cluster' && Value=='${CLUSTER}']" --output text 2>/dev/null | grep -q .; then
			printf '%s\n' "$arn"
		fi
	done <<<"$arns"
}

# cluster_volume_ids — EBS tagged kubernetes.io/cluster/<CLUSTER> (CSI fallback if extraVolumeTags
# didn't stamp project-id — grill F5). Empty when CLUSTER unknown.
cluster_volume_ids() {
	[ -z "$CLUSTER" ] && return 0
	aws ec2 describe-volumes \
		--filters "Name=tag:kubernetes.io/cluster/${CLUSTER},Values=owned,shared" "Name=status,Values=available,in-use" \
		--query 'Volumes[].VolumeId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

# ── 1. EC2 instances (tagged + cluster-tagged Karpenter/nodegroup). Terminate first: they hold
#       ENIs + reference SGs, blocking VPC teardown. ──
sweep_instances() {
	assert_scope
	local ids
	ids="$(
		{
			tagged_arns ec2:instance | while read -r a; do arn_id "$a"; done
			cluster_instance_ids
		} | grep -v '^$' | sort -u || true
	)"
	[ -z "$ids" ] && {
		echo "  · EC2 instances: none"
		return 0
	}
	echo "  · EC2 instances: $(printf '%s' "$ids" | grep -c .) to terminate"
	if [ "$DRY_RUN" != "1" ]; then
		# shellcheck disable=SC2086
		aws ec2 modify-instance-attribute --no-disable-api-termination --instance-ids $ids >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		aws ec2 terminate-instances --instance-ids $ids >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		aws ec2 wait instance-terminated --instance-ids $ids 2>/dev/null || true
	else
		# shellcheck disable=SC2086
		printf '      would terminate %s\n' $ids
	fi
}

# ── 2. Load balancers (LB-controller out-of-band) + target groups. Delete before subnets. ──
sweep_load_balancers() {
	local arns arn tgs tg
	arns="$(cluster_lb_arns)"
	if [ -n "$arns" ]; then
		echo "  · load balancers: $(printf '%s' "$arns" | grep -c .) to delete"
		while IFS= read -r arn; do
			[ -n "$arn" ] || continue
			retry_delete "elb $(arn_id "$arn")" aws elbv2 delete-load-balancer --load-balancer-arn "$arn"
		done <<<"$arns"
	else
		echo "  · load balancers: none"
	fi
	[ -z "$CLUSTER" ] && return 0
	tgs="$(aws elbv2 describe-target-groups --query 'TargetGroups[].TargetGroupArn' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r tg; do
		[ -n "$tg" ] || continue
		if aws elbv2 describe-tags --resource-arns "$tg" \
			--query "TagDescriptions[].Tags[?Key=='elbv2.k8s.aws/cluster' && Value=='${CLUSTER}']" --output text 2>/dev/null | grep -q .; then
			retry_delete "target-group $(arn_id "$tg")" aws elbv2 delete-target-group --target-group-arn "$tg"
		fi
	done <<<"$tgs"
}

# ── 3. EKS nodegroups + cluster (tofu-managed; sweep only if leaked past a killed destroy). ──
sweep_eks() {
	[ -z "$CLUSTER" ] && {
		echo "  · EKS: none"
		return 0
	}
	# describe-cluster is authoritative: skip cleanly if it is already gone.
	if ! aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
		echo "  · EKS cluster ${CLUSTER}: already gone"
		return 0
	fi
	local ngs ng
	ngs="$(aws eks list-nodegroups --cluster-name "$CLUSTER" --query 'nodegroups' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r ng; do
		[ -n "$ng" ] || continue
		retry_delete "nodegroup ${ng}" aws eks delete-nodegroup --cluster-name "$CLUSTER" --nodegroup-name "$ng"
	done <<<"$ngs"
	if [ "$DRY_RUN" != "1" ] && [ -n "$ngs" ]; then
		for ng in $ngs; do aws eks wait nodegroup-deleted --cluster-name "$CLUSTER" --nodegroup-name "$ng" 2>/dev/null || true; done
	fi
	retry_delete "eks cluster ${CLUSTER}" aws eks delete-cluster --name "$CLUSTER"
	[ "$DRY_RUN" != "1" ] && aws eks wait cluster-deleted --name "$CLUSTER" 2>/dev/null || true
}

# ── 4. NAT gateways (tagged) → wait → release their EIPs. ──
sweep_nat_and_eips() {
	assert_scope
	local nats nat eips eip
	nats="$(tagged_arns ec2:natgateway | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		retry_delete "nat-gateway ${nat}" aws ec2 delete-nat-gateway --nat-gateway-id "$nat"
	done <<<"$nats"
	if [ "$DRY_RUN" != "1" ] && [ -n "$nats" ]; then
		local waited=0 live
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			# shellcheck disable=SC2086,SC2016 # $nats: id list as args; backtick is JMESPath
			live="$(aws ec2 describe-nat-gateways --nat-gateway-ids $nats --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text 2>/dev/null | grep -c . || true)"
			[ "${live:-0}" -eq 0 ] && break
			echo "  · waiting for ${live} NAT gateway(s) to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 10
			waited=$((waited + 10))
		done
	fi
	eips="$(tagged_arns ec2:elastic-ip | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r eip; do
		[ -n "$eip" ] || continue
		retry_delete "eip ${eip}" aws ec2 release-address --allocation-id "$eip"
	done <<<"$eips"
}

# ── 5. EBS volumes (tagged pvc-* + cluster-tagged CSI fallback). Detach-force then delete. ──
sweep_volumes() {
	assert_scope
	local vols vol
	[ "$DRY_RUN" != "1" ] && sleep 10
	vols="$(
		{
			tagged_arns ec2:volume | while read -r a; do arn_id "$a"; done
			cluster_volume_ids
		} | grep -v '^$' | sort -u || true
	)"
	[ -z "$vols" ] && {
		echo "  · EBS volumes: none"
		return 0
	}
	echo "  · EBS volumes: $(printf '%s' "$vols" | grep -c .) to delete"
	while IFS= read -r vol; do
		[ -n "$vol" ] || continue
		[ "$DRY_RUN" = "1" ] && {
			echo "      would delete volume ${vol}"
			continue
		}
		aws ec2 detach-volume --volume-id "$vol" --force >/dev/null 2>&1 || true
		retry_delete "volume ${vol}" aws ec2 delete-volume --volume-id "$vol"
	done <<<"$vols"
}

# ── 6. Network teardown (tagged): ENIs → SGs → subnets → route tables (skip MAIN) → IGW → VPC. ──
sweep_network() {
	assert_scope
	local vpcs vpc enis eni sgs sg subnets subnet rts rt igws igw main

	enis="$(tagged_arns ec2:network-interface | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r eni; do
		[ -n "$eni" ] || continue
		retry_delete "eni ${eni}" aws ec2 delete-network-interface --network-interface-id "$eni"
	done <<<"$enis"

	sgs="$(tagged_arns ec2:security-group | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r sg; do
		[ -n "$sg" ] || continue
		retry_delete "security-group ${sg}" aws ec2 delete-security-group --group-id "$sg"
	done <<<"$sgs"

	subnets="$(tagged_arns ec2:subnet | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r subnet; do
		[ -n "$subnet" ] || continue
		retry_delete "subnet ${subnet}" aws ec2 delete-subnet --subnet-id "$subnet"
	done <<<"$subnets"

	# Route tables: the VPC's MAIN route table cannot be deleted (auto-removed with the VPC) —
	# attempting it fails forever, so skip it (grill F6).
	rts="$(tagged_arns ec2:route-table | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r rt; do
		[ -n "$rt" ] || continue
		# shellcheck disable=SC2016 # backticks are JMESPath, not command substitution
		main="$(aws ec2 describe-route-tables --route-table-ids "$rt" --query 'RouteTables[].Associations[?Main==`true`]' --output text 2>/dev/null || true)"
		if [ -n "$main" ]; then
			echo "      skip main route-table ${rt} (auto-removed with the VPC)"
			continue
		fi
		retry_delete "route-table ${rt}" aws ec2 delete-route-table --route-table-id "$rt"
	done <<<"$rts"

	vpcs="$(tagged_arns ec2:vpc | while read -r a; do arn_id "$a"; done)"
	igws="$(tagged_arns ec2:internet-gateway | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r igw; do
		[ -n "$igw" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			while IFS= read -r vpc; do
				[ -n "$vpc" ] || continue
				aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc" >/dev/null 2>&1 || true
			done <<<"$vpcs"
		fi
		retry_delete "internet-gateway ${igw}" aws ec2 delete-internet-gateway --internet-gateway-id "$igw"
	done <<<"$igws"

	while IFS= read -r vpc; do
		[ -n "$vpc" ] || continue
		retry_delete "vpc ${vpc}" aws ec2 delete-vpc --vpc-id "$vpc"
	done <<<"$vpcs"
}

# ── Final verification: a leak must NEVER exit green (grill F1/F2/F3). Uses tag-FILTERED
#    describes (union of the project-id tag AND the cluster tag), which — unlike `--instance-ids`
#    — never fail the whole call on an already-deregistered id (which would false-GREEN a mix of
#    gone+live), return ONLY currently-live resources (authoritative — no resourcegroupstaggingapi
#    lag ⇒ no false-RED), and cover BOTH the tofu-tagged and the out-of-band (Karpenter/ELB/CSI)
#    scopes. ──
by_tag_instances() {
	aws ec2 describe-instances \
		--filters "Name=tag:$1,Values=$2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
		--query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}
alive_instances() {
	{
		by_tag_instances "alethia:project-id" "$PROJECT_ID_TAG"
		[ -n "$CLUSTER" ] && by_tag_instances "kubernetes.io/cluster/${CLUSTER}" "owned,shared"
	} | grep -v '^$' | sort -u || true
}
by_tag_volumes() {
	aws ec2 describe-volumes \
		--filters "Name=tag:$1,Values=$2" "Name=status,Values=creating,available,in-use" \
		--query 'Volumes[].VolumeId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}
alive_volumes() {
	{
		by_tag_volumes "alethia:project-id" "$PROJECT_ID_TAG"
		[ -n "$CLUSTER" ] && by_tag_volumes "kubernetes.io/cluster/${CLUSTER}" "owned,shared"
	} | grep -v '^$' | sort -u || true
}
alive_nats() {
	# shellcheck disable=SC2016 # backtick is JMESPath
	aws ec2 describe-nat-gateways \
		--filter "Name=tag:alethia:project-id,Values=${PROJECT_ID_TAG}" \
		--query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}
alive_lbs() { cluster_lb_arns; }
alive_eks() { [ -n "$CLUSTER" ] && aws eks describe-cluster --name "$CLUSTER" --query 'cluster.name' --output text 2>/dev/null || true; }

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_instances)"; [ -n "$x" ] && leaks="${leaks}ec2-instance: $(join "$x")\n"
	x="$(alive_volumes)"; [ -n "$x" ] && leaks="${leaks}ebs-volume: $(join "$x")\n"
	x="$(alive_nats)"; [ -n "$x" ] && leaks="${leaks}nat-gateway: $(join "$x")\n"
	x="$(alive_lbs)"; [ -n "$x" ] && leaks="${leaks}load-balancer: $(join "$x")\n"
	x="$(alive_eks)"; [ -n "$x" ] && leaks="${leaks}eks-cluster: ${x}\n"
	if [ -n "$leaks" ]; then
		echo "  ✗ billable resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::aws cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never account-wide)." >&2
		return 1
	fi
	# Non-billable network residue (subnets/RT/SG/IGW/VPC still project-id-tagged) is a NOTICE, not
	# a hard fail — it ages out or indicates an upstream billable already caught above.
	local residue
	residue="$(tagged_arns | grep -E ':(subnet|route-table|security-group|internet-gateway|vpc|network-interface)/' || true)"
	# shellcheck disable=SC2086
	[ -n "$residue" ] && echo "::notice::aws cleanup: network residue still tagged (non-billable, will age out): $(printf '%s ' $residue)"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG/CLUSTER globals the sweep functions read, then runs them in the same strict
#    dependency order as the normal path. Returns verify_swept's status (0 clean / 1 leak); DRY_RUN
#    lists only and returns 0. Used by PREFLIGHT to sweep each discovered prior-run orphan. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	CLUSTER=""
	assert_scope
	discover_cluster
	sweep_instances
	sweep_load_balancers
	sweep_eks
	sweep_nat_and_eips
	sweep_volumes
	sweep_network
	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has project-id-tagged resources in this
#    region (prior-run orphans). Discovers all values of the `alethia:project-id` tag key via
#    get-tag-values, keeps only `e2e-`-prefixed values (never a real prod project-id), strips the
#    prefix, EXCLUDES this run (SELF_ENV), and re-validates each against the SAME specificity +
#    prod/shared denylist guards as the top-of-file ENV guards — so a preflight can never widen past
#    a genuine prior nightly. Empty output ⇒ nothing to sweep. ──
list_orphan_envs() {
	local vals v oenv
	vals="$(aws resourcegroupstaggingapi get-tag-values --key alethia:project-id \
		--query 'TagValues[]' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac # e2e-prefixed values only — never prod project-ids
		oenv="${v#e2e-}"
		[ "$oenv" = "$SELF_ENV" ] && continue # skip THIS run (its own teardown handles it)
		printf '%s' "$oenv" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$oenv" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data) continue ;;
		esac
		printf '%s\n' "$oenv"
	done <<<"$vals" | sort -u
}

# ── PREFLIGHT: sweep prior-run e2e orphans (NOT this run), best-effort + loud. ──
SELF_ENV="$ENV"
if [ "$PREFLIGHT" = "1" ]; then
	echo "→ aws STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	orphans="$(list_orphan_envs || true)"
	if [ -z "$orphans" ]; then
		echo "✓ preflight: no prior-run e2e orphans in ${REGION} — nothing to sweep"
		exit 0
	fi
	# shellcheck disable=SC2086
	echo "  orphan run ENVs found: $(printf '%s ' $orphans)"
	residual=0
	while IFS= read -r oenv; do
		[ -n "$oenv" ] || continue
		echo "── preflight sweep: prior run ${oenv} ──"
		if ! sweep_env "$oenv"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${oenv} (still billing) — the always() teardown / next preflight will retry. NOT failing this provisioning run."
			residual=1
		fi
	done <<<"$orphans"
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see warnings above) — continuing (best-effort, non-fatal)"
	else
		echo "✓ preflight complete — all prior-run e2e orphans in ${REGION} swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Orchestrate, in strict dependency order. ──
discover_cluster
sweep_instances
sweep_load_balancers
sweep_eks
sweep_nat_and_eips
sweep_volumes
sweep_network

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ aws DRY RUN complete for alethia:project-id=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
if ! verify_swept; then
	exit 1
fi
echo "✓ aws cleanup verified complete for run ${ENV} — no billable resources remain"
