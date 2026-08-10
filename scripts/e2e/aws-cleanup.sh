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
# ── WHAT IS COVERED, AND WHY THE LIST IS EXPLICIT ───────────────────────────────────────────────
# Compute/network was covered from the start; the STATEFUL half of a max-config project was not.
# Aurora (db.r6g.large), ElastiCache, DynamoDB, S3, ECR, Secrets Manager, SQS, SNS and four KMS keys
# were swept by nothing and — worse — verified by nothing, so a hard-killed run could leave an
# Aurora cluster running while this script printed "no billable resources remain" and exited 0. A
# sweeper that reports clean without looking is more expensive than no sweeper, because it stops
# anyone else looking. Everything now sweeps and verifies:
#
#   instances · ELBv2 + target groups · EKS · NAT + EIPs · EBS · RDS clusters + instances ·
#   ElastiCache replication groups · DynamoDB · S3 · ECR · Secrets Manager · SQS · SNS · KMS ·
#   network (ENI/SG/subnet/RT/IGW/VPC) · Route 53
#
# Adding a component to infra/templates/project/aws means adding it here too; that is not automated.
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
# ── PREFLIGHT budget (#2257). The preflight's "never blocks the provisioning run" promise is
# carried by `exit 0` at the end of its loop — which is only reached if the loop ENDS. It had no
# bound of any kind, and each sweep_env can legitimately burn minutes (DETACH_TIMEOUT waits for
# NAT gateways and for data services, plus EKS deletion). On run 31356854945 two orphans that
# cannot be swept — 29558347776-1 and 30518134684-1 — consumed the whole 90-minute job cap and the
# job was CANCELLED at 06:22, so `exit 0` never ran and the aws leg provisioned nothing at all.
# A best-effort step that can consume the job is not best-effort. Two bounds, both reported:
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

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

