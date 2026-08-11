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
# Three things the label selector alone cannot reach, each handled explicitly below rather than
# left silently absent — an unswept type that nobody mentions is indistinguishable from a swept one:
#
#   * hcloud_zone (dns.tf, #1816) DOES carry cluster=<name>; it was simply missing from the purge
#     and verify lists. Added — one line each, gated on the CLI actually supporting `hcloud zone`.
#   * The CCM's ingress load balancer carries NO cluster label and cannot be made to (see
#     sweep_unlabelled_lbs). It is bound to this run through its private-network attachment.
#   * Hetzner Object Storage is a different product on a different API. Swept over S3 when the
#     run's credentials are present, and reported as explicitly UNVERIFIED when they are not.
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
# ── PREFLIGHT (#2330). Discovery mode: sweep PRIOR-run e2e orphans rather than this run. See the
# block above the purge sequence for what it discriminates on and why it is not the cluster name.
# Bounded like the other four sweepers (#2257): an unbounded best-effort sweep can consume its
# caller's job budget, which is how run 31459117502 was cancelled at its cap and leaked a stack.
PREFLIGHT="${PREFLIGHT:-0}"
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

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

# Hetzner Object Storage is a SEPARATE PRODUCT from the Hetzner Cloud API — S3 at
# <region>.your-objectstorage.com, its own access-key pair, no hcloud labels, invisible to the
# hcloud CLI. So it can only be swept with S3 credentials, and only reported honestly without them.
# Same env names the runner exports at claim (packages/core/cloud/hetzner_provider.go:217-222).
S3_ACCESS_KEY="${HETZNER_S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${HETZNER_S3_SECRET_KEY:-}"
S3_REGION="${HETZNER_S3_REGION:-${ALETHIA_E2E_HCLOUD_REGION:-fsn1}}"
S3_ENDPOINT="${HETZNER_S3_ENDPOINT:-${S3_REGION}.your-objectstorage.com}"
# Set by the sweep/verify below when a type could not be looked at rather than looked at and found
# clean. The two are not the same answer and the final banner must not conflate them.
UNVERIFIABLE=""

