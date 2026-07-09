# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

#########################################################################
##                     ACK (Kubernetes) Outputs                        ##
#########################################################################

output "ack_cluster_name" {
  description = "Name of the ACK cluster (the pipeline configures kubeconfig only when set)"
  value       = var.provision_ack ? "${var.project_name}-${var.environment}" : ""
}

output "ack_cluster_endpoint" {
  description = "Public API server endpoint of the ACK cluster"
  value       = var.provision_ack ? module.cluster[0].cluster_endpoint : ""
}

output "kubeconfig" {
  description = "Kubeconfig for the ACK cluster"
  value       = var.provision_ack ? module.cluster[0].kubeconfig : ""
  sensitive   = true
}

#########################################################################
##                     Networking Outputs                              ##
#########################################################################

output "vpc_id" {
  description = "Id of the VPC (new or existing)"
  value       = var.provision_network ? try(module.network[0].vpc_id, "") : var.network_id
}

output "vswitch_ids" {
  description = "Vswitch ids used by the workloads"
  value       = local.vswitch_ids
}

#########################################################################
##                     RDS Outputs                                     ##
#########################################################################

output "rds_connection_string" {
  description = "Private connection string of the RDS instance"
  value       = var.create_rds ? module.rds[0].connection_string : null
}

output "rds_port" {
  description = "Port of the RDS instance"
  value       = var.create_rds ? module.rds[0].port : null
}

output "rds_database_name" {
  description = "Name of the default RDS database"
  value       = var.create_rds ? module.rds[0].database_name : null
}

#########################################################################
##                     KVStore (Redis) Outputs                         ##
#########################################################################

output "kvstore_connection_domain" {
  description = "Private connection domain of the KVStore instance"
  value       = var.create_kvstore ? module.kvstore[0].connection_domain : null
}

output "kvstore_port" {
  description = "Port of the KVStore instance"
  value       = var.create_kvstore ? module.kvstore[0].port : null
}

#########################################################################
##                     OSS / OTS / MNS / CR / KMS Outputs              ##
#########################################################################

output "oss_bucket_names" {
  description = "Names of the created OSS buckets"
  value       = var.create_oss ? module.oss[0].bucket_names : []
}

output "ots_table_names" {
  description = "Names of the created Tablestore tables"
  value       = var.create_ots ? module.ots[0].table_names : []
}

output "mns_queue_names" {
  description = "Names of the created MNS queues"
  value       = var.create_mns ? module.mns[0].queue_names : []
}

output "mns_topic_names" {
  description = "Names of the created MNS topics"
  value       = var.create_mns ? module.mns[0].topic_names : []
}

output "cr_namespace" {
  description = "Name of the Container Registry namespace"
  value       = (var.provision_cr && var.registry_provider == "native") ? module.cr[0].namespace : null
}

output "custom_secret_names" {
  description = "Names of the created KMS secrets"
  value       = (length(var.custom_secrets) > 0 && var.secrets_provider == "native") ? module.kms[0].secret_names : []
}

#########################################################################
##                     DNS Outputs                                     ##
#########################################################################

output "alidns_name_servers" {
  description = "AliDNS name servers for the managed domain"
  value       = (var.alidns_enabled && var.dns_provider == "native") ? module.dns[0].name_servers : []
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "region" {
  description = "Alibaba Cloud region"
  value       = var.region
}
