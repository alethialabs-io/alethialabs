output "name_servers" {
  description = "List of authoritative name servers for the managed zone"
  value       = google_dns_managed_zone.zone.name_servers
}

output "zone_name" {
  description = "The name of the managed DNS zone resource"
  value       = google_dns_managed_zone.zone.name
}



# The FQDN actually sent to GCP, after normalisation (#2099). Exported so the invariant is
# assertable from a test — the zone resource itself cannot be reached from the root, and a
# normalisation nobody can measure is one that quietly stops happening.
output "dns_name" {
  description = "The zone's dnsName as sent to GCP — always terminated with a dot"
  value       = local.dns_name
}
