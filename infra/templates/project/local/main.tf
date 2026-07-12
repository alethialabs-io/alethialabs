# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# `local` project template — a hermetic, in-tofu `kind` (Kubernetes-IN-Docker)
# cluster. This is the provisioning-E2E KEYSTONE: it drives the real
# `provisioner.RunDeployV2` spine end to end (plan -> verify gate -> signed
# receipt -> apply -> ConfigureKubeconfig -> WaitClusterReady ->
# WaitPodToAPIServer -> ArgoCD) against a genuine Kubernetes cluster, with NO
# cloud account and NO cloud credentials.
#
# It is deliberately driven through the HETZNER (Talos) code path: it emits the
# `talos_cluster_name` / `talos_cluster_endpoint` / `kubeconfig` outputs the
# runner's post-apply path reads, so `cloud.ExtractClusterName` finds the cluster
# and the spine LIGHTS UP with ZERO cloud_provider-enum surgery. `kind` ships
# kindnet (its own CNI), so `bootstrap_manifests` is emitted EMPTY — which also
# exercises the empty-bootstrap no-op branch in `applyBootstrapManifests`.
#
# PLAN-OUT-SAFETY (scripts/check-templates-plan-safe.sh): like the Hetzner/Talos
# template, this module applies NO Kubernetes objects in-tofu — there is no
# kubernetes/helm/kubectl PROVIDER wired from the cluster's own
# (known-after-apply) kubeconfig. The only resource is `kind_cluster`, whose
# kubeconfig is a known-after-apply OUTPUT the runner consumes post-apply. So
# `tofu plan -out` (the runner's only path) resolves every provider at plan time.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.6"

  # Console HTTP state proxy — the runner supplies address/lock/unlock at
  # `tofu init -backend-config=...` (per-job token via TF_HTTP_PASSWORD), exactly
  # like every other project template. Do NOT add attributes here. The in-process
  # T0 E2E test stands up a local http state server that speaks this backend.
  backend "http" {}

  required_providers {
    # tehcyx/kind bundles the `kind` toolchain (it does NOT shell out to a `kind`
    # binary) and creates the cluster against the local Docker daemon at apply.
    # Pinned explicitly so the keystone is reproducible.
    kind = {
      source  = "tehcyx/kind"
      version = "0.11.0"
    }
  }
}

# The kind provider talks to the local Docker daemon (DOCKER_HOST / default socket).
# No configuration is required for the common case.
provider "kind" {}

locals {
  # Same cluster-name convention as the managed/self-managed templates
  # (project-environment). Emitted as `talos_cluster_name` so ExtractClusterName
  # keys on it. kind cluster names must be lowercase RFC1123-ish, so callers pass
  # lowercase project/environment values.
  cluster_name = "${var.project_name}-${var.environment}"
}
