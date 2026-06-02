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
