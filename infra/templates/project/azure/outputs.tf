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
  value       = var.create_azure_db ? module.azure_db[0].fqdn : null
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
