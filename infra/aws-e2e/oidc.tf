# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The GitHub Actions OIDC provider, CREATED here rather than adopted. infra/aws-oidc adopts the one
# infra/email-ses/bootstrap made in the platform account; a new member account has none, and an IAM
# OIDC provider is per-account, so the e2e account needs its own.
#
# No thumbprint_list: optional from provider 5.81 (versions.tf), and IAM verifies GitHub's JWKS
# endpoint against its trusted-root library without one.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"

  # BUILT from plan-time values, not read off the resource. `arn` is computed, so a trust document
  # naming aws_iam_openid_connect_provider.github.arn would plan as `(known after apply)` on the very
  # first plan of this stack — the one plan the maintainer most needs to read in full, and every
  # check in checks.tf that inspects the trust JSON would evaluate to unknown. IAM names a provider
  # `oidc-provider/<url without scheme>`; check.github_oidc_provider_arn_matches compares this string
  # with the real `arn` once it is known.
  github_oidc_provider_arn = "arn:aws:iam::${var.e2e_account_id}:oidc-provider/${local.github_oidc_host}"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
  tags           = { purpose = "github-actions-e2e" }
}
