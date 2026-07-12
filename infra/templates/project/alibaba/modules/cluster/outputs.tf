# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "cluster_name" {
  description = "Name of the ACK cluster"
  value       = alicloud_cs_managed_kubernetes.this.name
}

output "cluster_id" {
  description = "Id of the ACK cluster"
  value       = alicloud_cs_managed_kubernetes.this.id
}

output "cluster_endpoint" {
  description = "Public API server endpoint of the ACK cluster"
  value       = try(alicloud_cs_managed_kubernetes.this.connections["api_server_internet"], "")
}

output "kubeconfig" {
  description = "Kubeconfig for the ACK cluster"
  value       = data.alicloud_cs_cluster_credential.this.kube_config
  sensitive   = true
}

output "rrsa_oidc_issuer_url" {
  description = "OIDC issuer URL of the cluster's RRSA identity (empty until the API reports it)"
  value       = try(alicloud_cs_managed_kubernetes.this.rrsa_metadata[0].rrsa_oidc_issuer_url, "")
}

output "rrsa_oidc_provider_arn" {
  description = "RAM OIDC provider ARN workload-identity roles trust (empty until the API reports it)"
  value       = try(alicloud_cs_managed_kubernetes.this.rrsa_metadata[0].ram_oidc_provider_arn, "")
}
