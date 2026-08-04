resource "google_dns_managed_zone" "zone" {
  name        = "${var.project_name}-${var.environment}-${var.zone_name}"
  dns_name    = var.domain
  project     = var.project_id
  description = "Managed DNS zone for ${var.domain} (${var.environment})"

  labels = var.labels
}


