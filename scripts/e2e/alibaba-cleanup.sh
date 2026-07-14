#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alibaba-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (Alibaba/ACK).
#
# Cloned guard-for-guard from scripts/e2e/aws-cleanup.sh (BYOC A1.3) and hcloud-cleanup.sh
# (A1.3). The T2 harness tears the cluster down GRACEFULLY in-process via `tofu destroy`
# (provisioner.RunDestroy) on the normal path. But if the test PROCESS is hard-killed (a
# `go test -timeout` panic, a CI step SIGKILL, a runner crash), t.Cleanup never runs and REAL,
# billable Alibaba resources leak — most dangerously the OUT-OF-BAND ones tofu never tracked:
# the ACK node-pool ECS instances, the CCM-created SLB/ALB load balancers, and the CSI-created
# `pvc-*` cloud disks. This script is the guarantee: the nightly runs it in an `always()` step
# so the run's resources are gone no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The Alibaba account is SHARED (like the hcloud + AWS accounts). An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * DISCOVERY is tag-driven. Every resource the alibaba project template creates inherits the
#     unique per-run handle `alethia:project-id=e2e-<ENV>` (locals.common_tags → every module's
#     `tags`; see infra/templates/project/alibaba/locals.tf + packages/core/cloud/tags.go
#     alibabaTagStyle). Alibaba tag filters (`--Tag.N.Key`/`--Tag.N.Value`) are EXACT matches, no
#     wildcards. ENV = <run_id>-<attempt>, unique per run.
#   * OUT-OF-BAND resources that do NOT inherit the template `tags` (CSI `pvc-*` cloud disks; the
#     CCM's SLB/ALB) are swept by a SECONDARY filter bound to THIS run's ACK cluster — discovered
#     from the tagged/named ACK cluster, keyed on the `ack.aliyun.com=<cluster_id>` tag ACK stamps
#     on cluster-owned cloud resources. If the cluster is already gone (a mid-destroy kill), the
#     cluster is re-found from any ACK cluster whose NAME embeds `-<ENV>` (the ACK name is
#     `<project>-<env>`, locals.ack_name) so the orphans are still found + swept + VERIFIED. Still
#     never account-wide: the secondary equality match on `<cluster_id>` (unique per run) excludes
#     every other run's / prod's resources.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last
#     line of defence — a leak NEVER exits green: verify_swept re-lists the tagged + cluster-owned
#     scopes and fails the step on any surviving BILLABLE resource (ACK/ECS/disks/SLB/ALB), so a
#     real leak can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=eu-central-1 ./scripts/e2e/alibaba-cleanup.sh
#   (positional $1 accepted for call-site symmetry with hcloud-cleanup.sh but IGNORED — the managed
#    sweepers read their scope from ALETHIA_E2E_ENV / _PROJECT / _REGION.)
#   ALETHIA_E2E_PROJECT=<project>   # optional; when set the ACK cluster name (<project>-<env>) is
#                                   # matched EXACTLY in addition to the tag, tightening discovery.
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# Requires: the `aliyun` CLI (authenticated — keyless AssumeRoleWithOIDC in CI) + jq.
set -euo pipefail

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only. A silent fallback to an ambient region that
# differs from where the run provisioned would make every (regional) tag query empty → delete
# nothing, verify nothing, exit green while the real region bills (aws-cleanup grill F3).
REGION="${ALETHIA_E2E_REGION:-}"
PROJECT="${ALETHIA_E2E_PROJECT:-}"
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

for bin in aliyun jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "✗ the '$bin' CLI is not installed." >&2
		exit 2
	fi
done

TAGK="alethia:project-id"          # the Alibaba sweep-handle key (alibabaTagStyle: colon-namespaced)
PROJECT_ID_TAG="e2e-${ENV}"        # its unique per-run value (config.ID = e2e-<env>)
CLUSTER_NAME=""                    # the ACK cluster name (<project>-<env>); may be derived below
CLUSTER_ID=""                      # the ACK cluster id — the secondary (out-of-band) scope

