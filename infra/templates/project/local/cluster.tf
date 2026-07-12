# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# The one and only resource: a local Kubernetes-IN-Docker cluster created at APPLY.
# Its kubeconfig/endpoint are known-after-apply and surface as OUTPUTS (outputs.tf)
# that the runner reads post-apply — never wired into an in-tofu Kubernetes/Helm
# provider (that would break `tofu plan -out`; see main.tf + the plan-safe guard).
resource "kind_cluster" "this" {
  name = local.cluster_name

  # Block until the control plane reports Ready, so `tofu apply` returning implies a
  # reachable API server (the runner's WaitClusterReady gate then re-proves it, and
  # WaitPodToAPIServer proves the pod datapath).
  wait_for_ready = var.wait_for_ready

  # Leave node_image unset (null) to let the provider pick its default kindest/node
  # image, unless the caller pins one. kind node images are version-specific
  # (kindest/node:vX.Y.Z), so we do NOT try to map var.kubernetes_version here.
  node_image = var.node_image != "" ? var.node_image : null
}
