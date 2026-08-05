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

output "rrsa_oidc_issuer_url" {
  description = "OIDC issuer URL of the cluster's RRSA identity (workload identity for in-cluster components)"
  value       = var.provision_ack ? module.cluster[0].rrsa_oidc_issuer_url : ""
}

output "rrsa_oidc_provider_arn" {
  description = "RAM OIDC provider ARN that RRSA workload-identity roles trust"
  value       = var.provision_ack ? module.cluster[0].rrsa_oidc_provider_arn : ""
}

output "external_secrets_ram_role_arn" {
  description = "RRSA RAM role ARN for the external-secrets operator (gates the alibaba ClusterSecretStore render)"
  value       = local.eso_rrsa_enabled ? alicloud_ram_role.external_secrets[0].arn : ""
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

output "cr_repository_paths" {
  description = "Map of registry component names to their <namespace>/<repository> path"
  # Guarded on the MODULE, not on a copy of its count predicate: indexing [0] of an empty module
  # fails the WHOLE apply with "Invalid index", a mile from its cause. Same reasoning as
  # gcp/outputs.tf's artifact_registry_urls, whose comment records that exact crash.
  value = length(module.cr) > 0 ? module.cr[0].repository_paths : {}
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

# The domain downstream bindings should use, resolved identically on both paths — aws/azure parity
# (#1992). Created in-template when alidns_enabled, else the domain the caller already owns.
output "alidns_domain_resolved" {
  description = "The AliDNS domain serving this project — created in-template when alidns_enabled, else the existing alidns_domain supplied by the caller."
  value       = (var.alidns_enabled && var.dns_provider == "native") ? module.dns[0].domain_name : var.alidns_domain
}

#########################################################################
##                     WAF Outputs                                     ##
#########################################################################

# Read by the runner (argocd.InfraFacts.AlibabaWAFInstanceID). Exporting it is what lets a deploy
# record an HONEST answer to "the WAF switch is on — is anything being filtered?". On this cloud
# the answer is no, and until this output existed nothing could tell "the switch is off" apart
# from "you are paying for a WAF 3.0 postpaid instance that inspects zero requests". The binding
# itself (alicloud_wafv3_domain, CNAME mode) needs the ingress load balancer's address, which
# does not exist at plan time — see modules/waf/main.tf for the provider evidence.
#
# null when the switch is off. ExtractOutput turns a null into "", which is exactly the
# "nothing built" signal the decision reads.
output "waf_instance_id" {
  description = "Id of the WAF 3.0 instance for the application WAF — exported UNATTACHED; no hostname is bound to it"
  value       = var.application_waf_enabled ? module.waf[0].instance_id : null
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "region" {
  description = "Alibaba Cloud region"
  value       = var.region
}
