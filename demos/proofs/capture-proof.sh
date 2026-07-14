#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# capture-proof.sh — Proof capture v2 for the T2 real-cloud nightly (BYOC A0.4).
#
# Where the legacy capture-e1.sh only ran on SUCCESS and dumped raw kubectl output, this
# builds a structured, SCRUBBED proof bundle on EVERY attempt (pass OR fail) so a red night
# is debuggable, derives a per-provider PASS/FAIL verdict, and — critically — routes
# everything captured through the A0.0 secret scrub (demos/proofs/scrub.sh) and asserts the
# finished bundle is grep-clean before exiting. If a secret ever survives, the step goes RED
# rather than committing/uploading it (program invariant 2).
#
# It is driven by the workflow (env below) but is runnable by hand too. It NEVER provisions,
# reads creds only to redact their VALUES, and touches nothing outside its output dir.
#
# Inputs (env; CLI args are a convenience fallback for provider/run-tag):
#   PROVIDER                        arg1 — hetzner|aws|…            (required)
#   ALETHIA_E2E_PROOF_RUN_TAG       arg2 — e.g. nightly-<run_id>    (default: local-<stamp>)
#   ALETHIA_E2E_PROOF_OUTCOME       success|failure|cancelled|…     (the T2 step's outcome)
#   ALETHIA_E2E_T2_RUNNER_LOG       path to the runner process log  (the summary source)
#   KUBECONFIG                      host kubeconfig for cluster state (optional; success path)
#   ALETHIA_E2E_REGION / _CLUSTER   region + unique cluster name    (for the summary)
#   ALETHIA_E2E_PROOF_START_EPOCH   epoch seconds at T2 start        (for the wall-clock)
#   ALETHIA_DATABASE_URL            migrated control-plane DB        (best-effort receipt pull)
#   HCLOUD_TOKEN / E2E_GIT_TOKEN    the run's secrets                (redacted, never captured)
#   GITHUB_STEP_SUMMARY             the verdict destination          (optional; stdout otherwise)
#
# Output: demos/proofs/<provider>/<UTC-stamp>/  with provision-summary.json, VERDICT.txt,
#   summary.txt (scrubbed runner-log highlights), receipt.json + verify-result.json (if the
#   DB is reachable), and — on the success path — scrubbed cluster state (nodes/pods/argocd).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=demos/proofs/scrub.sh
source "$root/demos/proofs/scrub.sh"

provider="${1:-${PROVIDER:-}}"
run_tag="${2:-${ALETHIA_E2E_PROOF_RUN_TAG:-local-$(date -u +%Y%m%dT%H%M%SZ)}}"
outcome="${ALETHIA_E2E_PROOF_OUTCOME:-unknown}"
runner_log="${ALETHIA_E2E_T2_RUNNER_LOG:-}"
region="${ALETHIA_E2E_REGION:-${ALETHIA_E2E_HCLOUD_REGION:-unknown}}"
cluster="${ALETHIA_E2E_CLUSTER:-unknown}"
start_epoch="${ALETHIA_E2E_PROOF_START_EPOCH:-}"

if [ -z "$provider" ]; then
	echo "usage: capture-proof.sh <provider> [run-tag]  (or set PROVIDER)" >&2
	exit 2
fi

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
out="$root/demos/proofs/$provider/$stamp"
mkdir -p "$out"
echo "→ capturing T2 proof v2 for $provider (outcome=$outcome) into $out"

# ── Build the exact-value secret redaction list from the run's creds. These VALUES are
#    redacted wherever they surface (a token echoed into a manifest/log). Never captured.
#    Exact-string redaction is the strongest guarantee (independent of the key-name denylist),
#    so we feed it every credential the run holds: the Hetzner token, the A0.6 git token, and —
#    for the aws path — the short-lived AWS session credentials the OIDC step exports. ──
literals=""
for v in "${HCLOUD_TOKEN:-}" "${E2E_GIT_TOKEN:-}" "${ALETHIA_E2E_GIT_TOKEN:-}" \
	"${AWS_SECRET_ACCESS_KEY:-}" "${AWS_SESSION_TOKEN:-}"; do
	[ -n "$v" ] && literals+="$v"$'\n'
done
SCRUB_LITERALS="$literals"
export SCRUB_LITERALS

