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

# Keyless DB auth (#722, #1464): the app's Entra login identity + the UAMI client id the generated KSA
# is annotated with. Non-null for BOTH engines when keyless is enabled with AKS (gated on
# enable_app_db_identity). A binding's `username` facet resolves from azure_db_aad_user; the manifest
# lane annotates the app KSA with azure_db_client_id.
output "azure_db_aad_user" {
  description = "Keyless app database username — the Entra (UAMI) principal name (#722)"
  value       = local.enable_app_db_identity ? azurerm_user_assigned_identity.app_db[0].name : null
}

output "azure_db_client_id" {
  description = "Client id of the app Entra Workload-Identity UAMI — annotated onto the generated app KSA; also the MySQL keyless bind value (`db-bootstrap --app-client-id`) (#722)"
  value       = local.enable_app_db_identity ? azurerm_user_assigned_identity.app_db[0].client_id : null
}

# Keyless least-privilege (#722 R5): the dedicated DB-admin identity the bootstrap Job runs as, and
# the app UAMI id the Job binds the app's scoped Entra login to (Postgres: OID via pgaadauth SECURITY
# LABEL; MySQL: client id via CREATE AADUSER).
output "azure_db_admin_client_id" {
  description = "Client id of the dedicated DB-admin Entra Workload-Identity UAMI — annotated onto the bootstrap Job KSA (#722)"
  value       = local.enable_app_db_identity ? azurerm_user_assigned_identity.db_admin[0].client_id : null
}

output "azure_db_app_oid" {
  description = "Object (principal) id of the app UAMI — the POSTGRES bootstrap Job binds the app's scoped role to it via `db-bootstrap --app-oid` (MySQL binds on azure_db_client_id instead) (#722)"
  value       = local.enable_app_db_identity ? azurerm_user_assigned_identity.app_db[0].principal_id : null
}

output "azure_db_admin_user" {
  description = "Entra login name (UAMI principal name) the keyless bootstrap Job connects as — the dedicated DB admin (#722)"
  value       = local.enable_app_db_identity ? azurerm_user_assigned_identity.db_admin[0].name : null
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
  # Guarded on the MODULE, not on a copy of its count predicate. `provision_acr` alone is NOT that
  # predicate: the module also requires `registry_provider == "native"` (acr.tf), because a pluggable
  # registry connector means the ACR is not ours to create. The console sets `provision_acr` from the
  # mere PRESENCE of a registry row, so selecting any connector left this indexing [0] of an empty
  # module and failed the WHOLE apply with "Invalid index" — a crash a mile from its cause.
  #
  # length(module...) can't drift from the count the way a duplicated predicate did.
  value = length(module.acr) > 0 ? module.acr[0].login_server : null
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
  description = "external-secrets operator managed identity client id (Workload Identity; gates the azurekv ClusterSecretStore render). The adopted identity when external_secrets_identity_name/_resource_group are set, otherwise the one this template created."
  value       = var.provision_aks ? local.external_secrets_client_id : null
}

output "key_vault_uri" {
  description = "URI of the project Key Vault (the azurekv ClusterSecretStore's vaultUrl)"
  value       = module.key_vault.vault_uri
}

#########################################################################
##                    Storage Account Outputs                          ##
#########################################################################

# Surfaced so the two bucket switches are legible from the plan — and so checks_storage.tftest.hcl
# can assert them from the ROOT, which is the only place tofu's test harness runs.
output "storage_container_access_types" {
  description = "Map of container name to the container_access_type it is planned with"
  value       = var.create_storage_account ? module.storage_account[0].container_access_types : {}
}

output "storage_blob_versioning_enabled" {
  description = "Whether blob versioning is planned on the project's storage account"
  value       = var.create_storage_account ? module.storage_account[0].blob_versioning_enabled : null
}

output "storage_allow_nested_items_to_be_public" {
  description = "Whether the storage account permits public containers"
  value       = var.create_storage_account ? module.storage_account[0].allow_nested_items_to_be_public : null
}
