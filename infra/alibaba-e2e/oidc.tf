# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The RAM OIDC provider trusting GitHub Actions. Alibaba pins the issuer's TLS cert-chain SHA1
# fingerprints on the provider; we pin the CA cert(s) (intermediate + root, `is_ca`) not the leaf,
# so a GitHub leaf-cert rotation doesn't silently break validation (same rationale as
# infra/connector/alibaba/main.tf + alethia-alibaba-setup.sh). Re-apply this stack to refresh the
# fingerprints if the issuing CA itself ever rotates.

data "alicloud_caller_identity" "current" {}

data "tls_certificate" "github" {
  url = var.github_issuer_url
}

locals {
  github_ca_fingerprints = [for c in data.tls_certificate.github.certificates : c.sha1_fingerprint if c.is_ca]
  # Defensive fallback: if none is flagged is_ca (single-cert chain), pin the whole chain.
  github_fingerprints = length(local.github_ca_fingerprints) > 0 ? local.github_ca_fingerprints : [
    for c in data.tls_certificate.github.certificates : c.sha1_fingerprint
  ]
}

resource "alicloud_ims_oidc_provider" "github" {
  oidc_provider_name = var.oidc_provider_name
  issuer_url         = var.github_issuer_url
  # Only tokens minted for the Alibaba STS audience are accepted (a token for another aud is
  # rejected before the sub is even checked).
  client_ids   = [var.oidc_audience]
  fingerprints = local.github_fingerprints
  description  = "Trust GitHub Actions OIDC for the ref-bound e2e-nightly RAM role (BYOC A3.1)."
}