echo "→ hcloud belt-and-suspenders cleanup for label ${SELECTOR}"
[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"

# ── Does this hcloud CLI know about DNS zones? `hcloud zone` is recent (the template gained
#    hcloud_zone with #1816, provider 1.56+). An older CLI makes `hcloud zone list` fail, and
#    list_ids swallows that into an empty list — which reads exactly like "no zones", the
#    report-clean-without-looking failure this whole file exists to prevent. Probe once, loudly.
ZONE_SUPPORTED=0
if hcloud zone list -o noheader >/dev/null 2>&1; then
	ZONE_SUPPORTED=1
else
	# Either the CLI predates `hcloud zone`, or the token cannot read zones. The probe cannot tell
	# them apart and does not need to: both mean this script could not look, which is reported —
	# never silently folded into "none".
	echo "::warning::'hcloud zone list' failed (CLI without DNS zone support, or a token that cannot read zones). DNS zones for ${SELECTOR} were NOT swept and NOT verified — check them by hand in the Hetzner Console."
	UNVERIFIABLE="${UNVERIFIABLE}dns-zones(hcloud zone list unavailable) "
fi

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

# ── The ingress load balancer, which carries NO cluster label and never will ────────────────────
#
# ingress-nginx ships `controller.service.type: LoadBalancer` (apps/console/lib/addons/catalog.ts),
# so the hcloud cloud-controller-manager creates a REAL, billable Load Balancer for it at runtime.
# `purge load-balancer --selector cluster=<name>` cannot see it and verify_swept confirmed nothing:
# a standing LB bill after every hard kill, reported as a clean teardown.
#
# THE OBVIOUS FIX DOES NOT EXIST. csi.tf solves the same problem for pvc-* volumes by handing the
# CSI driver HCLOUD_VOLUME_EXTRA_LABELS and hard-failing the plan if the label is missing, and the
# instinct is to copy that onto the CCM in cilium.tf. The CCM has no equivalent. Checked against
# the source at hetznercloud/hcloud-cloud-controller-manager@main: there is no labels annotation in
# internal/annotation/load_balancer.go (the only naming/identity knob is
# `load-balancer.hetzner.cloud/name`), and internal/hcops/load_balancer.go sets exactly ONE label on
# create — `hcloud-ccm/service-uid`, the Service UID, which the sweeper cannot know. There is no
# default-labels env var either. So the label simply cannot be stamped at the source.
#
# What CAN bind the LB to this run is the run's PRIVATE NETWORK. talos.tf writes the `hcloud`
# Secret with `network = local.network_id` and cilium.tf sets `networking.enabled=true`, so the CCM
# attaches every LB it creates to THIS cluster's network. The network itself carries
# cluster=<name> (main.tf `base_labels`), so it is discovered by the same selector as everything
# else — the binding stays scope-locked, exactly as the AWS sweeper binds out-of-band ELBs through
# a secondary `elbv2.k8s.aws/cluster` filter and the GCP sweeper binds LB residue through the VPC.
#
# The account-wide part of this is a LIST, never a delete: every id that reaches a delete has been
# confirmed attached to a network id that carries our label.
cluster_network_id() {
	assert_selector
	hcloud network list --selector "$SELECTOR" -o noheader -o columns=id 2>/dev/null | head -n1 | tr -d '[:space:]' || true
}

# unlabelled_lb_ids — Load Balancers attached to THIS run's private network but carrying no
# cluster label. Empty (never account-wide) unless the network id is a confirmed number.
unlabelled_lb_ids() {
	local net labelled
	net="$(cluster_network_id)"
	# A non-numeric or empty id would make the jq match degenerate; refuse rather than widen.
	printf '%s' "$net" | grep -Eq '^[0-9]+$' || return 0
	labelled="$(list_ids load-balancer | tr '\n' ' ')"
	hcloud load-balancer list -o json 2>/dev/null |
		jq -r --argjson net "$net" '.[] | select(((.private_net // []) | map(.network) | index($net)) != null) | .id' 2>/dev/null |
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			# Skip ones the labelled purge already covers, so they are not reported twice.
			case " $labelled " in *" $id "*) continue ;; esac
			printf '%s\n' "$id"
		done || true
}

sweep_unlabelled_lbs() {
	assert_selector
	local ids id
	if ! command -v jq >/dev/null 2>&1; then
		echo "::warning::jq is not installed — the CCM-created ingress load balancer for ${SELECTOR} could NOT be discovered (it carries no hcloud label; the only binding is its private-network attachment, which needs jq to read). NOT swept and NOT verified — check load balancers by hand."
		UNVERIFIABLE="${UNVERIFIABLE}ccm-load-balancers(no jq) "
		return 0
	fi
	ids="$(unlabelled_lb_ids)"
	if [ -z "$ids" ]; then
		echo "  · unlabelled (CCM) load balancers on this run's network: none"
		return 0
	fi
	echo "  · unlabelled (CCM) load balancers on this run's network: $(printf '%s\n' "$ids" | grep -c .) to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete load-balancer ${id} (bound via private network)"
			continue
		fi
		hcloud load-balancer delete "$id" >/dev/null 2>&1 &&
			echo "      deleted load-balancer ${id}" ||
			echo "      WARN: could not delete load-balancer ${id} (verify_swept will gate)" >&2
	done <<EOF
$ids
EOF
}

# ── Hetzner Object Storage ──────────────────────────────────────────────────────────────────────
#
# buckets.tf builds `minio_s3_bucket.bucket` named `<cluster_name>-<bucket>`. `force_destroy = true`
# means the GRACEFUL path reclaims it, so this only matters after a hard kill — and after a hard
# kill it is a standing monthly charge that nothing in this script could see, because Object Storage
# is not on the Cloud API at all. It was neither purged nor verified: silently absent.
#
# It is swept over S3 when the same credentials the apply used are present, scoped to the
# `<cluster_name>-` prefix — cluster_name is the run-unique, guard-validated handle this whole file
# is locked to, so the prefix is exactly as narrow as the label selector, not a broad name match.
# Without those credentials it is IMPOSSIBLE to look, and the honest report is to say so rather than
# let the final banner imply it was checked.
s3() { aws --endpoint-url "https://${S3_ENDPOINT}" --region "${S3_REGION}" "$@"; }

