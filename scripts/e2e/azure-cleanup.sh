#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# azure-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (Azure/AKS).
#
# Cloned guard-for-guard from scripts/e2e/aws-cleanup.sh (BYOC A1.3) + scripts/e2e/hcloud-cleanup.sh.
# The T2 harness tears the cluster down GRACEFULLY in-process via `tofu destroy`
# (provisioner.RunDestroy) on the normal path. But if the test PROCESS is hard-killed (a `go test
# -timeout` panic, a CI step SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable Azure
# resources leak — most dangerously the OUT-OF-BAND ones tofu never tracked: everything AKS
# auto-creates in its NODE resource group (the VMSS node agent pools, their managed disks, the
# standard Load Balancer + its public IPs, NSGs). This script is the guarantee: the nightly runs it
# in an `always()` step so the run's resources are gone no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The Azure subscription is the SHARED platform subscription. An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * Azure PIVOTS ON THE RESOURCE GROUP. The project template (infra/templates/project/azure) puts
#     the whole environment in ONE resource group `rg-<project>-<env>` that carries our unique per-run
#     handle tag `alethia:project-id=e2e-<ENV>` (azureTagStyle, colon-namespaced). AKS then
#     auto-creates a SECOND, node resource group `MC_<rg>_<aks>_<location>` holding every out-of-band
#     Kubernetes resource (VMSS/disks/LB/public-IPs/NSGs). Deleting a resource group cascades to
#     everything inside it, so a scoped RG delete is the whole teardown.
#   * DISCOVERY is tag-driven + env-embedded. The MAIN RG is found by the EXACT handle tag
#     (`az group list --tag alethia:project-id=e2e-<ENV>`, an exact match — no wildcard); the NODE RG
#     is found from `az aks show ... --query nodeResourceGroup` and (fallback, for a mid-destroy kill
#     where the parent AKS is already gone) by the `MC_` name prefix that embeds our unique `-<ENV>`.
#   * BEFORE deleting ANY resource group, assert_rg_in_scope requires it to EITHER carry the handle
#     tag OR embed `-<ENV>` in its name. The node RG has no handle tag (AKS-managed), so it clears via
#     the env-embed; the main RG clears via the tag. This is the defense that an ENV typo can't widen
#     the blast radius — a group that neither is tagged nor embeds this run's unique ENV is SKIPPED.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last line of
#     defence — a leak NEVER exits green: verify_swept re-lists the tagged RGs, the env-embedded node
#     RGs, and any surviving AKS/VMSS/public-IP embedding this run's ENV, and FAILS the step on any
#     billable survivor, so a stuck delete can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=germanywestcentral ./scripts/e2e/azure-cleanup.sh
#   (positional $1 accepted for call-site symmetry with the other sweepers but IGNORED.)
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# ── PREFLIGHT (stale-cluster preflight) ─────────────────────────────────────────────────────
# A prior nightly hard-killed before BOTH its graceful destroy AND its always() sweep leaks billable
# resources that keep costing until the NEXT run notices. PREFLIGHT=1 runs before provisioning and
# sweeps those orphans. It discovers every OTHER e2e run's handle by reading the `alethia:project-id`
# tag value off every resource group in the subscription, keeps only `e2e-`-prefixed values, EXCLUDES
# this run, re-validates each against the same specificity + prod/shared denylist guards, and runs the
# identical scope-locked sweep+verify per orphan. It is safe to sweep another e2e-* handle because
# same-cloud nightly runs are SERIALIZED (the workflow concurrency group) — so any other e2e-* value is
# a prior-run orphan, never a concurrent sibling. Posture is best-effort: a residual orphan emits
# `::warning::` but does NOT fail (a flaky API call must not red an otherwise-healthy provisioning
# night; the per-run always() teardown stays the fail-closed guarantee for THIS run).
#
# Requires: the Azure CLI `az` (authenticated — OIDC `azure/login` in CI).
set -euo pipefail

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only — no silent ambient fallback. Azure resource
# groups are subscription-global, so region does not scope discovery, but requiring it keeps the
# contract identical to the AWS sweeper and documents the run's location in the log.
REGION="${ALETHIA_E2E_REGION:-}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
# `az group delete --no-wait` returns immediately; an RG lingers in "Deleting" for minutes (an AKS
# teardown is ~10-15m). We fire all deletes async, then WAIT (bounded) for them to complete so
# verify_swept confirms a real teardown rather than false-REDing an in-flight delete.
DELETE_WAIT_TIMEOUT="${DELETE_WAIT_TIMEOUT:-1500}" # seconds to wait for RG deletes to complete

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resource groups tagged alethia:project-id=e2e-<ENV> or whose" >&2
	echo "  name embeds -<ENV> — never subscription-wide. Set ALETHIA_E2E_ENV to the unique per-run" >&2
	echo "  value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the tag/name filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback — parity with AWS). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  Required for parity + run provenance; set it to the run's Azure location." >&2
	exit 2
