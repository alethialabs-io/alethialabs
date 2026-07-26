# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-subscription keyless Azure Key Vault — TARGET-vault read grant (Model B).
#
# You run this in the subscription that OWNS the vault (subscription B, SAME tenant as the cluster),
# ONCE. It assigns your Alethia cluster's external-secrets workload identity the "Key Vault Secrets User"
# role on the target vault — no client secret is created or stored. The in-cluster External Secrets
# Operator authenticates with the cluster's AKS workload identity (authType: WorkloadIdentity) and reads
# the target vault by URL. Enter the target subscription id + vault URL in the Alethia `azure-kv-xacct`
# connector.
#
# SAME-TENANT ONLY. Cross-TENANT keyless Key Vault access is a hard Azure platform limit (a managed /
# workload identity cannot be used across tenants); it needs a customer-created app registration +
# federated credential in the vault's tenant and is out of scope for this module (see the connector docs).
#
# Prereqs: OpenTofu/Terraform authenticated to the SECRETS subscription (B); Azure AD read to resolve the
# identity's principal; the target vault must use RBAC authorization (enable_rbac_authorization = true).
# The cluster's external-secrets managed-identity client id — the `azure-kv-xacct` connector shows it, or
# read the project's `external_secrets_client_id` output.

variable "cluster_workload_identity_client_id" {
  description = "The Alethia cluster's external-secrets workload-identity client id (from the project's external_secrets_client_id output). Its service principal is granted Key Vault Secrets User on the target vault."
  type        = string
}

variable "target_key_vault_id" {
  description = "The full Azure resource id of the target Key Vault (in subscription B, same tenant), e.g. /subscriptions/<sub-b>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<name>."
  type        = string

  validation {
    condition     = can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.KeyVault/vaults/[^/]+$", var.target_key_vault_id))
    error_message = "target_key_vault_id must be a full Key Vault resource id (/subscriptions/.../providers/Microsoft.KeyVault/vaults/<name>)."
  }
}

# Resolve the workload identity's service-principal object id from its client id.
data "azuread_service_principal" "eso" {
  client_id = var.cluster_workload_identity_client_id
}

# "Key Vault Secrets User" (read secrets) on the target vault only — least-privilege, read-only. Requires
# the vault to use RBAC authorization; on an access-policy vault, grant a Get-secrets access policy instead.
resource "azurerm_role_assignment" "kv_secrets_reader" {
  scope                = var.target_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = data.azuread_service_principal.eso.object_id
}

output "role_assignment_id" {
  value       = azurerm_role_assignment.kv_secrets_reader.id
  description = "The role assignment granting the cluster's external-secrets identity read on the target vault."
}
