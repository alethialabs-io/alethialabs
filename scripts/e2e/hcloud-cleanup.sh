#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# hcloud-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly.
#
# The T2 harness (test/e2e/t2_provision_test.go) tears the cluster down GRACEFULLY
# in-process via `tofu destroy` (provisioner.RunDestroy). That covers the normal path.
# But if the test PROCESS is hard-killed (a `go test -timeout` panic, a CI step
# SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable hcloud resources
# leak. This script is the guarantee: the nightly workflow runs it in an `always()`
# step so the run's resources are destroyed no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The hcloud account is SHARED with prod + other test clusters. An unfiltered delete
# once nearly wiped prod (see the scope-destructive-cloud-ops memory). So this script
# NEVER deletes account-wide: EVERY hcloud call is scoped to the label selector
# `cluster=<CLUSTER_NAME>` — the exact label the hetzner template stamps on every
# resource it creates (servers, network, firewall, primary IPs, images). The cluster
# name is unique per run (derived from the GitHub run id/attempt), so the filter can
# only ever match THIS run's resources. The script refuses to run without a specific,
# plausibly-unique cluster name, and asserts the selector is non-empty before every
# call.
#
# Usage:
#   HCLOUD_TOKEN=... ./scripts/e2e/hcloud-cleanup.sh <cluster-name>
#   HCLOUD_TOKEN=... ALETHIA_E2E_CLUSTER_NAME=<cluster-name> ./scripts/e2e/hcloud-cleanup.sh
#   DRY_RUN=1 ...    # list what WOULD be deleted, delete nothing
set -euo pipefail

CLUSTER_NAME="${1:-${ALETHIA_E2E_CLUSTER_NAME:-}}"
DRY_RUN="${DRY_RUN:-0}"
# A volume cannot be deleted while attached, and `hcloud server delete` detaches asynchronously —
# so both a wait and per-item retries are required, else the sweep races the detach and leaks.
DETACH_TIMEOUT="${DETACH_TIMEOUT:-120}" # seconds to wait for volumes to detach after server delete
DELETE_RETRIES="${DELETE_RETRIES:-5}"   # per-resource delete attempts (exponential backoff)

# ── Guard 1: a specific cluster name is REQUIRED. No name ⇒ we would have no filter
#    ⇒ hard refuse (never fall through to an account-wide delete). ──
if [ -z "$CLUSTER_NAME" ]; then
	echo "✗ REFUSING TO RUN: no cluster name given." >&2
	echo "  Pass the unique per-run cluster name as \$1 or ALETHIA_E2E_CLUSTER_NAME." >&2
	echo "  This script only ever deletes resources labelled 'cluster=<name>' — never account-wide." >&2
	exit 2
fi

# ── Guard 2: the name must be specific enough to be a single run's cluster, not a
#    broad/shared prefix. Enforce the label-value grammar + a minimum length, and
#    reject a short list of dangerous bare names that could match shared infra. ──
if ! printf '%s' "$CLUSTER_NAME" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: cluster name '$CLUSTER_NAME' is not a valid, specific label value" >&2
	echo "  (need [a-z0-9][a-z0-9._-]{4,62}). Refusing so a typo can't become a broad delete." >&2
	exit 2
fi
case "$CLUSTER_NAME" in
prod | prod-* | production | production-* | staging | staging-* | alethia | alethia-data | main)
	echo "✗ REFUSING TO RUN: '$CLUSTER_NAME' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

if [ -z "${HCLOUD_TOKEN:-}" ]; then
	echo "✗ HCLOUD_TOKEN is unset — nothing to authenticate with." >&2
	exit 2
fi

if ! command -v hcloud >/dev/null 2>&1; then
	echo "✗ the 'hcloud' CLI is not installed." >&2
	echo "  Install it: https://github.com/hetznercloud/cli (e.g. 'brew install hcloud')." >&2
	exit 2
fi

# The single, non-empty selector every call is scoped by. Asserted before each use.
SELECTOR="cluster=${CLUSTER_NAME}"