s3_bucket_names() {
	assert_selector
	AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
		s3 s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null |
		tr '\t' '\n' | grep -E "^${CLUSTER_NAME}-" || true
}

# s3_available — 0 when Object Storage can actually be inspected. Sets UNVERIFIABLE and warns
# otherwise, so "no buckets" is never printed for "could not look".
s3_available() {
	if [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
		echo "::warning::HETZNER_S3_ACCESS_KEY/HETZNER_S3_SECRET_KEY are unset — Hetzner Object Storage buckets named ${CLUSTER_NAME}-* were NOT swept and NOT verified. Object Storage is a separate product with no hcloud label and no Cloud-API listing, so this script cannot see it without them. If this run provisioned buckets, check them by hand at https://${S3_ENDPOINT}."
		UNVERIFIABLE="${UNVERIFIABLE}object-storage-buckets(no S3 credentials) "
		return 1
	fi
	if ! command -v aws >/dev/null 2>&1; then
		echo "::warning::the 'aws' CLI is not installed — Hetzner Object Storage buckets named ${CLUSTER_NAME}-* were NOT swept and NOT verified. Check them by hand at https://${S3_ENDPOINT}."
		UNVERIFIABLE="${UNVERIFIABLE}object-storage-buckets(no aws CLI) "
		return 1
	fi
	return 0
}

sweep_object_storage() {
	assert_selector
	s3_available || return 0
	local names name
	names="$(s3_bucket_names)"
	if [ -z "$names" ]; then
		echo "  · object storage buckets: none"
		return 0
	fi
	echo "  · object storage buckets: $(printf '%s\n' "$names" | grep -c .) to delete"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		# Belt-and-braces: never issue a delete for a name outside this run's prefix.
		case "$name" in "${CLUSTER_NAME}-"*) ;; *) continue ;; esac
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete bucket ${name}"
			continue
		fi
		AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
			s3 s3 rm "s3://${name}" --recursive >/dev/null 2>&1 || true
		if AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
			s3 s3api delete-bucket --bucket "$name" >/dev/null 2>&1; then
			echo "      deleted bucket ${name}"
		else
			echo "      WARN: could not delete bucket ${name} (verify_swept will gate)" >&2
		fi
	done <<EOF
$names
EOF
}

# ── PREFLIGHT: prior-run orphan discovery (#2330) ───────────────────────────────────────────────
#
# WHY THIS EXISTS. e2e-orphan-reaper.yml reclaims stacks that a cancelled nightly leaked, by
# running each cloud's PREFLIGHT discovery out-of-band. hetzner was ABSENT from that reaper, and
# stated as a real gap, for exactly one reason: this script had no discovery mode. It sweeps one
# named cluster and nothing else. So a cancelled hetzner leg leaked with nothing to reclaim it.
#
# WHAT IT DISCRIMINATES ON, AND WHY NOT THE CLUSTER NAME. The obvious enumerator — "every
# `cluster=` label that looks like a run handle" — would key on `alethia-nl-<run_id>-<attempt>`,
# and `alethia-nl` is a PREFIX OF PROD's naming, not a test-only marker. A regex that has to be
# exactly right to avoid deleting production is the wrong shape for a sweeper in a shared account.
#
# Instead this keys on the SAME handle the other four clouds use: `alethia_project-id=e2e-<env>`,
# which packages/core/cloud/tags.go stamps on every resource through classification_tags, and
# which infra/templates/project/hetzner/checks_classification.tf ASSERTS reaches every hcloud
# resource. A resource without that label is not a nightly resource and is invisible here — which
# is the failure direction we want.
#
# The cluster name to sweep is then read back off the same resources' `cluster` label rather than
# reconstructed from the env, so the value handed to the scope-locked sweep is one hcloud itself
# reported, never one this script assembled.
#
# Posture matches the other four: best-effort, loud, bounded, and `exit 0` on every path — a
# preflight that can fail its caller is not a preflight.