# ── Runner-log stage detection: how far the deploy spine actually got (the failure-stage
#    for a red night; confirmation of each gate for a green one). Markers are the stdout
#    banners the provisioner + tofu emit (packages/core/provisioner/deploy.go). ──
have_log=0
[ -n "$runner_log" ] && [ -f "$runner_log" ] && have_log=1

log_has() { [ "$have_log" = 1 ] && grep -qF -- "$1" "$runner_log"; }

deploy_stage="queued"
log_has "Starting deployment for project" && deploy_stage="planning"
log_has "Applying OpenTofu changes" && deploy_stage="applying"
log_has "Apply complete!" && deploy_stage="applied"
log_has "Deployment completed successfully." && deploy_stage="deployed"
log_has "ArgoCD installed." && deploy_stage="argocd-installed"
log_has "ArgoCD ready" && deploy_stage="argocd-ready"

# Structured facts extracted from the log (numbers/hashes only — no secret surface).
extract_int() { [ "$have_log" = 1 ] && grep -oE "$1" "$runner_log" | grep -oE '[0-9]+' | head -1 || true; }
resources_added="$(extract_int 'Apply complete! Resources: [0-9]+ added')"
resources_destroyed="$(extract_int 'Destroy complete! Resources: [0-9]+ destroyed')"
receipt_signed=false
receipt_plan_sha=""
if log_has "Evidence receipt signed"; then
	receipt_signed=true
	receipt_plan_sha="$(grep -oE 'plan sha256 [0-9a-f]+' "$runner_log" | grep -oE '[0-9a-f]+$' | head -1 || true)"
fi
destroyed=false
log_has "Destroy complete!" && destroyed=true

# ── Scrubbed runner-log highlights: only the known-safe banner lines, then scrubbed as a
#    backstop. We do NOT dump the whole log into the committable bundle (the raw log is a
#    separate, short-retention debug artifact). ──
if [ "$have_log" = 1 ]; then
	grep -E 'Starting deployment|Applying OpenTofu|Apply complete!|Verification (gate|override)|Evidence receipt (signed|built)|Deployment completed|ArgoCD (installed|ready)|Destroy complete!|reachab|Ready' "$runner_log" 2>/dev/null \
		| scrub_stream >"$out/summary.txt" || true
fi

# ── Cluster state — the honest "SUCCESS = a working cluster" evidence. BEST-EFFORT: the T2
#    test tears the cluster down IN-PROCESS (t.Cleanup → RunDestroy) when the go-test step
#    ends, BEFORE this step — so on the nightly the cluster is usually already gone by now.
#    We therefore PROBE liveness first and only dump live state if it still answers (a local
#    run without teardown, or a failure that skipped destroy). When it's gone, the structured
#    summary (runner log + DB receipt) and the T2 outcome carry the proof instead. Every
#    captured file is scrubbed. ──
nodes_ready=0
argocd_total=0
argocd_ok=0
cluster_live=false
if [ -n "${KUBECONFIG:-}" ] && [ -f "${KUBECONFIG:-/nonexistent}" ] && kubectl get nodes --request-timeout=15s >/dev/null 2>&1; then
	cluster_live=true
	export KUBECONFIG
	kubectl get nodes -o wide >"$out/nodes.txt" 2>&1 || true
	kubectl get pods -A -o wide >"$out/pods.txt" 2>&1 || true
	kubectl -n kube-system get pods -o wide >"$out/kube-system.txt" 2>&1 || true
	kubectl get applications -n argocd -o wide >"$out/argocd-apps.txt" 2>&1 || true
	kubectl version -o yaml >"$out/version.yaml" 2>&1 || true
	for f in nodes.txt pods.txt kube-system.txt argocd-apps.txt version.yaml; do
		[ -f "$out/$f" ] && scrub_file "$out/$f"
	done
	[ -f "$out/nodes.txt" ] && nodes_ready="$(grep -cE '[[:space:]]Ready[[:space:]]' "$out/nodes.txt" || true)"
	if [ -f "$out/argocd-apps.txt" ]; then
		# Lines carrying both a Healthy and a Synced column = converged Applications.
		argocd_total="$(grep -cE 'Healthy|Degraded|Progressing|Missing|Unknown' "$out/argocd-apps.txt" || true)"
		argocd_ok="$(grep -cE 'Healthy[[:space:]]+Synced' "$out/argocd-apps.txt" || true)"
	fi
