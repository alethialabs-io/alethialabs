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
  # Guarded on the MODULE, not on a copy of its count predicate. `provision_artifact_registry` alone
  # is NOT that predicate: the module also requires `registry_provider == "native"` (artifact-registry.tf),
  # because a pluggable registry connector means Artifact Registry is not ours to create. The console
  # sets `provision_artifact_registry` from the mere PRESENCE of a registry row, so selecting any
  # connector left this indexing [0] of an empty module and failed the WHOLE apply with "Invalid
  # index" — a crash a mile from its cause.
  #
  # length(module...) can't drift from the count the way a duplicated predicate did.
  value = length(module.artifact_registry) > 0 ? module.artifact_registry[0].repository_urls : {}
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

# ONE pair of cache outputs for both engines: `endpointOutputKey` (packages/core/manifests) maps
# cloud+kind to a single output name, so a service bound to "the cache" reads `memorystore_host`
# whichever engine backs it. A separate `valkey_*` key would force every consumer to learn the engine,
# and one that forgot would resolve to null — which is the failure this lane exists to remove.
# The two toggles are mutually exclusive, so at most one side is non-null.
output "memorystore_host" {
  description = "Hostname or IP of the Memorystore Redis instance"
  value = try(coalesce(
    var.create_memorystore ? module.memorystore[0].host : null,
    var.create_memorystore_valkey ? module.memorystore_valkey[0].host : null,
  ), null)
}

output "memorystore_port" {
  description = "Port of the Memorystore Redis instance"
  value = try(coalesce(
    var.create_memorystore ? module.memorystore[0].port : null,
    var.create_memorystore_valkey ? module.memorystore_valkey[0].port : null,
  ), null)
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
  description = "external-secrets operator Google service account email (Workload Identity; gates the gcpsm ClusterSecretStore render). The adopted GSA when external_secrets_service_account_email is set, otherwise the one this template created."
  value       = var.provision_gke ? local.external_secrets_sa_email : null
}

#########################################################################
##                    Cloud Storage Outputs                            ##
#########################################################################

# Surfaced so the state of the `public_access` switch is legible from the outputs — and so
# checks_storage.tftest.hcl can assert BOTH halves of it from the root, which is the only place
# tofu's test harness can see (a *.tftest.hcl under modules/ is never executed).
output "cloud_storage_public_access_prevention" {
  description = "Map of bucket suffixes to the public_access_prevention each bucket is planned with"
  value       = var.create_cloud_storage ? module.cloud_storage[0].bucket_public_access_prevention : {}
}

output "cloud_storage_publicly_readable_buckets" {
  description = "Bucket suffixes that carry an allUsers reader binding"
  value       = var.create_cloud_storage ? module.cloud_storage[0].publicly_readable_buckets : []
}
