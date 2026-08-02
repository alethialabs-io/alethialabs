# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# COMPAT-001 (epic #1186) Kubernetes support-window gate (cloud + component windows).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# COMPAT-001 (epic #1186, block-at-apply): the rendered Kubernetes minor must sit inside the Hetzner
# cloud window (matrix.json k8s_cloud.hetzner = 1.35). A `check` block only WARNS, so the hard gate is
# the terraform_data precondition below; this check surfaces the same violation loudly at plan time.
check "compat_k8s_supported" {
  assert {
    condition     = local.hetzner_k8s_major == 1 && local.hetzner_k8s_minor == 35
    error_message = "COMPAT: Kubernetes '${local.render_kube_version}' is outside the Hetzner-supported minor 1.35 (packages/core/compat/matrix.json k8s_cloud.hetzner); terraform_data.compat_k8s_guard blocks apply."
  }
}

# Fail-closed apply gate (COMPAT-001): the rendered Kubernetes minor must satisfy the Hetzner cloud window
# AND every in-template component's support window (talos / cilium / hcloud-csi). The cloud window (1.35)
# is the tightest today, but the component preconditions independently guard a future matrix widening —
# the real invariant couplings_drift_test.go (#1214) proves in Go (e.g. raising k8s past Cilium's 1.35
# ceiling would break GitOps). `check` blocks only warn; a `terraform_data` lifecycle precondition is the
# actual gate. No bypass variable — waivers are a runner-layer compat.Override / COMPAT-001 concern.
resource "terraform_data" "compat_k8s_guard" {
  lifecycle {
    precondition {
      condition     = local.hetzner_k8s_major == 1 && local.hetzner_k8s_minor == 35
      error_message = "COMPAT-001: Kubernetes '${local.render_kube_version}' is outside the Hetzner-supported minor 1.35 (SSOT: packages/core/compat/matrix.json k8s_cloud.hetzner). Apply blocked fail-closed."
    }
    precondition {
      condition     = local.hetzner_k8s_minor >= 31 && local.hetzner_k8s_minor <= 36
      error_message = "COMPAT-001: Kubernetes '${local.render_kube_version}' is outside the Talos ${var.talos_version} support window 1.31-1.36 (matrix.json components.talos). Move Talos + kubernetes_version in lockstep."
    }
    precondition {
      condition     = local.hetzner_k8s_minor <= 35
      error_message = "COMPAT-001: Kubernetes '${local.render_kube_version}' exceeds the Cilium ${local.cilium_version} ceiling 1.35 (matrix.json components.cilium k8s_max). Raising k8s needs a Cilium bump first."
    }
    precondition {
      condition     = local.hetzner_k8s_minor >= 34 && local.hetzner_k8s_minor <= 36
      error_message = "COMPAT-001: Kubernetes '${local.render_kube_version}' is outside the hcloud-csi ${local.hcloud_csi_version} support window 1.34-1.36 (matrix.json components.hcloud-csi)."
    }
  }
}