# list_orphan_clusters — every OTHER run's `cluster` label value that still has e2e-labelled
# resources. Same validation and prod/shared denylist as the top-of-file guard, re-applied per
# candidate so discovery can never widen past a genuine prior nightly.
list_orphan_clusters() {
	local kind rows
	{
		for kind in server volume network firewall primary-ip image; do
			hcloud "$kind" list -o json 2>/dev/null |
				jq -r '.[]? | select((.labels["alethia_project-id"] // "") | startswith("e2e-"))
				               | .labels.cluster // empty' 2>/dev/null || true
		done
	} | while IFS= read -r rows; do
		[ -n "$rows" ] || continue
		[ "$rows" = "$CLUSTER_NAME" ] && continue # never this run — its own teardown owns it
		printf '%s' "$rows" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$rows" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-data) continue ;;
		esac
		printf '%s\n' "$rows"
	done | sort -u
}

if [ "$PREFLIGHT" = "1" ]; then
	# Discovery is entirely jq-driven. Without jq every list would yield nothing, the loop would
	# find no orphans, and this would exit 0 reporting a clean account it never looked at — the
	# precise failure aws-cleanup.sh's header calls "more expensive than no sweeper, because it
	# stops anyone else looking". Refuse instead. (Elsewhere in this file jq is optional because
	# its absence degrades a sweep that ALSO has a labelled path; here there is no other path.)
	if ! command -v jq >/dev/null 2>&1; then
		echo "::error::hetzner preflight requires jq — refusing to report a clean account it cannot inspect." >&2
		exit 2
	fi
	echo "→ hetzner STALE PREFLIGHT: sweeping prior-run e2e orphans (excludes this run ${CLUSTER_NAME})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	orphans="$(list_orphan_clusters || true)"
	if [ -z "$orphans" ]; then
		echo "✓ preflight: no prior-run e2e orphans — nothing to sweep"
		exit 0
	fi
	# shellcheck disable=SC2086
	echo "  orphan clusters found: $(printf '%s ' $orphans)"
	echo "  budget: ${PREFLIGHT_BUDGET_SECONDS}s wall-clock, at most ${PREFLIGHT_MAX_ENVS} orphan(s) this run"
	residual=0
	attempted=0
	deadline=$(($(date +%s) + PREFLIGHT_BUDGET_SECONDS))
	skipped=""
	while IFS= read -r ocl; do
		[ -n "$ocl" ] || continue
		if [ "$attempted" -ge "$PREFLIGHT_MAX_ENVS" ]; then
			skipped="${skipped}${ocl} (cap) "
			continue
		fi
		now=$(date +%s)
		if [ "$now" -ge "$deadline" ]; then
			skipped="${skipped}${ocl} (budget) "
			continue
		fi
		attempted=$((attempted + 1))
		echo "── preflight sweep: prior run ${ocl} (${attempted}/${PREFLIGHT_MAX_ENVS}, $((deadline - now))s budget left) ──"
		# Re-invoke THIS script scope-locked to the orphan rather than re-entering the sweep in
		# place: the whole file is written around one CLUSTER_NAME and one SELECTOR, computed at
		# the top. Recomputing them mid-run is how a selector goes stale and a delete goes wide.
		# A subshell with a fresh CLUSTER_NAME re-runs every guard from scratch for each orphan.
		if ! PREFLIGHT=0 DRY_RUN="$DRY_RUN" "$0" "$ocl"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${ocl} (still billing) — the always() teardown / next preflight will retry. NOT failing this run."
			residual=1
		fi
	done <<<"$orphans"
	if [ -n "$skipped" ]; then
		echo "::error::preflight left orphan(s) UNSWEPT and BILLING — bounds reached before they were reached: ${skipped}"
		echo "::error::sweep by hand, scope-locked: HCLOUD_TOKEN=… ./scripts/e2e/hcloud-cleanup.sh <cluster>"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see above) — continuing (best-effort, non-fatal)"
	else
		echo "✓ preflight complete — all prior-run e2e orphans swept"
	fi
	exit 0 # preflight never blocks its caller
