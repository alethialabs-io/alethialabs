#########################################################################
##                     GKE Outputs                                    ##
#########################################################################

output "gke_cluster_name" {
  description = "Name of the GKE cluster"
  value       = var.provision_gke ? module.gke[0].cluster_name : null
}

output "gke_cluster_endpoint" {
  description = "Endpoint of the GKE cluster"
  value       = var.provision_gke ? module.gke[0].cluster_endpoint : null
  sensitive   = true
}

output "gke_cluster_ca_certificate" {
  description = "Base64-encoded CA certificate of the GKE cluster"
  value       = var.provision_gke ? module.gke[0].cluster_ca_certificate : null
  sensitive   = true
}

#########################################################################
##                     Cloud SQL Outputs                               ##
#########################################################################

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name for Cloud SQL Proxy"
  value       = var.create_cloud_sql ? module.cloud_sql[0].connection_name : null
}

output "cloud_sql_ip" {
  description = "Private IP address of the Cloud SQL instance"
  value       = var.create_cloud_sql ? module.cloud_sql[0].instance_ip : null
}

output "cloud_sql_database" {
  description = "Name of the Cloud SQL database"
  value       = var.create_cloud_sql ? module.cloud_sql[0].database_name : null
}

# Keyless DB auth (#722): the app's IAM login identity + the GSA email the generated KSA is
# annotated with. Null unless Cloud SQL IAM auth is enabled. A binding's `username` facet resolves
# from cloud_sql_iam_user; the manifest lane annotates the app KSA with cloud_sql_app_gsa_email.
output "cloud_sql_iam_user" {
  description = "Keyless app database username — the CLOUD_IAM_SERVICE_ACCOUNT user (#722)"
  value       = local.enable_app_db_iam ? module.cloud_sql[0].app_iam_user : null
}

output "cloud_sql_app_gsa_email" {
  description = "Email of the app Cloud SQL Workload-Identity GSA — annotated onto the generated app KSA (#722)"
  value       = local.enable_app_db_iam ? google_service_account.app_db[0].email : null
}

# Keyless bootstrap (#722 R5): the Secret Manager secret id holding the BUILT_IN admin (default user)
# credentials. The bootstrap Job's ExternalSecret pulls username+password from it (via the gcpsm
# ClusterSecretStore) to connect as admin and grant the app IAM user its scoped privileges.
output "cloud_sql_credentials_secret" {
  description = "Secret Manager secret id of the Cloud SQL admin (default user) credentials — the keyless bootstrap Job's admin ExternalSecret RemoteKey (#722)"
  value       = var.create_cloud_sql ? module.cloud_sql[0].credentials_secret_id : null
}

#########################################################################
##                     Artifact Registry Outputs                       ##
#########################################################################

output "artifact_registry_urls" {
  description = "Map of Artifact Registry repository URLs"
  value       = var.provision_artifact_registry ? module.artifact_registry[0].repository_urls : {}
}

#########################################################################
##                     Secret Manager Outputs                          ##
#########################################################################

output "custom_secret_ids" {
  description = "List of Secret Manager secret IDs"
  value       = module.secret_manager.secret_ids
}

output "custom_secret_names" {
  description = "List of Secret Manager secret names"
  value       = module.secret_manager.secret_names
}


#########################################################################
##                     Memorystore Outputs                             ##
#########################################################################

output "memorystore_host" {
  description = "Hostname or IP of the Memorystore Redis instance"
  value       = var.create_memorystore ? module.memorystore[0].host : null
}

output "memorystore_port" {
  description = "Port of the Memorystore Redis instance"
  value       = var.create_memorystore ? module.memorystore[0].port : null
}

#########################################################################
##                     Cloud DNS Outputs                               ##
#########################################################################

output "cloud_dns_name_servers" {
  description = "Name servers for the Cloud DNS managed zone"
  value       = var.cloud_dns_enabled ? module.cloud_dns[0].name_servers : []
}

output "cloud_dns_zone_name" {
  description = "Name of the Cloud DNS managed zone"
  value       = var.cloud_dns_enabled ? module.cloud_dns[0].zone_name : null
}

#########################################################################
##                     Networking Outputs                              ##
#########################################################################

output "network_self_link" {
  description = "Self-link of the VPC network"
  value       = var.provision_network ? module.vpc_network[0].network_self_link : var.network_id
}

output "private_subnet_self_link" {
  description = "Self-link of the private subnetwork"
  value       = var.provision_network ? module.vpc_network[0].private_subnet_self_link : null
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "region_short" {
  description = "Short form of the deployment region"
  value       = local.gcp_regions_short[local.gcp_region_key]
}

output "project_id" {
  description = "GCP project ID"
  value       = var.project_id
}

#########################################################################
##            Workload Identity Outputs (cluster add-ons)             ##
#########################################################################

output "gcp_project_id" {
  description = "GCP project id (for Workload Identity annotations)"
  value       = var.project_id
}

output "external_dns_service_account" {
  description = "external-dns Google service account email (Workload Identity)"
  value       = var.provision_gke ? google_service_account.external_dns[0].email : null
}

output "external_secrets_service_account" {
  description = "external-secrets operator Google service account email (Workload Identity; gates the gcpsm ClusterSecretStore render)"
  value       = var.provision_gke ? google_service_account.external_secrets[0].email : null
}
