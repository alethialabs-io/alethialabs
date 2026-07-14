# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Subscription-scoped role assignments for the e2e service principal. Every assignment's scope is
# local.subscription_scope (var.subscription_id) and NOTHING wider — the subscription is the
# blast-radius boundary (Azure has no permissions boundary; see main.tf).
#
# Why these three built-ins:
#   * Contributor — create/destroy the whole AKS estate (AKS, VNet, DB, Redis, ACR, Storage, Service
#     Bus, Cosmos, Key Vault, managed identities, ...). Contributor CANNOT write role assignments.
#   * User Access Administrator — the templates DO create role assignments (external-dns DNS Zone
#     Contributor + the workload-identity federations, infra/templates/project/azure/
#     workload-identity.tf), which Contributor forbids. This role grants roleAssignments/write. It is
#     escalation-capable (it can grant Owner), which is EXACTLY why var.subscription_id must be a
#     dedicated e2e subscription — the SP can escalate only within that throwaway blast radius.
#   * Azure Kubernetes Service Cluster User Role — listClusterUserCredential, so the runner can pull
#     the fresh cluster's user kubeconfig. Cluster-admin authorization itself comes from the SP's
#     membership in the Entra admin group (admin-group.tf) + the template's admin_group_object_ids,
#     NOT from an Azure RBAC data-plane role.
#
# principal_type = "ServicePrincipal" avoids the "principal not found" replication race a fresh SP
# otherwise hits on first assignment.

resource "azurerm_role_assignment" "contributor" {
  scope                = local.subscription_scope
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.e2e.object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "user_access_admin" {
  scope                = local.subscription_scope
  role_definition_name = "User Access Administrator"
  principal_id         = azuread_service_principal.e2e.object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "aks_cluster_user" {
  scope                = local.subscription_scope
  role_definition_name = "Azure Kubernetes Service Cluster User Role"
  principal_id         = azuread_service_principal.e2e.object_id
  principal_type       = "ServicePrincipal"
}
