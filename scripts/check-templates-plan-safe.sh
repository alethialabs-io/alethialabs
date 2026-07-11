#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# CI guard: project templates must be `tofu plan -out`-safe — the runner's ONLY path.
#
# The runner deploys via `tofu plan -out=<file>` then applies that saved plan
# (packages/core/tofu/tofu.go: Plan uses tfexec.Out; Apply replays it). A saved plan
# must resolve EVERY provider config at plan time. A Kubernetes/Helm/kubectl provider
# configured from the cluster's OWN known-after-apply kubeconfig therefore makes
# `tofu plan -out` fail *before apply* — so the runner can never deploy that template.
# This shipped undetected on Hetzner (see #295: CNI/CCM/CSI were applied via in-tofu
# `kubectl_manifest` resources wired from `talos_cluster_kubeconfig`) because CI only
# ran `tofu validate`, which never evaluates provider configs.
#
# Invariant: a project template MUST NOT apply Kubernetes objects in-tofu. Post-cluster
# manifests belong in Talos `cluster.inlineManifests` (self-managed) or the runner's
# post-apply path (managed ArgoCD / marketplace add-ons). Offline `data "helm_template"`
# renderers are fine — they never connect to a cluster, so they resolve at plan time.
set -euo pipefail

ROOT="${1:-infra/templates/project}"

# Resources that APPLY to a live cluster and thus require a cluster-wired provider.
PATTERN='resource[[:space:]]+"(kubectl_manifest|helm_release|kubernetes_[a-z_]+)"'

hits="$(grep -rnE "$PATTERN" "$ROOT" 2>/dev/null || true)"
if [ -n "$hits" ]; then
  echo "❌ plan-out-safety violation — project template(s) apply Kubernetes objects in-tofu:"
  echo ""
  echo "$hits"
  echo ""
  echo "The runner deploys via 'tofu plan -out' → apply. A provider wired from the cluster's"
  echo "own known-after-apply kubeconfig cannot resolve at plan, so the runner can NEVER deploy"
  echo "this template (it fails at tf.Plan). Move post-cluster manifests to Talos"
  echo "cluster.inlineManifests (self-managed) or the runner's post-apply path (managed add-ons)."
  echo "Offline 'data \"helm_template\"' renderers are allowed."
  exit 1
fi

echo "✓ project templates are plan-out-safe (no in-tofu Kubernetes-applying resources)"