# ── ali <product> <ApiName> [--params…] — every aliyun call goes through here so the region is
#    pinned on ONE line. `--region` sets the endpoint region AND populates RegionId for RPC APIs,
#    so a call can never silently hit the wrong (or a default) region. ──
ali() { aliyun "$@" --region "$REGION"; }

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ]; then
	echo "→ alibaba belt-and-suspenders cleanup in ${REGION}, scope ${TAGK}=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

# assert_scope fails closed if the scope ever became empty (defensive — the guards above already
# ensure it can't, but never issue a tag-less aliyun call).
assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# looks_gone <stderr-text> — true if an aliyun delete error means the resource is already absent
# (idempotency: eventual consistency can list an already-deleted id; a NotFound on delete is
# success, not failure). Covers Alibaba's `Invalid<Res>Id.NotFound`, the generic `NotFound`, the
# ACK `ErrorClusterNotFound`, and the "does not exist" family.
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'NotFound|does not exist|not exist|InvalidResourceId\.NotFound|ErrorClusterNotFound|InvalidLoadBalancerId|Forbidden\.InstanceNotFound'
}

# retry_delete <human> <cmd...> — delete with backoff. "Already gone" = success. NEVER returns
# non-zero (so `set -e` can't abort the sweep BEFORE verify_swept, the real gate — aws grill F4);
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

################################################################################
# Tag-filtered discovery (primary scope) — one function per service. Each is tag-mandatory;
# none ever returns an unscoped list. jq's `?` swallows a missing key so an empty/oddly-shaped
# response degrades to "none", not an error.
################################################################################

# ecs_ids <DescribeApi> <jqPath> — generic ECS/VPC RPC lister, filtered on our project-id tag.
tagged_ids() {
	assert_scope
	local product="$1" api="$2" jqpath="$3"
	ali "$product" "$api" \
		--PageSize 100 \
		--Tag.1.Key "$TAGK" --Tag.1.Value "$PROJECT_ID_TAG" 2>/dev/null |
		jq -r "$jqpath" 2>/dev/null | grep -v '^$' || true
}

tagged_instances() { tagged_ids ecs DescribeInstances '.Instances.Instance[]?.InstanceId'; }
tagged_disks() { tagged_ids ecs DescribeDisks '.Disks.Disk[]?.DiskId'; }
tagged_security_groups() { tagged_ids ecs DescribeSecurityGroups '.SecurityGroups.SecurityGroup[]?.SecurityGroupId'; }
tagged_vpcs() { tagged_ids vpc DescribeVpcs '.Vpcs.Vpc[]?.VpcId'; }
tagged_vswitches() { tagged_ids vpc DescribeVSwitches '.VSwitches.VSwitch[]?.VSwitchId'; }
tagged_nat_gateways() { tagged_ids vpc DescribeNatGateways '.NatGateways.NatGateway[]?.NatGatewayId'; }
tagged_eips() { tagged_ids vpc DescribeEipAddresses '.EipAddresses.EipAddress[]?.AllocationId'; }

# SLB (classic) tag filter param spelling differs per API version; use the documented Tag.N.Key.
tagged_slbs() { tagged_ids slb DescribeLoadBalancers '.LoadBalancers.LoadBalancer[]?.LoadBalancerId'; }
# ALB lister is ROA-ish RPC (`ListLoadBalancers` → `.LoadBalancers[].LoadBalancerId`).
tagged_albs() {
	assert_scope
	ali alb ListLoadBalancers \
		--Tag.1.Key "$TAGK" --Tag.1.Value "$PROJECT_ID_TAG" 2>/dev/null |
		jq -r '.LoadBalancers[]?.LoadBalancerId' 2>/dev/null | grep -v '^$' || true
}

################################################################################
# Cluster discovery + out-of-band (cluster-owned) scope. The ACK CCM/CSI stamp
# `ack.aliyun.com=<cluster_id>` on the SLB/ALB/disks they create out-of-band; those do NOT carry
# the template project-id tag, so they are swept via this SECONDARY, cluster-scoped filter. It is
# only ever populated once CLUSTER_ID is known (a unique per-run value) — never account-wide.
################################################################################

