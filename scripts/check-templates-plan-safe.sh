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

# ── Second invariant: the AZ / zone COUNT must be plan-known ──────────────────────────────────
#
# The same `tofu plan -out` requirement means every `count`/`for_each` must resolve at plan. An
# availability-zones DATA SOURCE resolves to UNKNOWN at plan under the runner's deferred provider
# (assume-role / OIDC / WIF / RAM — credentials only resolve at apply). So `azs = data.<...>zones`
# or `length(data.<...>zones)` feeding a subnet/NAT count makes the count undeterminable → the
# plan fails "Invalid count argument" BEFORE apply. This broke the real aws nightly (#551, fixed in
# #608 by deriving AZs statically). Derive the AZ/zone count from a plan-known static list instead.
ZONES_PATTERN='(\bazs[[:space:]]*=[[:space:]]*data\.|length\(data\.[a-z_]*(availability_)?zones)'

# Reviewed exceptions — files that still carry the pattern, each with a tracking issue. DELETE the
# entry when the referenced fix lands. (Mirrors infra/.trivyignore: an allowlist, never a silent skip.)
ZONES_ALLOWLIST=(
  # (empty) — #621 fixed alibaba/network.tf: zone_ids no longer feeds a count; the vswitch count is
  # the plan-known var.subnet_count. Re-add a file here only with a tracking issue.
)

zone_hits="$(grep -rnE "$ZONES_PATTERN" "$ROOT" 2>/dev/null || true)"
# Drop allowlisted files. Guarded so an EMPTY allowlist is safe under `set -u` (and never runs the
# loop with f="" — grep -vF "" would drop every hit and mask real violations).
if [ "${#ZONES_ALLOWLIST[@]}" -gt 0 ]; then
  for f in "${ZONES_ALLOWLIST[@]}"; do
    zone_hits="$(printf '%s\n' "$zone_hits" | grep -vF "$f" || true)"
  done
fi
zone_hits="$(printf '%s\n' "$zone_hits" | grep -vE '^[[:space:]]*$' || true)"

if [ -n "$zone_hits" ]; then
  echo "❌ plan-out-safety violation — AZ/zone count derived from a zones DATA SOURCE (unknown at plan):"
  echo ""
  echo "$zone_hits"
  echo ""
  echo "Under the runner's deferred provider (assume-role/OIDC/WIF/RAM), a zones data source is unknown"
  echo "at plan, so a subnet/NAT 'count' built from it fails 'tofu plan -out' before apply (see #551/#608)."
  echo "Derive the AZ/zone count from a plan-known static list (e.g. aws: azs = [\"\${var.region}a\", …]),"
  echo "or make the subnet count a fixed number that indexes into the discovered zones."
  echo "If a template legitimately needs an exception, add it to ZONES_ALLOWLIST with a tracking issue."
  exit 1
fi

echo "✓ project templates derive AZ/zone counts plan-safely (no count from a zones data source)"