# ── 7. Route 53 hosted zones (tagged). NEW with #1754: until then the max-config `dns` fixture
#    used example.com, which AWS RESERVES, so the zone could never be created and there was
#    nothing here to leak. Now that the fixture uses a real name, a hard-killed run leaves a
#    billable zone ($0.50/month, forever) that `tofu destroy` never got to remove.
#
#    Route 53 is GLOBAL, so this is not region-scoped — which is exactly why the tag filter is
#    load-bearing rather than incidental: an unfiltered zone sweep in the shared platform account
#    would take out production DNS. tagged_arns() is the same mandatory per-run handle every
#    other sweep uses, and assert_scope refuses to proceed without it.
#
#    A zone only deletes once it holds nothing but its own NS + SOA. tofu owns any other record,
#    so on the graceful path this finds nothing; on the hard-kill path the zone is typically bare
#    (the fixture no longer requests an ACM validation record). Anything else is removed first
#    rather than letting the delete fail — a leak that "failed loudly" is still a leak.
sweep_route53() {
	assert_scope
	local zones zone rrs
	zones="$(tagged_arns route53:hostedzone | while read -r a; do arn_id "$a"; done | grep -v '^$' || true)"
	[ -z "$zones" ] && {
		echo "  · route53 hosted zones: none"
		return 0
	}
	echo "  · route53 hosted zones: $(printf '%s' "$zones" | grep -c .) to delete"
	while IFS= read -r zone; do
		[ -n "$zone" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			# Everything except the zone's own NS/SOA, as a single ChangeBatch of DELETEs.
			# shellcheck disable=SC2016 # the backticks are JMESPath literals, not a subshell
			rrs="$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" \
				--query 'ResourceRecordSets[?Type!=`NS` && Type!=`SOA`]' --output json 2>/dev/null || echo '[]')"
			if [ "$(printf '%s' "$rrs" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
				printf '%s' "$rrs" |
					jq '{Changes: [.[] | {Action: "DELETE", ResourceRecordSet: .}]}' \
						>"${TMPDIR:-/tmp}/r53-${zone}.json" 2>/dev/null || true
				aws route53 change-resource-record-sets --hosted-zone-id "$zone" \
					--change-batch "file://${TMPDIR:-/tmp}/r53-${zone}.json" >/dev/null 2>&1 || true
			fi
		fi
		retry_delete "route53 hosted-zone ${zone}" aws route53 delete-hosted-zone --id "$zone"
	done <<<"$zones"
}

# ── 8. Data services: Aurora/RDS + ElastiCache. THESE MUST GO BEFORE THE NETWORK SWEEP.
#
#    Neither was swept and neither was verified, so a hard-killed run left an Aurora cluster
#    (db.r6g.large, the most expensive thing the max-config fixture builds) and an ElastiCache
#    replication group running while the step exited 0. They are also the reason the network sweep
#    fails: both hold ENIs in the private subnets, so their subnets — and then the VPC — refuse to
#    delete for as long as they live. Deleting them here is what makes step 6 able to finish.
#
#    Both are tag-discovered like everything else. Final snapshots are explicitly skipped: a
#    snapshot of an e2e database is itself a billable artifact nothing would ever reclaim, and
#    RDS refuses the delete outright if neither a snapshot id nor the skip flag is given.
sweep_data_services() {
	assert_scope
	local ids id
	# Cluster INSTANCES first — a cluster with members refuses to delete.
	ids="$(tagged_arns rds:db | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "rds instance ${id}" aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups
	done <<<"$ids"
	ids="$(tagged_arns rds:cluster | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "rds cluster ${id}" aws rds delete-db-cluster --db-cluster-identifier "$id" --skip-final-snapshot
	done <<<"$ids"
	ids="$(tagged_arns elasticache:replicationgroup | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "elasticache replication-group ${id}" aws elasticache delete-replication-group --replication-group-id "$id" --no-retain-primary-cluster
	done <<<"$ids"

	# Wait for the ENIs to actually be released. Without this the network sweep runs against
	# subnets that are still in use and every delete fails — which, before the classification fix
	# below, was reported as a NOTICE and exited green.
	[ "$DRY_RUN" = "1" ] && return 0
	local waited=0 live
	while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
		live="$({ alive_rds_clusters; alive_rds_instances; alive_elasticache; } | grep -c . || true)"
		[ "${live:-0}" -eq 0 ] && break
		echo "  · waiting for ${live} data service(s) to finish deleting… (${waited}s/${DETACH_TIMEOUT}s)"
		sleep 15
		waited=$((waited + 15))
	done
}

# ── 9. Everything else the max-config fixture builds that nothing swept and nothing verified:
#       DynamoDB, S3, ECR, Secrets Manager, SQS, SNS, KMS. None of them holds an ENI, so they run
#       after the network teardown; all of them bill, and all of them carry the project-id tag via
#       the provider `default_tags` block (aws/main.tf:26), which is what makes them tag-discoverable
#       at all. ──
sweep_managed_services() {
	assert_scope
	local arns arn name

	# DynamoDB. `update-table --no-deletion-protection-enabled` first: the root template defaulted
	# deletion protection ON until this change, so a table built by an EARLIER apply is still
	# protected and DeleteTable on it is refused forever. Harmless on an unprotected table.
	arns="$(tagged_arns dynamodb:table)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(arn_id "$arn")"
		[ "$DRY_RUN" != "1" ] && aws dynamodb update-table --table-name "$name" --no-deletion-protection-enabled >/dev/null 2>&1 || true
		retry_delete "dynamodb table ${name}" aws dynamodb delete-table --table-name "$name"
	done <<<"$arns"

	# S3. A non-empty bucket cannot be deleted, and versioning leaves delete-markers that
	# `rm --recursive` does not remove — so purge object VERSIONS explicitly before the bucket.
	arns="$(tagged_arns s3)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		[ -n "$name" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			aws s3 rm "s3://${name}" --recursive >/dev/null 2>&1 || true
			purge_bucket_versions "$name"
		fi
		retry_delete "s3 bucket ${name}" aws s3api delete-bucket --bucket "$name"
	done <<<"$arns"

	arns="$(tagged_arns ecr:repository)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "ecr repository $(arn_id "$arn")" aws ecr delete-repository --repository-name "$(arn_id "$arn")" --force
	done <<<"$arns"

	# Secrets Manager. WITHOUT --force-delete-without-recovery a deleted secret sits in a 7-30 day
	# recovery window, still occupying its name, and describe-secret keeps returning it — so a
	# plain delete would leave verify_swept reporting a leak it could never clear.
	arns="$(tagged_arns secretsmanager:secret)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "secret ${arn##*:}" aws secretsmanager delete-secret --secret-id "$arn" --force-delete-without-recovery
	done <<<"$arns"

	# SQS deletes by queue URL, not ARN; the queue name is the ARN's last segment.
	arns="$(tagged_arns sqs)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		local url
		url="$(aws sqs get-queue-url --queue-name "$name" --query 'QueueUrl' --output text 2>/dev/null || true)"
		[ -n "$url" ] && [ "$url" != "None" ] || continue
		retry_delete "sqs queue ${name}" aws sqs delete-queue --queue-url "$url"
	done <<<"$arns"

	arns="$(tagged_arns sns)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "sns topic ${arn##*:}" aws sns delete-topic --topic-arn "$arn"
	done <<<"$arns"

	# KMS. There is NO immediate delete — a customer-managed key can only be SCHEDULED for
	# deletion, minimum 7 days, and it bills $1/key/month until it actually goes. Four keys is
	# $4/month per leaked run, which is why they belong here. It also means a key sitting in
	# PendingDeletion is as swept as a key can be, and alive_kms_keys() below must not call that a
	# leak — otherwise every clean run would fail its own verification.
	arns="$(tagged_arns kms:key)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(arn_id "$arn")"
		# Never touch an AWS-managed key. The tag filter already excludes them (they carry no
		# default_tags), but a scheduled deletion is irreversible and cheap to guard twice.
		if [ "$(aws kms describe-key --key-id "$name" --query 'KeyMetadata.KeyManager' --output text 2>/dev/null || echo UNKNOWN)" != "CUSTOMER" ]; then
			echo "      skip kms key ${name} (not customer-managed)"
			continue
		fi
		retry_delete "kms key ${name} (schedule 7d)" aws kms schedule-key-deletion --key-id "$name" --pending-window-in-days 7
	done <<<"$arns"
}

# purge_bucket_versions <bucket> — delete every object VERSION and delete-marker, in batches of
# 1000 (the DeleteObjects cap). A versioned bucket is not empty just because `s3 rm` returned.
purge_bucket_versions() {
	local bucket="$1" raw payload
	while :; do
		raw="$(aws s3api list-object-versions --bucket "$bucket" --max-keys 1000 --output json 2>/dev/null || echo '{}')"
		# Versions AND DeleteMarkers — a bucket holding only delete-markers still refuses to delete.
		payload="$(printf '%s' "$raw" | jq -c '{Objects: (((.Versions // []) + (.DeleteMarkers // [])) | map({Key, VersionId}))}' 2>/dev/null || echo '{"Objects":[]}')"
		[ "$(printf '%s' "$payload" | jq '.Objects | length' 2>/dev/null || echo 0)" -gt 0 ] || break
		aws s3api delete-objects --bucket "$bucket" --delete "$payload" >/dev/null 2>&1 || break
	done
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

# A surviving hosted zone bills at $0.50/month FOREVER — small per run, but it never ages out and
# nothing else would ever notice it. Unlike the describes above there is no tag-filtered Route 53
# list API, so this goes through the tagging API; its lag can only make this MISS a leak (a
# false-green already covered by the next run's sweep), never invent one.
alive_zones() { tagged_arns route53:hostedzone | while read -r a; do arn_id "$a"; done; }

# ── The eight types that were swept by nothing and verified by nothing. Each takes the tagged ARN
#    list and then CONFIRMS the resource with an authoritative per-service describe, the same
#    posture the compute probes use: the tagging API can lag behind a delete, and a lagging list on
#    its own would false-RED a clean run. Confirming can only make these MISS a leak the tagging API
#    has not caught up to yet — which the next run's PREFLIGHT sweeps — never invent one.
#
#    Terminal states are NOT leaks. A resource in `deleting` has been swept; reporting it would fail
#    every well-behaved run. That distinction is load-bearing for KMS in particular, where
#    PendingDeletion is the ONLY end state a sweeper can reach. ──
alive_rds_clusters() {
	local id
	for id in $(tagged_arns rds:cluster | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016 # backtick is JMESPath
		aws rds describe-db-clusters --db-cluster-identifier "$id" \
			--query 'DBClusters[?Status!=`deleting`].DBClusterIdentifier' --output text 2>/dev/null || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_rds_instances() {
	local id
	for id in $(tagged_arns rds:db | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016
		aws rds describe-db-instances --db-instance-identifier "$id" \
			--query 'DBInstances[?DBInstanceStatus!=`deleting`].DBInstanceIdentifier' --output text 2>/dev/null || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_elasticache() {
	local id
	for id in $(tagged_arns elasticache:replicationgroup | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016
		aws elasticache describe-replication-groups --replication-group-id "$id" \
			--query 'ReplicationGroups[?Status!=`deleting`].ReplicationGroupId' --output text 2>/dev/null || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_ddb_tables() {
	# describe-table returns `Table` as an OBJECT, not a list — a `[?…]` filter projection over it
	# silently evaluates to null, which would report every table as gone. Read the scalar status and
	# compare in shell instead.
	local id state
	for id in $(tagged_arns dynamodb:table | while read -r a; do arn_id "$a"; done); do
		state="$(aws dynamodb describe-table --table-name "$id" --query 'Table.TableStatus' --output text 2>/dev/null || true)"
		case "$state" in "" | None | DELETING) ;; *) printf '%s\n' "$id" ;; esac
	done
}
alive_s3_buckets() {
	local arn name
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		[ -n "$name" ] || continue
		aws s3api head-bucket --bucket "$name" >/dev/null 2>&1 && printf '%s\n' "$name"
	done <<<"$(tagged_arns s3)"
}
alive_ecr_repos() {
	local id
	for id in $(tagged_arns ecr:repository | while read -r a; do arn_id "$a"; done); do
		aws ecr describe-repositories --repository-names "$id" \
			--query 'repositories[].repositoryName' --output text 2>/dev/null || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_secrets() {
	local arn
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		aws secretsmanager describe-secret --secret-id "$arn" >/dev/null 2>&1 && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns secretsmanager:secret)"
}
alive_sqs_queues() {
	local arn url
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		url="$(aws sqs get-queue-url --queue-name "${arn##*:}" --query 'QueueUrl' --output text 2>/dev/null || true)"
		[ -n "$url" ] && [ "$url" != "None" ] && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns sqs)"
}
alive_sns_topics() {
	local arn
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		aws sns get-topic-attributes --topic-arn "$arn" >/dev/null 2>&1 && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns sns)"
}
alive_kms_keys() {
	# A key SCHEDULED for deletion is swept — 7 days is the shortest window AWS offers and nothing
	# can shorten it. Only a key still Enabled/Disabled means the sweep did not reach it.
	local id state
	for id in $(tagged_arns kms:key | while read -r a; do arn_id "$a"; done); do
		state="$(aws kms describe-key --key-id "$id" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || true)"
		case "$state" in Enabled | Disabled) printf '%s\n' "$id" ;; esac
	done
}

# ── Tag-FILTERED network describes. Authoritative and lag-free (they return only live resources),
#    unlike the resourcegroupstaggingapi list this used to grep. The default security group and a
#    VPC's main route table are excluded because neither can be deleted on its own — they go with
#    the VPC, and the VPC is reported in its own right, so listing them would be noise that trains
#    people to ignore the output. ──
net_by_tag() {
	aws ec2 "$1" --filters "Name=tag:alethia:project-id,Values=${PROJECT_ID_TAG}" \
		--query "$2" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}
alive_network() {
	{
		net_by_tag describe-vpcs 'Vpcs[].VpcId'
		net_by_tag describe-subnets 'Subnets[].SubnetId'
		net_by_tag describe-internet-gateways 'InternetGateways[].InternetGatewayId'
		net_by_tag describe-network-interfaces 'NetworkInterfaces[].NetworkInterfaceId'
		# shellcheck disable=SC2016 # backticks are JMESPath
		net_by_tag describe-security-groups 'SecurityGroups[?GroupName!=`default`].GroupId'
		# shellcheck disable=SC2016
		net_by_tag describe-route-tables 'RouteTables[?!not_null(Associations[?Main==`true`] | [0])].RouteTableId'
	} | sort -u || true
}

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_instances)"; [ -n "$x" ] && leaks="${leaks}ec2-instance: $(join "$x")\n"
	x="$(alive_volumes)"; [ -n "$x" ] && leaks="${leaks}ebs-volume: $(join "$x")\n"
	x="$(alive_nats)"; [ -n "$x" ] && leaks="${leaks}nat-gateway: $(join "$x")\n"
	x="$(alive_lbs)"; [ -n "$x" ] && leaks="${leaks}load-balancer: $(join "$x")\n"
	x="$(alive_eks)"; [ -n "$x" ] && leaks="${leaks}eks-cluster: ${x}\n"
	x="$(alive_zones)"; [ -n "$x" ] && leaks="${leaks}route53-hosted-zone: $(join "$x")\n"
	# The data + managed services. Aurora is the single most expensive survivor a killed run can
	# leave, and until this change nothing here was looked at even once.
	x="$(alive_rds_clusters)"; [ -n "$x" ] && leaks="${leaks}rds-cluster: $(join "$x")\n"
	x="$(alive_rds_instances)"; [ -n "$x" ] && leaks="${leaks}rds-instance: $(join "$x")\n"
	x="$(alive_elasticache)"; [ -n "$x" ] && leaks="${leaks}elasticache-replication-group: $(join "$x")\n"
	x="$(alive_ddb_tables)"; [ -n "$x" ] && leaks="${leaks}dynamodb-table: $(join "$x")\n"
	x="$(alive_s3_buckets)"; [ -n "$x" ] && leaks="${leaks}s3-bucket: $(join "$x")\n"
	x="$(alive_ecr_repos)"; [ -n "$x" ] && leaks="${leaks}ecr-repository: $(join "$x")\n"
	x="$(alive_secrets)"; [ -n "$x" ] && leaks="${leaks}secretsmanager-secret: $(join "$x")\n"
	x="$(alive_sqs_queues)"; [ -n "$x" ] && leaks="${leaks}sqs-queue: $(join "$x")\n"
	x="$(alive_sns_topics)"; [ -n "$x" ] && leaks="${leaks}sns-topic: $(join "$x")\n"
	x="$(alive_kms_keys)"; [ -n "$x" ] && leaks="${leaks}kms-key: $(join "$x")\n"

	# ── Surviving network is a LEAK, not a notice. ──
	# It used to be a `::notice::` on the reasoning that subnets and VPCs are free. They are, but
	# that is not what a surviving subnet MEANS: these deletes only fail while something still holds
	# an ENI in them, and the things that hold ENIs — RDS, ElastiCache, a load balancer, a lingering
	# ENI of any kind — are exactly the billable survivors. So the one signal that something
	# expensive is still alive was being printed as an FYI and the step exited 0. It is also the
	# only signal left when the billable holder is a type this script does not model at all.
	x="$(alive_network)"; [ -n "$x" ] && leaks="${leaks}network(vpc/subnet/eni/sg/rt/igw — SOMETHING STILL HOLDS AN ENI): $(join "$x")\n"

	if [ -n "$leaks" ]; then
		echo "  ✗ resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::aws cleanup INCOMPLETE — resources for run ${ENV} still exist (billable, or network still held by something billable). Investigate + remove (stay scope-locked; never account-wide)." >&2
		return 1
	fi
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
	sweep_data_services
	sweep_nat_and_eips
	sweep_volumes
	sweep_network
	sweep_managed_services
	sweep_route53
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
	echo "  budget: ${PREFLIGHT_BUDGET_SECONDS}s wall-clock, at most ${PREFLIGHT_MAX_ENVS} orphan(s) this run"
	residual=0
	attempted=0
	deadline=$(($(date +%s) + PREFLIGHT_BUDGET_SECONDS))
	# Anything the bounds stop us from reaching is named, not silently dropped — an unswept orphan
	# is BILLING, so "we ran out of budget" has to be as visible as "we tried and failed".
	skipped=""
	while IFS= read -r oenv; do
		[ -n "$oenv" ] || continue
		if [ "$attempted" -ge "$PREFLIGHT_MAX_ENVS" ]; then
			skipped="${skipped}${oenv} (cap) "
			continue
		fi
		now=$(date +%s)
		if [ "$now" -ge "$deadline" ]; then
			skipped="${skipped}${oenv} (budget) "
			continue
		fi
		attempted=$((attempted + 1))
		echo "── preflight sweep: prior run ${oenv} (${attempted}/${PREFLIGHT_MAX_ENVS}, $((deadline - now))s budget left) ──"
		if ! sweep_env "$oenv"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${oenv} (still billing) — the always() teardown / next preflight will retry. NOT failing this provisioning run."
			residual=1
		fi
	done <<<"$orphans"
	if [ -n "$skipped" ]; then
		# ::error:: (not ::warning::) because a bounded preflight that keeps deferring the SAME
		# orphan every night is how 29558347776-1 survived long enough to eat a job cap. This is
		# the signal that a human has to sweep it by hand; it still does not fail the step.
		echo "::error::preflight left orphan(s) UNSWEPT and BILLING — bounds reached before they were reached: ${skipped}"
		echo "::error::sweep by hand, scope-locked: ALETHIA_E2E_ENV=<env> ALETHIA_E2E_REGION=${REGION} ./scripts/e2e/aws-cleanup.sh"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see above) — continuing (best-effort, non-fatal)"
	else
		echo "✓ preflight complete — all prior-run e2e orphans in ${REGION} swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Orchestrate, in strict dependency order. sweep_data_services sits BEFORE the network teardown
#    because RDS and ElastiCache hold ENIs in the private subnets; sweep_managed_services sits after
#    it because nothing it touches does. ──
discover_cluster
sweep_instances
sweep_load_balancers
sweep_eks
sweep_data_services
sweep_nat_and_eips
sweep_volumes
sweep_network
sweep_managed_services
sweep_route53

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ aws DRY RUN complete for alethia:project-id=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
if ! verify_swept; then
	exit 1
fi
echo "✓ aws cleanup verified complete for run ${ENV} — no billable resources remain"
