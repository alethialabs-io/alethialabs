# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "e2e_azure_client_id" {
  description = "Set as the repo Actions VARIABLE E2E_AZURE_CLIENT_ID (the ARM_CLIENT_ID the azure nightly federates into). Its presence gates the azure path of e2e-nightly.yml."
  value       = azuread_application.e2e.client_id
}

output "e2e_azure_tenant_id" {
  description = "Set as the repo Actions VARIABLE E2E_AZURE_TENANT_ID (ARM_TENANT_ID)."
  value       = data.azuread_client_config.current.tenant_id
}

output "e2e_azure_subscription_id" {
  description = "Set as the repo Actions VARIABLE E2E_AZURE_SUBSCRIPTION_ID (ARM_SUBSCRIPTION_ID) — the dedicated e2e subscription."
  value       = var.subscription_id
}

output "aks_admin_group_object_id" {
  description = "The Entra admin group OBJECT ID. Wire it into the azure nightly cluster JSON (VARIABLE ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID, or in ALETHIA_E2E_CLUSTER_JSON) so the runner's AAD token — a member of this group — is authorized as AKS cluster-admin at create time (BYOC A2.2 self-admin)."
  value       = azuread_group.aks_admins.object_id
}

output "e2e_service_principal_object_id" {
  description = "The e2e service principal's object id (a member of the admin group; the principal the subscription role assignments target)."
  value       = azuread_service_principal.e2e.object_id
}

output "e2e_budget_action_group_id" {
  description = "The monitor action group the e2e budget alerts publish to (hang a kill-switch here later)."
  value       = azurerm_monitor_action_group.e2e_budget.id
}