else
	echo "cluster no longer reachable (torn down in-process at T2 end, or never came up) — live state skipped; proof rests on the T2 outcome + runner log + DB receipt" >"$out/cluster-state.note"
fi

# ── Best-effort: pull the signed verify receipt + control report from the control-plane DB.
#    These are non-secret (an ed25519 signature over the plan sha + per-control verdicts) and
#    are the headline "inspected, not vacuous" artifact. The runner already scrubbed the
#    metadata at the source (A0.0); we pull only these two sub-objects and scrub again. ──
if [ -n "${ALETHIA_DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
	psql "$ALETHIA_DATABASE_URL" -tAc \
		"SELECT COALESCE(execution_metadata->'verify_receipt','null') FROM public.jobs WHERE job_type='DEPLOY' LIMIT 1" \
		2>/dev/null | scrub_stream >"$out/receipt.json" || true
	psql "$ALETHIA_DATABASE_URL" -tAc \
		"SELECT COALESCE(execution_metadata->'verify_result','null') FROM public.jobs WHERE job_type='DEPLOY' LIMIT 1" \
		2>/dev/null | scrub_stream >"$out/verify-result.json" || true
	# Drop empty/null pulls so the bundle only carries real evidence.
	for f in receipt.json verify-result.json; do
		[ -f "$out/$f" ] && { [ ! -s "$out/$f" ] || grep -qx 'null' "$out/$f"; } && rm -f "$out/$f"
	done
fi

# ── Day-2 soak summary (BYOC A0.3). The T2 test writes a machine-readable summary to
#    ALETHIA_E2E_SOAK_SUMMARY (counts + booleans + a numeric volume id — no secrets). Fold it
#    into the bundle (scrubbed, as a backstop) and surface a one-line soak verdict. Absent ⇒
#    the soak was disabled/never ran and the capture is unchanged. ──
soak_summary="${ALETHIA_E2E_SOAK_SUMMARY:-}"
soak_verdict=""
if [ -n "$soak_summary" ] && [ -f "$soak_summary" ]; then
	scrub_stream <"$soak_summary" >"$out/soak-summary.json" || true
	if command -v jq >/dev/null 2>&1 && [ -f "$out/soak-summary.json" ]; then
		soak_verdict="$(jq -r '.verdict // empty' "$out/soak-summary.json" 2>/dev/null || true)"
	fi
	[ -n "$soak_verdict" ] && echo "  · soak: $soak_verdict"
fi

# ── Wall-clock. ──
duration_s=""
if [ -n "$start_epoch" ]; then
	duration_s="$(($(date -u +%s) - start_epoch))"
fi
git_sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ── The verdict. On SUCCESS the T2 test exits 0 ONLY if it asserted the WHOLE chain
#    (real apply → a Ready node → every expected ArgoCD Application Healthy+Synced) before
#    tearing down — so `outcome==success` is itself the authoritative proof of the chain,
#    even though the cluster is usually gone by capture time. We enrich the ArgoCD line with
#    LIVE counts when the cluster was still reachable. On FAILURE we report the stage the
#    spine died at. Kept terse for the step summary; the JSON carries the detail. ──
if [ "$outcome" = "success" ]; then
	if [ "$cluster_live" = true ]; then
		argocd_verdict="Healthy+Synced (${argocd_ok}/${argocd_total} live)"
		ready_verdict="${nodes_ready} node(s) Ready"
	else
		argocd_verdict="Healthy+Synced (T2-asserted)"
		ready_verdict="node Ready (T2-asserted)"
	fi
	verdict="✅ apply(${resources_added:-?} added)→${ready_verdict}→ArgoCD ${argocd_verdict}→destroyed(${resources_destroyed:-?})"
	verdict_icon="✅"
else
	argocd_verdict="not reached"
	verdict="❌ FAILED at stage '${deploy_stage}' (outcome=${outcome})"
	verdict_icon="❌"
fi
verdict_line="${provider}: ${verdict}"

# ── Structured proof (jq if present for safe quoting; a template fallback otherwise). ──
if command -v jq >/dev/null 2>&1; then
	jq -n \
		--arg provider "$provider" --arg region "$region" --arg cluster "$cluster" \
		--arg run_tag "$run_tag" --arg outcome "$outcome" --arg stage "$deploy_stage" \
		--arg git_sha "$git_sha" --arg stamp "$stamp" \
		--arg receipt_plan_sha "$receipt_plan_sha" \
		--argjson resources_added "${resources_added:-null}" \
		--argjson resources_destroyed "${resources_destroyed:-null}" \
		--argjson nodes_ready "${nodes_ready:-0}" \
		--argjson argocd_total "${argocd_total:-0}" \
		--argjson argocd_healthy_synced "${argocd_ok:-0}" \
		--arg argocd_verdict "$argocd_verdict" \
		--argjson cluster_live "$cluster_live" \
		--argjson receipt_signed "$receipt_signed" --argjson destroyed "$destroyed" \
		--argjson duration_s "${duration_s:-null}" \
		--arg verdict "$verdict_line" \
		'{provider:$provider, region:$region, cluster:$cluster, run_tag:$run_tag,
		  outcome:$outcome, deploy_stage:$stage, git_sha:$git_sha, captured_at:$stamp,
		  resources_added:$resources_added, resources_destroyed:$resources_destroyed,
		  cluster_live_at_capture:$cluster_live, nodes_ready:$nodes_ready,
		  argocd_total:$argocd_total, argocd_healthy_synced:$argocd_healthy_synced,
		  argocd_verdict:$argocd_verdict,
		  receipt_signed:$receipt_signed, receipt_plan_sha256:$receipt_plan_sha,
		  destroyed:$destroyed, duration_seconds:$duration_s, verdict:$verdict}' \
		>"$out/provision-summary.json"
