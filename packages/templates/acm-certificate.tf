module "acm" {
  count  = var.acm_certificate_enable ? 1 : 0
  source = "./modules/acm"
  # Configured for wildcard certificate
  domain_name = "*.${var.dns_main_domain}"
  r53_zone_id = var.dns_hosted_zone
}
