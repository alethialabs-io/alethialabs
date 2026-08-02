# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# AKS cluster BYOC access invariants (admin groups / authorized ranges / runner admin path).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# BYOC B4.1 — cluster_admins → admin_group_object_ids must carry Entra group OBJECT IDs
# (GUIDs), never names. AKS rejects non-GUID admin group ids, so fail loudly at plan time.
check "aks_admin_group_object_ids_are_guids" {
  assert {
    condition = alltrue([
      for id in var.aks_admin_group_object_ids :
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", id))
    ])
    error_message = "aks_admin_group_object_ids must be Entra group OBJECT IDs (GUIDs), not group names — map cluster_admins' `groups` to object ids."
  }
}

# BYOC B4.1 — every AKS API-server authorized range must be a valid IPv4 CIDR, so a
# typo can't silently widen or break the allow-list.
check "aks_authorized_ip_ranges_valid_cidrs" {
  assert {
    condition = alltrue([
      for c in var.aks_authorized_ip_ranges : can(cidrhost(c, 0))
    ])
    error_message = "aks_authorized_ip_ranges entries must be valid IPv4 CIDRs (e.g. 203.0.113.0/24)."
  }
}

# BYOC AZ-SELF-ADMIN (mirror of aws/modules/eks/checks.tf) — an AKS cluster the apply-runner
# cannot administer is useless: with Azure RBAC for Kubernetes on, the runner's AAD token 401s
# and it can never install ArgoCD/add-ons. Fail the PLAN if no runner-reachable admin path is
# configured, so a future default flip can't silently brick provisioning instead of the plan.
check "aks_runner_admin_path" {
  assert {
    condition     = var.aks_enable_creator_admin || length(var.aks_admin_group_object_ids) > 0
    error_message = "AKS would have NO runner-reachable admin: set aks_enable_creator_admin=true (default — grants the apply-runner RBAC Cluster Admin), or provide aks_admin_group_object_ids. Without one, the runner cannot install ArgoCD."
  }
}
