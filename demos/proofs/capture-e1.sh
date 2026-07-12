#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# capture-e1.sh — snapshot a real E1 provisioning run into a committable proof.
#
# The apply→cluster→ArgoCD→addons chain has never run on real infra; this script
# makes the FIRST run reproducible evidence rather than a screenshot. Run it right
# after a DEPLOY job reaches SUCCESS, pointed at the cluster's kubeconfig.
#
# Usage:
#   KUBECONFIG=/path/to/kubeconfig ./demos/proofs/capture-e1.sh <provider> [job-id]
#   # e.g.  KUBECONFIG=~/.alethia/kubeconfig ./demos/proofs/capture-e1.sh hetzner 0c3f...
#
# It writes demos/proofs/e1-<provider>/<UTC-date>/ with the cluster state, ArgoCD
# health, and a run-notes template. Attach the DEPLOY job's SSE log and the
# ed25519 verify receipt (downloaded from Evidence) into the same dir, then commit.
set -euo pipefail

provider="${1:?usage: capture-e1.sh <provider> [job-id]}"
job_id="${2:-unknown}"
: "${KUBECONFIG:?set KUBECONFIG to the provisioned cluster's kubeconfig}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
out="$root/demos/proofs/e1-$provider/$stamp"
mkdir -p "$out"

echo "→ capturing E1 proof for $provider into $out"

# Cluster reachability + state — the honest "SUCCESS = working cluster" evidence.
kubectl version -o yaml            > "$out/version.yaml"        2>&1 || true
kubectl get nodes -o wide          > "$out/nodes.txt"          2>&1 || true
kubectl get pods -A -o wide        > "$out/pods.txt"           2>&1 || true
kubectl get applications -n argocd -o wide > "$out/argocd-apps.txt" 2>&1 || true
kubectl get events -A --sort-by=.lastTimestamp > "$out/events.txt" 2>&1 || true
# CNI + cloud-integration bootstrap (the Talos Cilium / hcloud-CCM path — top failure suspect).
kubectl -n kube-system get pods -o wide > "$out/kube-system.txt" 2>&1 || true

cat > "$out/RUN-NOTES.md" <<EOF
# E1 proof — $provider — $stamp

- **DEPLOY job:** \`$job_id\`
- **Template:** infra/templates/project/$provider
- **Runner:** (operator / mode — e.g. self · docker)
- **Cluster spec:** (e.g. Talos cax11 × N @ nbg1)
- **Result:** (SUCCESS / FAILED at which gate)

## What to verify against the captured files
- [ ] \`nodes.txt\` — every node Ready (the #288 reachability gate)
- [ ] \`kube-system.txt\` — Cilium + hcloud-CCM pods Running (the #301 CNI bootstrap)
- [ ] \`pods.txt\` — no CrashLoopBackOff (esp. argocd-redis; the #308 pre-seed)
- [ ] \`argocd-apps.txt\` — infra-services + addons Healthy/Synced
- [ ] Attach: the DEPLOY job's full SSE log as \`deploy-log.txt\`
- [ ] Attach: the ed25519 verify receipt as \`receipt.json\` (Evidence → download)

## Seams that broke / fixes needed
(record anything that failed on the first real run — this is why E1 exists)

## Repeatability
- [ ] Destroyed the cluster
- [ ] Re-ran from scratch — same result (not a fluke)
EOF

echo "✓ captured. Now attach deploy-log.txt + receipt.json, fill RUN-NOTES.md, and commit $out"
