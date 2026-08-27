# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# external-dns identity invariants.
# Split out per the IaC rule that each feature owns its checks file; never append to checks.tf.

# The identity must be exactly one of "created here" or "adopted" — never both, never neither.
# If it resolved empty, the zone-scoped grant would render `serviceAccount:` with no principal and
# the apply would die deep inside IAM with an opaque message instead of here, naming the input.
check "external_dns_identity_resolved" {
  assert {
    condition     = !var.provision_gke || local.external_dns_sa_email != ""
    error_message = "The external-dns service account resolved to an empty email — set external_dns_service_account_email to adopt the standing GSA from infra/connector/gcp, or leave it empty to have this template create a per-deploy one."
  }
}

check "external_dns_identity_single_owner" {
  assert {
    condition     = !var.provision_gke || (local.external_dns_adopted != (length(google_service_account.external_dns) > 0))
    error_message = "The external-dns GSA must be either adopted or created by this template, never both — check external_dns_service_account_email."
  }
}

# A DNS-enabled environment on the CREATE path is a working record-writer that can never list a
# zone, so external-dns will CrashLoopBackOff on `Error 403: Forbidden` while ArgoCD reports the
# Application Synced (#2811). That is a warning rather than an apply failure on purpose: the
# cluster, the zone and cert-manager's DNS01 solver are all fine, and refusing the apply would take
# a working environment away to fix a controller. It must not be SILENT, which it was.
check "external_dns_can_list_zones" {
  assert {
    condition     = !(var.provision_gke && local.external_dns_zone != "") || local.external_dns_adopted
    error_message = "external-dns will not be able to list Cloud DNS zones: no external_dns_service_account_email was supplied, so this deploy created a per-deploy GSA whose grants are zone-scoped. `dns.managedZones.list` is a PROJECT-level permission that cannot be granted at zone scope, and external-dns calls List() before it writes anything — it will CrashLoopBackOff on 403 while its Application reports Synced. Run infra/connector/gcp to create the standing GSA and pass its email."
  }
}
