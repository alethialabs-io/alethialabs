locals {
  # The hostnames the platform actually serves on the GKE Ingress's load balancer. Today that is
  # exactly one: the ArgoCD Ingress installArgoCD renders at argocd.<domain>. Add a name here when
  # — and only when — something starts serving it AND external-dns publishes a record for it. A
  # name on a Google-managed certificate that resolves nowhere does not degrade gracefully: it
  # holds the entire certificate in FAILED_NOT_VISIBLE and takes every working name down with it.
  #
  # The apex is deliberately absent for exactly that reason. This template creates a zone and a
  # certificate and NO record sets, so the apex would never resolve, and `allow-http: "false"` on
  # the Ingress means there is no plaintext fallback to serve in the meantime.
  #
  # Derived HERE rather than inside the module so `tofu test` can assert on it: `assert` reads
  # `local.`, but cannot reach a module's internals without an output.
  platform_certificate_domains = ["argocd.${trimsuffix(var.cloud_dns_domain, ".")}"]
}

module "cloud_dns" {
  source = "./modules/cloud-dns"
  count  = var.cloud_dns_enabled && var.dns_provider == "native" ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  zone_name = var.cloud_dns_zone_name != "" ? var.cloud_dns_zone_name : local.cloud_dns_name
  domain    = var.cloud_dns_domain

  managed_certificate = var.cloud_dns_managed_certificate
  certificate_domains = local.platform_certificate_domains

  labels = local.gcp_default_labels
}
