# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# COMPAT-001 version-window gate (the check warns; the terraform_data precondition blocks).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# COMPAT-001 (epic #1186, block-at-apply): the EKS Kubernetes minor must sit inside the AWS support
# window (matrix.json k8s_cloud.aws = 1.33-1.35). A `check` block only WARNS, so the hard gate is the
# terraform_data precondition below; this check surfaces the same violation loudly at plan time.
check "compat_k8s_supported" {
  assert {
    condition     = !var.provision_eks || (local.eks_k8s_major == 1 && local.eks_k8s_minor >= 33 && local.eks_k8s_minor <= 35)
    error_message = "COMPAT: EKS Kubernetes '${var.eks_cluster_version}' is outside the AWS-supported window 1.33-1.35 (packages/core/compat/matrix.json k8s_cloud.aws); terraform_data.compat_k8s_guard blocks apply."
  }
}


# Fail-closed apply gate (COMPAT-001): an out-of-window Kubernetes minor hard-fails the plan here, so an
# incompatible cluster (the #1165 ArgoCD-on-1.35 class of break) can never be provisioned. `check` blocks
# only warn — a `terraform_data` lifecycle precondition is the actual gate. No bypass variable: waivers
# are a runner-layer concern (compat.Override / COMPAT-001), deliberately not exposed in the template.
resource "terraform_data" "compat_k8s_guard" {
  lifecycle {
    precondition {
      condition     = !var.provision_eks || (local.eks_k8s_major == 1 && local.eks_k8s_minor >= 33 && local.eks_k8s_minor <= 35)
      error_message = "COMPAT-001: EKS Kubernetes '${var.eks_cluster_version}' is outside the AWS-supported window 1.33-1.35 (SSOT: packages/core/compat/matrix.json k8s_cloud.aws). Apply blocked fail-closed — align eks_cluster_version and the matrix in lockstep."
    }
  }
}
