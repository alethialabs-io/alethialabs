output "name_servers" {
  description = "List of authoritative name servers for the managed zone"
  value       = google_dns_managed_zone.zone.name_servers
}

output "zone_name" {
  description = "The name of the managed DNS zone resource"
  value       = google_dns_managed_zone.zone.name
}

output "managed_certificate_id" {
  description = "The ID of the managed SSL certificate, or null if not created"
  value       = var.managed_certificate ? google_compute_managed_ssl_certificate.cert[0].id : null
}

# The NAME is what a GKE Ingress consumes: `ingress.gcp.kubernetes.io/pre-shared-cert` takes a
# comma-separated list of GLOBAL SSL-certificate names, not ids or self links. Without this the
# certificate above is created, billed and attached to no load balancer — the same shape of gap the
# Cloud Armor policy had.
output "managed_certificate_name" {
  description = "The name of the managed SSL certificate — the value a GKE Ingress's ingress.gcp.kubernetes.io/pre-shared-cert annotation takes — or null if not created"
  value       = var.managed_certificate ? google_compute_managed_ssl_certificate.cert[0].name : null
}