# all_clusters — the ACK cluster inventory in this region as compact JSON lines
# {id,name,tags}. `aliyun cs GET /api/v1/clusters` returns {"clusters":[…]} (or, on older CLIs, a
# bare array) — handle both.
all_clusters() {
	ali cs GET /api/v1/clusters 2>/dev/null |
		jq -c '(.clusters // .)[]? | {id: .cluster_id, name: .name, region: .region_id,
			pid: ((.tags // []) | map(select(.key == "'"$TAGK"'") | .value) | first) }' 2>/dev/null || true
}

# ── Discover THIS run's ACK cluster for the out-of-band secondary sweeps. First by the project-id
#    tag on the cluster; if the cluster is already gone or untagged (a mid tofu-destroy kill), fall
#    back to any cluster whose NAME embeds `-<ENV>` (ack_name = <project>-<env>) — and, when
#    ALETHIA_E2E_PROJECT is set, the EXACT `<project>-<env>` name. Never guessed past this run. ──
discover_cluster() {
	assert_scope
	local rows exact="" byname="" bytag=""
	rows="$(all_clusters)"
	[ -z "$rows" ] && {
		echo "  · no ACK clusters visible (nothing out-of-band to sweep, or already gone)"
		return 0
	}
	# Only ever consider clusters in THIS region (region_id must match).
	rows="$(printf '%s\n' "$rows" | jq -c "select(.region == \"$REGION\")" 2>/dev/null || true)"

	bytag="$(printf '%s\n' "$rows" | jq -r "select(.pid == \"$PROJECT_ID_TAG\") | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	byname="$(printf '%s\n' "$rows" | jq -r "select(.name | test(\"-${ENV}(\$|-)\")) | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	if [ -n "$PROJECT" ]; then
		exact="$(printf '%s\n' "$rows" | jq -r "select(.name == \"${PROJECT}-${ENV}\") | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	fi

	local pick="${bytag:-${exact:-$byname}}"
	if [ -n "$pick" ]; then
		CLUSTER_ID="$(printf '%s' "$pick" | cut -f1)"
		CLUSTER_NAME="$(printf '%s' "$pick" | cut -f2)"
		echo "  · cluster (secondary scope): ${CLUSTER_NAME} [${CLUSTER_ID}]"
	else
		echo "  · no cluster found for ENV ${ENV} (nothing out-of-band to sweep, or already gone)"
	fi
}

# cluster_tagged_ids <product> <api> <jqpath> — resources carrying the ACK `ack.aliyun.com=<id>`
# tag (out-of-band CCM/CSI resources). Empty when CLUSTER_ID unknown (never account-wide).
cluster_tagged_ids() {
	[ -z "$CLUSTER_ID" ] && return 0
	local product="$1" api="$2" jqpath="$3"
	ali "$product" "$api" \
		--PageSize 100 \
		--Tag.1.Key "ack.aliyun.com" --Tag.1.Value "$CLUSTER_ID" 2>/dev/null |
		jq -r "$jqpath" 2>/dev/null | grep -v '^$' || true
}

cluster_instance_ids() { cluster_tagged_ids ecs DescribeInstances '.Instances.Instance[]?.InstanceId'; }
cluster_disk_ids() { cluster_tagged_ids ecs DescribeDisks '.Disks.Disk[]?.DiskId'; }
cluster_slb_ids() { cluster_tagged_ids slb DescribeLoadBalancers '.LoadBalancers.LoadBalancer[]?.LoadBalancerId'; }
cluster_alb_ids() {
	[ -z "$CLUSTER_ID" ] && return 0
	ali alb ListLoadBalancers \
		--Tag.1.Key "ack.aliyun.com" --Tag.1.Value "$CLUSTER_ID" 2>/dev/null |
		jq -r '.LoadBalancers[]?.LoadBalancerId' 2>/dev/null | grep -v '^$' || true
}

################################################################################
# Sweep, in strict dependency order:
#   1. SLB / ALB   — CCM out-of-band; free their listeners before subnets/cluster go
#   2. ACK cluster — reclaims the node-pool ECS instances (+ most cluster-owned infra)
#   3. orphan ECS  — any node instance the cluster delete didn't reclaim
#   4. CSI disks   — dynamically-provisioned pvc-* cloud disks (detach-safe)
#   5. VPC residue — SNAT → NAT → EIP → security groups → vswitches → VPC
################################################################################

# ── 1. Load balancers (SLB classic + ALB), both tagged + cluster-owned (CCM). ──
sweep_load_balancers() {
	assert_scope
	local ids id
	ids="$({
		tagged_slbs
		cluster_slb_ids
	} | grep -v '^$' | sort -u || true)"
	if [ -z "$ids" ]; then
		echo "  · SLB load balancers: none"
	else
		echo "  · SLB load balancers: $(printf '%s' "$ids" | grep -c .) to delete"
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			retry_delete "slb ${id}" ali slb DeleteLoadBalancer --LoadBalancerId "$id"
		done <<<"$ids"
	fi
	ids="$({
		tagged_albs
		cluster_alb_ids
	} | grep -v '^$' | sort -u || true)"
	if [ -z "$ids" ]; then
		echo "  · ALB load balancers: none"
	else
		echo "  · ALB load balancers: $(printf '%s' "$ids" | grep -c .) to delete"
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			retry_delete "alb ${id}" ali alb DeleteLoadBalancer --LoadBalancerId "$id"
		done <<<"$ids"
	fi
}

# ── 2. ACK cluster (tofu-managed; sweep only if leaked past a killed destroy). Deleting the
#       cluster reclaims its node-pool ECS + most cluster-owned infra. ──
sweep_cluster() {
	[ -z "$CLUSTER_ID" ] && {
		echo "  · ACK cluster: none"
		return 0
	}
	retry_delete "ack cluster ${CLUSTER_NAME} [${CLUSTER_ID}]" ali cs DELETE "/clusters/${CLUSTER_ID}"
	if [ "$DRY_RUN" != "1" ]; then
		local waited=0
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			# describe returns non-zero (ErrorClusterNotFound) once the cluster is gone.
			ali cs GET "/api/v1/clusters/${CLUSTER_ID}" >/dev/null 2>&1 || break
			echo "  · waiting for ACK cluster ${CLUSTER_ID} to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 15
			waited=$((waited + 15))
		done
	fi
}

# ── 3. Orphan ECS instances (tagged node-pool ECS + cluster-owned). Terminate any node the
#       cluster delete didn't reclaim; they hold ENIs + disks blocking the VPC/disk teardown. ──
sweep_instances() {
	assert_scope
	local ids id
	ids="$({
		tagged_instances
		cluster_instance_ids
	} | grep -v '^$' | sort -u || true)"
	[ -z "$ids" ] && {
		echo "  · ECS instances: none"
		return 0
	}
	echo "  · ECS instances: $(printf '%s' "$ids" | grep -c .) to terminate"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		# --Force stops-then-releases a running instance in one call; --TerminateSubscription
		# releases any (unexpected) subscription instance too.
		retry_delete "ecs ${id}" ali ecs DeleteInstance --InstanceId "$id" --Force true
	done <<<"$ids"
}

