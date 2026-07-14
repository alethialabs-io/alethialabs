# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time guard for the cluster-access invariant (BYOC F1). A managed EKS cluster that no
# identity can administer is useless — the runner could never install ArgoCD/add-ons, and a
# customer could never reach it. So we FAIL THE PLAN (loud, before apply) unless at least one
# admin path is configured: the apply-runner creator-admin (default), an explicit cluster_admins
# entry, or a supplied access_entries map. Mirrors the A1.2 money-guard style (terraform_data
# precondition) so a regression that silently drops every admin path bricks the plan, not prod.
resource "terraform_data" "cluster_access_guard" {
  lifecycle {
    precondition {
      condition     = var.enable_creator_admin || length(var.cluster_admins) > 0 || length(keys(var.access_entries)) > 0
      error_message = "EKS cluster would have NO admin: set enable_creator_admin=true (default — grants the apply-runner cluster-admin), or provide cluster_admins / access_entries. Without one, the runner cannot install ArgoCD and no one can reach the cluster."
    }
  }
}
