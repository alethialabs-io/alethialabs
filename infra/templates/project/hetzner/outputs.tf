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
