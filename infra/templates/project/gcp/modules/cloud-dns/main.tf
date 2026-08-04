resource "google_dns_managed_zone" "zone" {
  name        = "${var.project_name}-${var.environment}-${var.zone_name}"
  dns_name    = var.domain
  project     = var.project_id
  description = "Managed DNS zone for ${var.domain} (${var.environment})"

  labels = var.labels
}

locals {
  # The names the certificate will actually be asked to serve, apex-normalised and de-duplicated.
  certificate_domains = distinct([for d in var.certificate_domains : trimsuffix(d, ".")])

  # A short digest of the SAN set, carried in the certificate's NAME. Changing `domains` forces
  # replacement, and a certificate attached to a live load balancer cannot be deleted before its
  # replacement exists — so this resource needs create_before_destroy, and create_before_destroy
  # needs the new object to have a DIFFERENT name. google_compute_managed_ssl_certificate has no
  # `name_prefix`, so the name has to carry the difference itself.
  certificate_suffix = substr(sha256(join(",", local.certificate_domains)), 0, 8)

  # The name was "<project_name>-<environment>-<zone_name>-cert", which repeats the naming stem
  # TWICE: zone_name defaults to the root's `dns-<region-short>-<environment>-<project_name>`, so
  # the readable form already carries environment and project_name before this prefix adds them
  # again. At the shipped stem budget that renders 56 characters against GCP's 63-char cap — and
  # adding the 9-character SAN digest above would have pushed the DEFAULT path to 65 and failed
  # the apply, on exactly the deploys that bring no zone id of their own.
  #
  # So drop the duplicated prefix and bound what remains. Same defensive shape as the root's
  # gke_node_pool_name (#1716): keep the readable form when it fits, truncate deterministically
  # when it does not, and trim a truncation that lands on a hyphen so the name stays valid. The
  # digest is what keeps two truncated names distinct, so it is never truncated itself.
  certificate_stem     = "${var.zone_name}-cert"
  certificate_stem_max = 63 - 1 - length(local.certificate_suffix) # 63 cap, "-", digest
  certificate_name = format("%s-%s",
    trimsuffix(substr(local.certificate_stem, 0, min(length(local.certificate_stem), local.certificate_stem_max)), "-"),
  local.certificate_suffix)
}

# A GLOBAL Google-managed SSL certificate for the hostnames the platform actually serves.
#
# Google provisions a managed certificate by checking that EVERY domain on it resolves to the load
# balancer the certificate is attached to. A name that never resolves does not degrade the
# certificate — it holds the whole thing in FAILED_NOT_VISIBLE, and every other name on it with it.
#
# That is why the apex is not here by default. This module creates a zone and a certificate and NO
# record sets; the only records that ever appear are the ones external-dns publishes from an
# Ingress, and today that is `argocd.<domain>`. A certificate issued for the bare apex could
# therefore never go ACTIVE, and because the GKE Ingress sets `allow-http: "false"` there is no
# plaintext fallback either — the ingress would serve nothing, permanently, while the ArgoCD-URL
# decision reported it installed.
resource "google_compute_managed_ssl_certificate" "cert" {
  count = var.managed_certificate ? 1 : 0

  name    = local.certificate_name
  project = var.project_id

  managed {
    domains = local.certificate_domains
  }

  lifecycle {
    create_before_destroy = true
  }
}
