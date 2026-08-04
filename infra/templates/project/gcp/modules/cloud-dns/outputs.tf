output "name_servers" {
  description = "List of authoritative name servers for the managed zone"
  value       = google_dns_managed_zone.zone.name_servers
}

output "zone_name" {
  description = "The name of the managed DNS zone resource"
  value       = google_dns_managed_zone.zone.name
}