fi

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
#   9. zones            — hcloud_zone (dns.tf, #1816); already labelled cluster=<name>, just never
#                         swept. A standing zone is a small forever-charge nothing else would notice
#  10. object storage   — a separate product; see sweep_object_storage
#
# The CCM load balancer and the network it is discovered through must both go BEFORE `purge
# network`, or the network delete fails with the LB still attached and the id we bind to is gone.
purge server "servers"
purge load-balancer "load balancers"
sweep_unlabelled_lbs
wait_for_volumes_detached
purge volume "volumes"
purge firewall "firewalls"
purge network "networks"
purge primary-ip "primary IPs"
purge image "images (talos snapshots)"
[ "$ZONE_SUPPORTED" = "1" ] && purge zone "dns zones"
sweep_object_storage

# ── Final verification: a leak must NEVER exit green. ──
# The whole point of this script is that nothing bills after the run. Previously a delete that
# failed (e.g. a still-attached volume) logged a WARN and the script still printed "✓ complete"
# and exited 0 — so a leaked, billable volume looked exactly like a clean teardown. Re-list every
# resource type under the SAME selector and fail loudly if anything survived.
verify_swept() {
	assert_selector
	local leaked=0 res ids count types

	# `zone` only when the CLI can actually list them — the probe at the top already warned and
	# recorded it as unverifiable otherwise, and silently dropping it here would undo that.
	types="server load-balancer volume firewall network primary-ip image"
	[ "$ZONE_SUPPORTED" = "1" ] && types="${types} zone"
	for res in $types; do
		ids="$(list_ids "$res")"
		[ -z "$ids" ] && continue
		count="$(printf '%s\n' "$ids" | grep -c . || true)"
		echo "  ✗ ${res}: ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
		leaked=$((leaked + count))
	done

	# The CCM's ingress LB carries no label, so the labelled loop above cannot see it — re-check it
	# through the same private-network binding the sweep used.
	if command -v jq >/dev/null 2>&1; then
		ids="$(unlabelled_lb_ids)"
		if [ -n "$ids" ]; then
			count="$(printf '%s\n' "$ids" | grep -c . || true)"
			echo "  ✗ load-balancer (unlabelled, on this run's network): ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
			leaked=$((leaked + count))
		fi
	fi

	# Object storage, when it can be looked at at all.
	if s3_available; then
		ids="$(s3_bucket_names)"
		if [ -n "$ids" ]; then
			count="$(printf '%s\n' "$ids" | grep -c . || true)"
			echo "  ✗ object-storage bucket: ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
			leaked=$((leaked + count))
		fi
	fi

	if [ "$leaked" -gt 0 ]; then
		# ::error:: surfaces it in the GitHub Actions UI rather than burying it in the log.
		echo "::error::hcloud cleanup INCOMPLETE — ${leaked} resource(s) for ${SELECTOR} still exist and are BILLING. Investigate and remove them (stay label-scoped; never delete account-wide)." >&2
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

# Reached only when verify_swept confirmed NOTHING it could look at remains. If something could not
# be looked at, say so HERE — the success line is what a human reads, and "verified complete" over a
# type nobody checked is the exact claim this script exists to stop making.
if [ -n "$UNVERIFIABLE" ]; then
	echo "⚠ hcloud cleanup: everything checkable for ${SELECTOR} is gone, but these were NOT VERIFIED: ${UNVERIFIABLE}"
	echo "::warning::hcloud cleanup for ${SELECTOR} left UNVERIFIED types: ${UNVERIFIABLE}— a human must confirm they are not billing."
else
	echo "✓ hcloud cleanup verified complete for ${SELECTOR} — no labelled resources remain"
fi
echo "  CSI volumes: dynamically-provisioned pvc-* volumes are created by the CSI controller"
echo "  at runtime (not by our template), so 'tofu destroy' cannot reclaim them. They are"
echo "  stamped with cluster=<name> at the source — the hetzner template sets the driver's"
echo "  HCLOUD_VOLUME_EXTRA_LABELS (infra/templates/project/hetzner/csi.tf, chart 2.15.0–2.20.2) —"
echo "  so the label-scoped 'volumes' purge above (after waiting out the async detach) reclaims"
echo "  them WITHOUT widening this script's blast radius. A pvc-* volume can only leak if it"
echo "  predates that change or came from an older template; sweep those by hand (never account-wide)."
