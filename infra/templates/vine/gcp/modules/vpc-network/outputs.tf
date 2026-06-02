output "network_name" {
  description = "Name of the VPC network"
  value       = google_compute_network.vpc.name
}

output "network_self_link" {
  description = "Self-link of the VPC network"
  value       = google_compute_network.vpc.self_link
}

output "private_subnet_name" {
  description = "Name of the private subnet"
  value       = google_compute_subnetwork.private.name
}

output "private_subnet_self_link" {
  description = "Self-link of the private subnet"
  value       = google_compute_subnetwork.private.self_link
}

output "public_subnet_name" {
  description = "Name of the public subnet"
  value       = google_compute_subnetwork.public.name
}

output "public_subnet_self_link" {
  description = "Self-link of the public subnet"
  value       = google_compute_subnetwork.public.self_link
}

output "pod_ip_range_name" {
  description = "Name of the secondary IP range for GKE pods"
  value       = local.pod_range_name
}

output "service_ip_range_name" {
  description = "Name of the secondary IP range for GKE services"
  value       = local.service_range_name
}
