locals {
  # GCP requires a managed zone's dnsName to be a FULLY-QUALIFIED name, terminated with a dot, and
  # rejects anything else with `Error 400: Invalid value for 'entity.managedZone.dnsName'`.
  #
  # Both this module's variable and the root's `cloud_dns_domain` DOCUMENTED that requirement in
  # prose and enforced it nowhere, and no real caller supplies it: the Go provider emits
  # `config.DNS.DomainName` verbatim, and the e2e harness's MaxConfigDomain() returns
  # `<env>.e2e.alethialabs.io`. So every real gcp apply that enabled DNS failed at this resource —
  # observed on the 2026-08-09 full-bar nightly (#2099).
  #
  # The tofu tests never caught it because their fixtures hand-wrote "example.com." WITH the dot,
  # so the suite only ever exercised the one shape the real callers never produce.
  #
  # Normalised HERE rather than in the Go provider deliberately. `DomainName` is also the stem the
  # runner builds hostnames from (the ArgoCD Ingress is rendered at `argocd.<domain>`), and a dot
  # appended there would travel into those names. The template is the only consumer that wants the
  # FQDN form, so the conversion belongs at its boundary.
  dns_name = endswith(var.domain, ".") ? var.domain : "${var.domain}."
}

resource "google_dns_managed_zone" "zone" {
  name        = "${var.project_name}-${var.environment}-${var.zone_name}"
  dns_name    = local.dns_name
  project     = var.project_id
  description = "Managed DNS zone for ${var.domain} (${var.environment})"

  labels = var.labels
}