echo "→ hcloud belt-and-suspenders cleanup for label ${SELECTOR}"
[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"

# assert_selector fails closed if the selector ever became empty (defensive — the
# guards above already ensure it can't, but never issue a label-less hcloud call).
assert_selector() {
	if [ -z "${SELECTOR#cluster=}" ]; then
		echo "✗ INTERNAL: empty selector — aborting before an unfiltered delete." >&2
		exit 3
	fi
}

# list_ids <resource> — ids of resources of <resource> carrying our label, one per line.
list_ids() {
	assert_selector
	hcloud "$1" list --selector "$SELECTOR" -o noheader -o columns=id 2>/dev/null || true
}

# purge <resource> [human-label] — delete every labelled resource of <resource>, with retries.
# Idempotent: an empty list is a clean no-op. A delete can legitimately fail transiently — most
# importantly a volume that is still ATTACHED (the API refuses: "The Volume must not be attached
# to a Server") because the server's delete detaches ASYNCHRONOUSLY. So retry with backoff rather
# than logging a single WARN and moving on. Anything still standing at the end is caught by the
# final verification sweep, which FAILS the step (see verify_swept) — a leak must never exit green.
purge() {
	local resource="$1"
	local label="${2:-$1}"
	local ids
	ids="$(list_ids "$resource")"
	if [ -z "$ids" ]; then
		echo "  · ${label}: none"
		return 0
	fi
	local count
	count="$(printf '%s\n' "$ids" | grep -c . || true)"
	echo "  · ${label}: ${count} to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete ${resource} ${id}"
			continue
		fi
		local attempt=1 delay=3 ok=0
		while [ "$attempt" -le "$DELETE_RETRIES" ]; do
			if hcloud "$resource" delete "$id" >/dev/null 2>&1; then
				echo "      deleted ${resource} ${id}"
				ok=1
				break
			fi
			# Already gone (a concurrent tofu destroy won the race) ⇒ success, not a failure.
			if ! hcloud "$resource" describe "$id" >/dev/null 2>&1; then
				echo "      ${resource} ${id} already gone"
				ok=1
				break
			fi
			echo "      retry ${attempt}/${DELETE_RETRIES}: ${resource} ${id} not deletable yet (waiting ${delay}s)" >&2
			sleep "$delay"
			attempt=$((attempt + 1))
			delay=$((delay * 2))
		done
		if [ "$ok" -ne 1 ]; then
			echo "      WARN: could not delete ${resource} ${id} after ${DELETE_RETRIES} attempts" >&2
		fi
	done <<EOF
$ids
EOF
}

# wait_for_volumes_detached — block until no labelled volume reports an attached server.
# `hcloud server delete` detaches its volumes asynchronously, so deleting a volume immediately
# after the server races that detach and gets rejected. Poll (selector-scoped, like everything
# else) until the volumes are free, or give up and let purge's retries + verify_swept handle it.
wait_for_volumes_detached() {
	assert_selector
	[ "$DRY_RUN" = "1" ] && return 0
	local waited=0 attached
	while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
		# column `server` is empty for a detached volume; count the non-empty ones.
		attached="$(hcloud volume list --selector "$SELECTOR" -o noheader -o columns=server 2>/dev/null | grep -c '[^[:space:]-]' || true)"
		if [ "${attached:-0}" -eq 0 ]; then
			[ "$waited" -gt 0 ] && echo "  · volumes detached after ${waited}s"
			return 0
		fi
		echo "  · waiting for ${attached} volume(s) to detach… (${waited}s/${DETACH_TIMEOUT}s)"
		sleep 5
		waited=$((waited + 5))
	done
	echo "  WARN: volumes still attached after ${DETACH_TIMEOUT}s — attempting delete anyway" >&2
}

# Deletion order respects dependencies:
#   1. servers          — free the network attachments, firewall bindings, primary IPs;
#                         also triggers the ASYNC detach of any attached volume
#   2. load-balancers   — CCM-created (none for the bare test, but sweep the label)
#   3. (wait)           — volumes cannot be deleted while attached; wait out the async detach
#   4. volumes          — CSI-created dynamic PVs, labelled via HCLOUD_VOLUME_EXTRA_LABELS
#   5. firewalls        — now unreferenced by any server
#   6. networks         — now unreferenced by any server
#   7. primary-ips      — template sets auto_delete=false, so delete explicitly
#   8. images           — the Talos snapshots the template built (labelled cluster=…)
purge server "servers"
purge load-balancer "load balancers"
wait_for_volumes_detached
purge volume "volumes"
purge firewall "firewalls"
purge network "networks"
purge primary-ip "primary IPs"
purge image "images (talos snapshots)"

# ── Final verification: a leak must NEVER exit green. ──
# The whole point of this script is that nothing bills after the run. Previously a delete that
# failed (e.g. a still-attached volume) logged a WARN and the script still printed "✓ complete"
# and exited 0 — so a leaked, billable volume looked exactly like a clean teardown. Re-list every
# resource type under the SAME selector and fail loudly if anything survived.
verify_swept() {
	assert_selector
	local leaked=0 res ids count
	for res in server load-balancer volume firewall network primary-ip image; do
		ids="$(list_ids "$res")"
		[ -z "$ids" ] && continue
		count="$(printf '%s\n' "$ids" | grep -c . || true)"
		echo "  ✗ ${res}: ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
		leaked=$((leaked + count))
	done
	if [ "$leaked" -gt 0 ]; then
		# ::error:: surfaces it in the GitHub Actions UI rather than burying it in the log.
		echo "::error::hcloud cleanup INCOMPLETE — ${leaked} resource(s) labelled ${SELECTOR} still exist and are BILLING. Investigate and remove them (stay label-scoped; never delete account-wide)." >&2
		return 1
	fi
	return 0
}

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ hcloud DRY RUN complete for ${SELECTOR} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing labelled ${SELECTOR} survived…"
if ! verify_swept; then
	exit 1
fi

# Reached only when verify_swept confirmed NOTHING labelled ${SELECTOR} remains.
echo "✓ hcloud cleanup verified complete for ${SELECTOR} — no labelled resources remain"
echo "  CSI volumes: dynamically-provisioned pvc-* volumes are created by the CSI controller"
echo "  at runtime (not by our template), so 'tofu destroy' cannot reclaim them. They are"
echo "  stamped with cluster=<name> at the source — the hetzner template sets the driver's"
echo "  HCLOUD_VOLUME_EXTRA_LABELS (infra/templates/project/hetzner/csi.tf, chart 2.15.0–2.20.2) —"
echo "  so the label-scoped 'volumes' purge above (after waiting out the async detach) reclaims"
echo "  them WITHOUT widening this script's blast radius. A pvc-* volume can only leak if it"
echo "  predates that change or came from an older template; sweep those by hand (never account-wide)."
