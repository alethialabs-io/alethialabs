# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The Entra ADMIN GROUP that feeds the AKS e2e self-admin fix (BYOC A2.2). This is the linchpin of
# "managed AKS provisioning that actually authorizes the runner":
#
#   1. This stack creates the group and adds the e2e service principal as a member.
#   2. The group's OBJECT ID is an output (aks_admin_group_object_id).
#   3. The maintainer wires that object id into the azure nightly's cluster JSON — either the
#      ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID env var (test/e2e t2MergeAzureAdminGroup drops it into
#      cluster.provider_config.aks_admin_group_object_ids), or directly in ALETHIA_E2E_CLUSTER_JSON.
#   4. packages/core/cloud/azure_provider.go resolveAKSAdminGroupObjectIDs maps it to the template's
#      aks_admin_group_object_ids tfvar, which renders AKS's AAD-integrated RBAC block with this group
#      as a cluster admin.
#   5. Because the e2e SP (the runner's identity) is a MEMBER of the group, the AAD token it presents
#      to the fresh API server is authorized as cluster-admin AT CREATE TIME — fixing the managed
#      "runner never authorized → ArgoCD 401s" failure that also afflicted EKS/GKE.
#
# On the customer/default path admin_group_object_ids stays empty and the AAD RBAC block is unrendered
# (plain Kubernetes RBAC, unchanged) — this group exists ONLY for the e2e nightly.

resource "azuread_group" "aks_admins" {
  display_name     = "${var.name_prefix}-aks-admins"
  description      = "Alethia e2e AKS cluster-admin group. Members' AAD tokens are authorized as cluster-admin on e2e AKS clusters via admin_group_object_ids. Wire its object id into the azure nightly cluster JSON."
  security_enabled = true
  owners           = [data.azuread_client_config.current.object_id]
}

# Add the e2e service principal (the runner's identity) as a member, so its AAD token is authorized.
resource "azuread_group_member" "e2e_sp" {
  group_object_id  = azuread_group.aks_admins.object_id
  member_object_id = azuread_service_principal.e2e.object_id
}
