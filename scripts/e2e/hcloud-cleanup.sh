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

# purge <resource> [human-label] — delete every labelled resource of <resource>.
# Idempotent: an empty list is a clean no-op. Per-item failures are logged, not fatal,
# so one stuck resource never blocks the rest (the workflow step stays green on a
# best-effort sweep; the graceful tofu destroy is the primary path).
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
		if hcloud "$resource" delete "$id" >/dev/null 2>&1; then
			echo "      deleted ${resource} ${id}"
		else
			echo "      WARN: failed to delete ${resource} ${id} (continuing)" >&2
		fi
	done <<EOF
$ids
EOF
}

# Deletion order respects dependencies:
#   1. servers          — free the network attachments, firewall bindings, primary IPs
#   2. load-balancers   — CCM-created (none for the bare test, but sweep the label)
#   3. volumes          — CSI-created dynamic PVs that happen to carry our label
#   4. firewalls        — now unreferenced by any server
#   5. networks         — now unreferenced by any server
#   6. primary-ips      — template sets auto_delete=false, so delete explicitly
#   7. images           — the Talos snapshots the template built (labelled cluster=…)
purge server "servers"
purge load-balancer "load balancers"
purge volume "volumes"
purge firewall "firewalls"
purge network "networks"
purge primary-ip "primary IPs"
purge image "images (talos snapshots)"

echo "✓ hcloud cleanup pass complete for ${SELECTOR}"
echo "  Note: dynamically-provisioned CSI volumes (pvc-*) created INSIDE the cluster are"
echo "  labelled by the CSI driver, not by our template — the graceful 'tofu destroy' and"
echo "  this label filter may not catch them. The nightly cluster runs no PVC workloads,"
echo "  but a maintainer should periodically check 'hcloud volume list' for stray pvc-* volumes."
