# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# The outputs are deliberately named with the `talos_*` prefix so the runner's
# HARDCODED output-name allowlist (cloud.ExtractClusterName / ExtractClusterEndpoint)
# discovers the cluster and runs the post-apply spine — no cloud_provider enum value
# is added for `local`; the deploy is driven as Provider="hetzner".

output "talos_cluster_name" {
  description = "Cluster name (project-environment). The runner configures kubeconfig + runs the post-apply spine only when this is non-empty."
  value       = local.cluster_name
}

output "talos_cluster_endpoint" {
  description = "Kubernetes API endpoint URL (https://127.0.0.1:<random-host-port>)."
  value       = kind_cluster.this.endpoint
}

output "kubeconfig" {
  description = "Raw kubeconfig for the kind cluster (read by the runner's ConfigureKubeconfig)."
  value       = kind_cluster.this.kubeconfig
  sensitive   = true
}

output "bootstrap_manifests" {
  description = "Post-apply CNI/cloud-integration manifests. EMPTY for kind: kindnet ships as the CNI, so there is nothing to bootstrap — which also exercises the empty-bootstrap no-op branch in the runner's applyBootstrapManifests."
  value       = ""
}
