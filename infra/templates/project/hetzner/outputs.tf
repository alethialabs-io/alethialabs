# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "talos_cluster_name" {
  description = "Cluster name (project-environment). The pipeline configures kubeconfig only when this is non-empty."
  value       = local.cluster_name
}

output "talos_cluster_endpoint" {
  description = "Kubernetes API endpoint URL (https://<control-plane-ip>:6443)."
  value       = local.cluster_endpoint
}

output "kubeconfig" {
  description = "Raw kubeconfig for the cluster."
  value       = talos_cluster_kubeconfig.this.kubeconfig_raw
  sensitive   = true
}

output "talosconfig" {
  description = "Talos client configuration (talosconfig)."
  value       = data.talos_client_configuration.this.talos_config
  sensitive   = true
}

output "network_id" {
  description = "The private network the cluster is attached to — created here when provision_network is true, otherwise the existing one named by var.network_id."
  value       = local.network_id
}

output "dns_zone_id" {
  description = "The hcloud DNS zone id (created in-template when cloud_dns_enabled, else the existing dns_hosted_zone)."
  value       = length(hcloud_zone.this) > 0 ? tostring(hcloud_zone.this[0].id) : var.dns_hosted_zone
}

output "dns_name_servers" {
  description = "Authoritative name servers for the created zone (delegate these at the registrar); empty when using an existing zone."
  value       = length(hcloud_zone.this) > 0 ? hcloud_zone.this[0].authoritative_nameservers.assigned : []
}

output "bucket_names" {
  description = "Provisioned Object Storage bucket names (namespaced by cluster). Empty when no buckets were requested."
  value       = [for b in minio_s3_bucket.bucket : b.bucket]
}

output "bucket_endpoints" {
  description = "Per-bucket S3 endpoint URLs (https://<endpoint>/<bucket>)."
  value       = { for name, b in minio_s3_bucket.bucket : name => "https://${var.hetzner_s3_endpoint}/${b.bucket}" }
}

output "bootstrap_manifests" {
  description = "CNI + cloud-integration manifests (hcloud Secret -> Cilium -> hcloud-CCM -> hcloud-CSI), rendered offline. The runner applies these post-apply (kubectl apply) before the reachability gate: Talos is CNI=none, so nodes stay NotReady until this is applied. Emitted as an output (not applied in-tofu) to keep 'tofu plan -out' resolvable and stay under Hetzner's 32 KiB cloud-init user_data limit."
  value       = local.bootstrap_manifests
  sensitive   = true
}
