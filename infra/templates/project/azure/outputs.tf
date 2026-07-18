#########################################################################
##                     AKS Outputs                                    ##
#########################################################################

output "aks_cluster_name" {
  description = "Name of the AKS cluster"
  value       = var.provision_aks ? module.aks[0].cluster_name : null
}

output "aks_cluster_endpoint" {
  description = "Endpoint of the AKS cluster"
  value       = var.provision_aks ? module.aks[0].cluster_endpoint : null
  sensitive   = true
}

output "aks_cluster_ca_certificate" {
  description = "Base64-encoded CA certificate of the AKS cluster (public; consumed by the runner to build a CLI-free kubeconfig)"
  value       = var.provision_aks ? module.aks[0].cluster_ca_certificate : null
  sensitive   = true
}

#########################################################################
##                     Resource Group Outputs                          ##
#########################################################################

output "resource_group_name" {
  description = "Name of the Azure resource group"
  value       = azurerm_resource_group.main.name
}

#########################################################################
##                     Azure DB Outputs                                ##
#########################################################################

output "azure_db_fqdn" {
  description = "Fully qualified domain name of the Azure Database flexible server"
  value       = var.create_azure_db ? module.azure_db[0].server_fqdn : null
}

# Keyless DB auth (#722): the app's Entra login identity + the UAMI client id the generated KSA is
# annotated with. Null unless Entra auth is enabled. A binding's `username` facet resolves from
# azure_db_aad_user; the manifest lane annotates the app KSA with azure_db_client_id.
output "azure_db_aad_user" {
  description = "Keyless app database username — the Entra (UAMI) principal name (#722)"
  value       = local.enable_app_db_aad ? azurerm_user_assigned_identity.app_db[0].name : null
}

output "azure_db_client_id" {
  description = "Client id of the app Entra Workload-Identity UAMI — annotated onto the generated app KSA (#722)"
  value       = local.enable_app_db_aad ? azurerm_user_assigned_identity.app_db[0].client_id : null
}

# Keyless least-privilege (#722 R5): the dedicated DB-admin identity the bootstrap Job runs as, and
# the app UAMI's object id the Job binds the app's scoped Entra login to (pgaadauth SECURITY LABEL).
output "azure_db_admin_client_id" {
  description = "Client id of the dedicated DB-admin Entra Workload-Identity UAMI — annotated onto the bootstrap Job KSA (#722)"
  value       = local.enable_app_db_aad ? azurerm_user_assigned_identity.db_admin[0].client_id : null
}

output "azure_db_app_oid" {
  description = "Object (principal) id of the app UAMI — the bootstrap Job binds the app's scoped Postgres role to it via `db-bootstrap --app-oid` (#722)"
  value       = local.enable_app_db_aad ? azurerm_user_assigned_identity.app_db[0].principal_id : null
}

output "azure_db_admin_user" {
  description = "Entra login name (UAMI principal name) the keyless bootstrap Job connects as — the dedicated DB admin (#722)"
  value       = local.enable_app_db_aad ? azurerm_user_assigned_identity.db_admin[0].name : null
}

output "azure_db_name" {
  description = "Name of the default Azure Database flexible server database (the keyless bootstrap Job's admin connection target, #722)"
  value       = var.create_azure_db ? module.azure_db[0].database_name : null
}

#########################################################################
##                     ACR Outputs                                     ##
#########################################################################

output "acr_login_server" {
  description = "Login server URL of the Azure Container Registry"
  value       = var.provision_acr ? module.acr[0].login_server : null
}

#########################################################################
##                     Key Vault Outputs                               ##
#########################################################################

output "custom_secret_ids" {
  description = "List of Key Vault secret IDs"
  value       = module.key_vault.secret_ids
}

#########################################################################
##                     Azure Cache Outputs                             ##
#########################################################################

output "azure_cache_hostname" {
  description = "Hostname of the Azure Cache for Redis instance"
  value       = var.create_azure_cache ? module.azure_cache[0].hostname : null
}

#########################################################################
##                     Azure DNS Outputs                               ##
#########################################################################

output "azure_dns_name_servers" {
  description = "Name servers for the Azure DNS zone"
  value       = var.azure_dns_enabled ? module.azure_dns[0].name_servers : []
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "location_short" {
  description = "Short form of the deployment location"
  value       = local.azure_locations_short[var.location]
}

#########################################################################
##            Workload Identity Outputs (cluster add-ons)             ##
#########################################################################

output "azure_tenant_id" {
  description = "Azure AD tenant id (for workload-identity annotations)"
  value       = data.azurerm_client_config.current.tenant_id
}

output "external_dns_client_id" {
  description = "external-dns managed identity client id (Workload Identity)"
  value       = var.provision_aks ? azurerm_user_assigned_identity.external_dns[0].client_id : null
}

output "external_secrets_client_id" {
  description = "external-secrets operator managed identity client id (Workload Identity; gates the azurekv ClusterSecretStore render)"
  value       = var.provision_aks ? azurerm_user_assigned_identity.external_secrets[0].client_id : null
}

output "key_vault_uri" {
  description = "URI of the project Key Vault (the azurekv ClusterSecretStore's vaultUrl)"
  value       = module.key_vault.vault_uri
}
