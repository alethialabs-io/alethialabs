module "cloud_dns" {
  source = "./modules/cloud-dns"
  count  = var.cloud_dns_enabled && var.dns_provider == "native" ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  zone_name   = var.cloud_dns_zone_name != "" ? var.cloud_dns_zone_name : local.cloud_dns_name
  domain      = var.cloud_dns_domain

  managed_certificate = var.cloud_dns_managed_certificate

  labels = local.gcp_default_labels
}
