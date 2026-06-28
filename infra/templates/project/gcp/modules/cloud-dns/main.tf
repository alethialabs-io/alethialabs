resource "google_dns_managed_zone" "zone" {
  name        = "${var.project_name}-${var.environment}-${var.zone_name}"
  dns_name    = var.domain
  project     = var.project_id
  description = "Managed DNS zone for ${var.domain} (${var.environment})"

  labels = var.labels
}

resource "google_compute_managed_ssl_certificate" "cert" {
  count = var.managed_certificate ? 1 : 0

  name    = "${var.project_name}-${var.environment}-${var.zone_name}-cert"
  project = var.project_id

  managed {
    domains = [trimsuffix(var.domain, ".")]
  }
}