fi

if ! command -v az >/dev/null 2>&1; then
	echo "✗ the 'az' CLI is not installed." >&2
	echo "  Install it: https://learn.microsoft.com/cli/azure/install-azure-cli" >&2
	exit 2
fi

TAG_KEY="alethia:project-id"
PROJECT_ID_TAG="e2e-${ENV}"

export AZURE_CORE_ONLY_SHOW_ERRORS="${AZURE_CORE_ONLY_SHOW_ERRORS:-true}"

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ]; then
	echo "→ azure belt-and-suspenders cleanup in ${REGION}, scope ${TAG_KEY}=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# looks_gone <stderr-text> — true if an az delete/show error means the resource group is already
# absent (idempotency: a NotFound on delete is success, not failure).
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'could not be found|does not exist|ResourceGroupNotFound|was not found|NotFound'
}

# rg_has_handle_tag <rg> — true iff the resource group carries our EXACT project-id handle tag.
rg_has_handle_tag() {
	local rg="$1" val
	val="$(az group show --name "$rg" --query "tags.\"${TAG_KEY}\"" -o tsv 2>/dev/null || true)"
	[ "$val" = "$PROJECT_ID_TAG" ]
}

# assert_rg_in_scope <rg> — FAIL-CLOSED scope gate run before every RG delete. A group is in scope
# ONLY if it carries the handle tag OR its name embeds this run's unique -<ENV>. Returns non-zero
# (caller SKIPS the delete) for anything else — the defense that an ENV typo can't widen scope.
assert_rg_in_scope() {
	assert_scope
	local rg="$1"
	[ -n "$rg" ] || return 1
	if rg_has_handle_tag "$rg"; then
		return 0
	fi
	case "$rg" in
	*"-${ENV}"* | *"-${ENV}_"*) return 0 ;;
	esac
	return 1
}

# retry_delete_rg <rg> — scope-gated, NotFound-tolerant async RG delete. NEVER returns non-zero (so
# `set -e` can't abort the sweep BEFORE verify_swept, the real gate); an unresolved failure logs a
# WARN and lets verify catch it authoritatively. A group that fails the scope gate is LOUDLY skipped.
retry_delete_rg() {
	assert_scope
	local rg="$1"
	[ -n "$rg" ] || return 0
	if ! assert_rg_in_scope "$rg"; then
		echo "      ✗ SKIP ${rg}: neither carries ${TAG_KEY}=${PROJECT_ID_TAG} nor embeds -${ENV} — refusing to delete out-of-scope group" >&2
		return 0
	fi
	if [ "$DRY_RUN" = "1" ]; then
		echo "      would delete resource-group ${rg}"
		return 0
	fi
	local attempt=1 delay=3 err
	while [ "$attempt" -le "$DELETE_RETRIES" ]; do
		if err="$(az group delete --name "$rg" --yes --no-wait 2>&1)"; then
			echo "      deleting resource-group ${rg} (async)"
			return 0
		fi
		if looks_gone "$err"; then
			echo "      resource-group ${rg} already gone"
			return 0
		fi
		echo "      retry ${attempt}/${DELETE_RETRIES}: ${rg} not deletable yet (waiting ${delay}s)" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	echo "      WARN: could not start delete of ${rg} after ${DELETE_RETRIES} attempts (verify_swept will gate)" >&2
	return 0
}

