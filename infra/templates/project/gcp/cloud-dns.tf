locals {
  # The hostnames the Google-managed certificate covers.
  #
  # ⚠ THE PLATFORM NO LONGER ATTACHES THIS CERTIFICATE TO ANYTHING (#1858). The GKE ArgoCD Ingress
  # used to consume it through `ingress.gcp.kubernetes.io/pre-shared-cert`; it now gets its TLS from
  # cert-manager over ACME DNS01, the same mechanism the managed_certificate switch means on every
  # other cloud (#1851). The resource and this variable are kept because `cloud_dns_managed_certificate`
  # is still the offer-parity CARRIER for `dns:managed_certificate` on gcp, and moving that cell onto
  # the in-cluster issuer is a shared-file change belonging to the lane that owns
  # infra/offer-exclusions.yaml. Removing the resource belongs with it.
  #
  # So read this list as "what a certificate you attach yourself would cover", not as a promise about
  # what the platform serves. Left unattached the certificate never leaves PROVISIONING at all —
  # Google validates a managed certificate by resolving every name on it to the load balancer it is
  # attached to — and installArgoCD says so in the deploy log rather than leaving it unexplained.
  #
  # The apex is still deliberately absent, and the reason still holds for anyone who does attach it:
  # this template creates a zone and NO record sets, the only records that ever appear are the ones
  # external-dns publishes from an Ingress, and ONE name that resolves nowhere holds the entire
  # certificate in FAILED_NOT_VISIBLE and takes every working name down with it.
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