# ── 4. CSI cloud disks (tagged pvc-* + cluster-owned CSI fallback). Detach then delete. ──
sweep_disks() {
	assert_scope
	local ids id
	[ "$DRY_RUN" != "1" ] && sleep 10
	ids="$({
		tagged_disks
		cluster_disk_ids
	} | grep -v '^$' | sort -u || true)"
	[ -z "$ids" ] && {
		echo "  · cloud disks: none"
		return 0
	}
	echo "  · cloud disks: $(printf '%s' "$ids" | grep -c .) to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		[ "$DRY_RUN" = "1" ] && {
			echo "      would delete disk ${id}"
			continue
		}
		ali ecs DetachDisk --DiskId "$id" >/dev/null 2>&1 || true
		retry_delete "disk ${id}" ali ecs DeleteDisk --DiskId "$id"
	done <<<"$ids"
}

# ── 5. VPC teardown (all tagged): SNAT entries → NAT gateways → EIPs → security groups →
#       vswitches → VPC. Dependency order; retry_delete's backoff absorbs residual races. ──
sweep_network() {
	assert_scope
	local nats nat eips eip sgs sg vsws vsw vpcs vpc

	# SNAT entries hang off the NAT gateway's snat table; delete them before the NAT gateway.
	nats="$(tagged_nat_gateways)"
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		# List this NAT's snat table + entries, then delete each entry.
		local stid entries eid
		stid="$(ali vpc DescribeNatGateways --NatGatewayId "$nat" 2>/dev/null |
			jq -r '.NatGateways.NatGateway[]?.SnatTableIds.SnatTableId[]?' 2>/dev/null | head -n1 || true)"
		if [ -n "$stid" ]; then
			entries="$(ali vpc DescribeSnatTableEntries --SnatTableId "$stid" 2>/dev/null |
				jq -r '.SnatTableEntries.SnatTableEntry[]?.SnatEntryId' 2>/dev/null | grep -v '^$' || true)"
			while IFS= read -r eid; do
				[ -n "$eid" ] || continue
				retry_delete "snat-entry ${eid}" ali vpc DeleteSnatEntry --SnatTableId "$stid" --SnatEntryId "$eid"
			done <<<"$entries"
		fi
	done <<<"$nats"

	# NAT gateways (--Force detaches remaining bindings).
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		retry_delete "nat-gateway ${nat}" ali vpc DeleteNatGateway --NatGatewayId "$nat" --Force true
	done <<<"$nats"
	if [ "$DRY_RUN" != "1" ] && [ -n "$nats" ]; then
		local waited=0 live
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			live="$(tagged_nat_gateways | grep -c . || true)"
			[ "${live:-0}" -eq 0 ] && break
			echo "  · waiting for ${live} NAT gateway(s) to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 10
			waited=$((waited + 10))
		done
	fi

	# EIPs (unassociate-then-release; ReleaseEipAddress refuses while still bound).
	eips="$(tagged_eips)"
	while IFS= read -r eip; do
		[ -n "$eip" ] || continue
		[ "$DRY_RUN" != "1" ] && ali vpc UnassociateEipAddress --AllocationId "$eip" >/dev/null 2>&1 || true
		retry_delete "eip ${eip}" ali vpc ReleaseEipAddress --AllocationId "$eip"
	done <<<"$eips"

	# Security groups (now unreferenced by any deleted ECS).
	sgs="$(tagged_security_groups)"
	while IFS= read -r sg; do
		[ -n "$sg" ] || continue
		retry_delete "security-group ${sg}" ali ecs DeleteSecurityGroup --SecurityGroupId "$sg"
	done <<<"$sgs"

	# Vswitches (subnets), then the VPC.
	vsws="$(tagged_vswitches)"
	while IFS= read -r vsw; do
		[ -n "$vsw" ] || continue
		retry_delete "vswitch ${vsw}" ali vpc DeleteVSwitch --VSwitchId "$vsw"
	done <<<"$vsws"

	vpcs="$(tagged_vpcs)"
	while IFS= read -r vpc; do
		[ -n "$vpc" ] || continue
		retry_delete "vpc ${vpc}" ali vpc DeleteVpc --VpcId "$vpc"
	done <<<"$vpcs"
}