# rg_exists <rg> — true iff the resource group still exists (any provisioning state).
rg_exists() {
	[ "$(az group exists --name "$1" 2>/dev/null || echo false)" = "true" ]
}

# wait_rgs_gone <rg...> — bounded poll until every named resource group is gone. Async deletes were
# fired by retry_delete_rg; here we confirm they COMPLETE so verify_swept judges the end state, not an
# in-flight delete. Times out loudly (verify_swept then fails on any survivor).
wait_rgs_gone() {
	[ "$DRY_RUN" = "1" ] && return 0
	[ "$#" -eq 0 ] && return 0
	local waited=0 rg live
	while [ "$waited" -lt "$DELETE_WAIT_TIMEOUT" ]; do
		live=0
		for rg in "$@"; do
			[ -n "$rg" ] || continue
			rg_exists "$rg" && live=$((live + 1))
		done
		[ "$live" -eq 0 ] && {
			[ "$waited" -gt 0 ] && echo "  · all target resource groups deleted after ${waited}s"
			return 0
		}
		echo "  · waiting for ${live} resource group(s) to finish deleting… (${waited}s/${DELETE_WAIT_TIMEOUT}s)"
		sleep 20
		waited=$((waited + 20))
	done
	echo "  WARN: resource group(s) still deleting after ${DELETE_WAIT_TIMEOUT}s — verify_swept will gate" >&2
}

# ── Discovery ────────────────────────────────────────────────────────────────
# main_rgs — the environment's primary resource group(s): tag-discovered (authoritative) UNION any
# `rg-`-prefixed group whose name embeds -<ENV> (belt-and-suspenders if the tag failed to apply). Both
# are re-gated by assert_rg_in_scope at delete time.
main_rgs() {
	assert_scope
	{
		az group list --tag "${TAG_KEY}=${PROJECT_ID_TAG}" --query "[].name" -o tsv 2>/dev/null || true
		az group list --query "[?starts_with(name,'rg-')].name" -o tsv 2>/dev/null | grep -i -- "-${ENV}" || true
	} | grep -v '^$' | sort -u || true
}

# node_rgs_of <main-rg> — the AKS-managed node resource group(s) for the AKS cluster(s) in <main-rg>.
# These normally cascade when the main RG is deleted; recorded so verify can confirm and so an orphan
# (parent gone mid-destroy) can be swept directly.
node_rgs_of() {
	local rg="$1"
	[ -n "$rg" ] || return 0
	az aks list --resource-group "$rg" --query "[].nodeResourceGroup" -o tsv 2>/dev/null | grep -v '^$' || true
}

# orphan_node_rgs — `MC_`-prefixed node resource groups whose name embeds -<ENV> (an AKS node RG left
# behind after its parent AKS/main-RG was torn down). Now parent-less, so directly deletable.
orphan_node_rgs() {
	assert_scope
	az group list --query "[?starts_with(name,'MC_')].name" -o tsv 2>/dev/null | grep -i -- "-${ENV}" | grep -v '^$' | sort -u || true
}

