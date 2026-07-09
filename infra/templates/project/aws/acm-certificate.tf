module "acm" {
  count  = var.acm_certificate_enable && var.dns_provider == "native" ? 1 : 0
  source = "./modules/acm"
  # Configured for wildcard certificate
  domain_name = "*.${var.dns_main_domain}"
  # Use the in-template-created zone when enabled, else the caller's existing zone id.
  r53_zone_id = var.cloud_dns_enabled ? module.route53[0].zone_id : var.dns_hosted_zone
}