################################################################################
# Final verification: a leak must NEVER exit green. Re-list the BILLABLE scopes (tagged + cluster-
# owned) authoritatively and fail the step on any survivor. Non-billable network residue
# (vswitch/SG/VPC still tagged) is a NOTICE, not a hard fail — it ages out or points at an
# upstream billable already caught above.
################################################################################
alive_cluster() {
	[ -z "$CLUSTER_ID" ] && return 0
	all_clusters | jq -r "select(.id == \"$CLUSTER_ID\") | .id" 2>/dev/null | grep -v '^$' || true
}
alive_instances() { {
	tagged_instances
	cluster_instance_ids
} | grep -v '^$' | sort -u || true; }
alive_disks() { {
	tagged_disks
	cluster_disk_ids
} | grep -v '^$' | sort -u || true; }
alive_slbs() { {
	tagged_slbs
	cluster_slb_ids
} | grep -v '^$' | sort -u || true; }
alive_albs() { {
	tagged_albs
	cluster_alb_ids
} | grep -v '^$' | sort -u || true; }
alive_nats() { tagged_nat_gateways; }
alive_eips() { tagged_eips; }

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_cluster)"; [ -n "$x" ] && leaks="${leaks}ack-cluster: $(join "$x")\n"
	x="$(alive_instances)"; [ -n "$x" ] && leaks="${leaks}ecs-instance: $(join "$x")\n"
	x="$(alive_disks)"; [ -n "$x" ] && leaks="${leaks}cloud-disk: $(join "$x")\n"
	x="$(alive_slbs)"; [ -n "$x" ] && leaks="${leaks}slb: $(join "$x")\n"
	x="$(alive_albs)"; [ -n "$x" ] && leaks="${leaks}alb: $(join "$x")\n"
	x="$(alive_nats)"; [ -n "$x" ] && leaks="${leaks}nat-gateway: $(join "$x")\n"
	x="$(alive_eips)"; [ -n "$x" ] && leaks="${leaks}eip: $(join "$x")\n"
	if [ -n "$leaks" ]; then
		echo "  ✗ billable resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::alibaba cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never account-wide)." >&2
		return 1
	fi
	# Non-billable network residue (vswitch/SG/VPC still tagged) is a NOTICE, not a hard fail.
	local residue
	residue="$({
		tagged_vswitches
		tagged_security_groups
		tagged_vpcs
	} | grep -v '^$' | sort -u || true)"
	# shellcheck disable=SC2086
	[ -n "$residue" ] && echo "::notice::alibaba cleanup: network residue still tagged (non-billable, will age out): $(printf '%s ' $residue)"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG/CLUSTER_* globals the sweep functions read, then runs them in the same
