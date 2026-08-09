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

################################################################################
# Node-pool verification surface
################################################################################
# These echo arguments this module SETS, so a `tofu test` can prove they were set. They exist for
# that reason and no other: the root's locals.tf decides WHICH of Alibaba's two mutually exclusive
# disk-performance arguments to send, and checks_cluster.tftest.hcl can read a root local — but a
# local proves only the decision, never the assignment. Delete the `system_disk_provisioned_iops =`
# line from the node pool above and every local-based assertion still passes, because the value was
# still computed; it simply stopped reaching the resource. That is the unwired-template defect in
# miniature, and reading the planned attribute back is what makes it visible.
#
# Not promoted to a ROOT output: the runner harvests root outputs into jobs.execution_metadata, and
# a node-pool argument is not a provisioning fact anything downstream consumes.

output "node_pool_system_disk_category" {
  description = "System disk category the node pool was planned with."
  value       = alicloud_cs_kubernetes_node_pool.default.system_disk_category
}

output "node_pool_system_disk_performance_level" {
  description = "ESSD performance level the node pool was planned with (null when not applicable)."
  value       = alicloud_cs_kubernetes_node_pool.default.system_disk_performance_level
}

output "node_pool_system_disk_provisioned_iops" {
  description = "Provisioned IOPS the node pool was planned with (null when not applicable)."
  value       = alicloud_cs_kubernetes_node_pool.default.system_disk_provisioned_iops
}

output "node_pool_spot_strategy" {
  description = "Bidding strategy the node pool was planned with."
  value       = alicloud_cs_kubernetes_node_pool.default.spot_strategy
}

output "node_pool_spot_price_limit_count" {
  description = "Number of spot_price_limit blocks rendered on the node pool."
  value       = length(alicloud_cs_kubernetes_node_pool.default.spot_price_limit)
}
