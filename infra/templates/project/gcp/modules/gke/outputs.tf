output "cluster_name" {
  description = "Name of the GKE cluster"
  value       = google_container_cluster.cluster.name
}

output "cluster_endpoint" {
  description = "Endpoint for the GKE cluster control plane"
  value       = google_container_cluster.cluster.endpoint
  sensitive   = true
}

output "cluster_ca_certificate" {
  description = "Base64-encoded public certificate authority of the cluster"
  value       = google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
  sensitive   = true
}

output "cluster_id" {
  description = "Unique identifier of the GKE cluster"
  value       = google_container_cluster.cluster.id
}

output "node_pool_name" {
  description = "Name of the default node pool (empty on Autopilot, which manages its own node pools). Derived defensively: GKE caps this at 39 characters, so an over-long readable name falls back to a truncated-plus-digest form (see locals in main.tf)."
  value       = var.enable_autopilot ? "" : google_container_node_pool.default[0].name
}