#    strict dependency order as the normal path. Returns verify_swept's status (0 clean / 1 leak);
#    DRY_RUN lists only and returns 0. Used by PREFLIGHT to sweep each discovered prior-run orphan. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	CLUSTER_NAME=""
	CLUSTER_ID=""
	assert_scope
	discover_cluster
	sweep_load_balancers
	sweep_cluster
	sweep_instances
	sweep_disks
	sweep_network
	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has an ACK cluster tagged/named in
#    this region (prior-run orphans). Alibaba has no cheap account-wide tag-VALUE enumerator like
#    AWS's get-tag-values, so we enumerate the ACK cluster inventory (the run's most expensive +
#    always-present resource) and read each cluster's project-id tag (or, if untagged, its
#    `-<env>`-embedded name). Keeps only `e2e-`-prefixed handles, EXCLUDES this run (SELF_ENV), and
#    re-validates each against the SAME specificity + prod/shared denylist guards as the top-of-file
#    ENV guards — so a preflight can never widen past a genuine prior nightly. Same-cloud nightly
#    runs are SERIALIZED (the e2e-nightly concurrency group), so any other e2e-* handle is a
#    prior-run orphan, never a concurrent sibling. Empty output ⇒ nothing to sweep. ──
list_orphan_envs() {
	local rows v oenv
	rows="$(all_clusters | jq -c "select(.region == \"$REGION\")" 2>/dev/null || true)"
	{
		# From the project-id tag…
		printf '%s\n' "$rows" | jq -r '.pid // empty' 2>/dev/null || true
		# …and from any cluster NAME that embeds an e2e handle (untagged / mid-destroy clusters).
		printf '%s\n' "$rows" | jq -r '.name // empty' 2>/dev/null |
			grep -oE 'e2e-[a-z0-9][a-z0-9._-]{4,62}' 2>/dev/null || true
	} | while IFS= read -r v; do
		[ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac
		oenv="${v#e2e-}"
		[ "$oenv" = "$SELF_ENV" ] && continue
		printf '%s' "$oenv" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$oenv" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data) continue ;;
		esac
		printf '%s\n' "$oenv"
	done | sort -u
}

# ── PREFLIGHT: sweep prior-run e2e orphans (NOT this run), best-effort + loud. ──
SELF_ENV="$ENV"
if [ "$PREFLIGHT" = "1" ]; then
	echo "→ alibaba STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
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
sweep_load_balancers
sweep_cluster
sweep_instances
sweep_disks
sweep_network

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ alibaba DRY RUN complete for ${TAGK}=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
if ! verify_swept; then
	exit 1
fi
echo "✓ alibaba cleanup verified complete for run ${ENV} — no billable resources remain"