else
	cat >"$out/provision-summary.json" <<EOF
{
  "provider": "$provider", "region": "$region", "cluster": "$cluster",
  "run_tag": "$run_tag", "outcome": "$outcome", "deploy_stage": "$deploy_stage",
  "git_sha": "$git_sha", "captured_at": "$stamp",
  "resources_added": ${resources_added:-null}, "resources_destroyed": ${resources_destroyed:-null},
  "cluster_live_at_capture": $cluster_live,
  "nodes_ready": ${nodes_ready:-0}, "argocd_total": ${argocd_total:-0},
  "argocd_healthy_synced": ${argocd_ok:-0}, "argocd_verdict": "$argocd_verdict",
  "receipt_signed": $receipt_signed, "receipt_plan_sha256": "$receipt_plan_sha",
  "destroyed": $destroyed, "duration_seconds": ${duration_s:-null},
  "verdict": "$verdict_line"
}
EOF
fi

cat >"$out/VERDICT.txt" <<EOF
$verdict_line
cluster:   $cluster ($region)
run:       $run_tag @ $git_sha
receipt:   signed=$receipt_signed sha256=${receipt_plan_sha:-n/a}
teardown:  destroyed=$destroyed (${resources_destroyed:-?} resources)
duration:  ${duration_s:-?}s
soak:      ${soak_verdict:-n/a (A0.3 soak off or not reached)}
EOF

# ── FAIL-CLOSED tripwire: the finished bundle MUST be grep-clean. A surviving secret makes
#    this exit non-zero → the step goes RED and nothing is uploaded/committed. ──
if ! assert_grep_clean "$out"; then
	echo "::error::proof capture ABORTED — the bundle failed the secret grep-clean tripwire. Not uploading." >&2
	exit 1
fi
echo "✓ proof bundle scrubbed + grep-clean: $out"

# ── Per-provider verdict → the workflow step summary (or stdout when run locally). ──
{
	echo "### T2 real-cloud proof — \`${provider}\` ${verdict_icon}"
	echo
	echo "**${verdict_line}**"
	echo
	echo "| field | value |"
	echo "|---|---|"
	echo "| cluster | \`${cluster}\` (${region}) |"
	echo "| outcome | ${outcome} |"
	echo "| deploy stage | ${deploy_stage} |"
	echo "| resources added | ${resources_added:-n/a} |"
	echo "| cluster live at capture | ${cluster_live} |"
	echo "| ArgoCD | ${argocd_verdict} |"
	echo "| signed receipt | ${receipt_signed} (sha256 \`${receipt_plan_sha:-n/a}\`) |"
	echo "| teardown | destroyed=${destroyed} (${resources_destroyed:-n/a} resources) |"
	echo "| duration | ${duration_s:-n/a}s |"
	echo "| day-2 soak (A0.3) | ${soak_verdict:-n/a} |"
	echo "| commit | \`${git_sha}\` |"
	echo
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

echo "✓ captured $out — verdict: $verdict_line"