# ── Final verification: a leak must NEVER exit green. Re-list the tagged main RGs, the env-embedded
#    node RGs, and any surviving AKS/VMSS/public-IP embedding this run's ENV. grep -i so an Azure
#    case-normalized RG name can't hide a survivor. ──
alive_tagged_rgs() {
	az group list --tag "${TAG_KEY}=${PROJECT_ID_TAG}" --query "[].name" -o tsv 2>/dev/null | grep -v '^$' || true
}
alive_env_rgs() {
	az group list --query "[].name" -o tsv 2>/dev/null | grep -i -- "-${ENV}" | grep -v '^$' | sort -u || true
}
alive_aks() {
	az aks list --query "[].name" -o tsv 2>/dev/null | grep -i -- "-${ENV}" | grep -v '^$' || true
}
alive_vmss() {
	az vmss list --query "[].resourceGroup" -o tsv 2>/dev/null | grep -i -- "-${ENV}" | grep -v '^$' || true
}
alive_public_ips() {
	az network public-ip list --query "[].resourceGroup" -o tsv 2>/dev/null | grep -i -- "-${ENV}" | grep -v '^$' || true
}

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_tagged_rgs)"; [ -n "$x" ] && leaks="${leaks}resource-group(tagged): $(join "$x")\n"
	x="$(alive_env_rgs)"; [ -n "$x" ] && leaks="${leaks}resource-group(env-embedded): $(join "$x")\n"
	x="$(alive_aks)"; [ -n "$x" ] && leaks="${leaks}aks-cluster: $(join "$x")\n"
	x="$(alive_vmss)"; [ -n "$x" ] && leaks="${leaks}vmss(in rg): $(join "$x")\n"
	x="$(alive_public_ips)"; [ -n "$x" ] && leaks="${leaks}public-ip(in rg): $(join "$x")\n"
	if [ -n "$leaks" ]; then
		echo "  ✗ billable resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::azure cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never subscription-wide)." >&2
		return 1
	fi
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG globals the discovery/verify functions read, then runs them in dependency
#    order: delete the MAIN RGs (this cascades AKS → its node RG + the DB/redis/etc), wait, then sweep
#    any ORPHAN node RG a mid-destroy kill left parent-less, wait, verify. Returns verify_swept's
#    status (0 clean / 1 leak); DRY_RUN lists only and returns 0. Used by PREFLIGHT per orphan too. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	assert_scope

	local mains rg nodes deleted=()
	mains="$(main_rgs)"
	if [ -n "$mains" ]; then
		echo "  · main resource groups: $(printf '%s' "$mains" | grep -c .) to delete"
		while IFS= read -r rg; do
			[ -n "$rg" ] || continue
			nodes="$(node_rgs_of "$rg")"
			[ -n "$nodes" ] && echo "      · ${rg} → node RG(s): $(printf '%s' "$nodes" | tr '\n' ' ')(cascade)"
			retry_delete_rg "$rg"
			deleted+=("$rg")
		done <<<"$mains"
	else
		echo "  · main resource groups: none"
	fi
	wait_rgs_gone "${deleted[@]}"

	# Orphan node RGs (parent AKS/main-RG already gone) — now directly deletable.
	local orphans orphan_deleted=()
	orphans="$(orphan_node_rgs)"
	if [ -n "$orphans" ]; then
		echo "  · orphan node resource groups (MC_… embedding -${ENV}): $(printf '%s' "$orphans" | grep -c .) to delete"
		while IFS= read -r rg; do
			[ -n "$rg" ] || continue
			retry_delete_rg "$rg"
			orphan_deleted+=("$rg")
		done <<<"$orphans"
		wait_rgs_gone "${orphan_deleted[@]}"
	else
		echo "  · orphan node resource groups: none"
	fi

	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has a project-id-tagged resource group in
#    this subscription (prior-run orphans). Reads the `alethia:project-id` tag value off every RG,
#    keeps only `e2e-`-prefixed values, strips the prefix, EXCLUDES this run (SELF_ENV), and
#    re-validates each against the SAME specificity + prod/shared denylist guards as the top-of-file
#    ENV guards — so a preflight can never widen past a genuine prior nightly. Empty ⇒ nothing to sweep. ──
list_orphan_envs() {
	local vals v oenv
	vals="$(az group list --query "[?tags.\"${TAG_KEY}\"].tags.\"${TAG_KEY}\"" -o tsv 2>/dev/null | grep -v '^$' || true)"
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac # e2e-prefixed values only — never a prod project-id
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
	echo "→ azure STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	orphans="$(list_orphan_envs || true)"
	if [ -z "$orphans" ]; then
		echo "✓ preflight: no prior-run e2e orphans in this subscription — nothing to sweep"
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
		echo "✓ preflight complete — all prior-run e2e orphans in this subscription swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Normal (belt-and-suspenders) path — the full scope-locked sweep + verify for THIS run. ──
if [ "$DRY_RUN" = "1" ]; then
	sweep_env "$ENV"
	echo "✓ azure DRY RUN complete for ${TAG_KEY}=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

if ! sweep_env "$ENV"; then
	exit 1
fi
echo "✓ azure cleanup verified complete for run ${ENV} — no billable resources remain"
